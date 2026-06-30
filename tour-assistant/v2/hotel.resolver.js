const axios = require('axios');
const { TOTUS_API_BASE_URL } = require('./config');

const api = axios.create({
  baseURL: TOTUS_API_BASE_URL,
  timeout: 20000,
});

const HOTEL_BRANDS =
  /hilton|marriott|hyatt|sheraton|radisson|intercontinental|ritz|four seasons|kempinski|rixos|swissotel|movenpick|novotel|ibis|holiday inn/i;

/**
 * Extract a hotel name from free-form user text.
 */
const TRAVEL_PHRASE =
  /^(поехать|отдохнуть|тур|вылет|на\s+море|в\s+|на\s+)/i;

function extractHotelNameFromText(text) {
  const raw = (text || '').trim();
  if (!raw) return null;

  // «ищу отели с рейтингом 10» — фильтр по рейтингу, не название отеля
  if (/рейтинг|rating|оценк/i.test(raw) && /отел/i.test(raw)) return null;

  // "хочу поехать в Анталию" — направление, не отель
  if (/хочу\s+(поехать|отдохнуть|тур|вылет)/i.test(raw)) return null;

  const patterns = [
    /(?:покажи|найди|найти|show me|find|ищу)\s+(?:мне\s+)?(?:отель\s+)?(.+)/i,
    /(?:хочу|нужен|интересует)\s+(?:мне\s+)?отель\s+(.+)/i,
    /(?:отель|hotel)\s+(.+)/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      const name = match[1].trim().replace(/[.!?]+$/, '');
      if (/рейтинг|rating|оценк/i.test(name)) continue;
      if (name.length >= 3 && !TRAVEL_PHRASE.test(name)) return name;
    }
  }

  if (HOTEL_BRANDS.test(raw) && raw.split(/\s+/).length >= 2 && !/^(antalya|анталь|dubai|дубай|turkey|турц)/i.test(raw)) {
    return raw.replace(/[.!?]+$/, '').trim();
  }

  return null;
}

/**
 * Resolve hotel name to Totus autocomplete result.
 */
async function resolveHotelByName(hotelName, fromCity = 'Moscow') {
  if (!hotelName || hotelName.length < 3) return null;

  try {
    const query = `"${hotelName}"`;
    const res = await api.get('/references/autocomplete_v2', {
      params: {
        query,
        from_city: fromCity,
        search_type: 'hotel',
      },
    });

    const groups = Array.isArray(res.data) ? res.data : [];
    const hotelGroup = groups.find((g) => g.group_name === 'hotels');
    const results = hotelGroup?.results || [];
    if (!results.length) return null;

    const best = results[0];
    return {
      hotel_id: String(best.id),
      hotel_name: best.name || best.name_en || hotelName,
      to_country: best.iso2 || '',
      to_city: best.city_name || best.country_name_ru || '',
    };
  } catch (err) {
    console.warn('[V2 hotel.resolver] resolve failed:', err.message);
    return null;
  }
}

module.exports = {
  extractHotelNameFromText,
  resolveHotelByName,
};
