// Offline sanity check: verifies the layout helper and that each app renders a
// valid 6x22 grid. Network-backed apps are attempted but failures are reported,
// not fatal (useful when running without internet or the board).

import { loadConfig } from '../src/config.js';
import { createEngine } from '../src/engine.js';
import { isValidGrid, gridToText } from '../src/vestaboard/characters.js';
import { parseDailyCron, planWakes, formatPmsetDate, mostRecentlyDue, slotToCron, formatDailyCron } from '../src/service/cron-slots.js';
import { parsePmsetSched, OWNER } from '../src/service/pmset-wakes.js';
import { moonInfo } from '../src/apps/evening/index.js';
import { entryFits } from '../src/apps/word/index.js';
import { readFile } from 'node:fs/promises';

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

  const daily = slotToCron({ time: '08:00', days: 'everyday', app: 'weather' });
  const weekdays = slotToCron({ time: '14:00', days: 'weekdays', app: 'market' });
  const weekends = slotToCron({ time: '09:30', days: 'weekends', app: 'quote' });
  if (daily !== '0 8 * * *' || weekdays !== '0 14 * * 1-5' || weekends !== '30 9 * * 0,6') {
    console.error('FAIL: slotToCron', { daily, weekdays, weekends });
    failures++;
  } else if (formatDailyCron(parseDailyCron(daily)) !== daily) {
    console.error('FAIL: formatDailyCron round-trip', daily);
    failures++;
  } else {
    console.log('OK: slotToCron everyday/weekdays/weekends');
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

  const noonThu = new Date(2026, 7, 13, 12, 0, 0);
  const dueNoon = mostRecentlyDue([
    { cron: '0 8 * * *', app: 'weather' },
    { cron: '0 14 * * 1-5', app: 'market' },
  ], noonThu);
  if (dueNoon?.app !== 'weather' || dueNoon.at.getHours() !== 8) {
    console.error('FAIL: mostRecentlyDue at Thursday noon should be weather 08:00', dueNoon);
    failures++;
  } else {
    console.log('OK: mostRecentlyDue Thursday 12:00 -> weather 08:00');
  }
  const dueAfternoon = mostRecentlyDue([
    { cron: '0 8 * * *', app: 'weather' },
    { cron: '0 14 * * 1-5', app: 'market' },
  ], new Date(2026, 7, 13, 15, 0, 0));
  if (dueAfternoon?.app !== 'market') {
    console.error('FAIL: mostRecentlyDue at Thursday 15:00 should be market', dueAfternoon);
    failures++;
  } else {
    console.log('OK: mostRecentlyDue Thursday 15:00 -> market');
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

{
  const newMoon = new Date(Date.UTC(2000, 0, 6, 18, 14, 0));
  const atNew = moonInfo(newMoon);
  const atFull = moonInfo(new Date(newMoon.getTime() + 14.765 * 86400000));
  if (atNew.phase !== 'NEW' || atNew.illum > 5) {
    console.error('FAIL: moonInfo at known new moon', atNew);
    failures++;
  } else if (atFull.phase !== 'FULL' || atFull.illum < 95) {
    console.error('FAIL: moonInfo at known full moon', atFull);
    failures++;
  } else {
    console.log(`OK: moonInfo NEW ${atNew.illum}% / FULL ${atFull.illum}%`);
  }
}

{
  const words = JSON.parse(await readFile(new URL('../src/apps/word/words.json', import.meta.url)));
  const bad = words.filter((w) => !entryFits(w, engine.layout));
  if (bad.length) {
    console.error('FAIL: word-of-the-day entries do not fit 6x22', bad.map((w) => w.word));
    failures++;
  } else {
    console.log(`OK: ${words.length} word-of-the-day entries fit the board`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} hard failure(s).`);
  process.exit(1);
}
console.log('\nCore checks passed.');
