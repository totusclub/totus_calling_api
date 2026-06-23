const DEEPSEEK_SYSTEM_PROMPT_MESSAGE = require('../shared/systemPrompt');

function buildSystemPrompt() {
  return DEEPSEEK_SYSTEM_PROMPT_MESSAGE;
}

module.exports = { buildSystemPrompt };
