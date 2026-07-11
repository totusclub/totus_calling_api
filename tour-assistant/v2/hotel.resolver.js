const axios = require('axios');
const { TOTUS_API_BASE_URL } = require('./config');

const api = axios.create({
  baseURL: TOTUS_API_BASE_URL,
  timeout: 20000,
});

const HOTEL_BRANDS =
  /hilton|double\s*tree|doubletree|marriott|hyatt|sheraton|radisson|intercontinental|ritz|four\s*seasons|kempinski|rixos|swissotel|movenpick|novotel|ibis|holiday\s*inn|riu\b|barcelo|titanic|regnum|voyage|maxx\s*royal|akva|aqua|calista|delphin|granada|limak|orange\s*county|paloma|sunrise|sun\s*&\s*sea|tui\s*blue|jumeirah|atlantis|fairmont|w\s*hotels|st\.?\s*regis|le\s*meridien|pullman|melia|iberostar|jet\s*tours|crystal|amara|liberty|concorde|pickalbatros|steigenberger|jaz\b|albatros|pick\s*albatros/i;

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
  { pattern: /rixos\s+шарм(?:\s*эль\s*шейх)?/i, query: 'Rixos Premium Seagate' },
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

const DESTINATION_STOPWORDS = new Set([
  'в', 'во', 'на', 'из', 'к', 'и', 'город', 'страна', 'курорт', 'отель',
  'тур', 'пакет', 'море', 'пляж', 'отдых', 'вылет', 'рядом', 'около',
]);

const HOTEL_KEYWORD_RE =
  /\b(отель|hotel|resort|spa|palace|beach|grand|royal|premium|deluxe|suites?|residence|club|inn|villas?|aparthotel|апарт|resort)\b/i;

/**
 * True when the whole candidate is just a country/city (a destination), not a
 * hotel. Brand-independent: relies on the destination catalog, not a fixed
 * hotel list. A name like "Rixos Seagate Sharm" is NOT pure (it has non-place
 * tokens), while "Турция" or "Шарм эль Шейх" is.
 */
function isPureDestination(candidate) {
  const {
    matchCountryCodeFromText,
    matchCityFromText,
  } = require('./destination.catalog');
  const s = normalizeHotelNameCandidate(candidate);
  if (!s) return true;
  const tokens = tokenize(s);
  if (!tokens.length) return true;
  if (!matchCountryCodeFromText(s) && !matchCityFromText(s)) return false;
  return tokens.every(
    (tk) =>
      tk.length < 3 ||
      DESTINATION_STOPWORDS.has(tk) ||
      Boolean(matchCountryCodeFromText(tk)) ||
      Boolean(matchCityFromText(tk)),
  );
}

/**
 * Decide whether a candidate string looks like a hotel *name* rather than a
 * generic phrase or a destination. Intentionally does NOT require a known
 * brand — any explicit hotel keyword or Latin proper name qualifies, and the
 * Totus autocomplete makes the final decision downstream. The brand list is
 * only kept as an extra positive signal, never as a hard requirement.
 */
function isLikelyHotelName(name) {
  const s = normalizeHotelNameCandidate(name);
  if (!s || s.length < 3) return false;
  if (isHotelsInCityPhrase(s)) return false;
  if (isPureDestination(s)) return false;
  if (/^(тур|пакет|направлен\w*|страна|курорт|море|пляж|отдых|город)$/i.test(s)) {
    return false;
  }
  if (HOTEL_KEYWORD_RE.test(s)) return true;
  if (containsHotelBrand(s)) return true;
  // Latin proper name — covers new/unknown hotels the brand list never had.
  if (/[a-z]{3,}/i.test(s)) return true;
  return false;
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

/**
 * Intent patterns capture the text AFTER a travel phrase ("найди тур в …",
 * "хочу поехать в …", "покажи …"). They deliberately grab the whole tail; the
 * decision of whether that tail is a hotel is made by `isLikelyHotelName`
 * (proper name / keyword) and, ultimately, by the autocomplete API — NOT by a
 * hardcoded brand list.
 */
const EXTRACTION_PATTERNS = [
  /(?:хочу|хотел\s+бы)\s+(?:потеплеть|отдохнуть|полететь|поехать|съездить|вылететь|улететь)\s+(?:в|во)\s+(?:отел[ьяейi]?\s+)?(.+)/iu,
  /(?:хочу|нужно)\s+(?:вылететь|полететь|улететь)\s+(?:в|во)\s+(?:отел[ьяейi]?\s+)?(.+)/iu,
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

/**
 * Extract a possible hotel-name candidate from free user text. Returns the raw
 * candidate (after alias normalization) or null. It never truncates the
 * distinguishing part of a name — the full tail is preserved so that
 * "Al Jadaf", "Palm Jumeirah" etc. survive for the resolver.
 */
function extractHotelCandidate(text) {
  const raw = (text || '').trim();
  if (!raw || isGenericHotelSearch(raw)) return null;

  for (const pattern of EXTRACTION_PATTERNS) {
    const name = extractFromPattern(raw, pattern);
    if (name) return applyQueryAliases(name);
  }

  // No leading travel verb — the user may have typed a bare hotel name.
  const bare = normalizeHotelNameCandidate(raw);
  if (!isHotelsInCityPhrase(bare) && isLikelyHotelName(bare)) {
    return applyQueryAliases(bare);
  }

  return null;
}

// Backward-compatible alias — used across the codebase.
const extractHotelNameFromText = extractHotelCandidate;

/** Align user spelling with Totus autocomplete (e.g. "double tree" → "doubletree"). */
function normalizeBrandSpelling(text) {
  return String(text || '').replace(/double\s+tree/gi, 'doubletree');
}

function buildQueryVariants(hotelName) {
  const canonical = applyQueryAliases(hotelName);
  const base = normalizeHotelNameCandidate(canonical);
  const baseSpelled = normalizeBrandSpelling(base);
  const withoutLocation = base.replace(LOCATION_STRIP_RE, '').trim();
  const words = tokenize(withoutLocation || base);
  const brandPrefix = words.slice(0, Math.min(3, words.length)).join(' ');
  const firstTwo = words.slice(0, 2).join(' ');
  const lastTwo = words.slice(-2).join(' ');
  const lastThree = words.slice(-3).join(' ');

  const variants = [
    `"${baseSpelled}"`,
    baseSpelled,
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
    lastThree,
    lastTwo,
  ];

  if (words.length > 3) {
    variants.push(words.slice(0, 4).join(' '));
  }

  return [...new Set(variants)]
    .map((v) => normalizeBrandSpelling(v))
    .filter((v) => v && v.replace(/"/g, '').trim().length >= 3);
}

function scoreHotelMatch(query, candidate, hints = {}) {
  const qNorm = normalizeHotelNameCandidate(query).toLowerCase();
  const cName = String(candidate.name || candidate.name_en || '').toLowerCase();
  const cEn = String(candidate.name_en || '').toLowerCase();
  const qTokens = tokenize(qNorm);
  const cTokens = tokenize(`${cName} ${cEn}`);

  let score = 0;
  if (!cName) return 0;

  const tokenMatches = (token) =>
    cTokens.some((ct) => ct === token || ct.includes(token) || token.includes(ct));

  if (cName === qNorm || cEn === qNorm) score += 120;
  else if (cName.includes(qNorm) || cEn.includes(qNorm)) score += 70;
  else if (qNorm.includes(cName)) score += 25;

  for (const token of qTokens) {
    if (token.length < 2) continue;
    if (cTokens.some((ct) => ct === token)) score += 14;
    else if (cTokens.some((ct) => ct.includes(token) || token.includes(ct))) score += 8;
  }

  // Penalize distinguishing query tokens missing from the candidate so a
  // generic name (e.g. "Double Tree By Hilton") cannot outrank a specific one
  // (e.g. "Doubletree By Hilton Dubai Al Jadaf") that the user actually named.
  const SCORE_STOPWORDS = new Set([
    'the', 'and', 'for', 'hotel', 'resort', 'spa', 'palace', 'beach', 'club',
    'отель', 'тур', 'ex',
  ]);
  for (const token of qTokens) {
    if (token.length < 4) continue;
    if (SCORE_STOPWORDS.has(token)) continue;
    if (HOTEL_BRANDS.test(token)) continue;
    if (!tokenMatches(token)) score -= 40;
  }

  if (/seagate/i.test(qNorm)) {
    if (/seagate/i.test(cName)) score += 35;
    else score -= 30;
    if (/adults\s+only|только\s+для\s+взросл/i.test(cName)) score -= 45;
    if (/premium/i.test(cName)) score += 15;
  }
  if (/premium/i.test(qNorm) && /premium/i.test(cName)) score += 20;
  if (/palace/i.test(qNorm) && /palace/i.test(cName)) score += 15;

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

/** Level.Travel-style: hotel name → canonical API city + country + labels. */
function buildDestinationFromHotel(match) {
  const {
    canonicalizeApiCity,
    matchCityFromText,
    getDefaultCityForCountry,
  } = require('./destination.catalog');
  const { normalizeToCity, isCountryPlaceholderToCity } = require('./search.params.normalizer');
  const { syncDestinationLabels } = require('./destination.labels');

  const iso2 = String(match.iso2 || '').toUpperCase();
  if (!iso2) return {};

  const cityParts = String(match.city_name || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const candidates = [...cityParts, match.city_name, match.name_en].filter(Boolean);

  let to_city = '';
  for (const raw of candidates) {
    const fromCatalog = matchCityFromText(raw);
    if (fromCatalog?.city) {
      to_city = canonicalizeApiCity(fromCatalog.city, iso2);
      break;
    }
    const normalized = normalizeToCity(raw, iso2);
    const canonical = canonicalizeApiCity(normalized, iso2);
    if (canonical && !isCountryPlaceholderToCity(canonical, iso2)) {
      to_city = canonical;
      break;
    }
    if (/шарм|sharm/i.test(raw)) {
      to_city = canonicalizeApiCity('Sharm El Sheikh', iso2);
      break;
    }
    if (/марса|marsa/i.test(raw)) {
      to_city = canonicalizeApiCity('Marsa Alam', iso2);
      break;
    }
    if (/дуб/i.test(raw) && iso2 === 'AE') {
      to_city = 'Dubai';
      break;
    }
  }

  if (!to_city) {
    to_city = getDefaultCityForCountry(iso2) || '';
  }

  if (iso2 === 'AE' && to_city && !/^(Dubai|Abu Dhabi)$/i.test(to_city)) {
    const blob = `${to_city} ${candidates.join(' ')}`.toLowerCase();
    if (/dubai|дуб|jumeirah|джумейр|palm|пальм|deira|дейра|marina|марина|kundu|кунду|lara/i.test(blob)) {
      to_city = /abu|абу/i.test(blob) ? 'Abu Dhabi' : 'Dubai';
    }
  }

  const patch = { to_country: iso2 };
  if (to_city) patch.to_city = to_city;
  return syncDestinationLabels(patch);
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

const MIN_MATCH_SCORE = 20;
const STRONG_MATCH_SCORE = 90;
const AMBIGUITY_GAP = 14;

/**
 * Query the autocomplete API across all query variants and return a deduped,
 * score-sorted list of candidate hotels. This is the single source of truth —
 * the API decides what is a real hotel, not a hardcoded list.
 */
async function findHotelMatches(hotelName, fromCity = 'Moscow', hints = {}) {
  const normalized = applyQueryAliases(hotelName);
  if (!normalized || normalized.length < 3) return { normalized, matches: [] };

  const variants = buildQueryVariants(normalized);
  const byId = new Map();

  for (const query of variants) {
    let results;
    try {
      results = await fetchAutocompleteResults(query, fromCity);
    } catch (err) {
      console.warn('[V2 hotel.resolver] autocomplete failed:', err.message);
      continue;
    }
    for (const candidate of results || []) {
      if (!candidate?.id) continue;
      const score = scoreHotelMatch(normalized, candidate, hints);
      const key = String(candidate.id);
      const prev = byId.get(key);
      if (!prev || score > prev.score) byId.set(key, { candidate, score });
    }
    const top = byId.size ? Math.max(...[...byId.values()].map((m) => m.score)) : 0;
    if (top >= STRONG_MATCH_SCORE) break;
  }

  const matches = [...byId.values()].sort((a, b) => b.score - a.score);
  return { normalized, matches };
}

function toResolvedHotel(match, fallbackName) {
  const destination = buildDestinationFromHotel(match.candidate);
  return {
    hotel_id: String(match.candidate.id),
    hotel_name: match.candidate.name || match.candidate.name_en || fallbackName,
    score: match.score,
    ...destination,
  };
}

/**
 * Resolve a hotel name with an explicit outcome:
 *   - status 'resolved'   → confident single hotel (`hotel`)
 *   - status 'ambiguous'  → several plausible hotels in different cities
 *                           (`options` — ask the user which one)
 *   - status 'not_found'  → nothing convincing
 */
async function resolveHotelDetailed(hotelName, fromCity = 'Moscow', hints = {}) {
  const { normalized, matches } = await findHotelMatches(hotelName, fromCity, hints);

  if (!matches.length) {
    return { status: 'not_found', hotel: null, options: [] };
  }

  const top = matches[0];
  if (top.score < MIN_MATCH_SCORE) {
    return {
      status: 'not_found',
      hotel: null,
      options: matches.slice(0, 3).map((m) => toResolvedHotel(m, normalized)),
    };
  }

  // Candidates within a small gap of the leader, sitting in different
  // cities/countries → genuinely ambiguous, so we should ask the user.
  const contenders = matches.filter(
    (m) => m.score >= MIN_MATCH_SCORE && top.score - m.score <= AMBIGUITY_GAP,
  );
  const distinctPlaces = new Set(
    contenders.map(
      (m) =>
        `${String(m.candidate.iso2 || '').toUpperCase()}|${String(
          m.candidate.city_name || '',
        ).toLowerCase()}`,
    ),
  );

  if (contenders.length >= 2 && distinctPlaces.size >= 2) {
    return {
      status: 'ambiguous',
      hotel: toResolvedHotel(top, normalized),
      options: contenders.slice(0, 4).map((m) => toResolvedHotel(m, normalized)),
    };
  }

  return { status: 'resolved', hotel: toResolvedHotel(top, normalized), options: [] };
}

/**
 * Backward-compatible resolve: returns the best hotel (resolved or the top of
 * an ambiguous set) or null. Prefer `resolveHotelDetailed` when you want to
 * ask the user to disambiguate.
 */
async function resolveHotelByName(hotelName, fromCity = 'Moscow', hints = {}) {
  const result = await resolveHotelDetailed(hotelName, fromCity, hints);
  return result.hotel;
}

module.exports = {
  extractHotelNameFromText,
  extractHotelCandidate,
  resolveHotelByName,
  resolveHotelDetailed,
  buildDestinationFromHotel,
  containsHotelBrand,
  isLikelyHotelName,
  isPureDestination,
  normalizeHotelNameCandidate,
};
