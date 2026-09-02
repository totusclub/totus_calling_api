const { createTextMessage, sanitizeAssistantText } = require('./dto/messages');
const memory = require('./memory.store');

function buildAiHistory(conversation) {
  return (conversation.messages || []).map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

function areSearchFieldsComplete(params) {
  const merged = params || {};
  const hasFrom = merged.from_city || merged.from_country;
  const hasToCountry = merged.to_country;
  const hasAdults = merged.adults;
  const hasStartDate = merged.start_date;
  const hasNights = merged.nights;
  const hasPriceMax = merged.filter_price_max;
  const hasKids = merged.kids !== undefined && merged.kids !== null;
  const kidsValue = parseInt(merged.kids || '0', 10);
  const hasKidsAges =
    kidsValue === 0 || (merged.kids_ages && Array.isArray(merged.kids_ages));
  return Boolean(
    hasFrom &&
      hasToCountry &&
      hasAdults &&
      hasStartDate &&
      hasNights &&
      hasPriceMax &&
      hasKids &&
      hasKidsAges,
  );
}

function detectPagination(userText, conversation) {
  const text = (userText || '').toLowerCase();
  const wantsMore =
    text.includes('другие') ||
    text.includes('ещё') ||
    text.includes('еще') ||
    text.includes('ещо') ||
    text.includes('следующие') ||
    text.includes('дальше') ||
    text.includes('ищи') ||
    text.includes('поищи') ||
    text.includes('найди');
  const session = conversation.searchSession || {};
  return Boolean(wantsMore && session.requestId && session.currentPage > 0);
}

function updateConversationTitle(conversation, userText) {
  if (
    conversation.title === 'Новый чат' &&
    userText &&
    conversation.messages.length <= 2
  ) {
    conversation.title = userText.slice(0, 48);
  }
}

function appendUserMessage(conversation, text) {
  const msg = createTextMessage({ role: 'user', content: text });
  conversation.messages.push(msg);
  updateConversationTitle(conversation, text);
  return msg;
}

function appendAssistantMessage(conversation, content) {
  const msg = createTextMessage({
    role: 'assistant',
    content: sanitizeAssistantText(content),
  });
  conversation.messages.push(msg);
  return msg;
}

function getMergedSearchParams(conversation) {
  return { ...(conversation.searchParams || {}) };
}

module.exports = {
  buildAiHistory,
  areSearchFieldsComplete,
  detectPagination,
  appendUserMessage,
  appendAssistantMessage,
  getMergedSearchParams,
  memory,
};
