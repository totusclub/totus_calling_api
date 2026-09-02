/**
 * Normalize V2 search params to the format expected by Totus / Level.Travel API.
 */

const FROM_CITY_ALIASES = {
  москва: 'Moscow',
  moscow: 'Moscow',
  'санкт-петербург': 'Saint Petersburg',
  'saint petersburg': 'Saint Petersburg',
  'st petersburg': 'Saint Petersburg',
  'st. petersburg': 'Saint Petersburg',
  спб: 'Saint Petersburg',
  питер: 'Saint Petersburg',
  кazan: 'Kazan',
  казань: 'Kazan',
  екатеринбург: 'Yekaterinburg',
  yekaterinburg: 'Yekaterinburg',
  новосибирск: 'Novosibirsk',
  novosibirsk: 'Novosibirsk',
};

const TO_CITY_ALIASES = {
  дубай: 'Dubai',
  dubai: 'Dubai',
  'abu dhabi': 'Abu Dhabi',
  'абу-даби': 'Abu Dhabi',
  'абу даби': 'Abu Dhabi',
  анталья: 'Antalya',
  antalya: 'Antalya',
  анталия: 'Antalya',
  antalia: 'Antalya',
  стамбул: 'Istanbul',
  istanbul: 'Istanbul',
  хургада: 'Hurghada',
  hurghada: 'Hurghada',
  белек: 'Belek',
  belek: 'Belek',
  sharm: 'Sharm El Sheikh',
  'шарм': 'Sharm El Sheikh',
  'шarm el sheikh': 'Sharm El Sheikh',
  бангкок: 'Bangkok',
  bangkok: 'Bangkok',
  пхукет: 'Phuket',
  phuket: 'Phuket',
  бали: 'Bali Island',
  bali: 'Bali Island',
  балли: 'Bali Island',
  'bali island': 'Bali Island',
  париж: 'Paris',
  paris: 'Paris',
  рим: 'Rome',
  rome: 'Rome',
  барcelona: 'Barcelona',
  барселона: 'Barcelona',
  barcelona: 'Barcelona',
};

const COUNTRY_PLACEHOLDER_NAMES = {
  TR: ['турция', 'turkey', 'tr', 'турцию', 'турции', 'турцией'],
  EG: ['египет', 'egypt', 'eg', 'египта', 'египту'],
  TH: ['таиланд', 'thailand', 'th', 'таиланда', 'таиланду'],
  GR: ['греция', 'greece', 'gr', 'греции', 'грецию'],
  ES: ['испания', 'spain', 'es', 'испании', 'испанию'],
  CY: ['кипр', 'cyprus', 'cy', 'кипра', 'кипру'],
  AE: ['оаэ', 'ae', 'эмираты', 'эмиратов'],
  MA: ['марокко', 'morocco', 'ma'],
  TN: ['тунис', 'tunisia', 'tn', 'туниса', 'тунису'],
  VN: ['вьетнам', 'vietnam', 'vn', 'вьетнама', 'вьетнаму'],
  MV: ['мальдивы', 'maldives', 'mv', 'мальдив'],
  ID: ['индонезия', 'indonesia', 'id', 'индонезию', 'индонезии'],
  IT: ['италия', 'italy', 'it', 'италии', 'италию'],
  FR: ['франция', 'france', 'fr', 'франции', 'францию'],
};

function isCountryPlaceholderToCity(toCity, toCountry) {
  if (!toCity || typeof toCity !== 'string') return false;
  const key = toCity.trim().toLowerCase();
  if (!key) return false;
  if (toCountry && key === String(toCountry).toLowerCase()) return true;
  const placeholders = COUNTRY_PLACEHOLDER_NAMES[toCountry] || [];
  if (placeholders.includes(key)) return true;
  for (const names of Object.values(COUNTRY_PLACEHOLDER_NAMES)) {
    if (names.includes(key)) return true;
  }
  return false;
}

function formatDateYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const INVALID_FROM_CITY =
  /вариант|лучше|какой|этих|отел|найти|интернет|показан|списк|не\s*важно|неважно|без\s*разниц|вс[её]\s*равно|любой|любого|не\s*знаю|решай|как\s*хочешь|пофиг|скажи|помоги/i;

/** Totus /start-search accepts flex_dates 0–6; 7+ returns HTTP 500. */
const MAX_FLEX_DATES = 6;

function clampFlexDates(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 2;
  return Math.min(MAX_FLEX_DATES, Math.max(0, Math.round(n)));
}

function normalizeFromCity(value) {
  if (!value || typeof value !== 'string') return value;
  const key = value.trim().toLowerCase();
  if (INVALID_FROM_CITY.test(key)) return 'Moscow';
  if (FROM_CITY_ALIASES[key]) return FROM_CITY_ALIASES[key];
  for (const [alias, canonical] of Object.entries(FROM_CITY_ALIASES)) {
    if (key.includes(alias)) return canonical;
  }
  // API expects latin city names — unknown cyrillic values (e.g. «Не важно»,
  // random phrases) cause /start-search 500. Fall back to Moscow.
  if (/[а-яё]/i.test(key)) return 'Moscow';
  return value.trim();
}

/** Bare reply to «из какого города вылетаете?» — not a travel destination. */
function isDepartureCityOnlyText(text) {
  const key = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!key || key.length > 40) return false;
  if (FROM_CITY_ALIASES[key]) return true;
  if (/^(москв\w*|moscow)$/.test(key)) return true;
  if (/^(питер|спб|санкт-?петербург|saint petersburg|st\.?\s*petersburg)$/.test(key)) return true;
  if (/^(казан\w*|екатеринбург|новосибирск|yekaterinburg|novosibirsk|kazan)$/.test(key)) {
    return true;
  }
  return false;
}

function normalizeToCity(value, toCountry) {
  if (!value || typeof value !== 'string') return value;
  const key = value.trim().toLowerCase();
  if (TO_CITY_ALIASES[key]) return TO_CITY_ALIASES[key];
  if (toCountry === 'AE' && /дуб/i.test(key)) return 'Dubai';
  return value.trim();
}

/**
 * If date is in the past, bump to the next future occurrence (same month/day).
 */
function normalizeStartDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return dateStr;
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateStr;

  let candidate = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00`);
  if (Number.isNaN(candidate.getTime())) return dateStr;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  while (candidate < today) {
    candidate.setFullYear(candidate.getFullYear() + 1);
  }

  return formatDateYmd(candidate);
}

const {
  COUNTRY_DEFAULT_CITY,
  COUNTRY_QUERY_ALIASES,
  applyCountryDefaultCity,
  canonicalizeApiCity,
} = require('./destination.catalog');

function normalizeSearchParamsForApi(params = {}) {
  const p = applyCountryDefaultCity({ ...params });

  if (p.from_city) {
    p.from_city = normalizeFromCity(p.from_city);
  }
  if (p.to_city) {
    if (isCountryPlaceholderToCity(p.to_city, p.to_country)) {
      delete p.to_city;
    } else {
      p.to_city = canonicalizeApiCity(normalizeToCity(p.to_city, p.to_country), p.to_country);
    }
  }
  const withCity = applyCountryDefaultCity(p);
  Object.assign(p, withCity);
  if (p.start_date) {
    p.start_date = normalizeStartDate(p.start_date);
  }
  if (p.nights !== undefined && p.nights !== '') {
    p.nights = String(p.nights);
  }
  if (p.adults !== undefined && p.adults !== '') {
    p.adults = String(p.adults);
  }
  if (p.kids !== undefined && p.kids !== '') {
    p.kids = String(p.kids);
  }
  if (p.flex_dates !== undefined && p.flex_dates !== '') {
    p.flex_dates = clampFlexDates(p.flex_dates);
  }

  return p;
}

module.exports = {
  normalizeFromCity,
  normalizeToCity,
  normalizeStartDate,
  normalizeSearchParamsForApi,
  isCountryPlaceholderToCity,
  isDepartureCityOnlyText,
  clampFlexDates,
  MAX_FLEX_DATES,
  applyCountryDefaultCity,
  COUNTRY_DEFAULT_CITY,
  COUNTRY_QUERY_ALIASES,
};
