// Layout helpers: turn text/lines into a valid rows x columns code grid.
// Apps use these so every screen renders consistently. An app may also return
// a raw code grid for full control (e.g. color-chip art).

import { BLANK, COLORS, charToCode } from '../vestaboard/characters.js';

export function createLayout({ rows = 6, columns = 22 } = {}) {
  const blankRow = () => new Array(columns).fill(BLANK);
  const blankGrid = () => Array.from({ length: rows }, blankRow);

  // Convert a single string into a row of codes, aligned within `columns`.
  function textToRow(text, align = 'left') {
    const chars = [...String(text)].slice(0, columns);
    const codes = chars.map(charToCode);
    const pad = columns - codes.length;
    if (pad <= 0) return codes;
    if (align === 'right') return [...new Array(pad).fill(BLANK), ...codes];
    if (align === 'center') {
      const left = Math.floor(pad / 2);
      return [
        ...new Array(left).fill(BLANK),
        ...codes,
        ...new Array(pad - left).fill(BLANK),
      ];
    }
    return [...codes, ...new Array(pad).fill(BLANK)];
  }

  // Build a full grid from up to `rows` strings.
  // opts: { align, vAlign: 'top'|'middle'|'bottom' }
  function lines(strings, opts = {}) {
    const { align = 'left', vAlign = 'top' } = opts;
    const rowsOut = strings.slice(0, rows).map((s) => textToRow(s ?? '', align));
    const grid = blankGrid();
    const pad = rows - rowsOut.length;
    let start = 0;
    if (vAlign === 'middle') start = Math.floor(pad / 2);
    else if (vAlign === 'bottom') start = pad;
    rowsOut.forEach((row, i) => {
      if (start + i < rows) grid[start + i] = row;
    });
    return grid;
  }

  // Word-wrap a paragraph into <= rows lines of <= columns chars.
  function wrap(text, { maxRows = rows } = {}) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const out = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length <= columns) {
        line = candidate;
      } else {
        if (line) out.push(line);
        // Hard-split any single word longer than a row.
        let w = word;
        while (w.length > columns) {
          out.push(w.slice(0, columns));
          w = w.slice(columns);
        }
        line = w;
      }
      if (out.length >= maxRows) break;
    }
    if (line && out.length < maxRows) out.push(line);
    return out.slice(0, maxRows);
  }

  // Set a whole row to a single color chip. `code` may be a color name or code.
  function colorRow(code) {
    const c = typeof code === 'string' ? COLORS[code] : code;
    return new Array(columns).fill(c ?? BLANK);
  }

  return { rows, columns, blankGrid, textToRow, lines, wrap, colorRow, COLORS };
}
