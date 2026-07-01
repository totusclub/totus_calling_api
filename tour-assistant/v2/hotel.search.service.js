const axios = require('axios');
const { TOTUS_API_BASE_URL } = require('./config');
const { findCheapestRoomOffer } = require('./room.offer.utils');
const { normalizeSearchParamsForApi } = require('./search.params.normalizer');

const api = axios.create({
  baseURL: TOTUS_API_BASE_URL,
  timeout: 60000,
});

function normalizeReadyOperators(readyOperators) {
  if (Array.isArray(readyOperators)) {
    return readyOperators.map(String).join(',');
  }
  return readyOperators;
}

function parseStarsFilter(filterStars) {
  if (!filterStars || filterStars === '3,4,5') return null;
  const allowed = String(filterStars)
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 5);
  return allowed.length ? new Set(allowed) : null;
}

function applyStarsFilter(hotels, filterStars) {
  const allowed = parseStarsFilter(filterStars);
  if (!allowed) return hotels;
  return (hotels || []).filter((hotel) => {
    const data = hotel.hotel || hotel;
    const stars = Number(data.stars ?? hotel.stars);
    return allowed.has(stars);
  });
}

function hotelKey(hotel) {
  const data = hotel.hotel || hotel;
  return String(data.id || hotel.id || '');
}

function getEffectiveHotelPrice(hotel) {
  const data = hotel.hotel || hotel;
  const price = hotel.room_price ?? hotel.min_price ?? data.min_price;
  const n = Number(price);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getHotelRating(hotel) {
  const data = hotel.hotel || hotel;
  const n = Number(data.rating ?? hotel.rating);
  return Number.isFinite(n) ? n : 0;
}

function applyRatingMinFilter(hotels, filterRatingMin) {
  const min = Number(filterRatingMin);
  if (!Number.isFinite(min) || min <= 0) return hotels || [];
  return (hotels || []).filter((hotel) => getHotelRating(hotel) >= min - 0.05);
}

function applyPriceMaxFilter(hotels, filterPriceMax) {
  const cap = Number(filterPriceMax);
  if (!Number.isFinite(cap) || cap <= 0) return hotels || [];
  return (hotels || []).filter((hotel) => {
    const price = getEffectiveHotelPrice(hotel);
    return price !== null && price <= cap;
  });
}

function mealMatchesFilter(mealType, filterMeals) {
  if (!filterMeals) return true;
  const meal = String(mealType || '').toLowerCase();
  const filter = String(filterMeals).toUpperCase();

  if (filter === 'UAI') {
    return meal.includes('ультра') || meal.includes('ultra') || meal.includes('uai');
  }
  if (filter === 'AI') {
    return (
      meal.includes('всё включ') ||
      meal.includes('все включ') ||
      meal.includes('all inclusive') ||
      meal.includes('ультра') ||
      meal.includes('ultra')
    );
  }
  if (filter.includes(',')) {
    const codes = filter.split(',').map((c) => c.trim());
    return codes.some((code) => {
      if (code === 'UAI') return meal.includes('ультра') || meal.includes('ultra');
      if (code === 'AI') return meal.includes('всё включ') || meal.includes('все включ');
      return meal.includes(code.toLowerCase());
    });
  }
  return true;
}

function applyMealsFilter(hotels, filterMeals) {
  if (!filterMeals) return hotels || [];
  return (hotels || []).filter((hotel) => {
    const meal = hotel.meal_type || (hotel.hotel || hotel).meal_type || '';
    return mealMatchesFilter(meal, filterMeals);
  });
}

function excludeHotelsById(hotels, excludeIds = []) {
  if (!excludeIds?.length) return hotels || [];
  const blocked = new Set(excludeIds.map(String));
  return (hotels || []).filter((hotel) => {
    const key = hotelKey(hotel);
    return key && !blocked.has(key);
  });
}

async function startSearch(searchParams) {
  const normalized = normalizeSearchParamsForApi(searchParams);
  const clean = {};
  const fields = [
    'from_city',
    'from_country',
    'to_country',
    'to_city',
    'adults',
    'kids',
    'kids_ages',
    'start_date',
    'nights',
    'search_type',
    'flex_dates',
    'hotel_ids',
  ];
  for (const key of fields) {
    if (normalized[key] !== undefined && normalized[key] !== '') {
      clean[key] = normalized[key];
    }
  }
  if (!clean.from_city && clean.from_country) {
    clean.from_city = 'Moscow';
  }
  if (clean.hotel_ids?.length) {
    clean.search_type = 'hotel';
  }

  try {
    console.log('[V2 hotel.search] start-search params:', clean);
    const res = await api.get('/start-search', { params: clean });
    return res.data?.request_id;
  } catch (err) {
    console.error(
      '[V2 hotel.search] start-search failed:',
      err.response?.status,
      err.response?.data || err.message,
    );
    return null;
  }
}

async function pollSearchStatus(requestId) {
  const MAX_POLLS = 15;
  for (let i = 0; i < MAX_POLLS; i++) {
    try {
      const res = await api.get('/search-status', { params: { request_id: requestId } });
      const statusMap = res.data?.status || {};
      const readyOps = Object.entries(statusMap)
        .filter(([, s]) => s === 'completed' || s === 'cached')
        .map(([id]) => id);
      if (readyOps.length > 0) return readyOps;
    } catch (err) {
      console.warn('[V2 hotel.search] search-status poll error:', err.message);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return [];
}

async function getGroupedHotels({ requestId, readyOperators, filterParams }) {
  const pageLimit = filterParams.page_limit || 3;
  const pageNumber = filterParams.page_number || 1;
  const params = {
    request_id: requestId,
    readyOperators: normalizeReadyOperators(readyOperators),
    page_number: pageNumber,
    page_limit: pageLimit,
    offset: (pageNumber - 1) * pageLimit,
    sort_by: filterParams.sort_by || 'relevance',
    filter_price_min: filterParams.filter_price_min ?? 0,
    filter_instant_confirm: filterParams.filter_instant_confirm ?? false,
  };

  const filterFields = [
    'filter_price_max',
    'filter_stars',
    'filter_meals',
    'filter_instant_confirm',
    'filter_regions',
    'filter_line',
    'filter_operators',
    'filter_hotel_type',
    'filter_beach_surface',
  ];
  for (const field of filterFields) {
    if (filterParams[field] !== undefined && filterParams[field] !== '') {
      params[field] = filterParams[field];
    }
  }

  if (!params.filter_stars) {
    params.filter_stars = '3,4,5';
  }

  try {
    console.log('[V2 hotel.search] grouped-hotels params:', {
      filter_stars: params.filter_stars,
      filter_price_max: params.filter_price_max,
      page_number: params.page_number,
      page_limit: params.page_limit,
    });
    const res = await api.get('/grouped-hotels', { params });
    const hotels = res.data?.hotels || [];
    const filtered = applyStarsFilter(hotels, params.filter_stars);
    if (filtered.length !== hotels.length) {
      console.log(
        `[V2 hotel.search] stars post-filter: ${hotels.length} → ${filtered.length} (filter_stars=${params.filter_stars})`,
      );
    }
    return filtered.slice(0, pageLimit);
  } catch (err) {
    console.error(
      '[V2 hotel.search] grouped-hotels failed:',
      err.response?.status,
      err.response?.data || err.message,
    );
    return [];
  }
}

async function getGroupedHotelsWithStarFilter({
  requestId,
  readyOperators,
  filterParams,
}) {
  const pageLimit = filterParams.page_limit || 3;
  const startPage = filterParams.page_number || 1;
  const starsFilter = filterParams.filter_stars;
  const needsStrictStars = Boolean(parseStarsFilter(starsFilter));

  if (!needsStrictStars) {
    return getGroupedHotels({ requestId, readyOperators, filterParams });
  }

  const collected = [];
  const seen = new Set();
  const maxPagesToScan = 8;

  for (let page = startPage; page < startPage + maxPagesToScan; page++) {
    const batch = await getGroupedHotels({
      requestId,
      readyOperators,
      filterParams: { ...filterParams, page_number: page },
    });

    for (const hotel of batch) {
      const key = hotelKey(hotel);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      collected.push(hotel);
      if (collected.length >= pageLimit) break;
    }

    if (collected.length >= pageLimit || batch.length === 0) break;
  }

  return collected.slice(0, pageLimit);
}

function buildFilterParams(searchParams) {
  const ratingMin = Number(searchParams.filter_rating_min);
  const hasRatingFilter = Number.isFinite(ratingMin) && ratingMin > 0;
  const filterParams = {
    page_number: searchParams.page_number || 1,
    page_limit: searchParams.page_limit || 3,
    sort_by: searchParams.sort_by || (hasRatingFilter ? 'rating,desc' : 'relevance'),
    filter_price_min: searchParams.filter_price_min ?? 0,
    filter_instant_confirm: searchParams.filter_instant_confirm ?? false,
    filter_stars: searchParams.filter_stars || '3,4,5',
  };
  const filterFields = [
    'filter_price_max',
    'filter_stars',
    'filter_meals',
    'filter_instant_confirm',
    'filter_regions',
    'filter_line',
    'filter_operators',
    'filter_hotel_type',
    'filter_beach_surface',
  ];
  for (const field of filterFields) {
    if (searchParams[field] !== undefined && searchParams[field] !== '') {
      filterParams[field] = searchParams[field];
    }
  }
  return filterParams;
}

function enrichHotelForClient(hotel, roomOffer = null) {
  const data = hotel.hotel || hotel;
  const price = roomOffer?.price || hotel.min_price || data.min_price;

  return {
    ...hotel,
    id: data.id || hotel.id,
    name: data.name || data.name_en || hotel.name,
    city_name: data.city_name || hotel.city_name,
    stars: data.stars || hotel.stars,
    rating: data.rating || hotel.rating,
    reviews_count: data.reviews_count || data.reviews || hotel.reviews_count,
    min_price: price,
    room_type: roomOffer?.room_type || hotel.room_type || '',
    meal_type: roomOffer?.meal_type || hotel.meal_type || '',
    room_price: roomOffer?.price || price,
    images: data.images || hotel.images,
    description: data.description || data.short_description || '',
    amenities: (Array.isArray(data.features)
      ? data.features
      : Array.isArray(data.amenities)
        ? data.amenities
        : []
    )
      .slice(0, 5)
      .map((a) => (typeof a === 'string' ? a : a?.name || a?.title))
      .filter(Boolean),
    hotel: data,
  };
}

async function fetchHotelRoomOffer(requestId, hotelId, searchParams) {
  if (!requestId || !hotelId) return null;
  try {
    const res = await api.get('/hotels-rooms', {
      params: { request_id: requestId, hotel_id: hotelId },
      timeout: 25000,
    });
    return findCheapestRoomOffer(res.data, {
      startDate: searchParams.start_date,
      nights: searchParams.nights,
      maxPrice: searchParams.filter_price_max,
      filterMeals: searchParams.filter_meals,
    });
  } catch (err) {
    console.warn('[V2 hotel.search] hotels-rooms failed for', hotelId, err.message);
    return null;
  }
}

async function enrichHotelsWithRoomOffers(hotels, requestId, searchParams) {
  const cap = Number(searchParams.filter_price_max);
  const hasCap = Number.isFinite(cap) && cap > 0;

  const tasks = (hotels || []).map(async (hotel) => {
    const data = hotel.hotel || hotel;
    const hotelId = data.id || hotel.id;
    const listPrice = getEffectiveHotelPrice(hotel);
    if (hasCap && listPrice !== null && listPrice > cap) {
      return null;
    }

    const roomOffer = await fetchHotelRoomOffer(requestId, hotelId, searchParams);
    if (searchParams.filter_meals && !roomOffer) {
      return null;
    }
    if (hasCap && roomOffer?.price && Number(roomOffer.price) > cap) {
      return null;
    }
    if (!roomOffer && hasCap && listPrice === null) {
      return null;
    }

    return enrichHotelForClient(hotel, roomOffer);
  });

  const enriched = await Promise.all(tasks);
  return enriched.filter(Boolean);
}

async function collectHotelsFromPages({
  requestId,
  readyOperators,
  filterParams,
  searchParams = {},
  excludeHotelIds = [],
  startPage = 1,
  maxPages = 8,
}) {
  const pageLimit = filterParams.page_limit || 3;
  const ratingMin = searchParams.filter_rating_min;
  const hasRatingFilter = Number(ratingMin) > 0;
  const priceCap = Number(searchParams.filter_price_max);
  const hasPriceCap = Number.isFinite(priceCap) && priceCap > 0;
  const collected = [];
  const seen = new Set((excludeHotelIds || []).map(String));
  let lastPage = startPage;
  const scanPages = hasRatingFilter ? Math.max(maxPages, 15) : maxPages;

  for (let page = startPage; page < startPage + scanPages; page++) {
    const batch = await getGroupedHotelsWithStarFilter({
      requestId,
      readyOperators,
      filterParams: { ...filterParams, page_number: page },
    });

    lastPage = page;
    if (!batch.length) break;

    let candidates = hasRatingFilter
      ? applyRatingMinFilter(batch, ratingMin)
      : batch;

    if (hasPriceCap) {
      candidates = candidates.filter((hotel) => {
        const price = getEffectiveHotelPrice(hotel);
        return price === null || price <= priceCap;
      });
    }

    for (const hotel of candidates) {
      const key = hotelKey(hotel);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      collected.push(hotel);
      if (collected.length >= pageLimit) {
        return { hotels: collected, lastPage };
      }
    }
  }

  return { hotels: collected, lastPage };
}

async function tryRelaxedSearch(conversation, searchParams, { excludeHotelIds = [] } = {}) {
  const relaxed = { ...searchParams };
  relaxed.flex_dates = Math.max(Number(relaxed.flex_dates) || 2, 4);
  relaxed.page_number = 1;
  // Keep filter_price_max — never show tours above the user's budget.

  const requestId = await startSearch(relaxed);
  if (!requestId) return { hotels: [], triedRelaxed: true };

  const readyOperators = await pollSearchStatus(requestId);
  if (!readyOperators.length) return { hotels: [], triedRelaxed: true };

  const filterParams = buildFilterParams(relaxed);
  const { hotels } = await collectHotelsFromPages({
    requestId,
    readyOperators,
    filterParams: { ...filterParams, page_number: 1 },
    searchParams: relaxed,
    excludeHotelIds,
    startPage: 1,
    maxPages: 6,
  });

  let enriched = await enrichHotelsWithRoomOffers(hotels, requestId, relaxed);
  enriched = applyPriceMaxFilter(enriched, relaxed.filter_price_max);
  enriched = applyMealsFilter(enriched, relaxed.filter_meals);
  enriched = applyRatingMinFilter(enriched, relaxed.filter_rating_min);

  if (enriched.length) {
    conversation.searchSession = { requestId, readyOperators, currentPage: 1 };
    conversation.searchParams = { ...relaxed, page_number: 1 };
  }

  return { hotels: enriched, triedRelaxed: true };
}

async function tryBestRatingFallback(
  conversation,
  searchParams,
  { requestId, readyOperators, excludeHotelIds = [] } = {},
) {
  const withoutRatingFilter = { ...searchParams, filter_rating_min: '', sort_by: 'rating,desc' };
  const filterParams = buildFilterParams(withoutRatingFilter);

  const { hotels } = await collectHotelsFromPages({
    requestId,
    readyOperators,
    filterParams,
    searchParams: {},
    excludeHotelIds,
    startPage: 1,
    maxPages: 8,
  });

  let enriched = await enrichHotelsWithRoomOffers(hotels, requestId, searchParams);
  enriched = applyPriceMaxFilter(enriched, searchParams.filter_price_max);
  enriched.sort((a, b) => getHotelRating(b) - getHotelRating(a));
  enriched = enriched.slice(0, searchParams.page_limit || 3);

  if (enriched.length) {
    conversation.searchSession = { requestId, readyOperators, currentPage: 1 };
  }

  return enriched;
}

async function runHotelSearch(
  conversation,
  searchParams,
  { isPagination = false, excludeHotelIds = [] } = {},
) {
  const session = conversation.searchSession || {};
  const filterParams = buildFilterParams(searchParams);
  const priceCap = searchParams.filter_price_max;
  const ratingMin = searchParams.filter_rating_min;

  const finalizeHotels = async (hotels, requestId, { skipPriceCap = false } = {}) => {
    const cap = skipPriceCap ? '' : priceCap;
    const enrichParams = skipPriceCap ? { ...searchParams, filter_price_max: '' } : searchParams;
    let enriched = await enrichHotelsWithRoomOffers(hotels, requestId, enrichParams);
    enriched = applyPriceMaxFilter(enriched, cap);
    enriched = applyMealsFilter(enriched, searchParams.filter_meals);
    enriched = applyRatingMinFilter(enriched, ratingMin);
    if (Number(ratingMin) > 0) {
      enriched.sort((a, b) => getHotelRating(b) - getHotelRating(a));
    }
    return enriched;
  };

  if (isPagination && session.requestId && session.readyOperators?.length) {
    const startPage = filterParams.page_number || (session.currentPage || 1) + 1;
    const { hotels, lastPage } = await collectHotelsFromPages({
      requestId: session.requestId,
      readyOperators: session.readyOperators,
      filterParams,
      searchParams,
      excludeHotelIds,
      startPage,
      maxPages: 10,
    });

    session.currentPage = lastPage;
    conversation.searchSession = session;
    const enriched = await finalizeHotels(hotels, session.requestId);
    return { hotels: enriched, triedRelaxed: false };
  }

  const requestId = await startSearch(searchParams);
  if (!requestId) {
    return tryRelaxedSearch(conversation, searchParams, { excludeHotelIds });
  }

  const readyOperators = await pollSearchStatus(requestId);
  if (!readyOperators.length) {
    return tryRelaxedSearch(conversation, searchParams, { excludeHotelIds });
  }

  const startPage = isPagination ? filterParams.page_number : 1;
  const { hotels, lastPage } = await collectHotelsFromPages({
    requestId,
    readyOperators,
    filterParams,
    searchParams,
    excludeHotelIds,
    startPage,
    maxPages: isPagination ? 10 : 6,
  });

  conversation.searchSession = {
    requestId,
    readyOperators,
    currentPage: lastPage,
  };

  let enriched = await finalizeHotels(hotels, requestId);

  if (
    !enriched.length &&
    !isPagination &&
    priceCap &&
    searchParams.hotel_ids?.length
  ) {
    const overBudget = await finalizeHotels(hotels, requestId, { skipPriceCap: true });
    if (overBudget.length) {
      const prices = overBudget.map(getEffectiveHotelPrice).filter((p) => p != null);
      const actualMinPrice = prices.length ? Math.min(...prices) : null;
      return {
        hotels: overBudget,
        triedRelaxed: false,
        budgetExceeded: true,
        hotelOverBudget: true,
        actualMinPrice,
      };
    }
  }

  if (!enriched.length && !isPagination && Number(ratingMin) > 0) {
    const fallbackHotels = await tryBestRatingFallback(conversation, searchParams, {
      requestId,
      readyOperators,
      excludeHotelIds,
    });
    if (fallbackHotels.length) {
      return { hotels: fallbackHotels, triedRelaxed: false, ratingFallback: true };
    }
    return { hotels: [], triedRelaxed: false, ratingMinExceeded: true };
  }

  if (!enriched.length && !isPagination) {
    return tryRelaxedSearch(conversation, searchParams, { excludeHotelIds });
  }

  return { hotels: enriched, triedRelaxed: false };
}

module.exports = {
  runHotelSearch,
  buildFilterParams,
  enrichHotelForClient,
  enrichHotelsWithRoomOffers,
  applyStarsFilter,
  parseStarsFilter,
  applyPriceMaxFilter,
  applyMealsFilter,
  applyRatingMinFilter,
  getHotelRating,
  getEffectiveHotelPrice,
  hotelKey,
};
