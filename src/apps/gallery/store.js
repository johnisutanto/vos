// Shared helper for saving the board's current content as a gallery design.
// Used by both the `vos capture` CLI command and the admin "Save current
// board" button so there's a single source of truth.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isValidGrid } from '../../vestaboard/characters.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ART_DIR = join(HERE, 'art');

// Turn an arbitrary name into a safe, lowercase file slug.
function slugify(name) {
  const slug = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'art';
}

// Read the current board via the client and persist it as art/<slug>.json.
// Returns { name, slug, file }.
export async function captureCurrentBoard(client, name, { rows = 6, columns = 22 } = {}) {
  const grid = await client.read();
  if (!isValidGrid(grid, rows, columns)) {
    throw new Error(`Board returned an invalid ${rows}x${columns} grid; nothing saved`);
  }
  const slug = slugify(name);
  await mkdir(ART_DIR, { recursive: true });
  const file = join(ART_DIR, `${slug}.json`);
  await writeFile(file, `${JSON.stringify({ name: String(name).trim() || slug, grid }, null, 2)}\n`);
  return { name: String(name).trim() || slug, slug, file };
}
