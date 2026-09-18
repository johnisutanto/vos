// Word of the Day — an uncommon English word plus a short definition.
// Uses a bundled list (no API key). The pick is stable for a calendar day so
// catch-up and preview show the same board. Every entry is written to fit
// 6x22: the word on row 1, framed by a yellow chip on each end, and the
// definition wrapped into the five rows below.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORDS_FILE = join(HERE, 'words.json');

let cached;

async function loadWords() {
  if (!cached) cached = JSON.parse(await readFile(WORDS_FILE, 'utf8'));
  return cached;
}

function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date - start) / 86_400_000);
}

// Full wrap (not truncated) must fit under the word row. The word sits
// between a color chip on each end, so it can use at most columns - 2.
export function entryFits(entry, layout) {
  const word = String(entry?.word || '').trim();
  const def = String(entry?.def || '').trim();
  if (!word || !def) return false;
  if (word.length > layout.columns - 2) return false;
  const full = layout.wrap(def, { maxRows: 99 });
  return full.length <= layout.rows - 1;
}

export async function pickEntry(now, layout) {
  const words = await loadWords();
  if (!words.length) throw new Error('Word list is empty');
  const start = dayOfYear(now) % words.length;
  for (let i = 0; i < words.length; i++) {
    const entry = words[(start + i) % words.length];
    if (entryFits(entry, layout)) return entry;
  }
  return words[start];
}

function framedWordRow(word, layout) {
  const inner = layout.columns - 2;
  const row = layout.textToRow(String(word).slice(0, inner), 'center');
  row[0] = layout.COLORS.yellow;
  row[layout.columns - 1] = layout.COLORS.yellow;
  return row;
}

export async function render({ layout, now = new Date() }) {
  const entry = await pickEntry(now, layout);
  const body = layout.wrap(entry.def, { maxRows: layout.rows - 1 });
  const grid = layout.blankGrid();
  grid[0] = framedWordRow(entry.word, layout);
  body.forEach((line, i) => {
    grid[i + 1] = layout.textToRow(line, 'left');
  });
  return grid;
}
