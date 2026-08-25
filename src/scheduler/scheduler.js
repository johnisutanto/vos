// Cron scheduler: fires each configured entry, renders the app, writes to board.

import cron from 'node-cron';
import { mostRecentlyDue } from '../service/cron-slots.js';

export class Scheduler {
  // engine = { renderApp(id) -> grid, writeGrid(grid), apps }
  constructor(engine, { schedule = [], keepOnError = true } = {}) {
    this.engine = engine;
    this.schedule = schedule;
    this.keepOnError = keepOnError;
    this.jobs = [];
    this.lastRun = null; // { app, at, ok, error }
    this._catchUpTimer = null;
    this._catchingUp = false;
  }

  start() {
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
    // Lid-closed Apple Silicon will not wake for pmset events. When the
    // process thaws (lid opened, clamshell, reboot), push the slot that
    // should currently be on the board. Polling covers freeze/thaw; the
    // immediate call covers a fresh launch after a missed morning.
    this.catchUp();
    this._catchUpTimer = setInterval(() => this.catchUp(), 60_000);
  }

  stop() {
    for (const job of this.jobs) job.stop();
    this.jobs = [];
    if (this._catchUpTimer) {
      clearInterval(this._catchUpTimer);
      this._catchUpTimer = null;
    }
  }

  async catchUp() {
    if (this._catchingUp) return;
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
  async fire(appId) {
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
