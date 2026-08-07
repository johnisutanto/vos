// Vestaboard character-code map and grid helpers.
// Source: https://docs.vestaboard.com/docs/characterCodes
//
// A message is a grid of integer codes. Flagship = 6 rows x 22 columns.
// Codes 0-70 are usable via the Local API (71 "Filled" is not).

export const BLANK = 0;

// Printable character -> code. Text is uppercased before lookup.
export const CHAR_TO_CODE = {
  ' ': 0,
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, I: 9, J: 10,
  K: 11, L: 12, M: 13, N: 14, O: 15, P: 16, Q: 17, R: 18, S: 19, T: 20,
  U: 21, V: 22, W: 23, X: 24, Y: 25, Z: 26,
  1: 27, 2: 28, 3: 29, 4: 30, 5: 31, 6: 32, 7: 33, 8: 34, 9: 35, 0: 36,
  '!': 37, '@': 38, '#': 39, $: 40, '(': 41, ')': 42, '-': 44, '+': 46,
  '&': 47, '=': 48, ';': 49, ':': 50, "'": 52, '"': 53, '%': 54, ',': 55,
  '.': 56, '/': 59, '?': 60, '°': 62,
};

// Named color chips -> code.
export const COLORS = {
  red: 63,
  orange: 64,
  yellow: 65,
  green: 66,
  blue: 67,
  violet: 68,
  white: 69,
  black: 70,
};

// Reverse map (code -> single display char) for the read/preview path.
export const CODE_TO_CHAR = (() => {
  const out = {};
  for (const [ch, code] of Object.entries(CHAR_TO_CODE)) {
    if (out[code] === undefined) out[code] = ch;
  }
  return out;
})();

// Highest code the Local API accepts.
export const MAX_CODE = 70;

// Convert one character to a code. Unsupported chars fall back to `?` (60),
// which is always a visible, valid code — we never silently emit an invalid one.
export function charToCode(ch) {
  const code = CHAR_TO_CODE[ch.toUpperCase?.() ?? ch];
  if (code !== undefined) return code;
  return CHAR_TO_CODE['?'];
}

// Validate a grid is exactly rows x cols of integers in [0, MAX_CODE].
export function isValidGrid(grid, rows, cols) {
  if (!Array.isArray(grid) || grid.length !== rows) return false;
  for (const row of grid) {
    if (!Array.isArray(row) || row.length !== cols) return false;
    for (const code of row) {
      if (!Number.isInteger(code) || code < 0 || code > MAX_CODE) return false;
    }
  }
  return true;
}

// Render a grid of codes back to a printable multi-line string (for logs/CLI).
export function gridToText(grid) {
  return grid
    .map((row) => row.map((code) => CODE_TO_CHAR[code] ?? '?').join(''))
    .join('\n');
}

// 24-bit ANSI background colors approximating each Vestaboard color chip,
// for a colored terminal preview.
const COLOR_RGB = {
  63: [231, 41, 33], // red
  64: [235, 116, 30], // orange
  65: [239, 193, 30], // yellow
  66: [42, 155, 82], // green
  67: [43, 106, 191], // blue
  68: [124, 74, 168], // violet
  69: [230, 230, 230], // white
  70: [26, 26, 26], // black
};

// Render a grid to a colorized string using ANSI blocks for color chips and
// bright cells for letters, so the terminal preview resembles the board.
// Falls back to plain text when the stream isn't a TTY (e.g. piped/CI).
export function gridToAnsi(grid, { color = true } = {}) {
  if (!color) return gridToText(grid);
  const reset = '\x1b[0m';
  return grid
    .map((row) =>
      row
        .map((code) => {
          const rgb = COLOR_RGB[code];
          if (rgb) {
            // Two spaces on a colored background => a chunky square tile.
            return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m  ${reset}`;
          }
          const ch = CODE_TO_CHAR[code] ?? '?';
          // Letters/blanks: dim background, char centered in a 2-wide cell.
          return `\x1b[48;2;20;24;32m\x1b[97m${ch === ' ' ? ' ' : ch} ${reset}`;
        })
        .join('')
    )
    .join('\n');
}
