// Daily Quote app — fetches a random quote from ZenQuotes (no API key).
// Retries until it gets one that fits the board; falls back to a bundled
// quotes.json (deterministic by day-of-year) if the network is unavailable,
// so the app always renders something.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ZENQUOTES = 'https://zenquotes.io/api/random';
const MAX_TRIES = 6; // ZenQuotes fetches before giving up on a fitting quote

// A quote fits if its wrapped body needs no more rows than we allot for it
// (all rows but the bottom, which holds the attribution) and the author line
// fits a single row.
function fits(quote, layout) {
  const bodyRows = layout.rows - 1;
  const wrapped = layout.wrap(`"${quote.text}"`, { maxRows: layout.rows });
  return wrapped.length <= bodyRows && `- ${quote.author}`.length <= layout.columns;
}

// Common named HTML entities that show up in ZenQuotes text.
const NAMED_ENTITIES = {
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ',
  mdash: '-', ndash: '-', hellip: '...', rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"',
};

// Decode HTML entities (named + numeric like &#13; / &#x27;) and collapse the
// control chars / whitespace they often introduce into single spaces.
function decodeEntities(str) {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ') // fold CR/LF/tabs/runs into single spaces
    .trim();
}

async function fetchRandom() {
  const res = await fetch(ZENQUOTES, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`ZenQuotes ${res.status}`);
  const data = await res.json();
  const item = Array.isArray(data) ? data[0] : null;
  if (!item?.q || !item?.a) throw new Error('ZenQuotes returned no quote');
  return { text: decodeEntities(item.q), author: decodeEntities(item.a) };
}

// Pull random quotes until one fits the board; on any network failure fall
// back to a bundled quote (scanning from the day's index for one that fits).
async function getQuote(now, layout) {
  try {
    let last = null;
    for (let i = 0; i < MAX_TRIES; i++) {
      const quote = await fetchRandom();
      if (fits(quote, layout)) return quote;
      last = quote;
    }
    return last; // none fit within the budget — render the last (will be trimmed)
  } catch {
    const quotes = JSON.parse(await readFile(join(HERE, 'quotes.json'), 'utf8'));
    const start = dayOfYear(now) % quotes.length;
    for (let i = 0; i < quotes.length; i++) {
      const quote = quotes[(start + i) % quotes.length];
      if (fits(quote, layout)) return quote;
    }
    return quotes[start];
  }
}

function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date - start;
  return Math.floor(diff / 86_400_000);
}

export async function render({ layout, now = new Date() }) {
  const quote = await getQuote(now, layout);

  // Body wraps into the top 5 rows; author right-aligned on the last row.
  const body = layout.wrap(`"${quote.text}"`, { maxRows: 5 });
  const grid = layout.lines(body);

  // Place the attribution on the bottom row, right-aligned.
  grid[layout.rows - 1] = layout.textToRow(`- ${quote.author}`, 'right');
  return grid;
}
