const axios = require('axios');
const { TOTUS_API_BASE_URL } = require('./config');
const { isDepartureCityOnlyText } = require('./search.params.normalizer');
const { getCountryPrep, getCountryNom, getCityPrep, getCityNom } = require('./destination.labels');
const {
  COUNTRY_DEFAULT_CITY,
  KNOWN_CITY_RESOLVES,
  matchCountryCodeFromText,
  matchCityFromText,
  getDefaultCityForCountry,
  canonicalizeApiCity,
  normalizeKey,
} = require('./destination.catalog');

const api = axios.create({
  baseURL: TOTUS_API_BASE_URL,
  timeout: 20000,
});

const MONTH_LIKE =
  /^(январ|феврал|март|апрел|ма[йя]|июн|июл|августа|сентябр|октябр|ноябр|декабр)/i;

function resolveKnownCityQuery(query) {
  const hit = matchCityFromText(query);
  if (!hit) return null;
  return buildPatchFromKnownCity(hit);
}

function buildPatchFromKnownCity({ country, city }) {
  const canonicalCity = canonicalizeApiCity(city, country) || city;
  const countryRu = getCountryNom(country) || country;
  const cityDisplay = getCityNom(canonicalCity, country) || getCityNom(city, country);
  const cityPrep = getCityPrep(canonicalCity, country) || getCityPrep(city, country);
  const label =
    cityDisplay && countryRu && cityDisplay !== countryRu
      ? `${cityDisplay}, ${countryRu}`
      : cityDisplay || countryRu;
  const prep =
    cityPrep && countryRu && cityPrep !== countryRu
      ? `${cityPrep}, ${countryRu}`
      : cityPrep || getCountryPrep(country) || label;
  return {
    kind: 'city',
    to_country: country,
    to_city: canonicalCity,
    destination_label: label,
    destination_label_prep: prep,
    search_intent: 'package',
    search_type: 'package',
  };
}

function extractExplicitCityName(userText) {
  const raw = String(userText || '').trim();
  if (!raw) return '';

  const patterns = [
    /(?:в\s+)?город[еу]?\s+([а-яёa-z\-]+)/i,
    /(?:курорт[еу]?|resort)\s+([а-яёa-z\-]+)/i,
  ];

  for (const re of patterns) {
    const match = raw.match(re);
    if (!match?.[1]) continue;
    const city = match[1].trim().replace(/[,.!?]+$/, '');
    if (city.length >= 2 && !MONTH_LIKE.test(city)) return city;
  }
  return '';
}

function extractDestinationQuery(userText) {
  const raw = (userText || '').trim();
  if (!raw) return '';
  const t = raw.toLowerCase();

  const explicitCity = extractExplicitCityName(raw);
  if (explicitCity) return explicitCity;

  const patterns = [
    /(?:подобрать|собер\w*|найд\w*|ищ\w*|хот\w*|поехать|полететь|отдохнуть|слетать)\s+(?:\S+\s+){0,4}(?:тур|поездк\w*|отдых)?\s*(?:в|vo|to|на)\s+([а-яёa-z\-\s]{2,40})/i,
    /(?:тур|поездк\w*)\s+(?:в|vo|to|на)\s+([а-яёa-z\-\s]{2,40})/i,
    /(?:город[еу]?|курорт[еу]?|resort|city)\s+([а-яёa-z\-\s]{2,40})/i,
    /\b(?:в|vo|to|на)\s+([а-яёa-z\-\s]{2,40}?)(?:[?.!,]|$|\s+(?:на|с|и|или|без))/i,
  ];

  for (const re of patterns) {
    const match = t.match(re);
    if (!match?.[1]) continue;
    const chunk = match[1].trim().replace(/[.!?]+$/, '');
    if (chunk.length >= 2 && !MONTH_LIKE.test(chunk)) return chunk;
  }

  if (isDepartureCityOnlyText(raw)) return '';
  return raw.length <= 48 ? raw : '';
}

function resolveKnownCountryQuery(query) {
  const code = matchCountryCodeFromText(query);
  if (!code) return null;
  const defaultCity = getDefaultCityForCountry(code);
  if (defaultCity) {
    return buildPatchFromKnownCity({ country: code, city: defaultCity });
  }
  const label = getCountryNom(code) || code;
  return {
    kind: 'country',
    to_country: code,
    destination_label: label,
    destination_label_prep: getCountryPrep(code) || label,
    search_intent: 'package',
    search_type: 'package',
  };
}

function isCountryOnlyQuery(query) {
  return Boolean(resolveKnownCountryQuery(query));
}

function mentionScore(query, candidate) {
  const q = normalizeKey(query);
  const c = normalizeKey(candidate);
  if (!q || !c) return 0;
  if (q === c) return 100;
  if (c.includes(q) || q.includes(c)) return 70;
  if (c.length >= 4 && q.length >= 4) {
    const cStem = c.slice(0, -1);
    const qStem = q.slice(0, -1);
    if (c.includes(qStem) || q.includes(cStem)) return 45;
  }
  return 0;
}

function scoreResult(result, query, groupName) {
  const primaryNames =
    groupName === 'countries'
      ? [result.name, result.name_en]
      : [result.name, result.name_en, result.city_name];

  let score = 0;
  for (const name of primaryNames) {
    score = Math.max(score, mentionScore(query, name));
  }

  if (groupName !== 'countries' && result.country_name_ru) {
    score = Math.max(score, Math.round(mentionScore(query, result.country_name_ru) * 0.55));
  }

  if (groupName === 'regions') score += 6;
  else if (groupName === 'metaregions') score += 2;
  else if (groupName === 'countries') score += 4;

  if (isCountryOnlyQuery(query) && groupName === 'countries') {
    score += 50;
  }
  if (isCountryOnlyQuery(query) && groupName === 'regions') {
    score -= 25;
  }

  return score;
}

function pickBestResult(groups, query) {
  const known = resolveKnownCityQuery(query);
  if (known) return { ...known, _group: 'regions', _known: true };

  let best = null;
  let bestScore = 0;
  const q = normalizeKey(query);

  for (const groupName of ['countries', 'regions', 'metaregions']) {
    const group = groups.find((g) => g.group_name === groupName);
    for (const result of group?.results || []) {
      if (!result?.iso2) continue;
      let score = scoreResult(result, query, groupName);
      if (/^бал[ил]/i.test(q) || q === 'bali' || q === 'bali island') {
        if (result.iso2 === 'ID' && /bali/i.test(result.name_en || result.name || '')) {
          score += 40;
        }
        if (result.iso2 === 'GR' && normalizeKey(result.name_en) === 'bali') {
          score -= 30;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = { ...result, _group: groupName };
      }
    }
  }

  return bestScore >= 20 ? best : null;
}

function buildPatchFromResult(item) {
  if (item._known) {
    const { _known, _group, ...patch } = item;
    return patch;
  }
  const iso2 = item.iso2 || '';
  const group = item._group;

  if (group === 'countries') {
    const defaultCity = COUNTRY_DEFAULT_CITY[iso2];
    if (defaultCity) {
      return buildPatchFromKnownCity({ country: iso2, city: defaultCity });
    }
    const label = getCountryNom(iso2) || item.name || item.country_name_ru || item.name_en || '';
    return {
      kind: 'country',
      to_country: iso2,
      destination_label: label,
      destination_label_prep: getCountryPrep(iso2) || label,
      search_intent: 'package',
      search_type: 'package',
    };
  }

  const cityEn = item.name_en || item.name || item.city_name || '';
  const canonicalCity = canonicalizeApiCity(cityEn, iso2) || cityEn;
  const countryRu = getCountryNom(iso2) || item.country_name_ru || '';
  const cityDisplay = getCityNom(canonicalCity, iso2);
  const label =
    countryRu && cityDisplay && cityDisplay !== countryRu
      ? `${cityDisplay}, ${countryRu}`
      : cityDisplay || countryRu;
  const cityPrep = getCityPrep(canonicalCity, iso2);
  const prep =
    countryRu && cityPrep && cityPrep !== countryRu
      ? `${cityPrep}, ${countryRu}`
      : cityPrep || getCountryPrep(iso2) || label;

  return {
    kind: 'city',
    to_country: iso2,
    to_city: canonicalCity,
    destination_label: label,
    destination_label_prep: prep,
    search_intent: 'package',
    search_type: 'package',
  };
}

async function resolveDestinationByText(query, fromCity = 'Moscow') {
  const trimmed = String(query || '').trim();
  if (trimmed.length < 2) return null;
  if (isDepartureCityOnlyText(trimmed) && !extractDestinationQuery(trimmed)) return null;

  const knownCountry = resolveKnownCountryQuery(trimmed);
  if (knownCountry) return knownCountry;

  const knownCity = resolveKnownCityQuery(trimmed);
  if (knownCity) return knownCity;

  try {
    const res = await api.get('/references/autocomplete_v2', {
      params: {
        query: `"${trimmed}"`,
        from_city: fromCity || 'Moscow',
        search_type: 'package',
      },
    });

    const groups = Array.isArray(res.data) ? res.data : [];
    const best = pickBestResult(groups, trimmed);
    if (!best?.iso2) return null;

    return buildPatchFromResult(best);
  } catch (err) {
    console.warn('[V2 destination.resolver] autocomplete failed:', err.message);
    return null;
  }
}

module.exports = {
  extractExplicitCityName,
  extractDestinationQuery,
  resolveDestinationByText,
};
