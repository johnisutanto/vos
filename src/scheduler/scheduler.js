// Cron scheduler: fires each configured entry, renders the app, writes to board.

import cron from 'node-cron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mostRecentlyDue } from '../service/cron-slots.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAUSE_FILE = join(ROOT, 'logs', 'paused');

async function readPaused() {
  try {
    if (!existsSync(PAUSE_FILE)) return false;
    return (await readFile(PAUSE_FILE, 'utf8')).trim() === '1';
  } catch {
    return false;
  }
}

async function writePaused(paused) {
  await mkdir(dirname(PAUSE_FILE), { recursive: true });
  await writeFile(PAUSE_FILE, paused ? '1\n' : '0\n', 'utf8');
}

export class Scheduler {
  // engine = { renderApp(id) -> grid, writeGrid(grid), apps }
  constructor(engine, { schedule = [], keepOnError = true } = {}) {
    this.engine = engine;
    this.schedule = schedule;
    this.keepOnError = keepOnError;
    this.jobs = [];
    this.lastRun = null; // { app, at, ok, error }
    this.paused = false;
    this._catchUpTimer = null;
    this._catchingUp = false;
  }

  async start() {
    this.paused = await readPaused();
    this._bindJobs();
    if (this.paused) {
      console.log('[scheduler] paused — timed slots and catch-up will not write. Push now still works.');
    }
    // Lid-closed Apple Silicon will not wake for pmset events. When the
    // process thaws (lid opened, clamshell, reboot), push the slot that
    // should currently be on the board. Polling covers freeze/thaw; the
    // immediate call covers a fresh launch after a missed morning.
    this.catchUp();
    if (!this._catchUpTimer) {
      this._catchUpTimer = setInterval(() => this.catchUp(), 60_000);
    }
  }

  _bindJobs() {
    for (const job of this.jobs) job.stop();
    this.jobs = [];
    for (const entry of this.schedule) {
      if (!entry.cron || !entry.app) continue;
      if (!cron.validate(entry.cron)) {
        console.warn(`[scheduler] invalid cron "${entry.cron}" for app ${entry.app}, skipping`);
        continue;
      }
      const job = cron.schedule(entry.cron, () => this.fire(entry.app));
      this.jobs.push(job);
      console.log(`[scheduler] scheduled ${entry.app} at "${entry.cron}"`);
    }
  }

  async replaceSchedule(schedule) {
    this.schedule = schedule;
    this._bindJobs();
    console.log('[scheduler] schedule updated from admin site');
    this.catchUp();
    return { schedule: this.schedule };
  }

  stop() {
    for (const job of this.jobs) job.stop();
    this.jobs = [];
    if (this._catchUpTimer) {
      clearInterval(this._catchUpTimer);
      this._catchUpTimer = null;
    }
  }

  async setPaused(paused) {
    this.paused = Boolean(paused);
    await writePaused(this.paused);
    console.log(this.paused
      ? '[scheduler] paused — timed slots will not write'
      : '[scheduler] resumed — timed slots will write again');
    if (!this.paused) this.catchUp();
    return { paused: this.paused };
  }

  async catchUp() {
    if (this.paused || this._catchingUp) return;
    const due = mostRecentlyDue(this.schedule);
    if (!due) return;
    if (this.lastRun?.ok && new Date(this.lastRun.at) >= due.at) return;
    this._catchingUp = true;
    try {
      console.log(`[scheduler] catch-up ${due.app} (slot was ${due.at.toISOString()})`);
      await this.fire(due.app);
    } finally {
      this._catchingUp = false;
    }
  }

  // Render one app and push it. Used by cron and by the admin "Push now" button.
  // force: true skips the pause gate (manual pushes from the UI).
  async fire(appId, { force = false } = {}) {
    if (this.paused && !force) {
      console.log(`[scheduler] skipped ${appId} (paused)`);
      return { ok: true, skipped: true };
    }
    const at = new Date().toISOString();
    try {
      const grid = await this.engine.renderApp(appId);
      await this.engine.writeGrid(grid);
      this.lastRun = { app: appId, at, ok: true };
      console.log(`[scheduler] pushed ${appId} at ${at}`);
      return { ok: true };
    } catch (err) {
      this.lastRun = { app: appId, at, ok: false, error: err.message };
      // keepOnError: we simply don't write — the board keeps its last content.
      console.error(`[scheduler] ${appId} failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }
}
