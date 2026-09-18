// Evening sky — tonight + tomorrow weather (Open-Meteo) and moon phase.
//
// 6pm slot: morning weather already covered "now"; this board is the plan for
// the rest of the night and tomorrow, plus something that looks good on the
// wall through dinner. Moon age is computed locally from a known new moon so
// we do not need a second API.

const FORECAST = 'https://api.open-meteo.com/v1/forecast';

// Mean synodic month, and a new moon at 2000-01-06 18:14 UTC.
const SYNODIC = 29.53058867;
const KNOWN_NEW = Date.UTC(2000, 0, 6, 18, 14, 0);

const PHASES = [
  { until: 1.84566, name: 'NEW' },
  { until: 5.53699, name: 'WAXING CRESCENT' },
  { until: 9.22831, name: 'FIRST QUARTER' },
  { until: 12.91963, name: 'WAXING GIBBOUS' },
  { until: 16.61096, name: 'FULL' },
  { until: 20.30228, name: 'WANING GIBBOUS' },
  { until: 23.99361, name: 'LAST QUARTER' },
  { until: 27.68493, name: 'WANING CRESCENT' },
  { until: SYNODIC, name: 'NEW' },
];

export function moonInfo(date = new Date()) {
  const days = (date.getTime() - KNOWN_NEW) / 86400000;
  const age = ((days % SYNODIC) + SYNODIC) % SYNODIC;
  const illum = Math.round(((1 - Math.cos((2 * Math.PI * age) / SYNODIC)) / 2) * 100);
  const phase = PHASES.find((p) => age < p.until)?.name || 'NEW';

  const toFull = (SYNODIC / 2 - age + SYNODIC) % SYNODIC;
  const toNew = (SYNODIC - age) % SYNODIC;
  const next = toFull <= toNew
    ? { event: 'FULL', days: toFull }
    : { event: 'NEW', days: toNew };

  return { age, illum, phase, next };
}

function moonLines(date) {
  const { illum, phase, next } = moonInfo(date);
  const top = `MOON ${phase}`.trim();
  const days = Math.round(next.days);
  let bottom;
  if (days <= 0) bottom = `${illum}%  ${next.event} TONIGHT`;
  else if (days === 1) bottom = `${illum}%  ${next.event} TOMORROW`;
  else bottom = `${illum}%  ${next.event} IN ${days} DAYS`;
  return [top.slice(0, 22), bottom.slice(0, 22)];
}

function summarize(code) {
  if (code === 0) return 'CLEAR';
  if (code === 1) return 'MOSTLY CLEAR';
  if (code === 2) return 'PARTLY CLOUDY';
  if (code === 3) return 'CLOUDY';
  if (code === 45 || code === 48) return 'FOGGY';
  if (code >= 51 && code <= 57) return 'DRIZZLE';
  if (code >= 61 && code <= 67) return 'RAIN';
  if (code >= 71 && code <= 77) return 'SNOW';
  if (code >= 80 && code <= 82) return 'SHOWERS';
  if (code === 85 || code === 86) return 'SNOW SHOWERS';
  if (code >= 95) return 'THUNDERSTORM';
  return 'MIXED';
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status} for ${url}`);
  return res.json();
}

// Weather code around 21:00 local today (typical "tonight"); fall back to current.
function tonightCode(fc, now) {
  const times = fc.hourly?.time || [];
  const codes = fc.hourly?.weather_code || [];
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const target = new Date(y, m, d, 21, 0, 0).getTime();
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = new Date(times[i]).getTime();
    const dist = Math.abs(t - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = codes[i];
    }
  }
  if (Number.isFinite(best) && bestDist <= 3 * 3600 * 1000) return best;
  return fc.current?.weather_code;
}

export async function render({ config, layout, now = new Date() }) {
  const { latitude, longitude } = config;
  const fc = await getJson(
    `${FORECAST}?latitude=${latitude}&longitude=${longitude}` +
      `&current=temperature_2m,weather_code` +
      `&hourly=weather_code` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min` +
      `&forecast_days=2&temperature_unit=celsius&timezone=auto`
  );

  const cur = fc?.current;
  const daily = fc?.daily;
  if (!cur || !daily) throw new Error('Open-Meteo returned no forecast data');

  const tnTemp = Math.round(cur.temperature_2m);
  const tnSum = summarize(tonightCode(fc, now));
  const tmwSum = summarize(daily.weather_code?.[1] ?? daily.weather_code?.[0]);
  const hi = Math.round(daily.temperature_2m_max?.[1] ?? daily.temperature_2m_max?.[0]);
  const lo = Math.round(daily.temperature_2m_min?.[1] ?? daily.temperature_2m_min?.[0]);
  const [moonTop, moonBottom] = moonLines(now);

  return layout.lines([
    `TONIGHT  ${tnTemp}°C`,
    tnSum,
    `TMW ${tmwSum}`.slice(0, 22),
    `HI ${hi}°C  LO ${lo}°C`,
    moonTop,
    moonBottom,
  ]);
}
