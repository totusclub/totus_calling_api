const MEAL_LABELS = {
  BB: 'Завтрак',
  RO: 'Без питания',
  AI: 'Всё включено',
  UAI: 'Ультра всё включено',
  HB: 'Завтрак и ужин',
  FB: 'Завтрак, обед, ужин',
  HBD: 'Завтрак и ужин',
  AI24: 'Всё включено 24 часа',
  DNR: 'Ужин',
  AIL: 'Всё включено с ограничениями',
  'FB+': 'Завтрак, обед, ужин +',
  'HB+': 'Завтрак и ужин +',
  HBL: 'Завтрак и обед',
};

function normalizeDate(value) {
  if (!value || typeof value !== 'string') return null;
  return value.trim().slice(0, 10);
}

function getMealLabel(mealId, mealTypes = []) {
  const found = mealTypes.find((m) => m.id === mealId);
  return found?.description || MEAL_LABELS[mealId] || mealId;
}

function mealIdMatchesFilter(mealId, filterMeals) {
  if (!filterMeals) return true;
  const id = String(mealId || '').toUpperCase();
  const filter = String(filterMeals).toUpperCase();

  if (filter === 'UAI') return id === 'UAI';
  if (filter === 'AI') return id === 'AI' || id === 'UAI';
  if (filter.includes(',')) {
    const allowed = filter.split(',').map((s) => s.trim());
    return allowed.includes(id);
  }
  return id === filter;
}

/**
 * Find cheapest room offer from hotels-rooms response.
 */
function findCheapestRoomOffer(roomsData, { startDate, nights, maxPrice, filterMeals } = {}) {
  const rooms = roomsData?.result || roomsData || [];
  if (!Array.isArray(rooms) || !rooms.length) return null;

  const targetDate = normalizeDate(startDate);
  const targetNights = nights ? Number(nights) : null;
  const priceCap = maxPrice ? Number(maxPrice) : null;

  let best = null;
  let fallback = null;

  for (const room of rooms) {
    const roomType = room.room?.name_ru || room.room?.name_en || '';
    const offersMap = room.offers || {};

    for (const [mealId, offers] of Object.entries(offersMap)) {
      if (!Array.isArray(offers)) continue;
      if (!mealIdMatchesFilter(mealId, filterMeals)) continue;
      const mealType = getMealLabel(mealId, room.meal_types);

      for (const offer of offers) {
        if (!offer?.price) continue;
        const price = Number(offer.price);
        if (priceCap && price > priceCap) continue;

        const candidate = {
          room_type: roomType,
          meal_type: mealType,
          meal_id: mealId,
          room_id: room.room?.id ?? null,
          room_listing_id: room.ID ?? null,
          offer_id: offer.id ?? null,
          operator_id: offer.operator_id ?? null,
          operator_name: offer.operator_name ?? null,
          price,
          nights_count: offer.nights_count,
          start_date: offer.start_date,
        };

        if (!fallback || candidate.price < fallback.price) {
          fallback = candidate;
        }

        const dateOk = !targetDate || normalizeDate(offer.start_date) === targetDate;
        const nightsOk = !targetNights || Number(offer.nights_count) === targetNights;

        if (dateOk && nightsOk) {
          if (!best || candidate.price < best.price) {
            best = candidate;
          }
        }
      }
    }
  }

  return best || fallback;
}

module.exports = {
  MEAL_LABELS,
  findCheapestRoomOffer,
  getMealLabel,
  mealIdMatchesFilter,
};
