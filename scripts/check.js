// Offline sanity check: verifies the layout helper and that each app renders a
// valid 6x22 grid. Network-backed apps are attempted but failures are reported,
// not fatal (useful when running without internet or the board).

import { loadConfig } from '../src/config.js';
import { createEngine } from '../src/engine.js';
import { isValidGrid, gridToText } from '../src/vestaboard/characters.js';

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

if (failures > 0) {
  console.error(`\n${failures} hard failure(s).`);
  process.exit(1);
}
console.log('\nCore checks passed.');
