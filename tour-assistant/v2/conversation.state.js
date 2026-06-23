/**
 * Backend-only conversation state machine (V2).
 * Step-by-step collection: one field per turn, then auto-search.
 */

const ConversationStage = {
  COLLECTING_PARAMS: 'collecting_params',
  READY_TO_SEARCH: 'ready_to_search',
  SEARCHING: 'searching',
  RESULTS: 'results',
};

const FIELD_LABELS = {
  search_intent: 'тип поиска (конкретный отель или тур/направление)',
  from_city: 'город вылета (откуда летите)',
  destination: 'направление (куда — страна, город или отель)',
  hotel_resolve: 'уточнение названия отеля',
  start_date: 'дата вылета',
  nights: 'количество ночей',
  adults: 'количество взрослых',
  kids: 'количество детей',
  kids_ages: 'возраст детей',
  filter_price_max: 'бюджет на тур (максимальная цена в рублях)',
  filter_meals: 'тип питания (всё включено или стандарт)',
};

function hasDestination(searchParams) {
  return Boolean(
    (searchParams.to_city && String(searchParams.to_city).trim()) ||
      (searchParams.to_country && String(searchParams.to_country).trim()),
  );
}

function hasHotelSearch(searchParams) {
  return Boolean(
    searchParams?.hotel_ids?.length > 0 ||
      (searchParams?.search_intent === 'hotel' &&
        searchParams?.hotel_name &&
        String(searchParams.hotel_name).trim()),
  );
}

function isHotelIntent(searchParams) {
  const p = searchParams || {};
  return p.search_intent === 'hotel' || p.hotel_ids?.length > 0;
}

function inferSearchIntentFromParams(searchParams) {
  const p = searchParams || {};
  if (p.search_intent === 'hotel' || p.search_intent === 'package') return p.search_intent;
  if (p.hotel_ids?.length) return 'hotel';
  return null;
}

function getKidsCount(searchParams) {
  const raw = searchParams?.kids;
  if (raw === '' || raw === undefined || raw === null) return null;
  return parseInt(String(raw), 10);
}

function getCollectionSteps(searchParams) {
  const steps = [];
  const inferred = inferSearchIntentFromParams(searchParams);
  if (!inferred && !searchParams?.search_intent) {
    steps.push('search_intent');
  }
  steps.push('from_city', 'destination');
  if (isHotelIntent({ ...searchParams, search_intent: searchParams?.search_intent || inferred })) {
    steps.push('hotel_resolve');
  }
  steps.push('start_date', 'nights', 'adults', 'kids');
  const kidsCount = getKidsCount(searchParams);
  if (kidsCount !== null && kidsCount > 0) {
    steps.push('kids_ages');
  }
  steps.push('filter_price_max', 'filter_meals');
  return steps;
}

/** Defaults safe during collection — do NOT pre-fill required fields. */
function applyDefaults(searchParams) {
  const p = { ...searchParams };
  if (!p.from_country) p.from_country = 'RU';
  if (!Array.isArray(p.kids_ages)) p.kids_ages = [];
  if (!p.search_type) p.search_type = 'package';
  if (!p.page_number) p.page_number = 1;
  if (!p.page_limit) p.page_limit = 3;
  return p;
}

/** Full defaults applied right before API search. */
function prepareSearchParams(searchParams) {
  const { normalizeSearchParamsForApi } = require('./search.params.normalizer');
  const p = applyDefaults(searchParams);
  if (!p.from_city) p.from_city = 'Moscow';
  if (p.kids === '' || p.kids === undefined || p.kids === null) p.kids = '0';
  if (!Array.isArray(p.kids_ages)) p.kids_ages = [];
  const kidsCount = parseInt(p.kids || '0', 10);
  if (kidsCount === 0) p.kids_ages = [];
  return normalizeSearchParamsForApi(p);
}

function isFieldMissing(searchParams, field) {
  const p = searchParams || {};
  switch (field) {
    case 'search_intent':
      return !inferSearchIntentFromParams(p) && !p.search_intent;
    case 'from_city':
      return !p.from_city || !String(p.from_city).trim();
    case 'destination':
      if (p.hotel_ids?.length) return false;
      if (p.hotel_name && isHotelIntent(p)) return false;
      return !hasDestination(p);
    case 'hotel_resolve':
      if (!isHotelIntent(p)) return false;
      return Boolean(p.hotel_name && !p.hotel_ids?.length);
    case 'start_date':
      return !p.start_date;
    case 'nights':
      return !p.nights;
    case 'adults':
      return !p.adults;
    case 'kids':
      return p.kids === '' || p.kids === undefined || p.kids === null;
    case 'kids_ages': {
      const kidsCount = getKidsCount(p);
      if (kidsCount === null || kidsCount === 0) return false;
      return !Array.isArray(p.kids_ages) || p.kids_ages.length !== kidsCount;
    }
    case 'filter_price_max':
      return !p.filter_price_max;
    case 'filter_meals':
      return !p.filter_meals || !String(p.filter_meals).trim();
    default:
      return false;
  }
}

function getMissingFields(searchParams) {
  return getCollectionSteps(searchParams).filter((field) => isFieldMissing(searchParams, field));
}

function getNextMissingField(searchParams) {
  const missing = getMissingFields(searchParams);
  return missing.length ? missing[0] : null;
}

function isReady(searchParams) {
  return getNextMissingField(searchParams) === null;
}

function resolveStage(searchParams, currentStage) {
  if (isReady(searchParams)) {
    return ConversationStage.READY_TO_SEARCH;
  }
  if (currentStage === ConversationStage.RESULTS) {
    return ConversationStage.RESULTS;
  }
  return ConversationStage.COLLECTING_PARAMS;
}

function userAsksHotelComparison(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t) return false;

  const patterns = [
    /какой\s+(из\s+)?(этих\s+)?(вариант|отел|тур)/,
    /какой\s+(вариант|отель|тур)\s+(лучше|выбрать|предпочест)/,
    /какой\s+лучше/,
    /кто\s+сам(ый|ая)\s+(отличн|лучш|хорош)/,
    /сам(ый|ая|ое)\s+(отличн|лучш|хорош)\s+отел/,
    /(лучш(ий|ая|ее)|лучше)\s+(вариант|отель|тур)/,
    /сам(ая|ый|ое)\s+лучш(ая|ий|ее)?\s*(отел|hotel)?/,
    /лучш(ий|ая|ее)\s+отел/,
    /что\s+(выбрать|посоветуешь|посоветуете|рекомендуешь|рекомендуете)/,
    /посоветуй(те)?\s+(какой|что|какой\s+из)/,
    /(сравни|сравнить)\s+(эт|вариант|отел)/,
    /which\s+(one|hotel)\s+is\s+better/,
    /compare\s+(these|the)\s+hotel/i,
  ];

  return patterns.some((re) => re.test(t));
}

function isPostSearchAdvisoryText(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t) return false;

  if (userAsksHotelComparison(text)) return true;

  const advisoryPatterns = [
    /(этих|этого|показанн|выше|вариантов?)\s/.test(t) &&
      /(лучш|отличн|выбрать|рекоменд|совет|мнени|думаешь|скажете)/.test(t),
    /(сам(ый|ая|ое)|наиболее)\s+(хорош|отличн|лучш)/.test(t),
    /(лучш(ий|ая|ее))\s+(отел|hotel|вариант|тур)/.test(t),
    /сам(ая|ый|ое)\s+лучш(ая|ий|ее)?\s*(отел|hotel)?/.test(t),
    /расскаж(и|ите)\s+про\s+(эт|отел|вариант|перв|втор|трет)/.test(t),
    /что\s+(думаешь|скажете|посоветуешь|посоветуете)/.test(t),
    /найти\s+(на\s+)?интернет/.test(t),
    /(погугл|загугл|поищи\s+в\s+интернет|в\s+интернет)/.test(t),
    /кто\s+сам(ый|ая)/.test(t),
  ];

  return advisoryPatterns.some(Boolean);
}

function getLastShownHotels(conversation) {
  const msgs = conversation?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'assistant' && Array.isArray(m.hotels) && m.hotels.length) {
      return m.hotels;
    }
  }
  return conversation?.results?.hotels || [];
}

function userWantsRetrySearch(text) {
  const t = (text || '').toLowerCase().trim();
  if (isPostSearchAdvisoryText(text) || userAsksHotelComparison(text)) return false;
  if (/найти\s+(на\s+)?интернет|в\s+интернет|в\s+сети|погугл|загугл/i.test(t)) return false;

  return (
    /^(найди|ищи|поищи|повтор)/.test(t) ||
    t.includes('ещё раз') ||
    t.includes('еще раз') ||
    t.includes('повтор') ||
    t.includes('найди снова') ||
    t.includes('найди ещё') ||
    t.includes('найди еще') ||
    t.includes('поищи снова') ||
    t.includes('попробуй')
  );
}

function userAsksWhyNoResults(text) {
  const t = (text || '').toLowerCase();
  return (
    t.includes('почему') ||
    t.includes('why') ||
    t.includes('не наш') ||
    t.includes('нет результат') ||
    t.includes('ничего не') ||
    t.includes('не работ')
  );
}

function userAsksDestinationActivities(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t) return false;

  const patterns = [
    /что\s+(можно|могу)\s+(там\s+)?(сделать|делать)/,
    /что\s+(там\s+)?(посмотреть|увидеть|интересного)/,
    /чем\s+(там\s+)?(заняться|занят)/,
    /можешь\s+(сказать|рассказать).*что\s+(можно|могу)/,
    /можете\s+(сказать|рассказать).*что\s+(можно|могу)/,
    /расскаж(и|ите)\s+(про|о|об)\s+(достопримеч|развлеч|активност|направлен)/,
    /что\s+(там\s+)?предлож(ишь|ите)/,
    /что\s+делать\s+(там|в\s+\w)/,
    /достопримечательност/,
    /развлечен/,
    /экскурс/,
    /что\s+там\s+(есть|интересного)/,
    /как\s+(там\s+)?отдыха(ют|ть)/,
  ];

  return patterns.some((re) => re.test(t));
}

function buildSearchFingerprint(params) {
  const p = params || {};
  return JSON.stringify({
    from_city: p.from_city,
    to_country: p.to_country,
    to_city: p.to_city,
    start_date: p.start_date,
    nights: p.nights,
    adults: p.adults,
    kids: p.kids,
    kids_ages: p.kids_ages,
    hotel_ids: p.hotel_ids,
    search_type: p.search_type,
    filter_price_max: p.filter_price_max,
    filter_meals: p.filter_meals,
    filter_stars: p.filter_stars,
  });
}

const SEARCH_FILTER_KEYS = [
  'filter_stars',
  'filter_meals',
  'filter_price_max',
  'filter_line',
  'filter_beach_surface',
  'filter_hotel_type',
];

function searchFiltersChanged(justReceived = {}) {
  return SEARCH_FILTER_KEYS.some(
    (k) => justReceived[k] !== undefined && justReceived[k] !== '',
  );
}

function userWantsMoreResults(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t) return false;

  const simpleMorePatterns = [
    /\b(ещё|еще|ещо)\b/,
    /\bдруг(ие|ой|ая|ое|ого|ую|им|их)\b/,
    /\bследующ(ие|ий|ая|ее)\b/,
    /\bдальше\b/,
    /\bпредлагай\b/,
    /покажи\s+(ещё|еще|друг|больше)/,
    /покаж(и|ите)\s+(ещё|еще|друг|больше)/,
    /дай\s+(ещё|еще|друг|больше)/,
    /найди\s+(ещё|еще|друг|больше)/,
    /поищи\s+(ещё|еще|друг|больше)/,
    /больше\s+(отел|вариант|тур|предлож)/,
    /(ещё|еще)\s+(отел|тур|вариант|предлож)/,
    /(друг(ие|ой|ая|ое)\s+(отел|тур|вариант))/,
    /(хочу|можно|нужно)\s+(ещё|еще|друг|больше)/,
    /more\s+hotel|similar\s+hotel/i,
  ];

  return simpleMorePatterns.some((re) => re.test(t));
}

function userGivesPositiveHotelFeedback(text) {
  const t = (text || '').toLowerCase();
  return (
    /очень\s+(хорош|класс|отлич|красив)/.test(t) ||
    /\b(отлично|супер|класс|здорово|прекрасно|шикарно|круто)\b/.test(t) ||
    /(нравится|понравил|подход)/.test(t) ||
    /very\s+good|great|nice|love\s+it|awesome/i.test(t)
  );
}

function userWantsMoreHotelsAfterResults(text) {
  if (userWantsMoreResults(text)) return true;

  if (userGivesPositiveHotelFeedback(text) && /(ещё|еще|друг|больше|more|another|similar)/i.test(text)) {
    return true;
  }

  const t = (text || '').toLowerCase();
  if (/покаж(и|ите)\s+(друг|ещё|еще|больше)/.test(t)) return true;
  if (/предлож(и|ите)\s+(друг|ещё|еще|больше)/.test(t)) return true;
  if (/друг(ие|ой)\s+(отел|вариант|тур)/.test(t)) return true;

  return false;
}

function formatMealsLabel(filterMeals) {
  const v = String(filterMeals || '').toUpperCase();
  if (v === 'AI' || v.includes('AI')) return 'всё включено';
  if (v === 'BB' || v.includes('BB')) return 'стандарт (завтрак и др.)';
  return filterMeals;
}

function summarizeKnownParams(searchParams) {
  const p = searchParams || {};
  const parts = [];
  const intent = inferSearchIntentFromParams(p) || p.search_intent;
  if (intent === 'hotel') parts.push('поиск: конкретный отель');
  else if (intent === 'package') parts.push('поиск: тур/направление');
  if (p.from_city) parts.push(`вылет из: ${p.from_city}`);
  if (p.hotel_name) parts.push(`отель: ${p.hotel_name}`);
  else if (p.to_city) parts.push(`куда: ${p.to_city}`);
  else if (p.to_country) parts.push(`куда: ${p.to_country}`);
  if (p.start_date) parts.push(`дата: ${p.start_date}`);
  if (p.nights) parts.push(`ночей: ${p.nights}`);
  if (p.adults) parts.push(`взрослых: ${p.adults}`);
  if (p.kids !== '' && p.kids !== undefined && p.kids !== null) {
    parts.push(`детей: ${p.kids}`);
    if (p.kids_ages?.length) parts.push(`возраст детей: ${p.kids_ages.join(', ')}`);
  }
  if (p.filter_price_max) {
    parts.push(`бюджет до ${Number(p.filter_price_max).toLocaleString('ru-RU')} ₽`);
  }
  if (p.filter_meals) parts.push(`питание: ${formatMealsLabel(p.filter_meals)}`);
  if (p.filter_stars) parts.push(`звёзды: ${p.filter_stars}`);
  return parts;
}

module.exports = {
  ConversationStage,
  FIELD_LABELS,
  applyDefaults,
  prepareSearchParams,
  isReady,
  hasDestination,
  hasHotelSearch,
  isHotelIntent,
  inferSearchIntentFromParams,
  getCollectionSteps,
  getKidsCount,
  isFieldMissing,
  getMissingFields,
  getNextMissingField,
  resolveStage,
  userWantsMoreResults,
  userWantsMoreHotelsAfterResults,
  userGivesPositiveHotelFeedback,
  userWantsRetrySearch,
  userAsksHotelComparison,
  isPostSearchAdvisoryText,
  getLastShownHotels,
  userAsksWhyNoResults,
  userAsksDestinationActivities,
  buildSearchFingerprint,
  searchFiltersChanged,
  SEARCH_FILTER_KEYS,
  summarizeKnownParams,
  formatMealsLabel,
};
