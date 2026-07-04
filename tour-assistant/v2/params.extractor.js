const {
  inferSearchIntentFromParams,
  isPostSearchAdvisoryText,
  isReady,
  userAsksHotelComparison,
} = require('./conversation.state');

const FROM_CITY_FALSE_POSITIVE = /^(этих|этого|these|those|вариант|показан|списк|лучше|какой|самый|найти|интернет)/i;

const MONTH_MAP = {
  января: '01',
  февраля: '02',
  марта: '03',
  апреля: '04',
  мая: '05',
  июня: '06',
  июля: '07',
  августа: '08',
  сентября: '09',
  октября: '10',
  ноября: '11',
  декабря: '12',
};

/** City/resort names — set both to_country and to_city. */
const CITY_DESTINATION_ALIASES = {
  'abu dhabi': { country: 'AE', city: 'Abu Dhabi' },
  'абу-даби': { country: 'AE', city: 'Abu Dhabi' },
  'абу даби': { country: 'AE', city: 'Abu Dhabi' },
  dubai: { country: 'AE', city: 'Dubai' },
  дубай: { country: 'AE', city: 'Dubai' },
  istanbul: { country: 'TR', city: 'Istanbul' },
  стамбул: { country: 'TR', city: 'Istanbul' },
  antalya: { country: 'TR', city: 'Antalya' },
  antalia: { country: 'TR', city: 'Antalya' },
  анталья: { country: 'TR', city: 'Antalya' },
  анталиа: { country: 'TR', city: 'Antalya' },
  анталия: { country: 'TR', city: 'Antalya' },
  анталиу: { country: 'TR', city: 'Antalya' },
  антител: { country: 'TR', city: 'Antalya' },
  антитела: { country: 'TR', city: 'Antalya' },
  belek: { country: 'TR', city: 'Belek' },
  белек: { country: 'TR', city: 'Belek' },
  paris: { country: 'FR', city: 'Paris' },
  париж: { country: 'FR', city: 'Paris' },
  bali: { country: 'ID', city: 'Bali Island' },
  бали: { country: 'ID', city: 'Bali Island' },
  балли: { country: 'ID', city: 'Bali Island' },
  'bali island': { country: 'ID', city: 'Bali Island' },
  hurghada: { country: 'EG', city: 'Hurghada' },
  хургада: { country: 'EG', city: 'Hurghada' },
  phuket: { country: 'TH', city: 'Phuket' },
  пхукет: { country: 'TH', city: 'Phuket' },
  bangkok: { country: 'TH', city: 'Bangkok' },
  бангкок: { country: 'TH', city: 'Bangkok' },
  barcelona: { country: 'ES', city: 'Barcelona' },
  барселона: { country: 'ES', city: 'Barcelona' },
  rome: { country: 'IT', city: 'Rome' },
  рим: { country: 'IT', city: 'Rome' },
};

const {
  applyCountryDefaultCity,
  matchCountryCodeFromText,
  matchCityFromText,
} = require('./destination.catalog');
const COUNTRY_ONLY_ALIASES = {
  турция: 'TR',
  turkey: 'TR',
  египет: 'EG',
  egypt: 'EG',
  таиланд: 'TH',
  thailand: 'TH',
  греция: 'GR',
  greece: 'GR',
  испания: 'ES',
  spain: 'ES',
  кипр: 'CY',
  cyprus: 'CY',
  оаэ: 'AE',
  марокко: 'MA',
  morocco: 'MA',
  тунис: 'TN',
  tunisia: 'TN',
  вьетнам: 'VN',
  vietnam: 'VN',
  мальдивы: 'MV',
  maldives: 'MV',
  малдиви: 'MV',
  мальдиви: 'MV',
  италия: 'IT',
  italy: 'IT',
  франция: 'FR',
  france: 'FR',
  индонезия: 'ID',
  indonesia: 'ID',
  'шри-ланка': 'LK',
  'шри ланка': 'LK',
  'sri lanka': 'LK',
  оман: 'OM',
  oman: 'OM',
  катар: 'QA',
  qatar: 'QA',
  иордания: 'JO',
  jordan: 'JO',
  черногория: 'ME',
  montenegro: 'ME',
  хорватия: 'HR',
  croatia: 'HR',
  индия: 'IN',
  india: 'IN',
  китай: 'CN',
  china: 'CN',
  япония: 'JP',
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
  georgia: 'GE',
  армения: 'AM',
  armenia: 'AM',
  азербайджан: 'AZ',
  azerbaijan: 'AZ',
  португалия: 'PT',
  portugal: 'PT',
  германия: 'DE',
  germany: 'DE',
  австрия: 'AT',
  austria: 'AT',
  швейцария: 'CH',
  switzerland: 'CH',
  чехия: 'CZ',
  czechia: 'CZ',
  сша: 'US',
  usa: 'US',
};

const SORTED_CITY_ENTRIES = Object.entries(CITY_DESTINATION_ALIASES).sort(
  (a, b) => b[0].length - a[0].length,
);
const SORTED_COUNTRY_ENTRIES = Object.entries(COUNTRY_ONLY_ALIASES).sort(
  (a, b) => b[0].length - a[0].length,
);

function textMentionsAlias(text, alias) {
  const t = (text || '').toLowerCase();
  const a = (alias || '').toLowerCase();
  if (!a) return false;
  if (t.includes(a)) return true;
  // Russian cases: «турцию» / «в Египет» still match «турция» / «египет»
  if (a.length >= 4) {
    const stem = a.slice(0, -1);
    if (stem.length >= 3 && t.includes(stem)) return true;
  }
  return false;
}

function matchCityDestination(text) {
  return matchCityFromText(text);
}

function matchCountryOnly(text) {
  return matchCountryCodeFromText(text);
}

/** User wants country-wide search, not a specific city (e.g. «по стране», «не в городе Мале»). */
function wantsCountryOnlySearch(text) {
  const t = (text || '').toLowerCase();
  return (
    /по\s+стране|в\s+стране|по\s+всей\s+стране|не\s+в\s+городе|не\s+обязательно\s+в|любой\s+курорт|везде\s+в|anywhere\s+in/i.test(
      t,
    )
  );
}

function applyDestinationFromText(text, patch) {
  const cityDest = matchCityDestination(text);
  if (cityDest) {
    patch.to_country = cityDest.country;
    patch.to_city = cityDest.city;
    return true;
  }
  const countryCode = matchCountryOnly(text);
  if (countryCode) {
    patch.to_country = countryCode;
    const withCity = applyCountryDefaultCity({ to_country: countryCode });
    if (withCity.to_city) patch.to_city = withCity.to_city;
    return true;
  }
  return false;
}

const { extractHotelNameFromText } = require('./hotel.resolver');

function normalizeSearchParams(params = {}) {
  const p = { ...params };
  if (p.nights !== undefined && p.nights !== '') p.nights = Number(p.nights) || p.nights;
  if (p.adults !== undefined && p.adults !== '') p.adults = String(p.adults);
  if (p.kids !== undefined && p.kids !== '') p.kids = String(p.kids);
  if (!p.from_country) p.from_country = 'RU';
  if (!Array.isArray(p.kids_ages)) p.kids_ages = [];
  if (!p.search_type) p.search_type = 'package';
  if (!p.page_number) p.page_number = 1;
  if (!p.page_limit) p.page_limit = 3;
  if (!p.sort_by) p.sort_by = 'price,asc';
  return p;
}

function mapMealPreference(text) {
  const t = (text || '').toLowerCase();
  const trimmed = (text || '').trim();
  if (/^(uai)$/i.test(trimmed)) return 'UAI';
  if (/ультра|ultra|\buai\b/i.test(t)) return 'UAI';
  if (
    /вс[ёе]\s*включ|all\s*inclusive|\bai\b/i.test(t) ||
    /^(ai)$/i.test(trimmed)
  ) {
    return 'AI';
  }
  if (
    /стандарт|standard|завтрак|bb|hb|fb|ro|полупансион|полный\s*пансион/i.test(t) ||
    /^(bb|hb|fb|ro)$/i.test((text || '').trim())
  ) {
    if (/без\s*пит[аиейюя]|^ro$/i.test(t)) return 'RO';
    return 'BB,HB,FB,RO';
  }
  if (/без\s*пит[аиейюя]/i.test(t)) return 'RO';
  return null;
}

function mapStarFilter(text) {
  const t = (text || '').toLowerCase().replace(/ё/g, 'е');
  const hasStarContext = /звезд|\*|★|\bstars?\b/i.test(t);
  if (!hasStarContext) return null;

  const starWordMatch = t.match(/(\d)\s*(?:\*|★|звезд(?:очн|ы|а|е)?|stars?)/);
  if (starWordMatch) {
    const star = starWordMatch[1];
    if (['3', '4', '5'].includes(star)) return star;
  }

  const reverseMatch = t.match(/(?:звезд(?:очн|ы|а|е)?|stars?)\s*(\d)/);
  if (reverseMatch && ['3', '4', '5'].includes(reverseMatch[1])) {
    return reverseMatch[1];
  }

  if (/\b5\s*star|\bfive\s*star|пят[iиёe]?\s*[-]?\s*звезд/i.test(t)) return '5';
  if (/\b4\s*star|четыр[iеe]?\s*[-]?\s*звезд/i.test(t)) return '4';
  if (/\b3\s*star|тр[iеe]?\s*[-]?\s*звезд/i.test(t)) return '3';

  // "только 5", "толко 5" near star context already matched hasStarContext
  const onlyStarMatch = t.match(/(?:только|толко|only|just)\s*(\d)\b/);
  if (onlyStarMatch && ['3', '4', '5'].includes(onlyStarMatch[1])) {
    return onlyStarMatch[1];
  }

  return null;
}

/** Guest review score (0–10), not hotel star category. */
function mapRatingFilter(text) {
  const t = (text || '').toLowerCase().replace(/ё/g, 'е');
  const hasRatingContext = /рейтинг|rating|оценк/i.test(t);
  if (!hasRatingContext) return null;

  const patterns = [
    /рейтинг(?:ом|ов|а|е)?\s*(?:выше|больше|от|не\s*ниже|>=?)?\s*(\d+(?:[.,]\d+)?)/,
    /(?:с\s+)?рейтинг(?:ом|ов|а|е)?\s*(?:выше|больше|от)?\s*(\d+(?:[.,]\d+)?)/,
    /(?:выше|больше)\s*(\d+(?:[.,]\d+)?)(?:\s*(?:по\s+)?рейтинг)?/,
    /(\d+(?:[.,]\d+)?)\s*\+?\s*(?:рейтинг|rating)/,
    /\brating\s*(?:at\s*least|from|of)?\s*(\d+(?:[.,]\d+)?)/i,
    /rating\s*(?:>=?|above)\s*(\d+(?:[.,]\d+)?)/i,
  ];

  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const val = parseFloat(String(m[1]).replace(',', '.'));
      if (Number.isFinite(val) && val > 0 && val <= 10) {
        return String(val);
      }
    }
  }
  return null;
}

function parseKidsAges(text, expectedCount) {
  const nums = (text || '').match(/\d{1,2}/g);
  if (!nums?.length) return null;
  const ages = nums.slice(0, expectedCount).map((n) => String(parseInt(n, 10)));
  return ages.length === expectedCount ? ages : ages.length > 0 ? ages : null;
}

/** Parse budget: 200000, 200 тыс, 200к, до 200 000 руб */
function parseBudgetAmount(text) {
  const raw = (text || '').trim();
  if (!raw) return null;
  const compact = raw.toLowerCase().replace(/\s+/g, '');

  const thousandMatch = compact.match(/(\d+)\s*(?:тыс|тр|т\.р|к|k)(?:\.?(?:руб|₽|rub))?/);
  if (thousandMatch) {
    return String(parseInt(thousandMatch[1], 10) * 1000);
  }

  const plainMatch = raw.match(/(\d[\d\s]{2,})/);
  if (plainMatch) {
    const digits = plainMatch[1].replace(/\s/g, '');
    if (digits.length >= 4) return digits;
  }

  return null;
}

function mergeSearchParams(base, patch) {
  if (!patch || typeof patch !== 'object') return normalizeSearchParams(base);
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null || value === '') continue;
    merged[key] = value;
  }
  return normalizeSearchParams(merged);
}

function extractSearchIntent(text, existing = {}, nextField = null) {
  const t = (text || '').toLowerCase();
  const trimmed = (text || '').trim();

  if (isPostSearchAdvisoryText(text) || userAsksHotelComparison(text)) {
    return {};
  }

  const isBestHotelQuestion =
    /(сам(ая|ый|ое)|наиболее)\s+(лучш|хорош|отличн)/i.test(t) &&
    /(отел|hotel|вариант|тур)/i.test(t);
  if (isBestHotelQuestion) return {};

  const tourAnswer =
    /(тур|направлен|страну|курорт|отдохнуть|путёвк|package|поехать|полет|лететь|вылет)/i.test(t) ||
    /^(тур|направлен|направление|страну|курорт)/i.test(trimmed);
  const hotelAnswer =
    /(отель|hotel|конкретн)/i.test(t) || /^(отель|hotel|конкретн)/i.test(trimmed);

  if (existing.search_intent) {
    if (tourAnswer && !hotelAnswer) {
      return { search_intent: 'package', search_type: 'package', hotel_name: '', hotel_ids: [] };
    }
    if (hotelAnswer && !tourAnswer) {
      return { search_intent: 'hotel', search_type: 'hotel' };
    }
    return {};
  }

  if (nextField === 'search_intent') {
    if (tourAnswer) return { search_intent: 'package', search_type: 'package' };
    if (hotelAnswer) return { search_intent: 'hotel', search_type: 'hotel' };
  }

  const hotelName = extractHotelNameFromText(text);
  const explicitHotel =
    /(отель|hotel)/i.test(t) ||
    /hilton|marriott|hyatt|sheraton|radisson|rixos|swissotel|movenpick|kempinski|ritz/i.test(t);

  if (hotelName && explicitHotel) {
    return { search_intent: 'hotel', search_type: 'hotel', hotel_name: hotelName };
  }

  if (tourAnswer && !hotelAnswer) {
    return { search_intent: 'package', search_type: 'package' };
  }
  if (hotelAnswer && !tourAnswer) {
    return { search_intent: 'hotel', search_type: 'hotel' };
  }

  return {};
}

function extractFilterOnlyPatch(text) {
  const patch = {};
  const meals = mapMealPreference(text);
  if (meals) patch.filter_meals = meals;
  const stars = mapStarFilter(text);
  if (stars) patch.filter_stars = stars;
  const ratingMin = mapRatingFilter(text);
  if (ratingMin) {
    patch.filter_rating_min = ratingMin;
    patch.sort_by = 'rating,desc';
    patch.hotel_name = '';
    patch.hotel_ids = [];
    patch.search_intent = 'package';
    patch.search_type = 'package';
  }
  const budget = parseBudgetAmount(text);
  if (budget) patch.filter_price_max = budget;
  return patch;
}

function extractFromUserText(text, existing = {}, nextField = null) {
  const patch = {};
  const t = (text || '').toLowerCase();
  const trimmed = (text || '').trim();

  if (isPostSearchAdvisoryText(text) && isReady(existing)) {
    return extractFilterOnlyPatch(text);
  }

  if (wantsCountryOnlySearch(text)) {
    patch._searchCountryOnly = true;
    const countryCode = matchCountryOnly(text) || existing.to_country;
    if (countryCode) patch.to_country = countryCode;
  }

  Object.assign(patch, extractSearchIntent(text, existing, nextField));

  if (nextField === 'search_intent') {
    if (/тур|направлен|страну|курорт|пакет|package|отдохнуть/i.test(t)) {
      patch.search_intent = 'package';
      patch.search_type = 'package';
      patch.hotel_name = '';
      patch.hotel_ids = [];
    } else if (/отель|hotel|конкретн/i.test(t)) {
      patch.search_intent = 'hotel';
      patch.search_type = 'hotel';
    }
  }

  // Step-by-step: short numeric answers map to the field we're currently asking for
  if (nextField === 'adults' && /^\d{1,2}$/.test(trimmed)) {
    patch.adults = trimmed;
  }
  if (nextField === 'nights' && /^\d{1,2}$/.test(trimmed)) {
    patch.nights = Number(trimmed);
  }
  if (nextField === 'adults') {
    if (/^(я\s+)?(только|один|одна|одного|solo|alone)$/i.test(trimmed)) patch.adults = '1';
    if (/^я\s+(один|одна|одного)$/i.test(trimmed)) patch.adults = '1';
    if (/^(двое|два|пара)$/i.test(trimmed)) patch.adults = '2';
    if (/^(трое|три)$/i.test(trimmed)) patch.adults = '3';
  }
  if (nextField === 'start_date') {
    const dmY = trimmed.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
    if (dmY) {
      patch.start_date = `${dmY[3]}-${dmY[2].padStart(2, '0')}-${dmY[1].padStart(2, '0')}`;
    }
  }
  if (nextField === 'from_city') {
    if (!/^(тур|отель|hotel|package|направлен)/i.test(trimmed)) {
      if (t.includes('москв') || trimmed.toLowerCase() === 'москва') patch.from_city = 'Moscow';
      else if (t.includes('петербург') || t.includes('спб') || trimmed.toLowerCase() === 'санкт-петербург') {
        patch.from_city = 'Saint Petersburg';
      } else if (trimmed.length >= 2) {
        patch.from_city = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
      }
    }
  }
  if (nextField === 'kids') {
    if (/^(нет|нен|без\s*дет|не\s*буд|0|none|no)$/i.test(trimmed)) patch.kids = '0';
    if (/^\d{1,2}$/.test(trimmed)) patch.kids = trimmed;
  }
  if (nextField === 'kids_ages') {
    const expected = parseInt(existing.kids || '0', 10);
    const ages = parseKidsAges(text, expected);
    if (ages?.length) patch.kids_ages = ages;
  }
  if (nextField === 'filter_price_max') {
    const budget = parseBudgetAmount(text);
    if (budget) patch.filter_price_max = budget;
  }
  if (nextField === 'filter_meals') {
    const meals = mapMealPreference(text);
    if (meals) patch.filter_meals = meals;
  }

  const nightsMatch = t.match(/(\d+)\s*(ноч|ночей|дней|дня)/);
  if (nightsMatch) patch.nights = Number(nightsMatch[1]);

  const adultsMatch = t.match(/(\d+)\s*(взросл|человек|чел|adult)/);
  if (adultsMatch) patch.adults = adultsMatch[1];
  if (/^я\s+(один|одна|одного)$/i.test(trimmed)) patch.adults = '1';

  const budget = parseBudgetAmount(text);
  if (budget) patch.filter_price_max = budget;

  const meals = mapMealPreference(text);
  if (meals) patch.filter_meals = meals;

  const stars = mapStarFilter(text);
  if (stars) patch.filter_stars = stars;

  const ratingMin = mapRatingFilter(text);
  if (ratingMin) {
    patch.filter_rating_min = ratingMin;
    patch.sort_by = 'rating,desc';
    patch.hotel_name = '';
    patch.hotel_ids = [];
    patch.search_intent = 'package';
    patch.search_type = 'package';
  }

  const kidsCountMatch =
    t.match(/(\d+)\s*(?:дет|ребён|ребен|child|children|childe|kids?)\b/) ||
    t.match(/(?:child|children|childe|kids?)\s*[:\-]?\s*(\d+)/);
  if (kidsCountMatch) patch.kids = kidsCountMatch[1];
  if (/^(нет|без)\s*дет/i.test(t)) patch.kids = '0';
  if (/\b(without|no)\s+(child|children|kids?)\b/i.test(t)) patch.kids = '0';
  if (/\bбез\s+дет/i.test(t)) patch.kids = '0';

  const agesInline =
    t.match(/дет[^\d]*(\d+(?:\s*(?:и|,|and)\s*\d+)*)/) ||
    t.match(/(?:child|children|kids?)[^\d]*(\d+(?:\s*(?:и|,|and)\s*\d+)*)/i);
  if (agesInline) {
    const expectedKids = patch.kids || existing.kids || '0';
    const ages = parseKidsAges(agesInline[1], parseInt(expectedKids, 10) || 10);
    if (ages?.length) {
      patch.kids_ages = ages;
      if (!patch.kids && ages.length > 0) patch.kids = String(ages.length);
    }
  }

  const dateMatch = t.match(/(\d{1,2})\s*(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/);
  const monthFirstMatch = t.match(/(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s*(\d{1,2})/);

  const applyMonthDay = (dayRaw, monthName) => {
    const day = String(dayRaw).padStart(2, '0');
    const month = MONTH_MAP[monthName];
    if (!month) return;
    const { normalizeStartDate } = require('./search.params.normalizer');
    const year = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;
    const targetMonth = parseInt(month, 10);
    let targetYear = targetMonth < currentMonth ? year + 1 : year;
    patch.start_date = normalizeStartDate(`${targetYear}-${month}-${day}`);
  };

  // «с 15 по 30 августа» / «15 августа по 30 августа» → start_date + nights
  const MONTH_RE = '(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)';
  const rangeMatch = t.match(
    new RegExp(`(?:с\\s+)?(\\d{1,2})\\s*(?:${MONTH_RE})?\\s+по\\s+(\\d{1,2})\\s*${MONTH_RE}`),
  );
  if (rangeMatch) {
    const day1 = parseInt(rangeMatch[1], 10);
    const month1 = rangeMatch[2] || rangeMatch[4];
    const day2 = parseInt(rangeMatch[3], 10);
    const month2 = rangeMatch[4];
    applyMonthDay(day1, month1);
    if (patch.start_date) {
      const m1 = parseInt(MONTH_MAP[month1], 10);
      const m2 = parseInt(MONTH_MAP[month2], 10);
      let nights = m1 === m2 ? day2 - day1 : Math.round(
        (new Date(2026, m2 - 1, day2) - new Date(2026, m1 - 1, day1)) / 86400000,
      );
      if (nights > 0 && nights <= 30) patch.nights = nights;
    }
  } else if (dateMatch) {
    applyMonthDay(dateMatch[1], dateMatch[2]);
  } else if (monthFirstMatch) {
    applyMonthDay(monthFirstMatch[2], monthFirstMatch[1]);
  }

  const isoDate = (text || '').match(/\d{4}-\d{2}-\d{2}/);
  if (isoDate) patch.start_date = isoDate[0];

  const dotDate = (text || '').match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (dotDate) {
    patch.start_date = `${dotDate[3]}-${dotDate[2].padStart(2, '0')}-${dotDate[1].padStart(2, '0')}`;
  }

  const skipBareDestinationParse =
    nextField === 'from_city' ||
    nextField === 'start_date' ||
    nextField === 'nights' ||
    nextField === 'adults' ||
    nextField === 'kids' ||
    nextField === 'kids_ages' ||
    nextField === 'filter_price_max' ||
    nextField === 'filter_meals';

  if (!skipBareDestinationParse) {
    if (applyDestinationFromText(text, patch)) {
      if (!existing.search_intent && !patch.search_intent) {
        patch.search_intent = 'package';
        patch.search_type = 'package';
      }
    } else {
      const inDestMatch = t.match(/\bв\s+([а-яёa-z\-\s]{3,30}?)(?:[?.!,]|$|\s+(?:на|с|и|или|без))/i);
      if (inDestMatch && !patch.to_country && !patch.hotel_name) {
        const destChunk = inDestMatch[1].trim();
        const monthLike = /^(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)/i.test(
          destChunk,
        );
        if (!monthLike && applyDestinationFromText(destChunk, patch)) {
          if (!existing.search_intent && !patch.search_intent) {
            patch.search_intent = 'package';
            patch.search_type = 'package';
          }
        }
      }
    }
  }

  const toCityMatch = t.match(/(?:поехать|лететь|полет|fly|go|хочу)\s+(?:в|vo|to)\s+([а-яёa-z\-\s]{3,30})/i);
  if (toCityMatch && !patch.to_country && !patch.to_city && !patch.hotel_name) {
    const rawCity = toCityMatch[1].trim().replace(/[.!?]+$/, '');
    if (!applyDestinationFromText(rawCity, patch)) {
      patch.to_city = rawCity.charAt(0).toUpperCase() + rawCity.slice(1);
    }
    if (!existing.search_intent && !patch.search_intent) {
      patch.search_intent = 'package';
      patch.search_type = 'package';
    }
  }

  const cityExplicitMatch = t.match(/(?:город[еу]?|курорт[еу]?|resort|city)\s+([а-яёa-z\-\s]{2,30})/i);
  if (cityExplicitMatch && !patch.hotel_name) {
    const rawCity = cityExplicitMatch[1]
      .trim()
      .replace(/[.!?]+$/, '')
      .split(/[,]/)[0]
      .trim();
    if (applyDestinationFromText(rawCity, patch)) {
      if (!existing.search_intent && !patch.search_intent) {
        patch.search_intent = 'package';
        patch.search_type = 'package';
      }
    }
  }

  const hotelsInCityMatch = t.match(/отел[ьяейи]?\s+(?:в|во)\s+([а-яёa-z\-]+)/i);
  if (hotelsInCityMatch && !patch.hotel_name) {
    const rawCity = hotelsInCityMatch[1].trim().replace(/[,.!?]+$/, '');
    const cityPatch = {};
    if (applyDestinationFromText(rawCity, cityPatch)) {
      Object.assign(patch, cityPatch);
    } else {
      patch.to_city = rawCity.charAt(0).toUpperCase() + rawCity.slice(1);
    }
    patch.search_intent = 'package';
    patch.search_type = 'package';
    patch.hotel_name = '';
    patch.hotel_ids = [];
  }

  const hotelName = extractHotelNameFromText(text);
  const intent =
    patch.search_intent || existing.search_intent || inferSearchIntentFromParams({ ...existing, ...patch });
  const explicitHotel =
    /\b(отель|hotel)\b/i.test(t) ||
    /hilton|marriott|hyatt|sheraton|radisson|rixos|riu\b|titanic|kempinski|barcelo|swissotel|movenpick|voyage|maxx royal|regnum/i.test(t);

  if (
    hotelName &&
    !/рейтинг|rating|оценк/i.test(hotelName) &&
    !existing.hotel_name &&
    intent === 'hotel' &&
    (explicitHotel || nextField === 'hotel_resolve' || nextField === 'destination')
  ) {
    patch.hotel_name = hotelName;
    patch.search_intent = 'hotel';
    patch.search_type = 'hotel';
  }

  const looksLikeDateOrNumber =
    Boolean(patch.start_date) ||
    /^\d/.test(trimmed) ||
    /^(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)/i.test(trimmed);

  if (
    nextField === 'destination' &&
    trimmed.length >= 2 &&
    !patch.to_country &&
    !patch.hotel_name &&
    !looksLikeDateOrNumber
  ) {
    if (!applyDestinationFromText(trimmed, patch)) {
      patch.to_city = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    }
  }

  const fromMatch = t.match(/(?:^|[^\wа-яё])(?:из|откуда|вылет\s*из)\s+([а-яёa-z\-\s]{3,30})/i);
  if (fromMatch) {
    const city = fromMatch[1].trim().replace(/[.!?]+$/, '');
    const cityLower = city.toLowerCase();
    const isFalsePositive =
      FROM_CITY_FALSE_POSITIVE.test(city) ||
      /вариант|лучше|отел|интернет|найти|какой|самый/i.test(cityLower);
    if (!isFalsePositive) {
      if (cityLower.includes('моск')) patch.from_city = 'Moscow';
      else if (cityLower.includes('петербург') || cityLower.includes('спб')) {
        patch.from_city = 'Saint Petersburg';
      } else if (city.length > 2) {
        patch.from_city = city.charAt(0).toUpperCase() + city.slice(1);
      }
    }
  }
  if (t.includes('москв') && (nextField === 'from_city' || !existing.from_city)) patch.from_city = 'Moscow';
  if ((t.includes('петербург') || t.includes('спб')) && (nextField === 'from_city' || !existing.from_city)) {
    patch.from_city = 'Saint Petersburg';
  }

  if (!existing.search_intent && !patch.search_intent && (patch.to_city || patch.to_country)) {
    patch.search_intent = 'package';
    patch.search_type = 'package';
  }

  // "из Москвы в Анталию" — extract both from and to in one message
  const fromToMatch = t.match(/из\s+([а-яёa-z\-\s]{2,25})\s+(?:в|vo|to)\s+([а-яёa-z\-\s]{2,25})/i);
  if (fromToMatch) {
    const fromRaw = fromToMatch[1].trim();
    const toRaw = fromToMatch[2].trim().replace(/[.!?]+$/, '');
    if (fromRaw.includes('моск')) patch.from_city = 'Moscow';
    else if (fromRaw.includes('петербург') || fromRaw.includes('спб')) patch.from_city = 'Saint Petersburg';
    else patch.from_city = fromRaw.charAt(0).toUpperCase() + fromRaw.slice(1);
    if (!patch.to_city) {
      if (!applyDestinationFromText(toRaw, patch)) {
        patch.to_city = toRaw.charAt(0).toUpperCase() + toRaw.slice(1);
      }
    }
    patch.search_intent = 'package';
    patch.search_type = 'package';
  }

  return patch;
}

function reconcileDestinationAfterExtraction(params, existing, userText, localPatch, aiPatch) {
  const { extractExplicitCityName } = require('./destination.resolver');
  const explicitCity = extractExplicitCityName(userText);
  const countryInMessage = matchCountryOnly(userText) || localPatch.to_country;
  const destMentioned = Boolean(
    countryInMessage || explicitCity || localPatch.to_city || localPatch.to_country,
  );
  if (!destMentioned) return;

  const countryChanged =
    Boolean(localPatch.to_country) && localPatch.to_country !== existing.to_country;
  const cityChanged =
    Boolean(localPatch.to_city && localPatch.to_city !== existing.to_city) ||
    Boolean(explicitCity && !textMentionsAlias(userText, existing.to_city || ''));

  if (countryChanged && !localPatch.to_city && !explicitCity) {
    delete params.to_city;
  }

  if (explicitCity) {
    const cityPatch = {};
    if (applyDestinationFromText(explicitCity, cityPatch)) {
      Object.assign(params, cityPatch);
    } else if (!params.to_city || countryChanged) {
      params.to_city = explicitCity.charAt(0).toUpperCase() + explicitCity.slice(1);
    }
  }

  if (countryChanged || cityChanged || explicitCity) {
    params.destination_label = '';
    params.destination_label_prep = '';
    clearStaleFiltersOnDestinationChange(params, userText, localPatch, aiPatch);
  }

  const budgetInMessage = parseBudgetAmount(userText);
  if (
    (countryChanged || cityChanged || explicitCity) &&
    !budgetInMessage &&
    !aiPatch.filter_price_max &&
    !localPatch.filter_price_max
  ) {
    delete params.filter_price_max;
  }

  const { syncDestinationLabels } = require('./destination.labels');
  if (params.to_country && (countryChanged || cityChanged || explicitCity)) {
    Object.assign(params, syncDestinationLabels(params));
  }
}

function clearStaleFiltersOnDestinationChange(params, userText, localPatch, aiPatch) {
  if (!mapMealPreference(userText) && !localPatch.filter_meals && !aiPatch.filter_meals) {
    delete params.filter_meals;
  }
  if (!mapStarFilter(userText) && !localPatch.filter_stars && !aiPatch.filter_stars) {
    delete params.filter_stars;
  }
  if (!mapRatingFilter(userText) && !localPatch.filter_rating_min && !aiPatch.filter_rating_min) {
    delete params.filter_rating_min;
    if (params.sort_by === 'rating,desc') params.sort_by = 'price,asc';
  }
  delete params.filter_line;
  delete params.filter_beach_surface;
  delete params.filter_regions;
  delete params.filter_sandy_beach;
}

function extractFromAiResponse(aiResponse) {
  if (!aiResponse) return {};
  const sp = aiResponse.searchParams;
  if (sp && typeof sp === 'object' && Object.keys(sp).length > 0) {
    return { ...sp };
  }
  return {};
}

function stripAccidentalDepartureDestination(params, previousParams, userText, nextField) {
  const { isDepartureCityOnlyText } = require('./search.params.normalizer');
  const { extractDestinationQuery } = require('./destination.resolver');
  const hasExplicitDest = Boolean(extractDestinationQuery(userText));
  const hadDestinationBefore = Boolean(previousParams?.to_country);

  // «москва» as a reply to the from_city question must never BECOME the
  // destination — but it must not erase a destination chosen earlier either.
  if (
    nextField === 'from_city' &&
    isDepartureCityOnlyText(userText) &&
    !hasExplicitDest &&
    !hadDestinationBefore
  ) {
    delete params.to_country;
    delete params.to_city;
    delete params.destination_label;
    delete params.destination_label_prep;
  }

  if (
    params.to_country === 'RU' &&
    params.to_city === 'Moscow' &&
    params.from_city === 'Moscow' &&
    !hasExplicitDest &&
    previousParams?.to_country !== 'RU'
  ) {
    delete params.to_country;
    delete params.to_city;
    delete params.destination_label;
    delete params.destination_label_prep;
  }
}

function applyExtraction(conversation, userText, aiResponse, nextField = null) {
  const previousParams = conversation.searchParams || {};
  let params = { ...previousParams };
  const aiPatch = extractFromAiResponse(aiResponse);
  const localPatch = extractFromUserText(userText, previousParams, nextField);

  // Local rules (regex / aliases) override AI extraction for the same fields.
  params = mergeSearchParams(params, aiPatch);
  params = mergeSearchParams(params, localPatch);
  stripAccidentalDepartureDestination(params, previousParams, userText, nextField);
  reconcileDestinationAfterExtraction(params, previousParams, userText, localPatch, aiPatch);

  const intent = params.search_intent || inferSearchIntentFromParams(params);
  if (intent === 'package') {
    params.search_type = 'package';
    params.search_intent = 'package';
    if (!params.hotel_ids?.length) {
      delete params.hotel_name;
      params.hotel_ids = [];
    }
  } else if (intent === 'hotel') {
    params.search_type = 'hotel';
    params.search_intent = 'hotel';
  }

  if (params.hotel_name && !params.hotel_ids?.length && intent === 'hotel') {
    params.search_type = 'hotel';
  }
  const { isCountryPlaceholderToCity } = require('./search.params.normalizer');
  if (params.to_city && isCountryPlaceholderToCity(params.to_city, params.to_country)) {
    delete params.to_city;
  }
  if (localPatch._searchCountryOnly) {
    delete params.to_city;
  }
  params = applyCountryDefaultCity(params);
  if (params.to_country) {
    const { syncDestinationLabels } = require('./destination.labels');
    Object.assign(params, syncDestinationLabels(params));
  }
  if (params.filter_rating_min) {
    params.hotel_name = '';
    params.hotel_ids = [];
    params.search_type = 'package';
    params.search_intent = 'package';
  }
  conversation.searchParams = params;
  return params;
}

module.exports = {
  normalizeSearchParams,
  mergeSearchParams,
  extractFromUserText,
  extractFromAiResponse,
  applyExtraction,
};
