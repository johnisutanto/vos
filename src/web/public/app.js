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

let catalog = [];
let scheduleDirty = false;
let appsLoad = null;

const PAGES = ['schedule', 'apps'];

function currentPage() {
  const hash = (location.hash || '#schedule').replace(/^#/, '');
  return PAGES.includes(hash) ? hash : 'schedule';
}

function ensureApps() {
  if (!appsLoad) appsLoad = loadApps();
  return appsLoad;
}

function reloadApps() {
  appsLoad = loadApps();
  return appsLoad;
}

function showPage(page) {
  if (!PAGES.includes(page)) page = 'schedule';
  document.querySelectorAll('[data-page-panel]').forEach((el) => {
    el.hidden = el.dataset.pagePanel !== page;
  });
  document.querySelectorAll('.nav a').forEach((a) => {
    a.setAttribute('aria-current', a.dataset.page === page ? 'page' : 'false');
  });
  if (page === 'apps') {
    ensureApps().catch((err) => {
      const box = document.getElementById('apps');
      if (box) box.textContent = err.message;
    });
  }
}

function wireNav() {
  if (!location.hash) history.replaceState(null, '', '#schedule');
  window.addEventListener('hashchange', () => showPage(currentPage()));
  showPage(currentPage());
}

async function loadStatus(apps, { keepEditor = false } = {}) {
  catalog = apps;
  const sched = await api('/api/schedule');

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

  if (!keepEditor || !scheduleDirty) {
    renderScheduleEditor(sched.schedule, apps);
  }

  renderAutomation(sched.paused);
}

function option(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

function markScheduleDirty() {
  scheduleDirty = true;
  const msg = document.getElementById('schedule-msg');
  if (msg && !msg.textContent) {
    msg.className = 'msg';
    msg.textContent = 'Unsaved changes.';
  }
}

function slotRow(entry, apps) {
  const el = document.createElement('div');
  el.className = 'slot edit';

  const time = document.createElement('input');
  time.type = 'time';
  time.required = true;
  time.dataset.field = 'time';
  time.value = entry.time || '08:00';
  time.setAttribute('aria-label', 'Time');

  const days = document.createElement('select');
  days.dataset.field = 'days';
  days.setAttribute('aria-label', 'Days');
  days.append(
    option('everyday', 'Every day'),
    option('weekdays', 'Weekdays'),
    option('weekends', 'Weekends'),
  );
  if (entry.days === 'custom') days.appendChild(option('custom', 'Custom days'));
  days.value = entry.days || 'everyday';

  const appSel = document.createElement('select');
  appSel.dataset.field = 'app';
  appSel.setAttribute('aria-label', 'App');
  const sorted = [...apps].sort((a, b) => a.name.localeCompare(b.name));
  for (const a of sorted) appSel.appendChild(option(a.id, a.name));
  if (entry.app && !sorted.some((a) => a.id === entry.app)) {
    appSel.appendChild(option(entry.app, `${entry.app} (missing)`));
  }
  if (entry.app) appSel.value = entry.app;

  const cron = document.createElement('input');
  cron.type = 'hidden';
  cron.dataset.field = 'cron';
  cron.value = entry.cron || '';

  const rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'secondary';
  rm.textContent = 'Remove';
  rm.onclick = () => {
    el.remove();
    markScheduleDirty();
    if (!document.querySelector('#timeline .slot.edit')) renderEmptyHint();
  };

  el.append(time, days, appSel, cron, rm);
  el.addEventListener('change', markScheduleDirty);
  el.addEventListener('input', markScheduleDirty);
  return el;
}

function renderEmptyHint() {
  const timeline = document.getElementById('timeline');
  if (timeline.querySelector('.slot.edit') || timeline.querySelector('.empty')) return;
  const empty = document.createElement('div');
  empty.className = 'slot empty';
  empty.textContent = 'No slots yet. Add one and save.';
  timeline.appendChild(empty);
}

function renderScheduleEditor(schedule, apps) {
  const timeline = document.getElementById('timeline');
  timeline.innerHTML = '';
  scheduleDirty = false;
  const rows = schedule || [];
  if (!rows.length) {
    renderEmptyHint();
    return;
  }
  for (const entry of rows) {
    timeline.appendChild(slotRow(entry, apps));
  }
}

function nextSlotDraft(apps) {
  const times = [...document.querySelectorAll('#timeline [data-field=time]')].map((i) => i.value);
  let hour = 8;
  if (times.length) {
    const last = times[times.length - 1] || '08:00';
    const parsed = Number(last.slice(0, 2));
    hour = Number.isFinite(parsed) ? (parsed + 1) % 24 : 8;
  }
  const sorted = [...apps].sort((a, b) => a.name.localeCompare(b.name));
  return {
    time: `${String(hour).padStart(2, '0')}:00`,
    days: 'everyday',
    app: sorted[0]?.id || '',
    cron: '',
  };
}

function readScheduleDraft() {
  return [...document.querySelectorAll('#timeline .slot.edit')].map((el) => ({
    time: el.querySelector('[data-field=time]').value,
    days: el.querySelector('[data-field=days]').value,
    app: el.querySelector('[data-field=app]').value,
    cron: el.querySelector('[data-field=cron]').value,
  }));
}

function wireSchedule() {
  const add = document.getElementById('schedule-add');
  const save = document.getElementById('schedule-save');
  const msg = document.getElementById('schedule-msg');
  if (!add || !save) return;

  add.onclick = () => {
    const timeline = document.getElementById('timeline');
    timeline.querySelector('.empty')?.remove();
    timeline.appendChild(slotRow(nextSlotDraft(catalog), catalog));
    markScheduleDirty();
  };

  save.onclick = async () => {
    save.disabled = true;
    add.disabled = true;
    msg.className = 'msg';
    msg.textContent = 'Saving…';
    try {
      const result = await api('/api/schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule: readScheduleDraft() }),
      });
      scheduleDirty = false;
      renderScheduleEditor(result.schedule, catalog);
      msg.className = 'msg ok';
      msg.textContent = result.schedule.length
        ? `Saved ${result.schedule.length} slot${result.schedule.length === 1 ? '' : 's'}.`
        : 'Saved an empty schedule. Timed writes will not run until you add a slot.';
    } catch (err) {
      msg.className = 'msg bad';
      msg.textContent = err.message;
    } finally {
      save.disabled = false;
      add.disabled = false;
    }
  };
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
      await loadStatus(apps, { keepEditor: true });
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
      reloadApps();
    } catch (err) {
      msg.className = 'msg bad';
      msg.textContent = err.message;
    }
  };
}

(async () => {
  try {
    wireNav();
    wireCapture();
    wireAutomation();
    wireSchedule();
    loadService();
    const apps = await api('/api/apps');
    await loadStatus(apps);
  } catch (err) {
    document.getElementById('status').innerHTML = `<span class="bad">${err.message}</span>`;
  }
})();
