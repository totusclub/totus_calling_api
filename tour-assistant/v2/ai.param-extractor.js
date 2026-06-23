const axios = require('axios');
const { DEEPSEEK_API_KEY, DEEPSEEK_API_URL } = require('./config');
const WORKFLOW_PROMPT = require('./workflow.prompt');

/**
 * Calls DeepSeek ONLY to extract searchParams (no chat / no nextQuestion).
 */
async function extractParamsWithAi(userMessage, conversation, nextField = null) {
  const history = (conversation.messages || [])
    .slice(-6)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));

  const messages = [
    { role: 'system', content: WORKFLOW_PROMPT },
    {
      role: 'system',
      content: [
        `Уже известные параметры (не перезаписывай без причины): ${JSON.stringify(conversation.searchParams || {})}`,
        nextField
          ? `Сейчас ожидается ответ на вопрос про: ${nextField}. Извлеки значение именно для этого поля.`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    ...history,
    { role: 'user', content: userMessage },
  ];

  try {
    const response = await axios.post(
      DEEPSEEK_API_URL,
      {
        model: 'deepseek-chat',
        messages,
        temperature: 0.2,
        max_tokens: 400,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        },
        timeout: 30000,
      },
    );

    const aiText = response.data?.choices?.[0]?.message?.content;
    if (!aiText) return {};

    let clean = aiText.trim();
    if (clean.startsWith('```')) {
      clean = clean.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    }
    if (!clean.startsWith('{')) {
      const m = clean.match(/\{[\s\S]*\}/);
      if (m) clean = m[0];
    }

    const parsed = JSON.parse(clean);
    return parsed.searchParams && typeof parsed.searchParams === 'object'
      ? parsed.searchParams
      : {};
  } catch (err) {
    console.warn('[V2 ai.param-extractor] Extraction failed:', err.message);
    return {};
  }
}

module.exports = { extractParamsWithAi };
