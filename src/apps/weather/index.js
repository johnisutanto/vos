// Weather app — Open-Meteo (open-meteo.com), no API key.
//
// Open-Meteo is coordinate-based and returns Celsius natively, plus daily
// min/max, a WMO weather code we map to a brief summary, and humidity. Its
// companion air-quality API supplies a US AQI. Both are keyless.

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const AIR_QUALITY = 'https://air-quality-api.open-meteo.com/v1/air-quality';

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status} for ${url}`);
  return res.json();
}

// WMO weather code -> brief, board-friendly summary.
// https://open-meteo.com/en/docs (weather_code table)
function summarize(code) {
  if (code === 0) return 'SUNNY';
  if (code === 1) return 'MOSTLY SUNNY';
  if (code === 2) return 'PARTLY CLOUDY';
  if (code === 3) return 'CLOUDY';
  if (code === 45 || code === 48) return 'FOGGY';
  if (code >= 51 && code <= 57) return 'DRIZZLE';
  if (code >= 61 && code <= 67) return 'RAINY';
  if (code >= 71 && code <= 77) return 'SNOWY';
  if (code >= 80 && code <= 82) return 'RAIN SHOWERS';
  if (code === 85 || code === 86) return 'SNOW SHOWERS';
  if (code >= 95) return 'THUNDERSTORM';
  return 'MIXED';
}

// US AQI value -> short category label.
function aqiCategory(aqi) {
  if (aqi <= 50) return 'GOOD';
  if (aqi <= 100) return 'MODERATE';
  if (aqi <= 150) return 'UNHLTHY SG';
  if (aqi <= 200) return 'UNHEALTHY';
  if (aqi <= 300) return 'V.UNHEALTHY';
  return 'HAZARDOUS';
}

export async function render({ config, layout }) {
  const { latitude, longitude, zip } = config;

  const fc = await getJson(
    `${FORECAST}?latitude=${latitude}&longitude=${longitude}` +
      `&current=temperature_2m,relative_humidity_2m,weather_code` +
      `&daily=temperature_2m_max,temperature_2m_min` +
      `&temperature_unit=celsius&timezone=auto`
  );

  const cur = fc?.current;
  const daily = fc?.daily;
  if (!cur || !daily) throw new Error('Open-Meteo returned no forecast data');

  const now = Math.round(cur.temperature_2m);
  const hi = Math.round(daily.temperature_2m_max?.[0]);
  const lo = Math.round(daily.temperature_2m_min?.[0]);
  const humidity = cur.relative_humidity_2m;
  const summary = summarize(cur.weather_code);

  // Air quality is best-effort — a failure here shouldn't blank the board.
  let aqiLine = null;
  try {
    const aq = await getJson(
      `${AIR_QUALITY}?latitude=${latitude}&longitude=${longitude}&current=us_aqi&timezone=auto`
    );
    const aqi = aq?.current?.us_aqi;
    if (Number.isFinite(aqi)) aqiLine = `AQI ${Math.round(aqi)} ${aqiCategory(aqi)}`;
  } catch {
    // leave aqiLine null
  }

  const lines = [
    `WEATHER ${zip}`,
    `${now}°C ${summary}`,
    `HI ${hi}°C  LO ${lo}°C`,
  ];
  if (Number.isFinite(humidity)) lines.push(`HUMIDITY ${Math.round(humidity)}%`);
  if (aqiLine) lines.push(aqiLine);

  return layout.lines(lines);
}
