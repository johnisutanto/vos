// On This Day app — a historical event for today's date via the OnThisDay API
// (today.zenquotes.io, no API key). The endpoint returns many events under
// data.Events; we pick one whose text fits the board rather than truncating.
//
// Each event text looks like "1969 – Apollo 11 lands on the Moon." — a year, an
// en dash, then the description. We split the year into a header row and wrap
// the description below it.

const API = 'https://today.zenquotes.io/api';

// Named HTML entities that show up in the event descriptions.
const NAMED_ENTITIES = {
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ',
  mdash: '-', ndash: '-', hellip: '...', rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"',
};

// Decode HTML entities (named + numeric) and normalize the unicode dashes and
// smart quotes the board can't render into plain ASCII, then fold whitespace.
function normalize(str) {
  return String(str)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[‒-―]/g, '-') // figure/en/em/horizontal-bar dashes -> hyphen
    .replace(/[‘’′]/g, "'") // smart single quotes / prime
    .replace(/[“”″]/g, '"') // smart double quotes / double prime
    .replace(/[…]/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

// Split "1969 - description" into { year, text }. If there's no leading year we
// fall back to the whole string as the body with no header year.
function splitEvent(raw) {
  const m = raw.match(/^\s*(\d{1,4})\s*-\s*(.*)$/);
  if (m) return { year: m[1], text: m[2].trim() };
  return { year: null, text: raw };
}

// An event fits if the header (year) plus the wrapped description need no more
// than the board's rows.
function fits(event, layout) {
  const headerRows = event.year ? 1 : 0;
  const wrapped = layout.wrap(event.text, { maxRows: layout.rows });
  return wrapped.length <= layout.rows - headerRows;
}

export async function render({ layout, now = new Date() }) {
  const month = now.getMonth() + 1;
  const date = now.getDate();

  const res = await fetch(`${API}/${month}/${date}`);
  if (!res.ok) throw new Error(`OnThisDay ${res.status}`);
  const data = await res.json();

  const events = (data?.data?.Events ?? [])
    .map((e) => e?.text)
    .filter(Boolean)
    .map((t) => splitEvent(normalize(t)));
  if (!events.length) throw new Error('OnThisDay returned no events');

  // First event that fits the board; else fall back to the first (trimmed).
  const event = events.find((e) => fits(e, layout)) || events[0];

  const header = `ON THIS DAY${event.year ? ` ${event.year}` : ''}`;
  const body = layout.wrap(event.text, { maxRows: layout.rows - 1 });
  return layout.lines([header, ...body]);
}
