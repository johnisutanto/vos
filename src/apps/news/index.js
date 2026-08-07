// Headline News app — top item from GNews top-headlines (requires an API key).
// GNews returns several articles; we pick the first headline that fits the
// board (header row + wrapped title) rather than truncating a long one.
//
// GNews has no continent filter, so we infer each article's region from its
// source URL's country-code TLD and keep only the allowed continents (config
// `regions`). Generic TLDs (.com/.org/…) can't be geolocated, so they are
// included by default — the net effect is filtering OUT regional papers from
// unwanted continents while keeping the mainstream English feed.

// Country-code TLD -> continent. Only codes we want to classify need listing;
// anything absent (incl. generic TLDs like .com) is treated as unknown.
const TLD_CONTINENT = {
  // North America
  us: 'north-america', ca: 'north-america', mx: 'north-america',
  // Europe
  uk: 'europe', ie: 'europe', de: 'europe', fr: 'europe', es: 'europe',
  it: 'europe', nl: 'europe', be: 'europe', ch: 'europe', at: 'europe',
  se: 'europe', no: 'europe', dk: 'europe', fi: 'europe', pl: 'europe',
  pt: 'europe', gr: 'europe', cz: 'europe', ro: 'europe', hu: 'europe',
  ua: 'europe', ru: 'europe', eu: 'europe',
  // Asia
  in: 'asia', sg: 'asia', jp: 'asia', cn: 'asia', hk: 'asia', tw: 'asia',
  kr: 'asia', my: 'asia', ph: 'asia', id: 'asia', th: 'asia', vn: 'asia',
  pk: 'asia', bd: 'asia', lk: 'asia', ae: 'asia', sa: 'asia', il: 'asia',
  qa: 'asia', tr: 'asia',
  // South America
  br: 'south-america', ar: 'south-america', cl: 'south-america',
  co: 'south-america', pe: 'south-america', ve: 'south-america',
  uy: 'south-america', ec: 'south-america', bo: 'south-america',
  py: 'south-america',
  // Africa
  za: 'africa', ng: 'africa', ke: 'africa', tz: 'africa', ug: 'africa',
  gh: 'africa', et: 'africa', eg: 'africa', ma: 'africa', dz: 'africa',
  zw: 'africa', zm: 'africa', rw: 'africa', sn: 'africa',
  // Oceania
  au: 'oceania', nz: 'oceania', fj: 'oceania',
};

// Continent for an article's source URL, or null if it can't be determined
// (generic TLD, missing URL, unmapped ccTLD).
function continentOf(url) {
  try {
    const host = new URL(url).hostname; // e.g. www.thecitizen.co.tz
    const tld = host.split('.').pop().toLowerCase();
    return TLD_CONTINENT[tld] ?? null;
  } catch {
    return null;
  }
}

// Keep an article if its region is allowed, or unknown (default-include).
function inRegion(article, allowed) {
  const continent = continentOf(article?.source?.url);
  return continent === null || allowed.has(continent);
}

// A headline fits if its wrapped title needs no more rows than we allot below
// the header row.
function fits(title, layout) {
  const bodyRows = layout.rows - 1;
  return layout.wrap(title, { maxRows: layout.rows }).length <= bodyRows;
}

export async function render({ config, layout }) {
  const {
    apiKey,
    category = 'general',
    lang = 'en',
    source,
    regions = ['north-america', 'europe', 'asia', 'south-america'],
  } = config;
  if (!apiKey) throw new Error('news app needs an apiKey in config (gnews.io)');

  const url =
    `https://gnews.io/api/v4/top-headlines?category=${encodeURIComponent(category)}` +
    `&lang=${encodeURIComponent(lang)}&apikey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`GNews ${res.status}`);
  const data = await res.json();
  const allArticles = data?.articles?.filter((a) => a?.title) ?? [];
  if (!allArticles.length) throw new Error('GNews returned no articles');

  // Restrict to the allowed continents; if that empties the list, fall back to
  // the unfiltered set rather than blanking the board.
  const allowed = new Set(regions);
  const regional = allArticles.filter((a) => inRegion(a, allowed));
  const articles = regional.length ? regional : allArticles;

  // First headline that fits; else fall back to the top one (will be trimmed).
  const article = articles.find((a) => fits(a.title, layout)) || articles[0];

  const header = `${source || article.source?.name || 'NEWS'}`.slice(0, layout.columns);
  const headline = layout.wrap(article.title, { maxRows: layout.rows - 1 });

  return layout.lines([header, ...headline]);
}
