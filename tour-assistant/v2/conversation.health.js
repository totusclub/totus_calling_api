function normalizeReply(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function hashReply(text) {
  return normalizeReply(text);
}

function ensureMeta(conversation) {
  if (!conversation.meta) {
    conversation.meta = {
      last_reply_hash: '',
      identical_reply_streak: 0,
      escalation_level: 0,
      last_search_outcome: null,
      turn_count: 0,
      episodic: [],
      suggested_reset: false,
    };
  }
  if (!Array.isArray(conversation.meta.episodic)) {
    conversation.meta.episodic = [];
  }
  if (!conversation.semantic) {
    conversation.semantic = { preferences: {} };
  }
  return conversation.meta;
}

function recordTurn(conversation) {
  const meta = ensureMeta(conversation);
  meta.turn_count = (meta.turn_count || 0) + 1;
}

function recordAssistantReply(conversation, content) {
  const meta = ensureMeta(conversation);
  const hash = hashReply(content);
  if (!hash) return;
  if (hash === meta.last_reply_hash) {
    meta.identical_reply_streak = (meta.identical_reply_streak || 0) + 1;
  } else {
    meta.identical_reply_streak = 0;
    meta.last_reply_hash = hash;
  }
}

function wouldRepeatReply(conversation, content) {
  const meta = ensureMeta(conversation);
  const hash = hashReply(content);
  if (!hash) return false;
  return hash === meta.last_reply_hash && (meta.identical_reply_streak || 0) >= 1;
}

function shouldForceEscalation(conversation) {
  const meta = ensureMeta(conversation);
  if ((meta.identical_reply_streak || 0) >= 2) return true;
  if (
    (meta.escalation_level || 0) > 0 &&
    meta.last_search_outcome === 'no_results' &&
    (meta.identical_reply_streak || 0) >= 1
  ) {
    return true;
  }
  return false;
}

function recordSearchOutcome(conversation, outcome) {
  const meta = ensureMeta(conversation);
  meta.last_search_outcome = outcome;
  if (outcome === 'found') {
    meta.escalation_level = 0;
    meta.identical_reply_streak = 0;
  }
}

function appendEpisodicEvent(conversation, event) {
  const meta = ensureMeta(conversation);
  meta.episodic.push({
    ...event,
    at: new Date().toISOString(),
  });
  if (meta.episodic.length > 40) {
    meta.episodic = meta.episodic.slice(-40);
  }
}

function isConversationTooLong(conversation, maxTurns = 50) {
  const meta = ensureMeta(conversation);
  return (meta.turn_count || 0) >= maxTurns;
}

module.exports = {
  ensureMeta,
  recordTurn,
  recordAssistantReply,
  wouldRepeatReply,
  shouldForceEscalation,
  recordSearchOutcome,
  appendEpisodicEvent,
  isConversationTooLong,
  hashReply,
};
