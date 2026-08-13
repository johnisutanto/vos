// Admin website: serves the static UI and a small JSON API the UI calls.

import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { captureCurrentBoard } from '../apps/gallery/store.js';
import * as service from '../service/launchd.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// The admin site is unauthenticated by design (see README), which is a fair
// trade for previews and pushes. Installing a launchd agent is not: it would
// let anyone on the LAN plant a persistent background job. These routes are
// therefore restricted to callers on the loopback interface. Express is not
// behind a proxy here, so the peer address cannot be forged with a header.
function loopbackOnly(req, res, next) {
  const addr = req.socket.remoteAddress || '';
  const local = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  if (!local) {
    return res.status(403).json({ error: 'Service control is only available from localhost.' });
  }
  next();
}

// Run work once the reply is flushed, for actions that stop this process.
function afterResponse(res, fn) {
  res.on('finish', () => setTimeout(fn, 150));
}

// Release the listening socket, then let launchd start the supervised copy and
// exit so it can bind. On failure the plist is still installed with RunAtLoad,
// so the agent comes up at next login; `vos service status` explains the state.
async function handOffTo(svc, httpServer) {
  try {
    if (httpServer) {
      httpServer.closeAllConnections?.();
      await new Promise((resolve) => httpServer.close(resolve));
    }
    await svc.bootstrap();
    console.log('[vos] background service started; this foreground process is exiting.');
    process.exit(0);
  } catch (err) {
    console.error(`[vos] could not start the background service: ${err.message}`);
    console.error('[vos] the agent is installed and will start at next login. Run `vos service status` to check.');
    process.exit(1);
  }
}

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

  // Is the background launchd agent installed and running?
  app.get('/api/service', loopbackOnly, async (req, res) => {
    try {
      res.json(await service.status());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Turn the background agent on or off. Body: { enabled: boolean }.
  app.post('/api/service', loopbackOnly, async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'Body must be { "enabled": true | false }' });
    }
    if (!service.supported) {
      return res.status(501).json({ error: `Requires macOS (launchd); this is ${process.platform}.` });
    }

    const before = await service.status();
    const httpServer = req.app.locals.httpServer;

    try {
      if (req.body.enabled) {
        // Already supervised: starting it again would boot out the job that is
        // serving this very request, killing the service instead of renewing
        // it. Enabling an enabled service is a no-op — except we still try to
        // install scheduled wakes if this Mac does not have them yet (e.g. a
        // service that was enabled before wakes existed).
        if (before.running) {
          if (!before.wakes?.installed) {
            await service.installWakeDaemon();
          }
          return res.json({
            ok: true, enabled: true, handoff: false, alreadyRunning: true,
            wakes: (await service.status()).wakes,
          });
        }
        // Scheduled wakes need an admin prompt. Do that *before* writing the
        // user-agent plist or handing off, so a cancelled password leaves this
        // foreground server running and does not leave a stray LaunchAgent.
        await service.installWakeDaemon();
        await service.writePlist();
        res.json({ ok: true, enabled: true, handoff: true });
        afterResponse(res, () => handOffTo(service, httpServer));
      } else {
        // Cancel wakes (admin prompt) before we kill this process.
        let wakesError;
        try {
          await service.uninstallWakeDaemon();
        } catch (err) {
          wakesError = err.message;
          console.error(`[vos] removing scheduled wakes failed: ${err.message}`);
        }
        res.json({ ok: true, enabled: false, stoppedSelf: before.isSelf, wakesError });
        // bootout terminates this process when it is the supervised one, so
        // it has to happen after the response is on the wire.
        afterResponse(res, async () => {
          try {
            await service.uninstallAgent();
          } catch (err) {
            console.error(`[vos] disabling the service failed: ${err.message}`);
          }
        });
      }
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
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
