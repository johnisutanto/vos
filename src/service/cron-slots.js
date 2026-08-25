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
