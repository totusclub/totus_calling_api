const axios = require('axios');
const { DEEPSEEK_API_KEY, DEEPSEEK_API_URL } = require('./config');
const { stripMetaLanguage } = require('./response.composer');
const { summarizeKnownParams } = require('./conversation.state');

const ACTIVITIES_PROMPT = `Ты — премиальный travel-консьерж Totus. Пользователь спрашивает, чем заняться в направлении поездки.

Ответь профессионально, живо и по делу:
- 4–6 конкретных идей: экскурсии, пляж, рестораны, шопинг, природа, wellness, вечерний досуг — по типу направления
- Учитывай сезон и даты поездки, если они указаны
- Для отеля — расскажи про район, курорт и что рядом
- Короткие абзацы или нумерованный список (1. 2. 3.) — без markdown-заголовков
- Обращайтесь на «вы», тон эксперта-консьержа
- Не упоминай API, поиск туров, базы данных
- Не задавай вопросов в конце — только полезная информация о направлении
- Объём: 80–180 слов`;

function getDestinationContext(params) {
  const p = params || {};
  if (p.hotel_name && String(p.hotel_name).trim()) {
    return {
      label: String(p.hotel_name).trim(),
      kind: 'hotel',
      city: p.to_city || '',
      country: p.to_country || '',
    };
  }
  if (p.to_city && String(p.to_city).trim()) {
    return {
      label: String(p.to_city).trim(),
      kind: 'city',
      country: p.to_country || '',
    };
  }
  if (p.to_country && String(p.to_country).trim()) {
    return {
      label: String(p.to_country).trim(),
      kind: 'country',
    };
  }
  return null;
}

function buildTripContext(params) {
  const parts = summarizeKnownParams(params);
  return parts.length ? parts.join('; ') : 'пока мало деталей';
}

/**
 * Professional answer: what to do at the current destination context.
 */
async function generateDestinationActivitiesAnswer(userText, conversation, knownParams) {
  const destination = getDestinationContext(knownParams);

  if (!destination) {
    return 'С удовольствием расскажу, чем заняться — для точных рекомендаций сначала уточним направление поездки.';
  }

  const history = (conversation.messages || [])
    .slice(-6)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));

  const placeLine =
    destination.kind === 'hotel'
      ? `Отель/курорт: ${destination.label}${destination.city ? ` (${destination.city})` : ''}`
      : destination.kind === 'city'
        ? `Город/курорт: ${destination.label}${destination.country ? `, ${destination.country}` : ''}`
        : `Страна/направление: ${destination.label}`;

  const messages = [
    { role: 'system', content: ACTIVITIES_PROMPT },
    {
      role: 'system',
      content: [
        placeLine,
        `Контекст поездки: ${buildTripContext(knownParams)}`,
        knownParams.start_date ? `Дата вылета: ${knownParams.start_date}` : '',
        knownParams.nights ? `Ночей: ${knownParams.nights}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    ...history,
    { role: 'user', content: userText },
  ];

  try {
    const response = await axios.post(
      DEEPSEEK_API_URL,
      {
        model: 'deepseek-chat',
        messages,
        temperature: 0.65,
        max_tokens: 450,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        },
        timeout: 25000,
      },
    );

    const raw = response.data?.choices?.[0]?.message?.content?.trim();
    const clean = stripMetaLanguage(raw || '');
    if (clean && clean.length > 20) return clean;
  } catch (err) {
    console.warn('[V2 destination.info] AI answer failed:', err.message);
  }

  const name = destination.label;
  return [
    `В ${name} обычно стоит обратить внимание на несколько форматов отдыха:`,
    '1. Пляжный отдых и водные активности',
    '2. Экскурсии к главным достопримечательностям',
    '3. Местная кухня и вечерние прогулки',
    '4. Шопинг и SPA — по вашему настроению',
    'Могу подсказать подробнее после уточнения дат и формата поездки.',
  ].join('\n');
}

module.exports = {
  generateDestinationActivitiesAnswer,
  getDestinationContext,
};
