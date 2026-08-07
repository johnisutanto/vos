// Market Wrap app — Yahoo Finance chart quotes (no API key).
import { charToCode } from '../../vestaboard/characters.js';

//
// Yahoo's public chart endpoint returns a `meta` block with the latest price
// and the prior session's close, so we compute a true day-over-day % change
// and color the header green/red by the aggregate direction.

async function fetchQuote(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`;
  // Yahoo blocks requests without a browser-like User-Agent.
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${ticker}`);
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`Yahoo returned no data for ${ticker}`);
  const close = Number(meta.regularMarketPrice);
  const prev = Number(meta.chartPreviousClose);
  if (!Number.isFinite(close) || !Number.isFinite(prev) || prev === 0) {
    throw new Error(`Yahoo gave non-numeric data for ${ticker}`);
  }
  const pct = ((close - prev) / prev) * 100;
  return { close, prev, pct };
}

// Format a price to fit an 8-char cell: no decimals for large index levels,
// fewer decimals as the number grows, so the column stays aligned.
function fmtPrice(n) {
  if (n >= 10000) return String(Math.round(n));
  if (n >= 1000) return n.toFixed(1);
  return n.toFixed(2);
}

// Format an absolute dollar change with a leading sign, scaled to fit a
// 7-char cell (sign + up to 6 chars): "+5.65", "-54.40", "+435.95", "+1234.5".
function fmtChange(delta) {
  const sign = delta >= 0 ? '+' : '-';
  const abs = Math.abs(delta);
  let body;
  if (abs >= 10000) body = String(Math.round(abs));
  else if (abs >= 1000) body = abs.toFixed(1);
  else body = abs.toFixed(2);
  return `${sign}${body}`;
}

// Column spans within the 22-wide row. Symbol sits left; price and change are
// right-aligned into their fields; the up/down color chip owns the last column.
const SYM_END = 5; // symbol occupies cols 0-4
const PRICE_END = 13; // price right-aligned, ending at col 13
const CHANGE_END = 20; // change right-aligned, ending at col 20
const CHIP_COL = 21; // trailing green/red indicator

// Write `text` into a row so its last char lands on column `end` (inclusive).
function placeRight(row, text, end) {
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const col = end - (chars.length - 1 - i);
    if (col >= 0 && col < row.length) row[col] = charToCode(chars[i]);
  }
}

// Human title reflecting the US market session, from the current time in ET.
function sessionTitle(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const weekday = get('weekday');
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const mins = hour * 60 + minute;

  const weekend = weekday === 'Sat' || weekday === 'Sun';
  const OPEN = 9 * 60 + 30; // 9:30 AM ET
  const CLOSE = 16 * 60; // 4:00 PM ET

  if (weekend || mins >= CLOSE) return 'MARKET @ CLOSE';
  if (mins < OPEN) return 'MARKET @ OPEN';
  if (mins < OPEN + 15) return 'MARKET @ OPEN'; // opening snapshot
  // Mid-session: show the current ET clock time, e.g. "MARKET @ 10:00AM".
  const h12 = ((hour + 11) % 12) + 1;
  const ampm = hour < 12 ? 'AM' : 'PM';
  return `MARKET @ ${h12}:${String(minute).padStart(2, '0')}${ampm}`;
}

export async function render({ config, layout, now }) {
  const { tickers, labels } = config;

  // At most four tickers fit below the header + column-label rows.
  const shown = tickers.slice(0, layout.rows - 2);

  // Fetch resiliently — one failed ticker shouldn't blank the whole board.
  const quotes = await Promise.all(
    shown.map(async (t) => {
      try {
        return { t, ...(await fetchQuote(t)) };
      } catch {
        return { t, close: null, prev: null };
      }
    })
  );

  const grid = layout.blankGrid();

  // Row 0: centered session title flanked by direction-colored chips. The chip
  // color aggregates the day: green if more tickers up than down, else red.
  const ups = quotes.filter((q) => q.close !== null && q.close >= q.prev).length;
  const downs = quotes.filter((q) => q.close !== null && q.close < q.prev).length;
  const headChip = ups >= downs ? layout.COLORS.green : layout.COLORS.red;
  grid[0] = layout.textToRow(sessionTitle(now), 'center');
  grid[0][0] = grid[0][1] = headChip;
  grid[0][layout.columns - 1] = grid[0][layout.columns - 2] = headChip;

  // Row 1: column headers, right-aligned over the price and change fields.
  placeRight(grid[1], '$', PRICE_END);
  placeRight(grid[1], '+/-', CHANGE_END);

  // Rows 2..5: one ticker each — SYMBOL, price, dollar change, up/down chip.
  quotes.forEach((q, i) => {
    const row = grid[2 + i];
    const sym = (labels?.[q.t] || q.t).slice(0, SYM_END);
    placeRight(row, sym, sym.length - 1); // left-anchored at col 0

    if (q.close === null) {
      placeRight(row, 'N/A', CHANGE_END);
      row[CHIP_COL] = layout.COLORS.black;
      return;
    }

    placeRight(row, fmtPrice(q.close), PRICE_END);
    placeRight(row, fmtChange(q.close - q.prev), CHANGE_END);
    row[CHIP_COL] = q.close >= q.prev ? layout.COLORS.green : layout.COLORS.red;
  });

  return grid;
}
