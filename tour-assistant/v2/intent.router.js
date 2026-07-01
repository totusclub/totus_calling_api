const {
  userAsksWhyNoResults,
  userAsksDestinationActivities,
  userAsksHotelComparison,
  userWantsMoreHotelsAfterResults,
  userWantsRetrySearch,
  searchFiltersChanged,
  getLastShownHotels,
} = require('./conversation.state');

function userIsComplaint(text) {
  const t = (text || '').toLowerCase();
  return (
    /тупишь|тупой|тупая|идиот|бесишь|бесит|одно и то же|одинаков|повторяешь|не понимаешь|не слушаешь/i.test(
      t,
    ) ||
    /always the same|you are stupid|same answer/i.test(t)
  );
}

function userWantsSessionReset(text) {
  const t = (text || '').toLowerCase().trim();
  return (
    /^(новый чат|с нуля|заново|сброс|reset|start over)/i.test(t) ||
    /начн(и|ите)\s+(сначала|заново|новый)/i.test(t)
  );
}

function userRejectsCurrentDestination(text) {
  const t = (text || '').toLowerCase();
  return (
    /не\s+(там|туда|это|франц|париж|турц|египет|бали|мальдив|шарм|белек|анталь)/i.test(t) ||
    /друг(ое|ой|ая|ого)\s+направлен/i.test(t) ||
    /не\s+найти\s+на/i.test(t) ||
    /not\s+(france|paris|turkey|bali)/i.test(t)
  );
}

function userMentionsTravelAdvice(text) {
  const t = (text || '').toLowerCase();
  return (
    /виз[аы]|погод|когда лучше|сезон|безопасн|документ|паспорт/i.test(t) &&
    !/найди|ищи|покажи|тур/i.test(t)
  );
}

/**
 * Classify user intent for routing (rules-first, no LLM).
 */
function classifyIntent(userText, conversation, context = {}) {
  const { justReceived = {}, params = {} } = context;
  const shownCount = getLastShownHotels(conversation).length;
  const inResults = Boolean(conversation.lastSearchFingerprint || shownCount > 0);

  if (userIsComplaint(userText)) {
    return {
      primary: 'COMPLAINT',
      forcesSearch: false,
      allowsTemplateReply: false,
      confidence: 0.95,
    };
  }

  if (userWantsSessionReset(userText)) {
    return {
      primary: 'RESET_SESSION',
      forcesSearch: false,
      allowsTemplateReply: false,
      confidence: 0.95,
    };
  }

  if (userAsksHotelComparison(userText)) {
    return {
      primary: 'COMPARE_HOTELS',
      forcesSearch: false,
      allowsTemplateReply: true,
      confidence: 0.9,
    };
  }

  if (userAsksDestinationActivities(userText)) {
    return {
      primary: 'DESTINATION_QA',
      forcesSearch: false,
      allowsTemplateReply: false,
      confidence: 0.9,
    };
  }

  if (userMentionsTravelAdvice(userText)) {
    return {
      primary: 'TRAVEL_ADVICE',
      forcesSearch: false,
      allowsTemplateReply: false,
      confidence: 0.75,
    };
  }

  if (userWantsMoreHotelsAfterResults(userText)) {
    return {
      primary: 'MORE_RESULTS',
      forcesSearch: true,
      allowsTemplateReply: false,
      confidence: 0.9,
    };
  }

  if (userWantsRetrySearch(userText)) {
    return {
      primary: 'RETRY_SEARCH',
      forcesSearch: true,
      allowsTemplateReply: false,
      confidence: 0.9,
    };
  }

  if (userAsksWhyNoResults(userText)) {
    return {
      primary: 'WHY_NO_RESULTS',
      forcesSearch: shownCount === 0 || conversation.searchFailed,
      allowsTemplateReply: shownCount > 0,
      confidence: 0.85,
    };
  }

  if (userRejectsCurrentDestination(userText)) {
    return {
      primary: 'CHANGE_DESTINATION',
      rejectCurrent: true,
      forcesSearch: true,
      allowsTemplateReply: false,
      confidence: 0.85,
    };
  }

  if (searchFiltersChanged(justReceived)) {
    return {
      primary: 'REFINE_SEARCH',
      forcesSearch: true,
      allowsTemplateReply: false,
      confidence: 0.9,
    };
  }

  if (justReceived.to_country || justReceived.to_city || justReceived.hotel_name) {
    return {
      primary: justReceived.hotel_name ? 'SEARCH_HOTEL' : 'CHANGE_DESTINATION',
      forcesSearch: inResults,
      allowsTemplateReply: false,
      confidence: 0.85,
    };
  }

  if (params.hotel_ids?.length || (params.search_intent === 'hotel' && params.hotel_name)) {
    return {
      primary: 'SEARCH_HOTEL',
      forcesSearch: false,
      allowsTemplateReply: false,
      confidence: 0.7,
    };
  }

  if (inResults) {
    return {
      primary: 'POST_SEARCH_CHAT',
      forcesSearch: false,
      allowsTemplateReply: true,
      confidence: 0.6,
    };
  }

  return {
    primary: 'COLLECT_OR_SEARCH',
    forcesSearch: false,
    allowsTemplateReply: false,
    confidence: 0.5,
  };
}

module.exports = {
  classifyIntent,
  userIsComplaint,
  userWantsSessionReset,
  userRejectsCurrentDestination,
};
