#!/usr/bin/env node
// Vestaboard OS entrypoint.
//
// Commands:
//   (none) | serve   Start scheduler + admin website (default).
//   enable           Exchange the enablement token for a persistent API key.
//   push <app>       Render an app and write it to the board once, then exit.
//   preview <app>    Render an app and print it to the terminal (no write).
//   capture <name>   Read the board's current content and save it as gallery art.
//   service <cmd>    Manage the background launchd agent (status|install|uninstall|restart|diagnose).

import { loadConfig } from './config.js';
import { createEngine } from './engine.js';
import { Scheduler } from './scheduler/scheduler.js';
import { createServer } from './web/server.js';
import { VestaboardClient } from './vestaboard/client.js';
import { gridToText, gridToAnsi } from './vestaboard/characters.js';
import { captureCurrentBoard } from './apps/gallery/store.js';

const [command, arg] = process.argv.slice(2);

const cfg = await loadConfig();

switch (command) {
  case 'enable':
    await enable();
    break;
  case 'push':
    await once(arg, true);
    break;
  case 'preview':
    await once(arg, false);
    break;
  case 'capture':
    await capture(arg);
    break;
  case 'service':
    await serviceCmd(arg);
    break;
  case undefined:
  case 'serve':
    await serve();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}

async function enable() {
  const token = cfg.env.enablementToken;
  if (!token) {
    console.error('Set VESTABOARD_ENABLEMENT_TOKEN in .env first (from vestaboard.com/local-api).');
    process.exit(1);
  }
  const client = new VestaboardClient({ host: cfg.env.host });
  const apiKey = await client.enable(token);
  console.log('\nLocal API enabled. Add this to your .env:\n');
  console.log(`VESTABOARD_LOCAL_API_KEY=${apiKey}\n`);
}

async function once(appId, write) {
  if (!appId) {
    console.error('Usage: vos ' + (write ? 'push' : 'preview') + ' <app>');
    process.exit(1);
  }
  const engine = await createEngine(cfg);
  const grid = await engine.renderApp(appId);
  console.log(`\n${appId}:\n`);
  console.log(gridToAnsi(grid, { color: process.stdout.isTTY }));
  console.log('');
  if (write) {
    await engine.writeGrid(grid);
    console.log('Written to board.');
  }
}

async function capture(name) {
  if (!name) {
    console.error('Usage: vos capture <name>   (saves the board\'s current content as gallery art)');
    process.exit(1);
  }
  const client = new VestaboardClient({
    host: cfg.env.host,
    apiKey: cfg.env.apiKey,
    rows: cfg.board.rows,
    columns: cfg.board.columns,
  });
  const { name: saved, file } = await captureCurrentBoard(client, name, cfg.board);
  console.log(`Saved current board as "${saved}" -> ${file}`);
}

async function serviceCmd(action) {
  const service = await import('./service/launchd.js');
  const wakes = await import('./service/pmset-wakes.js');

  if (action === 'wakes') {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      await wakes.refreshWakes(cfg);
    } else {
      const plan = await wakes.planned(cfg);
      console.log(`Wake plan: ${plan.events.length} event(s), ${plan.leadMinutes} min before each slot, next ${plan.days ?? 14} days.`);
      for (const ev of plan.events.slice(0, 8)) {
        console.log(`  ${ev.key}  (before ${ev.app} at ${ev.slot.toTimeString().slice(0, 5)})`);
      }
      if (plan.events.length > 8) console.log(`  … ${plan.events.length - 8} more`);
      if (plan.skipped.length) {
        console.warn(`Skipped ${plan.skipped.length} cron(s) that are not a simple daily time.`);
      }
    }
    return;
  }
  if (action === 'wakes-cancel') {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
      console.error('wakes-cancel must run as root (used by service uninstall).');
      process.exit(1);
    }
    await wakes.cancelOurWakes();
    console.log('Cancelled vos-tagged pmset wake events.');
    return;
  }

  if (!service.supported) {
    console.error(`Background service requires macOS (launchd); this is ${process.platform}.`);
    process.exit(1);
  }

  const describe = (s) => {
    if (!s.installed && !s.loaded) return 'disabled (not installed)';
    if (s.running) return `enabled, running (pid ${s.pid})`;
    if (s.loaded) return 'enabled, loaded but not running — check the logs';
    return 'installed but not loaded — run `vos service install`';
  };

  switch (action) {
    case 'diagnose': {
      const { diagnose } = await import('./service/diagnose.js');
      console.log(await diagnose(cfg));
      break;
    }
    case 'status': {
      const s = await service.status();
      console.log(`vos background service: ${describe(s)}`);
      console.log(`  label: ${s.label}`);
      console.log(`  plist: ${s.plistPath}`);
      console.log(`  logs:  ${s.logDir}`);
      if (s.wakes?.error) {
        console.log(`  wakes: error — ${s.wakes.error}`);
      } else if (s.wakes?.installed) {
        console.log(`  wakes: ${s.wakes.count} scheduled, ${s.wakes.leadMinutes} min lead, next ${s.wakes.next || '(none yet)'}`);
      } else {
        console.log('  wakes: not installed (macOS will ask for admin when you enable)');
      }
      break;
    }
    case 'restart': {
      const s = await service.restart();
      console.log(`Restarted. Status: ${describe(s)}`);
      console.log('User agent now wraps caffeinate -i -s (no idle sleep on AC). No admin prompt.');
      break;
    }
    case 'install':
    case 'enable': {
      const s = await service.install();
      console.log(`Installed and started. Status: ${describe(s)}`);
      console.log(`Admin site: http://localhost:${cfg.env.port}`);
      if (s.wakes?.installed) {
        console.log(`Scheduled wakes: ${s.wakes.count} event(s), ${s.wakes.leadMinutes} min before each slot.`);
      }
      break;
    }
    case 'uninstall':
    case 'disable': {
      await service.uninstall();
      console.log('Stopped the background service and removed scheduled wakes.');
      break;
    }
    default:
      console.error('Usage: vos service <status|install|uninstall|restart|diagnose>');
      process.exit(1);
  }
}

async function serve() {
  if (cfg.usedExample) {
    console.warn('[vos] No config/config.yaml found — using config.example.yaml.');
  }
  const engine = await createEngine(cfg);
  const scheduler = new Scheduler(engine, {
    schedule: cfg.schedule,
    keepOnError: cfg.options.keepOnError,
  });
  await scheduler.start();

  const app = createServer({ engine, scheduler, cfg });
  const server = app.listen(cfg.env.port, () => {
    console.log(`[vos] admin site: http://localhost:${cfg.env.port}`);
    if (!cfg.env.apiKey) {
      console.warn('[vos] No VESTABOARD_LOCAL_API_KEY set — previews work, writes will fail.');
    }
  });
  // The service toggle needs to release this socket before handing the port
  // to the launchd-supervised copy.
  app.locals.httpServer = server;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[vos] port ${cfg.env.port} is already in use.`);
      console.error('[vos] the background service may already be running — check `vos service status`.');
      process.exit(1);
    }
    throw err;
  });
}
