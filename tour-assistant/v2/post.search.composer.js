const axios = require('axios');
const { DEEPSEEK_API_KEY, DEEPSEEK_API_URL } = require('./config');
const { stripMetaLanguage } = require('./response.composer');
const { summarizeKnownParams, getLastShownHotels } = require('./conversation.state');

const POST_SEARCH_PROMPT = `Ты — премиальный travel-консьерж Totus. Пользователь уже получил подборку отелей и пишет ответ.

Ответь профессионально и по контексту (2–4 предложения):
- Если похвалил варианты — поблагодари и предложи ОДИН конкретный следующий шаг: «ещё отели», «другие даты» или «уточнить бюджет/звёзды».
- Если спрашивает про показанные отели — ответь по сути, опираясь на список ниже.
- Если хочет другие/ещё отели — подтверди, что покажете дополнительные варианты (не пиши «ищу»).
- Если неясно — задай ОДИН уточняющий вопрос: показать ещё похожие или подобрать с другими параметрами.

Правила:
- Обращайтесь на «вы», тон эксперта-консьержа.
- Не повторяй длинные списки отелей с ценами — карточки уже на экране.
- Не упоминай API и технические детали.
- Без markdown.`;

const COMPARISON_PROMPT = `Ты — премиальный travel-консьерж Totus. Пользователь видит карточки отелей и спрашивает, какой вариант лучше.

Сравни показанные отели и дай чёткую рекомендацию (3–5 предложений):
- Назови лучший вариант и кратко объясни почему (рейтинг, звёзды, пляж, цена, питание, район).
- Упомяни 1–2 альтернативы: кому они могут подойти лучше (например, бюджет, первая линия, завтрак).
- Не запускай новый поиск и не проси уточнить параметры, если вопрос только о сравнении.
- Обращайтесь на «вы», без markdown, без повторения полного списка карточек.`;

function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${Math.round(n).toLocaleString('ru-RU')} ₽`;
}

function summarizeShownHotels(hotels = []) {
  return hotels.slice(0, 5).map((h, i) => {
    const d = h.hotel || h;
    const name = d.name || h.name || 'Отель';
    const stars = d.stars ? `${d.stars}★` : '';
    const city = d.city || d.region_name || h.city_name || '';
    return `${i + 1}. ${name}${stars ? ` ${stars}` : ''}${city ? `, ${city}` : ''}`;
  });
}

function summarizeHotelsForComparison(hotels = []) {
  return hotels.slice(0, 5).map((h, i) => {
    const d = h.hotel || h;
    const name = d.name || h.name || 'Отель';
    const parts = [
      `${i + 1}. ${name}`,
      d.stars ? `${d.stars}★` : '',
      d.rating != null ? `рейтинг ${Number(d.rating).toFixed(1)}` : '',
      formatPrice(h.room_price || h.min_price),
      h.meal_type || '',
      h.room_type ? `номер: ${h.room_type}` : '',
      d.features?.line ? `линия пляжа ${d.features.line}` : '',
      d.features?.beach_distance != null ? `до пляжа ${d.features.beach_distance} м` : '',
      d.features?.wi_fi === 'FREE' ? 'Wi‑Fi бесплатно' : '',
      d.city || d.region_name || '',
    ].filter(Boolean);
    return parts.join(', ');
  });
}

function buildFallbackComparisonReply(hotels = []) {
  if (!hotels.length) {
    return 'Сначала покажу варианты — напишите «найди», и я подберу туры по вашим параметрам.';
  }

  const ranked = [...hotels].sort((a, b) => {
    const ra = Number((a.hotel || a).rating) || 0;
    const rb = Number((b.hotel || b).rating) || 0;
    if (rb !== ra) return rb - ra;
    const sa = Number((a.hotel || a).stars) || 0;
    const sb = Number((b.hotel || b).stars) || 0;
    return sb - sa;
  });

  const best = ranked[0];
  const d = best.hotel || best;
  const name = d.name || best.name;
  const rating = d.rating != null ? Number(d.rating).toFixed(1) : null;
  const price = formatPrice(best.room_price || best.min_price);

  let reply = `Из показанных я бы выделил ${name}`;
  if (d.stars) reply += ` (${d.stars}★`;
  if (rating) reply += `, рейтинг ${rating}`;
  if (d.stars || rating) reply += ')';
  reply += ' — лучший баланс качества и отзывов';
  if (price) reply += ` при цене около ${price}`;
  reply += '.';

  if (ranked.length > 1) {
    const alt = ranked[1];
    const ad = alt.hotel || alt;
    reply += ` ${ad.name || alt.name} — хорошая альтернатива`;
    const altPrice = formatPrice(alt.room_price || alt.min_price);
    if (altPrice) reply += ` (от ${altPrice})`;
    reply += '.';
  }

  reply += ' Могу подробнее рассказать про любой из них или показать ещё варианты.';
  return reply;
}

async function generateHotelComparisonReply(userText, conversation, params, hotels) {
  const shown = hotels?.length ? hotels : getLastShownHotels(conversation);
  const hotelLines = summarizeHotelsForComparison(shown);
  const tripContext = summarizeKnownParams(params).join('; ') || 'параметры поездки собраны';

  if (!hotelLines.length) {
    return buildFallbackComparisonReply([]);
  }

  const history = (conversation.messages || [])
    .slice(-6)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));

  const messages = [
    { role: 'system', content: COMPARISON_PROMPT },
    {
      role: 'system',
      content: [
        `Контекст поездки: ${tripContext}`,
        `Отели для сравнения:\n${hotelLines.join('\n')}`,
      ].join('\n'),
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
        temperature: 0.5,
        max_tokens: 320,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        },
        timeout: 20000,
      },
    );

    const raw = response.data?.choices?.[0]?.message?.content?.trim();
    const clean = stripMetaLanguage(raw || '');
    if (clean && clean.length > 20) return clean;
  } catch (err) {
    console.warn('[V2 post.search] comparison reply failed:', err.message);
  }

  return buildFallbackComparisonReply(shown);
}

function buildFallbackPostSearchReply(userText, conversation, params) {
  const shown = getLastShownHotels(conversation);
  const hadResults = shown.length > 0;
  const dest = params.to_city || params.to_country || 'направление';

  if (!hadResults) {
    return `По ${dest} вариантов пока нет. Могу сдвинуть даты, изменить бюджет или предложить соседний курорт — что попробуем?`;
  }

  const positive = /очень\s+(хорош|класс|отлич)|отлично|супер|нравится|понравил|здорово|very\s+good|great/i.test(
    (userText || '').toLowerCase(),
  );

  if (positive) {
    return `Рад, что варианты вам подходят! Показать ещё отели в ${dest} или подобрать альтернативы с другими датами и бюджетом?`;
  }

  return `Варианты по ${dest} уже выше. Могу показать ещё отели, изменить даты или уточнить фильтры — напишите, что удобнее.`;
}

async function generatePostSearchReply(userText, conversation, params) {
  const hotels = getLastShownHotels(conversation);
  const hotelLines = summarizeShownHotels(hotels);
  const tripContext = summarizeKnownParams(params).join('; ') || 'параметры поездки собраны';

  const history = (conversation.messages || [])
    .slice(-6)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));

  const messages = [
    { role: 'system', content: POST_SEARCH_PROMPT },
    {
      role: 'system',
      content: [
        `Контекст поездки: ${tripContext}`,
        hotelLines.length
          ? `Показанные отели:\n${hotelLines.join('\n')}`
          : 'Отели пока не найдены по этим параметрам.',
      ].join('\n'),
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
        temperature: 0.55,
        max_tokens: 220,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        },
        timeout: 20000,
      },
    );

    const raw = response.data?.choices?.[0]?.message?.content?.trim();
    const clean = stripMetaLanguage(raw || '');
    if (clean && clean.length > 15) return clean;
  } catch (err) {
    console.warn('[V2 post.search] AI reply failed:', err.message);
  }

  return buildFallbackPostSearchReply(userText, conversation, params);
}

module.exports = {
  generatePostSearchReply,
  generateHotelComparisonReply,
  buildFallbackPostSearchReply,
  buildFallbackComparisonReply,
  summarizeShownHotels,
  summarizeHotelsForComparison,
};
