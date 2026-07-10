const axios = require('axios');
const { TOTUS_API_BASE_URL } = require('./config');

const api = axios.create({
  baseURL: TOTUS_API_BASE_URL,
  timeout: 20000,
});

const HOTEL_BRANDS =
  /hilton|marriott|hyatt|sheraton|radisson|intercontinental|ritz|four\s*seasons|kempinski|rixos|swissotel|movenpick|novotel|ibis|holiday\s*inn|riu\b|barcelo|titanic|regnum|voyage|maxx\s*royal|akva|aqua|calista|delphin|granada|limak|orange\s*county|paloma|sunrise|sun\s*&\s*sea|tui\s*blue|jumeirah|atlantis|fairmont|w\s*hotels|st\.?\s*regis|le\s*meridien|pullman|melia|iberostar|jet\s*tours|crystal|amara|liberty|concorde|pickalbatros|steigenberger|jaz\b|albatros|pick\s*albatros/i;

const TRAVEL_PHRASE =
  /^(поехать|отдохнуть|тур|вылет|на\s+море|в\s+|на\s+)/i;

const LOCATION_TAIL_RE =
  /\s+(?:в|во|из|на|at|in)\s+(?:египт|турци|турц|дуба|дубай|анталь|антали|шарм|хургад|мармар|белек|кемер|оаэ|таиланд|кипр|греци|испани|итали|мальдив|тунис|марокко|кипр|сочи|крым|абхаз|грузи|египте|турции).*/i;

const DATE_TAIL_RE =
  /\s+(?:с|на|от)\s+\d{1,2}(?:\s+\S+)?(?:\s+(?:по|до)\s+\d{1,2}(?:\s+\S+)?)?$/i;

/** Common user phrasing → canonical autocomplete query */
const HOTEL_QUERY_ALIASES = [
  { pattern: /rixos\s+seagate(?:\s+sharm)?/i, query: 'Rixos Premium Seagate' },
  { pattern: /seagate\s+sharm/i, query: 'Rixos Premium Seagate' },
  { pattern: /hilton\s+dubai\s+palm/i, query: 'Hilton Dubai Palm Jumeirah' },
  { pattern: /riu\s+dubai/i, query: 'Riu Dubai' },
  { pattern: /wind\s+of\s+lara/i, query: 'Wind Of Lara Hotel & Spa' },
  { pattern: /concorde\s+moreen/i, query: 'Concorde Moreen Beach Resort' },
  { pattern: /mardan\s+palace/i, query: 'Mardan Palace' },
  { pattern: /rixos\s+sharm(?!\s+el)/i, query: 'Rixos Sharm El Sheikh' },
  { pattern: /rixos\s+premium\s+seagate/i, query: 'Rixos Premium Seagate' },
  { pattern: /titanic\s+deluxe/i, query: 'Titanic Deluxe' },
  { pattern: /maxx\s*royal/i, query: 'Maxx Royal' },
  { pattern: /ic\s+hotels?\s+green/i, query: 'IC Hotels Green Palace' },
];

const LOCATION_STRIP_RE =
  /\s+(?:sharm(?:\s*el\s*sheikh)?|шарм(?:\s*эль\s*шейх)?|dubai|дубай|marsa(?:\s*alam)?|марса(?:\s*алам)?|hurghada|хургад(?:а)?|antalya|анталь(?:я|и)?|kemer|кемер|belek|белек|lara|лара|side|сиде|alanya|аланья|kundu|кунду|palm(?:\s*jumeirah)?|пальм(?:а|е)?|jumeirah|джумейр).*/i;

function containsHotelBrand(text) {
  return HOTEL_BRANDS.test(text || '');
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function isHotelsInCityPhrase(fragment) {
  const s = (fragment || '').trim();
  return (
    /^отел[ьяейи]?\s+(?:в|во)\s+/i.test(s) ||
    (/^отел/i.test(s) && /\s(?:в|во)\s+[а-яёa-z\-]+/i.test(s))
  );
}

function isGenericHotelSearch(text) {
  const raw = (text || '').trim();
  if (!raw) return true;
  if (/рейтинг|rating|оценк/i.test(raw) && /отел/i.test(raw)) return true;
  if (/отел[ьяейи]?\s+(?:с|со)\s+(?:рейтинг|звезд|звёзд)/i.test(raw)) return true;
  if (
    /отел/i.test(raw) &&
    /\s(?:в|во)\s+[а-яёa-z\-]/i.test(raw) &&
    !/(?:тур|пакет)\s+(?:в|во)\s+отел/i.test(raw) &&
    !containsHotelBrand(raw)
  ) {
    return true;
  }
  return false;
}

function normalizeHotelNameCandidate(name) {
  return String(name || '')
    .replace(/^\s*(?:в|во)\s+отел[ьяеи]?\s+/i, '')
    .replace(/^\s*(?:отель|hotel|the)\s+/i, '')
    .replace(/\s*\((?:ex\.?|бывш\.?|former)[^)]*\)/gi, '')
    .replace(/\s+(?:ex\.?|ex-|бывш\.?)\s+.+$/i, '')
    .replace(LOCATION_TAIL_RE, '')
    .replace(DATE_TAIL_RE, '')
    .replace(/\s+(?:на\s+)?\d{1,2}\s*(?:ноч|ночей|дней|дня)\b.*/i, '')
    .replace(/\s+(?:для|на)\s+\d+\s*(?:взросл|чел|дет|adult).*/i, '')
    .replace(/[«»"'`]+/g, '')
    .replace(/[.!?]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function applyQueryAliases(name) {
  const normalized = normalizeHotelNameCandidate(name);
  for (const { pattern, query } of HOTEL_QUERY_ALIASES) {
    if (pattern.test(normalized)) return query;
  }
  return normalized;
}

function isLikelyHotelName(name) {
  const s = normalizeHotelNameCandidate(name);
  if (!s || s.length < 3) return false;
  if (isHotelsInCityPhrase(s)) return false;
  if (/^(тур|пакет|направлен|страна|курорт)$/i.test(s)) return false;
  if (containsHotelBrand(s)) return true;
  if (/\b(отель|hotel|resort|spa|palace|beach|grand|royal|premium|deluxe|suites?)\b/i.test(s)) {
    return true;
  }
  const words = s.split(/\s+/);
  return words.length >= 2 && /[a-z]/i.test(s);
}

function stripTrailingContext(name) {
  return normalizeHotelNameCandidate(name);
}

function extractFromPattern(raw, pattern) {
  const match = raw.match(pattern);
  if (!match?.[1]) return null;
  const name = normalizeHotelNameCandidate(match[1]);
  if (name.length < 3 || isHotelsInCityPhrase(name)) return null;
  return isLikelyHotelName(name) ? name : null;
}

function extractHotelNameFromText(text) {
  const raw = (text || '').trim();
  if (!raw || isGenericHotelSearch(raw)) return null;
  if (/хочу\s+(поехать|отдохнуть|тур|вылет)\s+(?:в|во|на)\s+(?!отел)/i.test(raw)) {
    return null;
  }

  const extractionPatterns = [
    /(?:тур|пакет|путёвк[аи]|путевк[аи])\s+(?:в|во)\s+(?:отел[ьяеи]?\s+)?(.+)/iu,
    /(?:найди|найти|покажи|ищу|ищи|подбери|подобрать|хочу|нужен|нужна|интересует|забронир\w*|бронир\w*|забук\w*|book|останов\w*|посел\w*|остановиться|поселиться)\s+(?:мне\s+)?(?:тур\s+)?(?:в|во)\s+(?:отел[ьяеи]?\s+)?(.+)/iu,
    /(?:найди|найти|покажи|ищу|ищи|подбери)\s+(?:мне\s+)?(?:тур\s+)?(?:в|во)\s+(.+)/iu,
    /(?:забронировать|бронировать|забронир\w*|бронир\w*|забукать|book)\s+(?:мне\s+)?(.+)/iu,
    /(?:покажи|найди|найти|ищу|ищи|хочу|нужен|интересует)\s+(?:мне\s+)?(?:варианты?\s+)?(?:в\s+)?отел[ьяеи]?\s+(.+)/iu,
    /(?:покажи|найди|найти|ищу|ищи)\s+(?:мне\s+)?(?:отель\s+)?(.+)/iu,
    /(?:хочу|нужен|интересует)\s+(?:мне\s+)?(?:в\s+)?(.+)/iu,
    /(?:размещени[ея]|проживани[ея]|номер)\s+(?:в|во)\s+(?:отел[ьяеи]?\s+)?(.+)/iu,
    /(?:отель|hotel)\s+(.+)/iu,
    /(?:а\s+)?(?:что\s+)?(?:насчёт|насчет|про)\s+(.+)/iu,
  ];

  for (const pattern of extractionPatterns) {
    const name = extractFromPattern(raw, pattern);
    if (name) return applyQueryAliases(name);
  }

  if (containsHotelBrand(raw)) {
    const brandMatch = raw.match(
      /((?:hilton|marriott|hyatt|sheraton|radisson|intercontinental|ritz|kempinski|rixos|swissotel|movenpick|novotel|riu|barcelo|titanic|regnum|voyage|maxx\s*royal|concorde|pickalbatros|wind\s+of\s+lara|ic\s+hotels?|mardan\s+palace)[^.!?]*)/iu,
    );
    if (brandMatch?.[1]) {
      const name = applyQueryAliases(brandMatch[1]);
      if (isLikelyHotelName(name)) return name;
    }
  }

  if (
    containsHotelBrand(raw) &&
    raw.split(/\s+/).length >= 2 &&
    !/^(antalya|анталь|dubai|дубай|turkey|турц|egypt|египт)/i.test(raw)
  ) {
    return applyQueryAliases(raw);
  }

  return null;
}

function buildQueryVariants(hotelName) {
  const canonical = applyQueryAliases(hotelName);
  const base = normalizeHotelNameCandidate(canonical);
  const withoutLocation = base.replace(LOCATION_STRIP_RE, '').trim();
  const words = tokenize(withoutLocation || base);
  const brandPrefix = words.slice(0, Math.min(3, words.length)).join(' ');
  const firstTwo = words.slice(0, 2).join(' ');

  const variants = [
    `"${base}"`,
    base,
    `"${canonical}"`,
    canonical,
    withoutLocation,
    `"${withoutLocation}"`,
    brandPrefix,
    `"${brandPrefix}"`,
    firstTwo,
    `"${firstTwo}"`,
  ];

  if (words.length > 3) {
    variants.push(words.slice(0, 4).join(' '));
  }

  return [...new Set(variants)].filter((v) => v && v.replace(/"/g, '').trim().length >= 3);
}

function scoreHotelMatch(query, candidate, hints = {}) {
  const qNorm = normalizeHotelNameCandidate(query).toLowerCase();
  const cName = String(candidate.name || candidate.name_en || '').toLowerCase();
  const cEn = String(candidate.name_en || '').toLowerCase();
  const qTokens = tokenize(qNorm);
  const cTokens = tokenize(`${cName} ${cEn}`);

  let score = 0;
  if (!cName) return 0;

  if (cName === qNorm || cEn === qNorm) score += 120;
  if (cName.includes(qNorm) || qNorm.includes(cName)) score += 60;

  for (const token of qTokens) {
    if (token.length < 2) continue;
    if (cTokens.some((ct) => ct === token)) score += 14;
    else if (cTokens.some((ct) => ct.includes(token) || token.includes(ct))) score += 8;
  }

  if (hints.to_country && candidate.iso2 && hints.to_country === candidate.iso2) {
    score += 12;
  }
  if (hints.to_city && candidate.city_name) {
    const city = String(candidate.city_name).toLowerCase();
    const hint = String(hints.to_city).toLowerCase();
    if (city.includes(hint) || hint.includes(city)) score += 8;
  }

  if (candidate.stars >= 4) score += 2;
  return score;
}

function pickBestResult(query, results, hints = {}) {
  if (!results?.length) return null;
  let best = null;
  let bestScore = 0;
  for (const candidate of results) {
    const score = scoreHotelMatch(query, candidate, hints);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore >= 12 ? best : results[0];
}

async function fetchAutocompleteResults(query, fromCity) {
  const res = await api.get('/references/autocomplete_v2', {
    params: {
      query,
      from_city: fromCity,
      search_type: 'hotel',
    },
  });
  const groups = Array.isArray(res.data) ? res.data : [];
  const hotelGroup = groups.find((g) => g.group_name === 'hotels');
  return hotelGroup?.results || [];
}

/**
 * Resolve hotel name to Totus autocomplete result.
 */
async function resolveHotelByName(hotelName, fromCity = 'Moscow', hints = {}) {
  const normalized = applyQueryAliases(hotelName);
  if (!normalized || normalized.length < 3) return null;

  const variants = buildQueryVariants(normalized);
  let bestMatch = null;
  let bestScore = 0;

  try {
    for (const query of variants) {
      const results = await fetchAutocompleteResults(query, fromCity);
      const candidate = pickBestResult(normalized, results, hints);
      if (!candidate) continue;

      const score = scoreHotelMatch(normalized, candidate, hints);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = candidate;
      }
      if (score >= 90) break;
    }

    if (!bestMatch) return null;

    return {
      hotel_id: String(bestMatch.id),
      hotel_name: bestMatch.name || bestMatch.name_en || normalized,
      to_country: bestMatch.iso2 || hints.to_country || '',
      to_city: bestMatch.city_name || bestMatch.country_name_ru || hints.to_city || '',
    };
  } catch (err) {
    console.warn('[V2 hotel.resolver] resolve failed:', err.message);
    return null;
  }
}

module.exports = {
  extractHotelNameFromText,
  resolveHotelByName,
  containsHotelBrand,
  isLikelyHotelName,
  normalizeHotelNameCandidate,
};
