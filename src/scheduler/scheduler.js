// Cron scheduler: fires each configured entry, renders the app, writes to board.

import cron from 'node-cron';

export class Scheduler {
  // engine = { renderApp(id) -> grid, writeGrid(grid), apps }
  constructor(engine, { schedule = [], keepOnError = true } = {}) {
    this.engine = engine;
    this.schedule = schedule;
    this.keepOnError = keepOnError;
    this.jobs = [];
    this.lastRun = null; // { app, at, ok, error }
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
  }

  stop() {
    for (const job of this.jobs) job.stop();
    this.jobs = [];
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
