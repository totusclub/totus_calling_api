const memory = require('./memory.store');
const { ConversationStage } = require('./conversation.state');
const { processTurn, buildApiPayload, ensureConversationState } = require('./tour.orchestrator');

async function processUserMessage(conversationId, text, options = {}) {
  return processTurn(conversationId, text, options);
}

function createConversation({ userId, title } = {}) {
  const conversation = memory.createEmptyConversation({ userId, title });
  ensureConversationState(conversation);
  conversation.stage = ConversationStage.COLLECTING_PARAMS;
  conversation.results = { hotels: [] };
  memory.saveConversation(conversation);

  const payload = buildApiPayload(conversation);
  return {
    ok: true,
    ...payload,
    conversation: {
      id: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt,
    },
  };
}

function getConversationMessages(conversationId, { userId } = {}) {
  const conversation = memory.getConversation(conversationId);
  if (!conversation) {
    const err = new Error('Conversation not found');
    err.status = 404;
    throw err;
  }
  if (userId && conversation.userId && String(conversation.userId) !== String(userId)) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }
  ensureConversationState(conversation);
  const payload = buildApiPayload(conversation);
  return {
    ok: true,
    ...payload,
    conversation: {
      id: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt,
    },
  };
}

function listConversations({ userId } = {}) {
  return { ok: true, conversations: memory.listConversations({ userId }) };
}

function deleteConversation(conversationId, { userId } = {}) {
  const conversation = memory.getConversation(conversationId);
  if (!conversation) {
    const err = new Error('Conversation not found');
    err.status = 404;
    throw err;
  }
  if (userId && conversation.userId && String(conversation.userId) !== String(userId)) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }
  memory.deleteConversation(conversationId);
  return { ok: true };
}

module.exports = {
  processUserMessage,
  createConversation,
  getConversationMessages,
  listConversations,
  deleteConversation,
};
