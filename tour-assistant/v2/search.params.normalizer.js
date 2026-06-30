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
  sharm: 'Sharm El Sheikh',
  'шарм': 'Sharm El Sheikh',
  'шarm el sheikh': 'Sharm El Sheikh',
  бангкок: 'Bangkok',
  bangkok: 'Bangkok',
  пхукет: 'Phuket',
  phuket: 'Phuket',
  бали: 'Bali',
  bali: 'Bali',
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

const INVALID_FROM_CITY = /вариант|лучше|какой|этих|отел|найти|интернет|показан|списк/i;

function normalizeFromCity(value) {
  if (!value || typeof value !== 'string') return value;
  const key = value.trim().toLowerCase();
  if (INVALID_FROM_CITY.test(key)) return 'Moscow';
  if (FROM_CITY_ALIASES[key]) return FROM_CITY_ALIASES[key];
  for (const [alias, canonical] of Object.entries(FROM_CITY_ALIASES)) {
    if (key.includes(alias)) return canonical;
  }
  return value.trim();
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

function normalizeSearchParamsForApi(params = {}) {
  const p = { ...params };

  if (p.from_city) {
    p.from_city = normalizeFromCity(p.from_city);
  }
  if (p.to_city) {
    if (isCountryPlaceholderToCity(p.to_city, p.to_country)) {
      delete p.to_city;
    } else {
      p.to_city = normalizeToCity(p.to_city, p.to_country);
    }
  }
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

  return p;
}

module.exports = {
  normalizeFromCity,
  normalizeToCity,
  normalizeStartDate,
  normalizeSearchParamsForApi,
  isCountryPlaceholderToCity,
};
