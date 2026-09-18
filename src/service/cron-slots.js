// Translate the subset of cron expressions vos actually uses into concrete
// Date objects. We only accept "minute hour * * <dow>" with a fixed minute and
// hour — the same shape the admin UI already pretty-prints. Step syntax
// (`*/15`) and day-of-month filters are rejected so we never schedule a wake
// at the wrong time.

const ALL_DAYS = new Set([0, 1, 2, 3, 4, 5, 6]);

export function parseDailyCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  if (dom !== '*' || month !== '*') return null;
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return null;
  const mi = Number(minute);
  const h = Number(hour);
  if (mi < 0 || mi > 59 || h < 0 || h > 23) return null;
  const weekdays = parseDow(dow);
  if (!weekdays) return null;
  return { minute: mi, hour: h, weekdays };
}

function parseDow(field) {
  if (field === '*') return new Set(ALL_DAYS);
  const days = new Set();
  for (const piece of field.split(',')) {
    const range = piece.split('-');
    if (range.length === 1) {
      if (!/^\d+$/.test(range[0])) return null;
      days.add(Number(range[0]));
    } else if (range.length === 2) {
      if (!/^\d+$/.test(range[0]) || !/^\d+$/.test(range[1])) return null;
      const a = Number(range[0]);
      const b = Number(range[1]);
      if (a > b) return null;
      for (let d = a; d <= b; d++) days.add(d);
    } else {
      return null;
    }
  }
  for (const d of days) {
    if (d < 0 || d > 6) return null;
  }
  return days;
}

function startOfLocalDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function slotTimesInRange(parsed, from, until) {
  const out = [];
  const day = startOfLocalDay(from);
  while (day < until) {
    if (parsed.weekdays.has(day.getDay())) {
      const slot = new Date(
        day.getFullYear(), day.getMonth(), day.getDate(),
        parsed.hour, parsed.minute, 0, 0,
      );
      if (slot > from && slot <= until) out.push(slot);
    }
    day.setDate(day.getDate() + 1);
  }
  return out;
}

// pmset wants "MM/dd/yy HH:mm:ss" in the *local* timezone, 24-hour clock.
export function formatPmsetDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${String(d.getFullYear()).slice(-2)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatLocalTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Most recent slot that should already have run by `now`. Used to catch up
// after sleep: node-cron does not backfill, and a lid-closed Mac will not
// wake, so the first chance to update the board is when the process thaws.
export function lastSlotAtOrBefore(parsed, now) {
  const start = startOfLocalDay(now);
  for (let i = 0; i < 8; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() - i);
    if (!parsed.weekdays.has(day.getDay())) continue;
    const slot = new Date(
      day.getFullYear(), day.getMonth(), day.getDate(),
      parsed.hour, parsed.minute, 0, 0,
    );
    if (slot <= now) return slot;
  }
  return null;
}

export function mostRecentlyDue(schedule, now = new Date()) {
  let best = null;
  for (const entry of schedule || []) {
    const parsed = parseDailyCron(entry.cron);
    if (!parsed || !entry.app) continue;
    const at = lastSlotAtOrBefore(parsed, now);
    if (!at) continue;
    if (!best || at > best.at) best = { app: entry.app, at, cron: entry.cron };
  }
  return best;
}

// Unique wake times a few minutes before each upcoming slot. Entries whose
// cron we cannot parse are returned in `skipped` so the caller can warn.
const EVERYDAY = new Set([0, 1, 2, 3, 4, 5, 6]);
const WEEKDAYS = new Set([1, 2, 3, 4, 5]);
const WEEKENDS = new Set([0, 6]);

function sameDays(a, b) {
  if (a.size !== b.size) return false;
  for (const d of a) {
    if (!b.has(d)) return false;
  }
  return true;
}

export function daysPreset(weekdays) {
  if (sameDays(weekdays, EVERYDAY)) return 'everyday';
  if (sameDays(weekdays, WEEKDAYS)) return 'weekdays';
  if (sameDays(weekdays, WEEKENDS)) return 'weekends';
  return 'custom';
}

export function formatDailyCron({ minute, hour, weekdays }) {
  const preset = daysPreset(weekdays);
  let dow = '*';
  if (preset === 'weekdays') dow = '1-5';
  else if (preset === 'weekends') dow = '0,6';
  else if (preset === 'custom') dow = [...weekdays].sort((a, b) => a - b).join(',');
  return `${Number(minute)} ${Number(hour)} * * ${dow}`;
}

export function parseClock(time) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(time || '').trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

// Turn an admin-site slot { time, days, app, cron? } into a cron string.
export function slotToCron(slot) {
  if (slot?.days === 'custom') {
    const parsed = parseDailyCron(slot.cron);
    if (!parsed) throw new Error('Custom days need a valid cron expression');
    const clock = slot.time ? parseClock(slot.time) : { hour: parsed.hour, minute: parsed.minute };
    if (!clock) throw new Error(`Invalid time "${slot.time}"`);
    return formatDailyCron({ ...clock, weekdays: parsed.weekdays });
  }
  const clock = parseClock(slot?.time);
  if (!clock) throw new Error(`Invalid time "${slot?.time || ''}"`);
  const weekdays = slot?.days === 'weekdays' ? WEEKDAYS
    : slot?.days === 'weekends' ? WEEKENDS
    : slot?.days === 'everyday' || !slot?.days ? EVERYDAY
    : null;
  if (!weekdays) throw new Error('Days must be everyday, weekdays, or weekends');
  return formatDailyCron({ ...clock, weekdays });
}

export function describeScheduleEntry(entry) {
  const parsed = parseDailyCron(entry.cron);
  if (!parsed) {
    return {
      app: entry.app,
      cron: entry.cron,
      time: '08:00',
      days: 'everyday',
      parseable: false,
    };
  }
  return {
    app: entry.app,
    cron: entry.cron,
    time: `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`,
    days: daysPreset(parsed.weekdays),
    parseable: true,
  };
}

export function normalizeSchedule(entries, knownApps) {
  if (!Array.isArray(entries)) throw new Error('schedule must be an array');
  if (entries.length > 48) throw new Error('Too many slots (max 48)');
  const known = knownApps instanceof Set ? knownApps : new Set(knownApps || []);
  const out = [];
  const seen = new Set();
  for (const [i, raw] of entries.entries()) {
    const app = String(raw?.app || '').trim();
    if (!app) throw new Error(`Slot ${i + 1} is missing an app`);
    if (known.size && !known.has(app)) throw new Error(`Unknown app "${app}"`);
    const cron = slotToCron(raw);
    if (seen.has(cron)) throw new Error(`Two slots share the same time and days`);
    seen.add(cron);
    out.push({ cron, app });
  }
  out.sort((a, b) => cronSortKey(a.cron).localeCompare(cronSortKey(b.cron)));
  return out;
}

function cronSortKey(cron) {
  const parsed = parseDailyCron(cron);
  if (!parsed) return cron;
  return `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute).padStart(2, '0')}`;
}

export function planWakes(schedule, {
  from = new Date(),
  days = 14,
  leadMinutes = 3,
  minLeadMs = 45_000,
} = {}) {
  const until = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  const leadMs = leadMinutes * 60 * 1000;
  const byKey = new Map();
  const skipped = [];

  for (const entry of schedule || []) {
    const parsed = parseDailyCron(entry.cron);
    if (!parsed) {
      skipped.push(entry);
      continue;
    }
    for (const slot of slotTimesInRange(parsed, from, until)) {
      const wake = new Date(slot.getTime() - leadMs);
      if (wake.getTime() - from.getTime() < minLeadMs) continue;
      const key = formatPmsetDate(wake);
      if (!byKey.has(key)) {
        byKey.set(key, { wake, slot, app: entry.app, key });
      }
    }
  }

  return {
    events: [...byKey.values()].sort((a, b) => a.wake - b.wake),
    skipped,
    from,
    until,
    leadMinutes,
  };
}
