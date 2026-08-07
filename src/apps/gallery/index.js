// Art Gallery app — randomly displays one of your saved Vestaboard designs.
//
// Designs live as JSON files in ./art/, each: { "name": "...", "grid": [[...],...] }.
// Capture them from the board with `vos capture <name>` or the admin
// "Save current board" button (both read the board's current content).
//
// Picks a random design each run, avoiding an immediate repeat. The
// last-shown name is persisted to ./.last so the no-repeat rule holds across
// separate `vos push` invocations, not just within one running process.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ART_DIR = join(HERE, 'art');
const LAST_FILE = join(HERE, '.last');

async function loadDesigns() {
  if (!existsSync(ART_DIR)) return [];
  const files = (await readdir(ART_DIR)).filter((f) => f.endsWith('.json'));
  const designs = [];
  for (const f of files) {
    try {
      const data = JSON.parse(await readFile(join(ART_DIR, f), 'utf8'));
      if (Array.isArray(data.grid)) {
        designs.push({ name: data.name || f.replace(/\.json$/, ''), grid: data.grid });
      }
    } catch {
      // Skip unreadable/malformed files rather than blanking the board.
    }
  }
  return designs;
}

async function readLast() {
  try {
    return (await readFile(LAST_FILE, 'utf8')).trim();
  } catch {
    return null;
  }
}

export async function render({ layout }) {
  const designs = await loadDesigns();
  if (designs.length === 0) {
    return layout.lines(['ART GALLERY', '', 'NO ART SAVED YET', 'USE VOS CAPTURE'], {
      align: 'center',
      vAlign: 'middle',
    });
  }

  // Avoid repeating the previous pick when we have more than one design.
  const last = await readLast();
  const pool = designs.length > 1 ? designs.filter((d) => d.name !== last) : designs;
  const pick = pool[Math.floor(Math.random() * pool.length)];

  await writeFile(LAST_FILE, pick.name, 'utf8').catch(() => {});
  return pick.grid;
}
