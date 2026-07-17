const axios = require('axios');
const { DEEPSEEK_API_KEY, DEEPSEEK_API_URL } = require('./config');
const { DEEPSEEK_MODEL, LLM_TEMPERATURE } = require('../llm.config');

const HOTEL_ENRICH_PROMPT = `Ты определяешь конкретный отель и его местоположение для туристического API.

Верни ТОЛЬКО JSON без markdown:
{
  "is_hotel": true,
  "hotel_name": "полное официальное название отеля",
  "to_country": "ISO2 код страны или пустая строка",
  "to_city": "город на английском для API (Dubai, Sharm El Sheikh, Antalya, Hurghada) или пустая строка",
  "confidence": "high"
}

Правила:
- is_hotel=false, если пользователь спрашивает страну/курорт/город, а не конкретный отель.
- НИКОГДА не сокращай название отеля — сохраняй район/филиал: Al Jadaf, Palm Jumeirah, Marsa Alam, Premium Seagate, Adults Only и т.д.
- to_country: TR, EG, AE, TH, GR, ES и т.д. (ровно 2 буквы).
- to_city: каноническое английское имя для поиска туров.
- Если город/страна неясны — оставь пустыми, confidence="low".
- Не выдумывай отель, которого нет в сообщении пользователя.
- confidence: "high" | "medium" | "low".`;

function parseAiJson(text) {
  if (!text) return null;
  let clean = String(text).trim();
  if (clean.startsWith('```')) {
    clean = clean.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  }
  if (!clean.startsWith('{')) {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) clean = m[0];
  }
  return JSON.parse(clean);
}

function sanitizeAiHotelResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.is_hotel === false) return null;

  const hotel_name = String(raw.hotel_name || '').trim();
  if (!hotel_name || hotel_name.length < 3) return null;

  let to_country = String(raw.to_country || '').trim().toUpperCase();
  if (to_country.length !== 2) to_country = '';

  const to_city = String(raw.to_city || '').trim();
  const confidence = ['high', 'medium', 'low'].includes(raw.confidence)
    ? raw.confidence
    : 'medium';

  return {
    hotel_name,
    to_country: to_country || undefined,
    to_city: to_city || undefined,
    confidence,
    from_ai: true,
  };
}

/**
 * Ask DeepSeek for the full hotel name + country/city before Totus autocomplete.
 * Results are cached per conversation on the normalized hotel query key.
 */
async function enrichHotelWithDeepSeek({
  userText = '',
  hotelName = '',
  existingParams = {},
  conversation = null,
} = {}) {
  const seed = String(hotelName || userText || '').trim();
  if (!seed || seed.length < 3) return null;

  const queryKey = seed.toLowerCase();
  const cached = conversation?.meta?.hotel_ai_enrich;
  if (cached?.query === queryKey && cached.result) {
    return cached.result;
  }

  const context = [
    existingParams.to_country ? `Уже известная страна: ${existingParams.to_country}` : '',
    existingParams.to_city ? `Уже известный город: ${existingParams.to_city}` : '',
    hotelName ? `Кандидат названия отеля: ${hotelName}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const messages = [
    { role: 'system', content: HOTEL_ENRICH_PROMPT },
    {
      role: 'user',
      content: [context, `Сообщение пользователя: ${userText || hotelName}`]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];

  try {
    const response = await axios.post(
      DEEPSEEK_API_URL,
      {
        model: DEEPSEEK_MODEL,
        messages,
        temperature: LLM_TEMPERATURE.extraction,
        max_tokens: 200,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        },
        timeout: 20000,
      },
    );

    const aiText = response.data?.choices?.[0]?.message?.content;
    const parsed = parseAiJson(aiText);
    const result = sanitizeAiHotelResult(parsed);

    if (conversation?.meta) {
      conversation.meta.hotel_ai_enrich = { query: queryKey, result };
    }

    return result;
  } catch (err) {
    console.warn('[V2 hotel.ai-enricher] DeepSeek enrich failed:', err.message);
    return null;
  }
}

module.exports = { enrichHotelWithDeepSeek, sanitizeAiHotelResult };
