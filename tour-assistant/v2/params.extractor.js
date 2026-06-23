const {
  hasDestination,
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

const COUNTRY_ALIASES = {
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
  дубай: 'AE',
  dubai: 'AE',
  'абу-даби': 'AE',
  'abu dhabi': 'AE',
  марокко: 'MA',
  morocco: 'MA',
  тунис: 'TN',
  tunisia: 'TN',
  вьетнам: 'VN',
  vietnam: 'VN',
  мальдивы: 'MV',
  maldives: 'MV',
  бали: 'ID',
  bali: 'ID',
  италия: 'IT',
  italy: 'IT',
  франция: 'FR',
  france: 'FR',
  париж: 'FR',
  paris: 'FR',
  стамбул: 'TR',
  istanbul: 'TR',
  анталья: 'TR',
  antalya: 'TR',
  анталиа: 'TR',
  antalia: 'TR',
  анталия: 'TR',
};

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
  if (!p.sort_by) p.sort_by = 'relevance';
  return p;
}

function mapMealPreference(text) {
  const t = (text || '').toLowerCase();
  if (
    /вс[ёе]\s*включ|all\s*inclusive|\bai\b|uai|ультра|ultra/i.test(t) ||
    /^(ai|uai)$/i.test((text || '').trim())
  ) {
    return 'AI';
  }
  if (
    /стандарт|standard|завтрак|bb|hb|fb|ro|полупансион|полный\s*пансион|без\s*пит/i.test(t) ||
    /^(bb|hb|fb|ro)$/i.test((text || '').trim())
  ) {
    return 'BB,HB,FB,RO';
  }
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

function parseKidsAges(text, expectedCount) {
  const nums = (text || '').match(/\d{1,2}/g);
  if (!nums?.length) return null;
  const ages = nums.slice(0, expectedCount).map((n) => String(parseInt(n, 10)));
  return ages.length === expectedCount ? ages : ages.length > 0 ? ages : null;
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
  const budgetMatch = (text || '').match(/(\d{4,})\s*(руб|₽|rub|тыс|т\.р\.|тр)?/i);
  if (budgetMatch) patch.filter_price_max = budgetMatch[1];
  return patch;
}

function extractFromUserText(text, existing = {}, nextField = null) {
  const patch = {};
  const t = (text || '').toLowerCase();
  const trimmed = (text || '').trim();

  if (isPostSearchAdvisoryText(text) && isReady(existing)) {
    return extractFilterOnlyPatch(text);
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
    const num = trimmed.replace(/\s/g, '').match(/(\d{4,})/);
    if (num) patch.filter_price_max = num[1];
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

  const budgetMatch = t.match(/(\d{4,})\s*(руб|₽|rub|тыс|т\.р\.|тр)?/i);
  if (budgetMatch) patch.filter_price_max = budgetMatch[1];

  const meals = mapMealPreference(text);
  if (meals) patch.filter_meals = meals;

  const stars = mapStarFilter(text);
  if (stars) patch.filter_stars = stars;

  const kidsCountMatch = t.match(/(\d+)\s*(дет|реб)/);
  if (kidsCountMatch) patch.kids = kidsCountMatch[1];
  if (/^(нет|без)\s*дет/i.test(t)) patch.kids = '0';

  const agesInline = t.match(/дет[^\d]*(\d+(?:\s*(?:и|,|и)\s*\d+)*)/);
  if (agesInline) {
    const ages = parseKidsAges(agesInline[1], 10);
    if (ages?.length) patch.kids_ages = ages;
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

  if (dateMatch) {
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

  for (const [name, code] of Object.entries(COUNTRY_ALIASES)) {
    if (t.includes(name)) {
      patch.to_country = code;
      if (!existing.to_city) {
        const cityLabel =
          name === 'анталиа' || name === 'antalia' || name === 'анталья' || name === 'antalya'
            ? 'Antalya'
            : name === 'дубай' || name === 'dubai'
              ? 'Dubai'
              : name.charAt(0).toUpperCase() + name.slice(1);
        patch.to_city = cityLabel;
      }
      if (!existing.search_intent && !patch.search_intent) {
        patch.search_intent = 'package';
        patch.search_type = 'package';
      }
      break;
    }
  }

  const toCityMatch = t.match(/(?:поехать|лететь|полет|fly|go|хочу)\s+(?:в|vo|to)\s+([а-яёa-z\-\s]{3,30})/i);
  if (toCityMatch && !patch.to_city && !patch.hotel_name) {
    const rawCity = toCityMatch[1].trim().replace(/[.!?]+$/, '');
    const cityKey = rawCity.toLowerCase();
    let matched = false;
    for (const [name, code] of Object.entries(COUNTRY_ALIASES)) {
      if (cityKey.includes(name) || name.includes(cityKey)) {
        patch.to_country = code;
        patch.to_city =
          name === 'анталиа' || name === 'antalia' || name === 'анталья' || name === 'antalya'
            ? 'Antalya'
            : name === 'дубай' || name === 'dubai'
              ? 'Dubai'
              : rawCity.charAt(0).toUpperCase() + rawCity.slice(1);
        matched = true;
        break;
      }
    }
    if (!matched) {
      patch.to_city = rawCity.charAt(0).toUpperCase() + rawCity.slice(1);
    }
    if (!existing.search_intent && !patch.search_intent) {
      patch.search_intent = 'package';
      patch.search_type = 'package';
    }
  }

  const hotelName = extractHotelNameFromText(text);
  const intent =
    patch.search_intent || existing.search_intent || inferSearchIntentFromParams({ ...existing, ...patch });
  const explicitHotel =
    /\b(отель|hotel)\b/i.test(t) || /hilton|marriott|hyatt|sheraton|radisson|rixos/i.test(t);

  if (
    hotelName &&
    !existing.hotel_name &&
    intent === 'hotel' &&
    (explicitHotel || nextField === 'hotel_resolve' || nextField === 'destination')
  ) {
    patch.hotel_name = hotelName;
    patch.search_intent = 'hotel';
    patch.search_type = 'hotel';
  }

  if (nextField === 'destination' && trimmed.length >= 2 && !patch.to_country && !patch.hotel_name) {
    const cityLabel = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    patch.to_city = cityLabel;
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
      const toKey = toRaw.toLowerCase();
      let matched = false;
      for (const [name, code] of Object.entries(COUNTRY_ALIASES)) {
        if (toKey.includes(name) || name.includes(toKey)) {
          patch.to_country = code;
          patch.to_city =
            name === 'анталиа' || name === 'antalia' || name === 'анталья' || name === 'antalya'
              ? 'Antalya'
              : toRaw.charAt(0).toUpperCase() + toRaw.slice(1);
          matched = true;
          break;
        }
      }
      if (!matched) patch.to_city = toRaw.charAt(0).toUpperCase() + toRaw.slice(1);
    }
    patch.search_intent = 'package';
    patch.search_type = 'package';
  }

  return patch;
}

function extractFromAiResponse(aiResponse) {
  if (!aiResponse) return {};
  const sp = aiResponse.searchParams;
  if (sp && typeof sp === 'object' && Object.keys(sp).length > 0) {
    return { ...sp };
  }
  return {};
}

function applyExtraction(conversation, userText, aiResponse, nextField = null) {
  let params = conversation.searchParams || {};
  const aiPatch = extractFromAiResponse(aiResponse);
  const localPatch = extractFromUserText(userText, params, nextField);

  // Local rules (regex / aliases) override AI extraction for the same fields.
  params = mergeSearchParams(params, aiPatch);
  params = mergeSearchParams(params, localPatch);

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
  if (!hasDestination(params) && params.to_country) {
    params.to_city = params.to_city || params.to_country;
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
