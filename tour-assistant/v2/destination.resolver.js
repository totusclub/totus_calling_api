const axios = require('axios');
const { TOTUS_API_BASE_URL } = require('./config');
const { getCountryPrep, getCountryNom, getCityPrep, getCityNom } = require('./destination.labels');

const api = axios.create({
  baseURL: TOTUS_API_BASE_URL,
  timeout: 20000,
});

const MONTH_LIKE =
  /^(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)/i;

/**
 * Pull a destination phrase from free-form user text for autocomplete lookup.
 */
function extractDestinationQuery(userText) {
  const raw = (userText || '').trim();
  if (!raw) return '';
  const t = raw.toLowerCase();

  const patterns = [
    /(?:подобрать|собер\w*|найд\w*|ищ\w*|хот\w*|поехать|полететь|отдохнуть|слетать)\s+(?:\S+\s+){0,4}(?:тур|поездк\w*|отдых)?\s*(?:в|vo|to|на)\s+([а-яёa-z\-\s]{2,40})/i,
    /(?:тур|поездк\w*)\s+(?:в|vo|to|на)\s+([а-яёa-z\-\s]{2,40})/i,
    /(?:город|курорт|resort|city)\s+([а-яёa-z\-\s]{2,40})/i,
    /\b(?:в|vo|to|на)\s+([а-яёa-z\-\s]{2,40}?)(?:[?.!,]|$|\s+(?:на|с|и|или|без))/i,
  ];

  for (const re of patterns) {
    const match = t.match(re);
    if (!match?.[1]) continue;
    const chunk = match[1].trim().replace(/[.!?]+$/, '');
    if (chunk.length >= 2 && !MONTH_LIKE.test(chunk)) return chunk;
  }

  return raw.length <= 48 ? raw : '';
}

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .trim();
}

function mentionScore(query, candidate) {
  const q = normalizeForMatch(query);
  const c = normalizeForMatch(candidate);
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

  return score;
}

function pickBestResult(groups, query) {
  let best = null;
  let bestScore = 0;

  for (const groupName of ['countries', 'regions', 'metaregions']) {
    const group = groups.find((g) => g.group_name === groupName);
    for (const result of group?.results || []) {
      if (!result?.iso2) continue;
      const score = scoreResult(result, query, groupName);
      if (score > bestScore) {
        bestScore = score;
        best = { ...result, _group: groupName };
      }
    }
  }

  return bestScore >= 20 ? best : null;
}

function buildPatchFromResult(item) {
  const iso2 = item.iso2 || '';
  const group = item._group;

  if (group === 'countries') {
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
  const cityRu = item.name || item.city_name || cityEn;
  const countryRu = getCountryNom(iso2) || item.country_name_ru || '';
  const cityDisplay = getCityNom(cityEn) || cityRu;
  const label =
    countryRu && cityDisplay && cityDisplay !== countryRu
      ? `${cityDisplay}, ${countryRu}`
      : cityDisplay || countryRu;
  const cityPrep = getCityPrep(cityEn) || cityRu;
  const prep =
    countryRu && cityPrep && cityPrep !== countryRu
      ? `${cityPrep}, ${countryRu}`
      : cityPrep || label;

  return {
    kind: 'city',
    to_country: iso2,
    to_city: cityEn,
    destination_label: label,
    destination_label_prep: prep,
    search_intent: 'package',
    search_type: 'package',
  };
}

/**
 * Resolve any destination via Totus / Level.Travel autocomplete (all catalog countries & resorts).
 */
async function resolveDestinationByText(query, fromCity = 'Moscow') {
  const trimmed = String(query || '').trim();
  if (trimmed.length < 2) return null;

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
  extractDestinationQuery,
  resolveDestinationByText,
};
