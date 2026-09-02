/** V2-only config — does not touch legacy tour-assistant routes. */
const llm = require('../llm.config');
const { env } = require('../../lib/env');

module.exports = {
  // Только из .env (Б.1): без ключа v2-эндпоинты ИИ отвечают ошибкой конфигурации
  DEEPSEEK_API_KEY: env('DEEPSEEK_API_KEY') || null,
  DEEPSEEK_API_URL:
    process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions',
  DEEPSEEK_MODEL: llm.DEEPSEEK_MODEL,
  LLM_TEMPERATURE: llm.LLM_TEMPERATURE,
  TOTUS_API_BASE_URL: process.env.TOTUS_API_BASE_URL || 'https://api.totus.club',
  CONVERSATIONS_DIR:
    process.env.TOUR_ASSISTANT_V2_DATA_DIR ||
    require('path').join(__dirname, '../../data/tour-assistant-v2'),
};
