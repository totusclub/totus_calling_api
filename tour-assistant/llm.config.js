/**
 * Central LLM configuration for tour-assistant (V2 + legacy shared).
 *
 * deepseek-chat is deprecated 2026-07-24 → use deepseek-v4-flash.
 * Override via env: DEEPSEEK_MODEL, DEEPSEEK_MODEL_THINKING
 */
module.exports = {
  DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
  /** Thinking / chain-of-thought mode (replaces deepseek-reasoner). */
  DEEPSEEK_MODEL_THINKING:
    process.env.DEEPSEEK_MODEL_THINKING || 'deepseek-v4-flash',

  LLM_TEMPERATURE: {
    /** Hotel enrich, strict JSON extraction */
    extraction: 0.1,
    /** Search params from user message */
    params: 0.2,
    /** Collection questions, post-search replies */
    dialogue: 0.3,
    /** Legacy tour chat (was 0.7) */
    chat: 0.3,
  },
};
