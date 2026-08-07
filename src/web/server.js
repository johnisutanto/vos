// Admin website: serves the static UI and a small JSON API the UI calls.

import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { captureCurrentBoard } from '../apps/gallery/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export function createServer({ engine, scheduler, cfg }) {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(HERE, 'public')));

  // List apps with their manifests + schedule.
  app.get('/api/apps', (req, res) => {
    const list = [...engine.apps.values()].map(({ manifest }) => ({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      schedule: manifest.schedule || [],
      config: manifest.config || {},
    }));
    res.json(list);
  });

  // The active daily schedule (from config.yaml) + board + last run.
  app.get('/api/schedule', (req, res) => {
    res.json({
      board: { rows: engine.rows, columns: engine.columns, timezone: cfg.board.timezone || null },
      schedule: cfg.schedule,
      lastRun: scheduler.lastRun,
      host: cfg.env.host,
      hasApiKey: Boolean(cfg.env.apiKey),
    });
  });

  // Render an app to a grid without writing to the board (for preview).
  app.get('/api/apps/:id/preview', async (req, res) => {
    try {
      const grid = await engine.renderApp(req.params.id);
      res.json({ grid });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Render + write to the board now.
  app.post('/api/apps/:id/push', async (req, res) => {
    const result = await scheduler.fire(req.params.id);
    res.status(result.ok ? 200 : 502).json(result);
  });

  // Save the board's current content as a gallery art design.
  app.post('/api/capture', async (req, res) => {
    const name = (req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'A name is required' });
    try {
      const saved = await captureCurrentBoard(engine.client, name, {
        rows: engine.rows,
        columns: engine.columns,
      });
      res.json({ ok: true, name: saved.name });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Read what's currently on the board.
  app.get('/api/board', async (req, res) => {
    try {
      const grid = await engine.client.read();
      res.json({ grid });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return app;
}
