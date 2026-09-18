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
  const paused = sched.paused
    ? ' · <span class="bad">schedule paused</span>'
    : '';
  const last = sched.lastRun
    ? ` · last: ${sched.lastRun.app} ${sched.lastRun.ok ? '<span class="ok">ok</span>' : '<span class="bad">failed</span>'}`
    : '';
  status.innerHTML = `${sched.host} · ${keyState}${paused}${last}`;

  const timeline = document.getElementById('timeline');
  timeline.innerHTML = '';
  timeline.classList.toggle('paused', Boolean(sched.paused));
  const sorted = [...sched.schedule].sort((a, b) => fmtCron(a.cron).localeCompare(fmtCron(b.cron)));
  for (const slot of sorted) {
    const app = byId[slot.app] || { name: slot.app, description: '(app not found)' };
    const el = document.createElement('div');
    el.className = 'slot';
    el.innerHTML = `<div class="time">${fmtCron(slot.cron)}</div>
      <div><div class="name">${app.name}</div><div class="desc">${app.description}</div></div>`;
    timeline.appendChild(el);
  }

  renderAutomation(sched.paused);
}

function renderAutomation(paused) {
  const toggle = document.getElementById('automation-toggle');
  const state = document.getElementById('automation-state');
  const detail = document.getElementById('automation-detail');
  if (!toggle) return;
  toggle.checked = !paused;
  toggle.disabled = false;
  state.textContent = paused ? 'Paused' : 'Running';
  detail.textContent = paused
    ? 'Timed slots will not write. Push now and the admin site still work.'
    : 'Slots write to the board on schedule.';
}

function wireAutomation() {
  const toggle = document.getElementById('automation-toggle');
  const msg = document.getElementById('automation-msg');
  if (!toggle) return;
  toggle.onchange = async () => {
    const running = toggle.checked;
    toggle.disabled = true;
    msg.className = 'msg';
    msg.textContent = running ? 'Resuming…' : 'Pausing…';
    try {
      await api('/api/schedule/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: !running }),
      });
      msg.className = 'msg ok';
      msg.textContent = running ? 'Schedule resumed.' : 'Schedule paused.';
      const apps = await api('/api/apps');
      await loadStatus(apps);
    } catch (err) {
      msg.className = 'msg bad';
      msg.textContent = err.message;
      toggle.checked = !running;
      toggle.disabled = false;
    }
  };
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

// Poll until an admin server answers again, used across a service handoff
// where the process serving this page exits and launchd starts a new one.
async function waitForServer({ tries = 30, delayMs = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      const res = await fetch('/api/service', { cache: 'no-store' });
      if (res.ok) return true;
    } catch {
      // Still down — keep waiting.
    }
  }
  return false;
}

function wakeBlurb(state) {
  const w = state.wakes;
  if (!w) return '';
  if (w.error) return ` Scheduled wakes: ${w.error}`;
  if (!w.installed) {
    return ' The Mac will not wake from sleep until scheduled wakes are installed (macOS will ask for your password when you enable).';
  }
  const next = w.next ? ` Next wake ${w.next}.` : '';
  return ` Wakes from sleep ${w.leadMinutes} min before each slot.${next}`;
}

function renderService(state) {
  const toggle = document.getElementById('service-toggle');
  const label = document.getElementById('service-state');
  const detail = document.getElementById('service-detail');

  toggle.checked = state.running;
  toggle.disabled = false;
  label.textContent = state.running ? 'Enabled' : 'Disabled';
  detail.textContent = state.running
    ? `Running in the background (pid ${state.pid}). Survives reboot.${wakeBlurb(state)}`
    : 'Not running in the background. The schedule only fires while a terminal runs vos.';
}

async function loadService() {
  const section = document.getElementById('service-section');
  const msg = document.getElementById('service-msg');
  const toggle = document.getElementById('service-toggle');

  let state;
  try {
    state = await api('/api/service');
  } catch {
    // 403 for non-loopback callers, or the route is unavailable. Either way
    // there is nothing actionable here, so leave the section hidden.
    return;
  }
  if (!state.supported) return;

  section.hidden = false;
  renderService(state);

  toggle.onchange = async () => {
    const enabling = toggle.checked;
    toggle.disabled = true;
    msg.className = 'msg';
    msg.textContent = enabling
      ? 'Installing… macOS may ask for your password to schedule wake-from-sleep.'
      : 'Stopping… macOS may ask for your password to remove scheduled wakes.';

    let result;
    try {
      result = await api('/api/service', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: enabling }),
      });
    } catch (err) {
      msg.className = 'msg bad';
      msg.textContent = err.message;
      toggle.checked = !enabling;
      toggle.disabled = false;
      return;
    }

    if (enabling && result.handoff) {
      msg.textContent = 'Handing off to the background service…';
      const back = await waitForServer();
      if (back) {
        msg.className = 'msg ok';
        msg.textContent = 'Enabled. The background service is now serving this page, and this Mac will wake before each slot.';
        loadService();
      } else {
        msg.className = 'msg bad';
        msg.textContent = 'Started, but the admin site did not come back. Check logs/service.err.log.';
      }
      return;
    }

    if (!enabling) {
      msg.className = 'msg ok';
      if (result.stoppedSelf) {
        // The process that would answer /api/service just exited, so paint the
        // final state from what we already know instead of refetching.
        renderService({ running: false, pid: null });
        toggle.disabled = true;
        msg.textContent = 'Disabled. This page was served by that process — run `npm start` to bring the admin site back.';
        if (result.wakesError) {
          msg.className = 'msg bad';
          msg.textContent += ` Scheduled wakes may still be present: ${result.wakesError}`;
        }
      } else {
        msg.textContent = 'Disabled.';
        loadService();
      }
      return;
    }

    loadService();
  };
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
    wireAutomation();
    loadService();
    const apps = await loadApps();
    await loadStatus(apps);
  } catch (err) {
    document.getElementById('status').innerHTML = `<span class="bad">${err.message}</span>`;
  }
})();
