// Currency Exchange app — USD rates via open.er-api.com (no API key).
//
// The free endpoint returns a `rates` map keyed by currency code, refreshed
// daily. The header names the base, then one row per target: "EUR    0.8782".

const API = 'https://open.er-api.com/v6/latest';

// Format a rate to fit the value column: fewer decimals as the number grows
// (JPY/IDR are large, EUR/AUD are ~1), so the column stays readable.
function fmtRate(n) {
  if (n >= 1000) return Math.round(n).toLocaleString('en-US'); // e.g. 17,944
  if (n >= 100) return n.toFixed(1);
  return n.toFixed(4);
}

export async function render({ config, layout }) {
  const { base = 'USD', targets = [] } = config;

  const res = await fetch(`${API}/${encodeURIComponent(base)}`);
  if (!res.ok) throw new Error(`er-api ${res.status}`);
  const data = await res.json();
  if (data?.result !== 'success' || !data.rates) {
    throw new Error('er-api returned no rates');
  }

  const grid = layout.blankGrid();
  grid[0] = layout.textToRow(`${base} EXCHANGE`, 'center');

  // One currency per row below the header; code left, rate right-aligned.
  targets.slice(0, layout.rows - 1).forEach((code, i) => {
    const rate = Number(data.rates[code]);
    const value = Number.isFinite(rate) ? fmtRate(rate) : 'N/A';
    const left = layout.textToRow(code, 'left');
    const right = layout.textToRow(value, 'right');
    // Merge: keep the code on the left, the value on the right of the same row.
    grid[1 + i] = left.map((cell, col) => (right[col] !== 0 ? right[col] : cell));
  });

  return grid;
}
