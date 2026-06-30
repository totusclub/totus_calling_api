const axios = require('axios');
const { DEEPSEEK_API_KEY, DEEPSEEK_API_URL } = require('./config');
const { stripMetaLanguage } = require('./response.composer');
const { FIELD_LABELS, summarizeKnownParams } = require('./conversation.state');

const QUESTION_PROMPT = `Ты — премиальный travel-консьерж Totus. Ведёшь пошаговый диалог для подбора тура.

Формат ответа (2 части, коротко):
1) Коротко подтверди, что понял из последнего сообщения пользователя (1 предложение).
2) Задай ОДИН вопрос только про следующее недостающее поле.

Правила:
- Спрашивай строго ОДНО поле за раз — никогда два и более.
- Спрашивай ТОЛЬКО про поле, указанное в «Следующий шаг». Запрещено спрашивать про другие поля.
- Порядок сбора: тип (отель/тур) → откуда → куда → дата → ночи → взрослые → (возраст детей, только если пользователь сам упомянул детей) → бюджет → питание.
- Если следующий шаг — «тип поиска»: задай один вопрос «конкретный отель или тур/направление?».
- Не упоминай поиск, API, базы данных, инструменты.
- Не пиши «ищу», «подбираю», «сейчас найду».
- Будь дружелюбным и профессиональным.
- Если пользователь дал несколько деталей — поблагодари кратко, но спроси только следующее одно поле.
- Верни ТОЛЬКО текст ответа, без JSON и markdown.`;

const FALLBACK_QUESTIONS = {
  search_intent:
    'Подскажите: ищете конкретный отель или хотите подобрать тур в определённое направление?',
  from_city: 'Из какого города планируете вылет?',
  destination: 'Куда планируете поехать? Можно назвать страну, город или отель.',
  hotel_resolve: 'Уточните, пожалуйста, полное название отеля.',
  start_date: 'На какую дату планируете вылет?',
  nights: 'На сколько ночей планируете поездку?',
  adults: 'Сколько взрослых будет в поездке?',
  kids: 'Будут ли с вами дети? Если да — сколько?',
  kids_ages: 'Укажите возраст каждого ребёнка (например: 5 и 8).',
  filter_price_max: 'Какой максимальный бюджет на тур в рублях?',
  filter_meals: 'Какой тип питания предпочитаете: всё включено или стандарт?',
};

/**
 * Step-by-step: acknowledge + ask for exactly one next field.
 */
async function generateCollectionQuestion(
  userText,
  conversation,
  nextField,
  knownParams,
  justReceived = {},
) {
  if (!nextField) return null;

  const history = (conversation.messages || [])
    .slice(-8)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));

  const knownSummary = summarizeKnownParams(knownParams);
  const receivedKeys = Object.keys(justReceived).filter(
    (k) => justReceived[k] !== undefined && justReceived[k] !== '',
  );

  const messages = [
    { role: 'system', content: QUESTION_PROMPT },
    {
      role: 'system',
      content: [
        `Уже собрано: ${knownSummary.length ? knownSummary.join('; ') : 'пока ничего'}`,
        `Следующий шаг — спросить только про: ${FIELD_LABELS[nextField] || nextField}`,
        receivedKeys.length
          ? `Из последнего сообщения извлечено: ${JSON.stringify(justReceived)}`
          : 'Из последнего сообщения новых полей не извлечено',
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

    const raw = response.data?.choices?.[0]?.message?.content?.trim();
    const clean = stripMetaLanguage(raw || '');
    if (clean && clean.length > 5) return clean;
  } catch (err) {
    console.warn('[V2 question.composer] AI question failed:', err.message);
  }

  const fallback = FALLBACK_QUESTIONS[nextField];
  if (knownSummary.length && fallback) {
    return `Принял. ${fallback}`;
  }
  return fallback || null;
}

module.exports = { generateCollectionQuestion };
