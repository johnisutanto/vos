// Admin UI logic: fetch schedule + apps, render split-flap previews, push.

// Code -> display char, mirroring src/vestaboard/characters.js for the preview.
const CODE_TO_CHAR = (() => {
  const map = { 0: ' ' };
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  letters.split('').forEach((ch, i) => { map[i + 1] = ch; });
  const digits = '1234567890';
  digits.split('').forEach((ch, i) => { map[27 + i] = ch; });
  Object.assign(map, {
    37: '!', 38: '@', 39: '#', 40: '$', 41: '(', 42: ')', 44: '-', 46: '+',
    47: '&', 48: '=', 49: ';', 50: ':', 52: "'", 53: '"', 54: '%', 55: ',',
    56: '.', 59: '/', 60: '?', 62: '°',
  });
  return map;
})();

const COLOR_CODES = new Set([63, 64, 65, 66, 67, 68, 69, 70]);

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// Build a split-flap grid element from a 2D array of codes.
function renderBoard(grid) {
  const board = document.createElement('div');
  board.className = 'board';
  const cols = grid[0]?.length || 22;
  board.style.gridTemplateColumns = `repeat(${cols}, 20px)`;
  for (const row of grid) {
    for (const code of row) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      if (COLOR_CODES.has(code)) {
        tile.classList.add('c' + code);
      } else {
        tile.textContent = CODE_TO_CHAR[code] ?? '';
      }
      board.appendChild(tile);
    }
  }
  return board;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Render a day-of-week cron field ("*", "1-5", "0,6", "3") as a short label,
// or '' for "every day". Returns null if we can't make sense of it.
function fmtDow(field) {
  if (field === '*') return '';
  if (field === '1-5') return 'Mon–Fri';
  if (field === '0,6' || field === '6,0') return 'Sat/Sun';
  const nums = field.split(',');
  if (nums.every((n) => /^\d$/.test(n))) {
    return nums.map((n) => DOW[Number(n)]).join(', ');
  }
  return null; // unrecognized (e.g. step/range we don't special-case)
}

function fmtCron(cron) {
  // "m h * * <dow>" -> "HH:MM" (+ weekday label); else show raw.
  const parts = cron.split(/\s+/);
  if (parts.length === 5 && parts[2] === '*' && parts[3] === '*') {
    const [m, h, , , dow] = parts;
    const dowLabel = fmtDow(dow);
    if (/^\d+$/.test(m) && /^\d+$/.test(h) && dowLabel !== null) {
      const time = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
      return dowLabel ? `${time} (${dowLabel})` : time;
    }
  }
  return cron;
}

async function loadStatus(apps) {
  const sched = await api('/api/schedule');
  const byId = Object.fromEntries(apps.map((a) => [a.id, a]));

  const status = document.getElementById('status');
  const keyState = sched.hasApiKey
    ? '<span class="ok">API key set</span>'
    : '<span class="bad">no API key (previews only)</span>';
  const last = sched.lastRun
    ? ` · last: ${sched.lastRun.app} ${sched.lastRun.ok ? '<span class="ok">ok</span>' : '<span class="bad">failed</span>'}`
    : '';
  status.innerHTML = `${sched.host} · ${keyState}${last}`;

  const timeline = document.getElementById('timeline');
  timeline.innerHTML = '';
  const sorted = [...sched.schedule].sort((a, b) => fmtCron(a.cron).localeCompare(fmtCron(b.cron)));
  for (const slot of sorted) {
    const app = byId[slot.app] || { name: slot.app, description: '(app not found)' };
    const el = document.createElement('div');
    el.className = 'slot';
    el.innerHTML = `<div class="time">${fmtCron(slot.cron)}</div>
      <div><div class="name">${app.name}</div><div class="desc">${app.description}</div></div>`;
    timeline.appendChild(el);
  }
}

async function loadApps() {
  const apps = await api('/api/apps');
  const container = document.getElementById('apps');
  container.innerHTML = '';

  for (const app of apps) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h3>${app.name}</h3><p class="desc">${app.description}</p>`;

    const preview = document.createElement('div');
    preview.textContent = 'Loading preview…';
    card.appendChild(preview);

    const msg = document.createElement('div');
    msg.className = 'msg';

    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    const previewBtn = document.createElement('button');
    previewBtn.className = 'secondary';
    previewBtn.textContent = 'Refresh';
    const pushBtn = document.createElement('button');
    pushBtn.textContent = 'Push now';
    rowEl.append(previewBtn, pushBtn);

    async function refresh() {
      preview.textContent = 'Loading preview…';
      msg.textContent = '';
      try {
        const { grid } = await api(`/api/apps/${app.id}/preview`);
        preview.replaceChildren(renderBoard(grid));
      } catch (err) {
        preview.textContent = '';
        msg.className = 'msg bad';
        msg.textContent = err.message;
      }
    }

    previewBtn.onclick = refresh;
    pushBtn.onclick = async () => {
      msg.className = 'msg';
      msg.textContent = 'Pushing…';
      try {
        await api(`/api/apps/${app.id}/push`, { method: 'POST' });
        msg.className = 'msg ok';
        msg.textContent = 'Pushed to board.';
      } catch (err) {
        msg.className = 'msg bad';
        msg.textContent = err.message;
      }
    };

    card.append(rowEl, msg);
    container.appendChild(card);
    refresh();
  }

  return apps;
}

function wireCapture() {
  const btn = document.getElementById('capture-btn');
  const input = document.getElementById('capture-name');
  const msg = document.getElementById('capture-msg');
  if (!btn) return;
  btn.onclick = async () => {
    const name = input.value.trim();
    if (!name) {
      msg.className = 'msg bad';
      msg.textContent = 'Enter a name first.';
      return;
    }
    msg.className = 'msg';
    msg.textContent = 'Reading board…';
    try {
      const { name: saved } = await api('/api/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      msg.className = 'msg ok';
      msg.textContent = `Saved "${saved}" to the gallery.`;
      input.value = '';
      // Refresh app cards so the gallery preview reflects the new art.
      loadApps();
    } catch (err) {
      msg.className = 'msg bad';
      msg.textContent = err.message;
    }
  };
}

(async () => {
  try {
    wireCapture();
    const apps = await loadApps();
    await loadStatus(apps);
  } catch (err) {
    document.getElementById('status').innerHTML = `<span class="bad">${err.message}</span>`;
  }
})();
