/**
 * Human-readable Russian destination labels for user-facing messages.
 * API/search still uses ISO country codes and English city names internally.
 */

const COUNTRY_LABELS = {
  TR: { nom: 'Турция', prep: 'Турции' },
  EG: { nom: 'Египет', prep: 'Египте' },
  TH: { nom: 'Таиланд', prep: 'Таиланде' },
  GR: { nom: 'Греция', prep: 'Греции' },
  ES: { nom: 'Испания', prep: 'Испании' },
  CY: { nom: 'Кипр', prep: 'Кипре' },
  AE: { nom: 'ОАЭ', prep: 'ОАЭ' },
  MA: { nom: 'Марокко', prep: 'Марокко' },
  TN: { nom: 'Тунис', prep: 'Тунисе' },
  VN: { nom: 'Вьетнам', prep: 'Вьетнаме' },
  MV: { nom: 'Мальдивы', prep: 'Мальдивах' },
  ID: { nom: 'Индонезия', prep: 'Индонезии' },
  IT: { nom: 'Италия', prep: 'Италии' },
  FR: { nom: 'Франция', prep: 'Франции' },
  LK: { nom: 'Шри-Ланка', prep: 'Шри-Ланке' },
  OM: { nom: 'Оман', prep: 'Омане' },
  QA: { nom: 'Катар', prep: 'Катаре' },
  JO: { nom: 'Иордания', prep: 'Иордании' },
  ME: { nom: 'Черногория', prep: 'Черногории' },
  HR: { nom: 'Хорватия', prep: 'Хорватии' },
  IN: { nom: 'Индия', prep: 'Индии' },
  CN: { nom: 'Китай', prep: 'Китае' },
  JP: { nom: 'Япония', prep: 'Японии' },
  KR: { nom: 'Южная Корея', prep: 'Южной Корее' },
  SC: { nom: 'Сейшелы', prep: 'Сейшелах' },
  MU: { nom: 'Маврикий', prep: 'Маврикии' },
  CU: { nom: 'Куба', prep: 'Кубе' },
  MX: { nom: 'Мексика', prep: 'Мексике' },
  DO: { nom: 'Доминикана', prep: 'Доминикане' },
  TZ: { nom: 'Танзания', prep: 'Танзании' },
  RU: { nom: 'Россия', prep: 'России' },
  GE: { nom: 'Грузия', prep: 'Грузии' },
  AM: { nom: 'Армения', prep: 'Армении' },
  AZ: { nom: 'Азербайджан', prep: 'Азербайджане' },
  PT: { nom: 'Португалия', prep: 'Португалии' },
  DE: { nom: 'Германия', prep: 'Германии' },
  AT: { nom: 'Австрия', prep: 'Австрии' },
  CH: { nom: 'Швейцария', prep: 'Швейцарии' },
  CZ: { nom: 'Чехия', prep: 'Чехии' },
  US: { nom: 'США', prep: 'США' },
};

const CITY_LABELS = {
  Antalya: { nom: 'Анталья', prep: 'Анталье' },
  Belek: { nom: 'Белек', prep: 'Белеке' },
  Istanbul: { nom: 'Стамбул', prep: 'Стамбуле' },
  Dubai: { nom: 'Дубай', prep: 'Дубае' },
  'Abu Dhabi': { nom: 'Абу-Даби', prep: 'Абу-Даби' },
  Bali: { nom: 'Бали', prep: 'Бали' },
  Hurghada: { nom: 'Хургада', prep: 'Хургаде' },
  'Sharm El Sheikh': { nom: 'Шарм-эль-Шейх', prep: 'Шарм-эль-Шейхе' },
  Phuket: { nom: 'Пхукет', prep: 'Пхукете' },
  Bangkok: { nom: 'Бангкок', prep: 'Бангкоке' },
  Barcelona: { nom: 'Барселона', prep: 'Барселоне' },
  Rome: { nom: 'Рим', prep: 'Риме' },
  Paris: { nom: 'Париж', prep: 'Париже' },
  Moscow: { nom: 'Москва', prep: 'Москве' },
  'Saint Petersburg': { nom: 'Санкт-Петербург', prep: 'Санкт-Петербурге' },
};

const ISO_CODE = /^[A-Z]{2}$/i;

function normalizeCityKey(value) {
  return String(value || '').trim();
}

function normalizeCountryKey(value) {
  return String(value || '').trim().toUpperCase();
}

function getCountryNom(code) {
  const key = normalizeCountryKey(code);
  if (!key) return '';
  if (COUNTRY_LABELS[key]) return COUNTRY_LABELS[key].nom;
  if (ISO_CODE.test(key)) return '';
  return String(code).trim();
}

function getCountryPrep(code) {
  const key = normalizeCountryKey(code);
  if (!key) return '';
  if (COUNTRY_LABELS[key]) return COUNTRY_LABELS[key].prep;
  if (ISO_CODE.test(key)) return '';
  return getCountryNom(code);
}

function getCityNom(city) {
  const key = normalizeCityKey(city);
  if (!key) return '';
  if (CITY_LABELS[key]) return CITY_LABELS[key].nom;
  return key;
}

function getCityPrep(city) {
  const key = normalizeCityKey(city);
  if (!key) return '';
  if (CITY_LABELS[key]) return CITY_LABELS[key].prep;
  return getCityNom(city);
}

function isHotelSearch(params) {
  const p = params || {};
  return Boolean(
    p.search_intent === 'hotel' ||
      p.search_type === 'hotel' ||
      (Array.isArray(p.hotel_ids) && p.hotel_ids.length > 0),
  );
}

function buildLiveDestinationSummary(params) {
  const p = params || {};
  const cityNom = p.to_city ? getCityNom(p.to_city) : '';
  const countryNom = p.to_country ? getCountryNom(p.to_country) : '';
  if (cityNom && countryNom && cityNom !== countryNom) {
    return `${cityNom}, ${countryNom}`;
  }
  if (cityNom) return cityNom;
  if (countryNom) return countryNom;
  return '';
}

function buildLiveDestinationPhrase(params) {
  const p = params || {};
  const cityPrep = p.to_city ? getCityPrep(p.to_city) : '';
  const countryNom = p.to_country ? getCountryNom(p.to_country) : '';
  if (cityPrep && countryNom) {
    const cityNom = getCityNom(p.to_city);
    if (cityNom === countryNom) return cityPrep;
    return `${cityPrep}, ${countryNom}`;
  }
  if (cityPrep) return cityPrep;
  if (p.to_country) return getCountryPrep(p.to_country);
  return '';
}

/**
 * Short label for summaries (nominative): «куда: Индонезия», «куда: Анталья».
 */
function formatDestinationSummary(params) {
  const p = params || {};
  if (isHotelSearch(p) && p.hotel_name && (p.hotel_ids?.length || p.search_intent === 'hotel')) {
    return String(p.hotel_name).trim();
  }
  const live = buildLiveDestinationSummary(p);
  if (live) return live;
  if (p.destination_label && String(p.destination_label).trim()) {
    return String(p.destination_label).trim();
  }
  return '';
}

/**
 * Phrase after «в» for search results: «в Индонезии», «в Анталье, Турция».
 */
function formatDestinationInPhrase(params) {
  const p = params || {};
  if (isHotelSearch(p) && p.hotel_name && (p.hotel_ids?.length || p.search_intent === 'hotel')) {
    return String(p.hotel_name).trim();
  }
  const live = buildLiveDestinationPhrase(p);
  if (live) return live;
  if (p.destination_label_prep && String(p.destination_label_prep).trim()) {
    return String(p.destination_label_prep).trim();
  }
  return '';
}

/** Persist labels that match current to_country / to_city (never leave stale Sharm when params say Belek). */
function syncDestinationLabels(params) {
  const p = params || {};
  return {
    ...p,
    destination_label: formatDestinationSummary(p),
    destination_label_prep: formatDestinationInPhrase(p),
  };
}

/**
 * Phrase after «по» for no-results: «по Индонезии», «по Анталье».
 */
function formatDestinationPoPhrase(params) {
  const phrase = formatDestinationInPhrase(params);
  return phrase || 'этому направлению';
}

module.exports = {
  getCountryNom,
  getCountryPrep,
  getCityNom,
  getCityPrep,
  buildLiveDestinationSummary,
  buildLiveDestinationPhrase,
  formatDestinationSummary,
  formatDestinationInPhrase,
  formatDestinationPoPhrase,
  syncDestinationLabels,
  isHotelSearch,
};
