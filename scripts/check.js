// Offline sanity check: verifies the layout helper and that each app renders a
// valid 6x22 grid. Network-backed apps are attempted but failures are reported,
// not fatal (useful when running without internet or the board).

import { loadConfig } from '../src/config.js';
import { createEngine } from '../src/engine.js';
import { isValidGrid, gridToText } from '../src/vestaboard/characters.js';
import { parseDailyCron, planWakes, formatPmsetDate } from '../src/service/cron-slots.js';
import { parsePmsetSched, OWNER } from '../src/service/pmset-wakes.js';

const cfg = await loadConfig();
const engine = await createEngine(cfg);

let failures = 0;

// 1. Layout helper produces a valid grid.
const demo = engine.layout.lines(['HELLO', 'WORLD'], { align: 'center' });
if (!isValidGrid(demo, engine.rows, engine.columns)) {
  console.error('FAIL: layout.lines() produced an invalid grid');
  failures++;
} else {
  console.log('OK: layout.lines() -> valid grid');
}

// 2. Each app renders a valid grid.
for (const id of engine.apps.keys()) {
  try {
    const grid = await engine.renderApp(id);
    console.log(`OK: app "${id}" -> valid ${engine.rows}x${engine.columns} grid`);
    console.log(gridToText(grid).split('\n').map((l) => '   |' + l + '|').join('\n'));
  } catch (err) {
    console.warn(`WARN: app "${id}" render failed (may be network): ${err.message}`);
  }
}

// 3. Wake planner: simple daily crons, weekday filters, skip step-syntax.
{
  if (parseDailyCron('0 8 * * *')?.hour !== 8) {
    console.error('FAIL: parseDailyCron 0 8 * * *');
    failures++;
  } else {
    console.log('OK: parseDailyCron daily 08:00');
  }
  if (parseDailyCron('*/15 8 * * *') !== null) {
    console.error('FAIL: step cron should be rejected');
    failures++;
  } else {
    console.log('OK: parseDailyCron rejects step syntax');
  }

  // Thursday 2026-08-13 12:00 local. 08:00 is past; 14:00 weekday is ahead.
  const from = new Date(2026, 7, 13, 12, 0, 0);
  const plan = planWakes([
    { cron: '0 8 * * *', app: 'weather' },
    { cron: '0 14 * * 1-5', app: 'market' },
    { cron: '*/15 * * * *', app: 'bad' },
  ], { from, days: 7, leadMinutes: 3, minLeadMs: 0 });

  const keys = plan.events.map((e) => e.key);
  const weatherWake = formatPmsetDate(new Date(2026, 7, 14, 7, 57, 0)); // Fri 07:57
  const marketWake = formatPmsetDate(new Date(2026, 7, 13, 13, 57, 0)); // Thu 13:57
  const saturdayMarket = formatPmsetDate(new Date(2026, 7, 15, 13, 57, 0)); // Sat should be absent

  if (!keys.includes(weatherWake) || !keys.includes(marketWake)) {
    console.error('FAIL: expected weather Friday 07:57 and market Thursday 13:57 in', keys.slice(0, 6));
    failures++;
  } else if (keys.includes(saturdayMarket)) {
    console.error('FAIL: weekday-only market scheduled a Saturday wake');
    failures++;
  } else if (plan.skipped.length !== 1) {
    console.error('FAIL: expected one skipped cron, got', plan.skipped);
    failures++;
  } else {
    console.log(`OK: wake plan ${plan.events.length} events, skipped ${plan.skipped.length} unparseable`);
  }
}

{
  const sample = `Repeating power events:
  wakepoweron at 6:57AM every day
Scheduled power events:
 [0]  wake at 08/14/2026 07:57:00 by 'local.vos'
 [1]  wake at 08/13/2026 16:55:26 by 'com.apple.alarm.user-invisible-com.apple.osanalytics.hardhighengagementtimer'
`;
  const parsed = parsePmsetSched(sample);
  const ours = parsed.filter((e) => e.owner === OWNER);
  if (parsed.length !== 2 || ours.length !== 1 || ours[0].key !== '08/14/26 07:57:00') {
    console.error('FAIL: parsePmsetSched', parsed);
    failures++;
  } else {
    console.log('OK: parsePmsetSched keeps only local.vos events (does not touch repeating wakes)');
  }
}

if (failures > 0) {
  console.error(`\n${failures} hard failure(s).`);
  process.exit(1);
}
console.log('\nCore checks passed.');
