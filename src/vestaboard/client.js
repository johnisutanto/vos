// Thin client for the Vestaboard Local API.
// Docs: https://docs.vestaboard.com/docs/local-api/endpoints
//
//   Enablement (one-time): POST /local-api/enablement
//     header X-Vestaboard-Local-Api-Enablement-Token -> { apiKey }
//   Write:  POST /local-api/message  (body: rows x cols code grid)
//   Read:   GET  /local-api/message  -> current code grid
//   All read/write calls use header X-Vestaboard-Local-Api-Key.

import { isValidGrid } from './characters.js';

const PORT = 7000;

// A single write can hit a transient network blip (the board briefly
// unreachable over TCP). Retry a couple of times with a short escalating
// delay so one hiccup doesn't drop the whole scheduled push until the next
// cron fire — which, for weekday-only apps, could be a full day away.
const WRITE_RETRIES = 3;
const WRITE_BACKOFF_MS = [1000, 3000]; // delay before attempt 2, then 3

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class VestaboardClient {
  constructor({ host = 'vestaboard.local', apiKey, rows = 6, columns = 22 } = {}) {
    this.baseUrl = `http://${host}:${PORT}/local-api`;
    this.apiKey = apiKey;
    this.rows = rows;
    this.columns = columns;
  }

  // One-time: exchange the emailed enablement token for a persistent API key.
  async enable(enablementToken) {
    const res = await fetch(`${this.baseUrl}/enablement`, {
      method: 'POST',
      headers: {
        'X-Vestaboard-Local-Api-Enablement-Token': enablementToken,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`Enablement failed: ${res.status} ${await safeText(res)}`);
    }
    const data = await res.json();
    if (!data.apiKey) throw new Error('Enablement response had no apiKey');
    this.apiKey = data.apiKey;
    return data.apiKey;
  }

  // Read the grid currently on the board.
  async read() {
    this.#requireKey();
    const res = await fetch(`${this.baseUrl}/message`, {
      method: 'GET',
      headers: this.#authHeaders(),
    });
    if (!res.ok) throw new Error(`Read failed: ${res.status} ${await safeText(res)}`);
    const data = await res.json();
    // The board returns either a bare grid or an object wrapping one.
    return Array.isArray(data) ? data : data.message ?? data.currentMessage ?? data;
  }

  // Write a rows x columns grid of character codes to the board.
  //
  // Only the network POST is retried: a bad grid or a rejected API key won't
  // fix itself on a second try, so those throw immediately. A transient
  // `fetch failed` (board briefly unreachable) is retried with backoff.
  async write(grid) {
    this.#requireKey();
    if (!isValidGrid(grid, this.rows, this.columns)) {
      throw new Error(`Refusing to write: grid is not a valid ${this.rows}x${this.columns} code grid`);
    }

    let lastErr;
    for (let attempt = 1; attempt <= WRITE_RETRIES; attempt++) {
      let res;
      try {
        res = await fetch(`${this.baseUrl}/message`, {
          method: 'POST',
          headers: this.#authHeaders(),
          body: JSON.stringify(grid),
        });
      } catch (err) {
        // Network-level failure (connection refused/reset/timeout) — retryable.
        lastErr = err;
        const delay = WRITE_BACKOFF_MS[attempt - 1];
        if (delay !== undefined) {
          console.warn(`[vestaboard] write attempt ${attempt} failed (${err.message}); retrying in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        break;
      }

      // The board can return 2xx with a plain-text error body (e.g. "Invalid
      // API key" comes back as 201), so status alone isn't a reliable success
      // signal. An auth/validation rejection is not retryable — fail fast.
      const body = await safeText(res);
      if (!res.ok || /invalid api key/i.test(body)) {
        throw new Error(`Write failed: ${res.status} ${body}`);
      }
      try {
        return JSON.parse(body);
      } catch {
        return {};
      }
    }

    throw new Error(`Write failed after ${WRITE_RETRIES} attempts: ${lastErr?.message ?? 'unknown error'}`);
  }

  #authHeaders() {
    return {
      'X-Vestaboard-Local-Api-Key': this.apiKey,
      'Content-Type': 'application/json',
    };
  }

  #requireKey() {
    if (!this.apiKey) {
      throw new Error('No API key set. Run `npm run enable` or set VESTABOARD_LOCAL_API_KEY.');
    }
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
