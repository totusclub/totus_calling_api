/** V2-only config — does not touch legacy tour-assistant routes. */
module.exports = {
  DEEPSEEK_API_KEY:
    process.env.DEEPSEEK_API_KEY || '',
  DEEPSEEK_API_URL:
    process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions',
  TOTUS_API_BASE_URL: process.env.TOTUS_API_BASE_URL || 'https://api.totus.club',
  CONVERSATIONS_DIR:
    process.env.TOUR_ASSISTANT_V2_DATA_DIR ||
    require('path').join(__dirname, '../../data/tour-assistant-v2'),
};
