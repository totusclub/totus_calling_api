/**
 * Single source of truth: country defaults, query aliases, city Russian labels,
 * and sanitization of raw API region names (e.g. «Aegean Sea Turkey»).
 */

/** Default package resort when user names only the country. */
const COUNTRY_DEFAULT_CITY = {
  TR: 'Antalya',
  EG: 'Hurghada',
  TH: 'Phuket',
  GR: 'Crete',
  ES: 'Tenerife',
  CY: 'Ayia Napa',
  AE: 'Dubai',
  MV: 'Male',
  ID: 'Bali Island',
  VN: 'Nha Trang',
  MA: 'Agadir',
  TN: 'Hammamet',
  IT: 'Rimini',
  LK: 'Bentota',
  OM: 'Muscat',
  QA: 'Doha',
  JO: 'Aqaba',
  ME: 'Budva',
  HR: 'Dubrovnik',
  IN: 'Goa',
  CN: 'Sanya',
  JP: 'Tokyo',
  KR: 'Seoul',
  SC: 'Mahe',
  MU: 'Grand Baie',
  CU: 'Varadero',
  MX: 'Cancun',
  DO: 'Punta Cana',
  TZ: 'Zanzibar',
  GE: 'Batumi',
  AZ: 'Baku',
  PT: 'Algarve',
  FR: 'Paris',
  DE: 'Berlin',
  AT: 'Vienna',
  CH: 'Zurich',
  CZ: 'Prague',
  US: 'Miami',
  AM: 'Yerevan',
  RU: 'Sochi',
};

/**
 * Package /start-search: search by country only (no to_city).
 * AM + Yerevan → API 500; AM without to_city → OK.
 * MV + Male → Male is the airport hub, not a resort; users book «Мальдивы», not «Мале».
 */
const PACKAGE_COUNTRY_WITHOUT_CITY = new Set(['AM', 'MV']);

/** Russian / English country names → ISO code (incl. common cases). */
const COUNTRY_QUERY_ALIASES = {
  турция: 'TR',
  турцию: 'TR',
  турции: 'TR',
  турцией: 'TR',
  turkey: 'TR',
  египет: 'EG',
  египта: 'EG',
  египту: 'EG',
  египит: 'EG',
  египед: 'EG',
  egypt: 'EG',
  таиланд: 'TH',
  таиланда: 'TH',
  таиланду: 'TH',
  thailand: 'TH',
  греция: 'GR',
  греции: 'GR',
  грецию: 'GR',
  greece: 'GR',
  испания: 'ES',
  испании: 'ES',
  испанию: 'ES',
  spain: 'ES',
  кипр: 'CY',
  кипра: 'CY',
  кипру: 'CY',
  cyprus: 'CY',
  оаэ: 'AE',
  эмираты: 'AE',
  эмиратов: 'AE',
  uae: 'AE',
  марокко: 'MA',
  morocco: 'MA',
  тунис: 'TN',
  туниса: 'TN',
  тунису: 'TN',
  tunisia: 'TN',
  вьетнам: 'VN',
  вьетнама: 'VN',
  вьетнаму: 'VN',
  vietnam: 'VN',
  мальдивы: 'MV',
  мальдив: 'MV',
  малдиви: 'MV',
  мальдиви: 'MV',
  maldives: 'MV',
  италия: 'IT',
  италии: 'IT',
  италию: 'IT',
  italy: 'IT',
  франция: 'FR',
  франции: 'FR',
  францию: 'FR',
  франсиу: 'FR',
  франсиа: 'FR',
  france: 'FR',
  индонезия: 'ID',
  индонезии: 'ID',
  индонезию: 'ID',
  indonesia: 'ID',
  'шри-ланка': 'LK',
  'шри ланка': 'LK',
  'sri lanka': 'LK',
  оман: 'OM',
  oman: 'OM',
  катар: 'QA',
  qatar: 'QA',
  иордания: 'JO',
  иордании: 'JO',
  jordan: 'JO',
  черногория: 'ME',
  черногории: 'ME',
  montenegro: 'ME',
  хорватия: 'HR',
  хорватии: 'HR',
  croatia: 'HR',
  индия: 'IN',
  индии: 'IN',
  india: 'IN',
  китай: 'CN',
  китая: 'CN',
  china: 'CN',
  япония: 'JP',
  японии: 'JP',
  japan: 'JP',
  корея: 'KR',
  'южная корея': 'KR',
  'south korea': 'KR',
  сейшелы: 'SC',
  seychelles: 'SC',
  маврикий: 'MU',
  mauritius: 'MU',
  куба: 'CU',
  cuba: 'CU',
  мексика: 'MX',
  mexico: 'MX',
  доминикана: 'DO',
  dominicana: 'DO',
  'доминиканская республика': 'DO',
  танзания: 'TZ',
  tanzania: 'TZ',
  грузия: 'GE',
  грузии: 'GE',
  georgia: 'GE',
  армения: 'AM',
  армении: 'AM',
  armenia: 'AM',
  азербайджан: 'AZ',
  azerbaijan: 'AZ',
  португалия: 'PT',
  португалии: 'PT',
  portugal: 'PT',
  германия: 'DE',
  германии: 'DE',
  germany: 'DE',
  австрия: 'AT',
  австрии: 'AT',
  austria: 'AT',
  швейцария: 'CH',
  швейцарии: 'CH',
  switzerland: 'CH',
  чехия: 'CZ',
  чехии: 'CZ',
  czechia: 'CZ',
  сша: 'US',
  usa: 'US',
  россия: 'RU',
  россии: 'RU',
  russia: 'RU',
};

/** Canonical API city keys for KNOWN_CITY_RESOLVES and autocomplete shortcuts. */
const KNOWN_CITY_RESOLVES = {
  bali: { country: 'ID', city: 'Bali Island' },
  бали: { country: 'ID', city: 'Bali Island' },
  балли: { country: 'ID', city: 'Bali Island' },
  'bali island': { country: 'ID', city: 'Bali Island' },
  'о. бали': { country: 'ID', city: 'Bali Island' },
  antalya: { country: 'TR', city: 'Antalya' },
  antalia: { country: 'TR', city: 'Antalya' },
  анталья: { country: 'TR', city: 'Antalya' },
  анталиа: { country: 'TR', city: 'Antalya' },
  анталия: { country: 'TR', city: 'Antalya' },
  анталиу: { country: 'TR', city: 'Antalya' },
  анталию: { country: 'TR', city: 'Antalya' },
  анталиа: { country: 'TR', city: 'Antalya' },
  антител: { country: 'TR', city: 'Antalya' },
  антитела: { country: 'TR', city: 'Antalya' },
  belek: { country: 'TR', city: 'Belek' },
  белек: { country: 'TR', city: 'Belek' },
  side: { country: 'TR', city: 'Side' },
  сиде: { country: 'TR', city: 'Side' },
  kemer: { country: 'TR', city: 'Kemer' },
  кемер: { country: 'TR', city: 'Kemer' },
  marmaris: { country: 'TR', city: 'Marmaris' },
  мармарис: { country: 'TR', city: 'Marmaris' },
  alanya: { country: 'TR', city: 'Alanya' },
  аланья: { country: 'TR', city: 'Alanya' },
  istanbul: { country: 'TR', city: 'Istanbul' },
  стамбул: { country: 'TR', city: 'Istanbul' },
  dubai: { country: 'AE', city: 'Dubai' },
  дубай: { country: 'AE', city: 'Dubai' },
  'abu dhabi': { country: 'AE', city: 'Abu Dhabi' },
  'абу-даби': { country: 'AE', city: 'Abu Dhabi' },
  'абу даби': { country: 'AE', city: 'Abu Dhabi' },
  hurghada: { country: 'EG', city: 'Hurghada' },
  хургада: { country: 'EG', city: 'Hurghada' },
  sharm: { country: 'EG', city: 'Sharm El Sheikh' },
  шарм: { country: 'EG', city: 'Sharm El Sheikh' },
  'шарм эль шейх': { country: 'EG', city: 'Sharm El Sheikh' },
  'шарм эл шейх': { country: 'EG', city: 'Sharm El Sheikh' },
  'шарм-эль-шейх': { country: 'EG', city: 'Sharm El Sheikh' },
  'sharm el sheikh': { country: 'EG', city: 'Sharm El Sheikh' },
  phuket: { country: 'TH', city: 'Phuket' },
  пхукет: { country: 'TH', city: 'Phuket' },
  bangkok: { country: 'TH', city: 'Bangkok' },
  бангкок: { country: 'TH', city: 'Bangkok' },
  pattaya: { country: 'TH', city: 'Pattaya' },
  паттайя: { country: 'TH', city: 'Pattaya' },
  paris: { country: 'FR', city: 'Paris' },
  париж: { country: 'FR', city: 'Paris' },
  rome: { country: 'IT', city: 'Rome' },
  рим: { country: 'IT', city: 'Rome' },
  barcelona: { country: 'ES', city: 'Barcelona' },
  барселона: { country: 'ES', city: 'Barcelona' },
  cancun: { country: 'MX', city: 'Cancun' },
  канкун: { country: 'MX', city: 'Cancun' },
  'punta cana': { country: 'DO', city: 'Punta Cana' },
  'пунта-кана': { country: 'DO', city: 'Punta Cana' },
  ереван: { country: 'AM', city: 'Yerevan' },
  yerevan: { country: 'AM', city: 'Yerevan' },
};

/** Raw API region/metaregion names → canonical search city. */
const API_CITY_CANONICAL = {
  'aegean sea turkey': 'Antalya',
  'mediterranean turkey': 'Antalya',
  'turkish riviera': 'Antalya',
  'antalya coast': 'Antalya',
  'red sea egypt': 'Hurghada',
  'red sea': 'Hurghada',
  'south sinai': 'Sharm El Sheikh',
  'andaman sea thailand': 'Phuket',
  'gulf of thailand': 'Pattaya',
  'bali indonesia': 'Bali Island',
  'lesser sunda islands': 'Bali Island',
};

/** Russian display labels for API city names (nominative / prepositional). */
const CITY_LABELS_RU = {
  Antalya: { nom: 'Анталья', prep: 'Анталье' },
  Belek: { nom: 'Белек', prep: 'Белеке' },
  Side: { nom: 'Сиде', prep: 'Сиде' },
  Kemer: { nom: 'Кемер', prep: 'Кемере' },
  Marmaris: { nom: 'Мармарис', prep: 'Мармарисе' },
  Alanya: { nom: 'Аланья', prep: 'Аланье' },
  Istanbul: { nom: 'Стамбул', prep: 'Стамбуле' },
  Dubai: { nom: 'Дубай', prep: 'Дубае' },
  'Abu Dhabi': { nom: 'Абу-Даби', prep: 'Абу-Даби' },
  Bali: { nom: 'Бали', prep: 'Бали' },
  'Bali Island': { nom: 'Бали', prep: 'Бали' },
  Hurghada: { nom: 'Хургада', prep: 'Хургаде' },
  'Sharm El Sheikh': { nom: 'Шарм-эль-Шейх', prep: 'Шарм-эль-Шейхе' },
  Phuket: { nom: 'Пхукет', prep: 'Пхукете' },
  Pattaya: { nom: 'Паттайя', prep: 'Паттайе' },
  Bangkok: { nom: 'Бангкок', prep: 'Бангкоке' },
  Barcelona: { nom: 'Барселона', prep: 'Барселоне' },
  Tenerife: { nom: 'Тенерифе', prep: 'Тенерифе' },
  Rome: { nom: 'Рим', prep: 'Риме' },
  Rimini: { nom: 'Римини', prep: 'Римини' },
  Paris: { nom: 'Париж', prep: 'Париже' },
  Crete: { nom: 'Крит', prep: 'Крите' },
  'Ayia Napa': { nom: 'Айя-Напа', prep: 'Айя-Напе' },
  Male: { nom: 'Мале', prep: 'Мале' },
  'Nha Trang': { nom: 'Нячанг', prep: 'Нячанге' },
  Agadir: { nom: 'Агадир', prep: 'Агадире' },
  Hammamet: { nom: 'Хаммамет', prep: 'Хаммамете' },
  Bentota: { nom: 'Бентота', prep: 'Бентоте' },
  Muscat: { nom: 'Маскат', prep: 'Маскате' },
  Doha: { nom: 'Доха', prep: 'Дохе' },
  Aqaba: { nom: 'Акаба', prep: 'Акабе' },
  Budva: { nom: 'Будва', prep: 'Будве' },
  Dubrovnik: { nom: 'Дубровник', prep: 'Дубровнике' },
  Goa: { nom: 'Гоа', prep: 'Гоа' },
  Sanya: { nom: 'Санья', prep: 'Санье' },
  Tokyo: { nom: 'Токио', prep: 'Токио' },
  Seoul: { nom: 'Сеул', prep: 'Сеуле' },
  Mahe: { nom: 'Маэ', prep: 'Маэ' },
  'Grand Baie': { nom: 'Гранд-Бэй', prep: 'Гранд-Бэй' },
  Varadero: { nom: 'Варадеро', prep: 'Варадеро' },
  Cancun: { nom: 'Канкун', prep: 'Канкуне' },
  'Punta Cana': { nom: 'Пунта-Кана', prep: 'Пунта-Кане' },
  Zanzibar: { nom: 'Занзибар', prep: 'Занзибаре' },
  Batumi: { nom: 'Батуми', prep: 'Батуми' },
  Baku: { nom: 'Баку', prep: 'Баку' },
  Algarve: { nom: 'Алгарве', prep: 'Алгарве' },
  Berlin: { nom: 'Берлин', prep: 'Берлине' },
  Vienna: { nom: 'Вена', prep: 'Вене' },
  Zurich: { nom: 'Цюрих', prep: 'Цюрихе' },
  Prague: { nom: 'Прага', prep: 'Праге' },
  Miami: { nom: 'Майами', prep: 'Майами' },
  Yerevan: { nom: 'Ереван', prep: 'Ереване' },
  Sochi: { nom: 'Сочи', prep: 'Сочи' },
  Moscow: { nom: 'Москва', prep: 'Москве' },
  'Saint Petersburg': { nom: 'Санкт-Петербург', prep: 'Санкт-Петербурге' },
};

const COUNTRY_NAME_IN_CITY =
  /\b(turkey|egypt|thailand|spain|greece|indonesia|cyprus|vietnam|morocco|tunisia|italy|france|germany|portugal|croatia|montenegro|india|china|japan|mexico|cuba|mauritius|seychelles|maldives)\b/i;

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .trim();
}

function matchCountryCodeFromText(text) {
  const q = normalizeKey(text);
  if (!q) return null;
  const entries = Object.entries(COUNTRY_QUERY_ALIASES).sort((a, b) => b[0].length - a[0].length);
  for (const [alias, code] of entries) {
    if (q === alias || q.includes(alias)) return code;
    // Russian cases: «турцию» matches «турци», «египит» ~ «египе»
    if (alias.length >= 4) {
      const stem = alias.slice(0, -1);
      if (stem.length >= 3 && (q.includes(stem) || q === stem)) return code;
    }
  }
  return null;
}

function matchCityFromText(text) {
  const q = normalizeKey(text);
  if (!q) return null;
  const entries = Object.entries(KNOWN_CITY_RESOLVES).sort((a, b) => b[0].length - a[0].length);
  for (const [alias, dest] of entries) {
    if (q === alias || q.includes(alias)) return dest;
    if (alias.length >= 4) {
      const stem = alias.slice(0, -1);
      if (stem.length >= 3 && q.includes(stem)) return dest;
    }
  }
  return null;
}

function getDefaultCityForCountry(countryCode) {
  return COUNTRY_DEFAULT_CITY[String(countryCode || '').toUpperCase()] || '';
}

function isRedundantApiCityName(city, countryCode) {
  const key = String(city || '').trim();
  if (!key) return false;
  if (CITY_LABELS_RU[key]) return false;
  const lower = key.toLowerCase();
  if (API_CITY_CANONICAL[lower]) return true;
  if (COUNTRY_NAME_IN_CITY.test(lower)) return true;
  if (/\b(sea|coast|riviera|gulf|islands|region|area)\b/i.test(lower)) return true;
  if (countryCode) {
    const placeholders = Object.entries(COUNTRY_QUERY_ALIASES)
      .filter(([, code]) => code === countryCode)
      .map(([alias]) => alias);
    if (placeholders.some((p) => lower === p || lower.includes(p))) return true;
  }
  return false;
}

function canonicalizeApiCity(city, countryCode) {
  const key = String(city || '').trim();
  if (!key) return key;
  const lower = key.toLowerCase();
  if (API_CITY_CANONICAL[lower]) return API_CITY_CANONICAL[lower];
  if (CITY_LABELS_RU[key]) return key;
  const country = String(countryCode || '').toUpperCase();
  if (isRedundantApiCityName(key, country)) {
    return getDefaultCityForCountry(country) || key;
  }
  return key;
}

function applyCountryDefaultCity(params = {}) {
  const p = { ...params };
  if (!p.to_country || p.hotel_ids?.length) return p;
  const country = String(p.to_country).toUpperCase();
  if (PACKAGE_COUNTRY_WITHOUT_CITY.has(country)) {
    delete p.to_city;
    return p;
  }
  const defaultCity = getDefaultCityForCountry(country);
  if (!defaultCity) return p;
  if (!p.to_city || isRedundantApiCityName(p.to_city, country)) {
    p.to_city = defaultCity;
  }
  return p;
}

module.exports = {
  COUNTRY_DEFAULT_CITY,
  COUNTRY_QUERY_ALIASES,
  KNOWN_CITY_RESOLVES,
  API_CITY_CANONICAL,
  CITY_LABELS_RU,
  normalizeKey,
  matchCountryCodeFromText,
  matchCityFromText,
  getDefaultCityForCountry,
  isRedundantApiCityName,
  canonicalizeApiCity,
  applyCountryDefaultCity,
  PACKAGE_COUNTRY_WITHOUT_CITY,
};
