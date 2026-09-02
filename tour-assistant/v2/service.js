const { callDeepSeek } = require('./deepseek.client');
const { applyAutoSearchFix } = require('../shared/autoSearchResolver');
const { sanitizeAssistantText } = require('./dto/messages');
const memory = require('./memory.store');
const hotelSearch = require('./hotel.search.service');
const manager = require('./conversation.manager');

async function processUserMessage(conversationId, text, { userId, onChunk } = {}) {
  let conversation = memory.getConversation(conversationId);
  if (!conversation) {
    const err = new Error('Conversation not found');
    err.status = 404;
    throw err;
  }

  if (userId && conversation.userId && conversation.userId !== userId) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }

  manager.appendUserMessage(conversation, text);

  const aiHistory = manager.buildAiHistory(conversation);
  const mergedParams = manager.getMergedSearchParams(conversation);

  if (onChunk) onChunk({ event: 'typing', data: { active: true } });

  const aiResponse = await callDeepSeek(text, aiHistory, mergedParams);
  const autoFix = applyAutoSearchFix({
    text,
    aiResponse,
    conversationHistory: aiHistory,
    mergedParams,
    currentSearchParams: conversation.searchParams,
  });

  let finalChatMode = autoFix.finalChatMode;
  let finalSearchParams = autoFix.finalSearchParams || {};

  if (finalChatMode === false && finalSearchParams && !finalSearchParams.filter_stars) {
    finalSearchParams.filter_stars = '5';
  }

  const safeQuestion = sanitizeAssistantText(aiResponse.nextQuestion);

  if (finalChatMode) {
    const content = safeQuestion || 'Чем ещё могу помочь?';
    if (onChunk) {
      onChunk({ event: 'message_chunk', data: { content } });
    }
    manager.appendAssistantMessage(conversation, content);
    memory.saveConversation(conversation);
    if (onChunk) {
      onChunk({
        event: 'final_message',
        data: { messages: conversation.messages, conversationId: conversation.id },
      });
    }
    return {
      conversationId: conversation.id,
      messages: conversation.messages,
    };
  }

  conversation.searchParams = {
    ...conversation.searchParams,
    ...finalSearchParams,
  };

  const allFilled = manager.areSearchFieldsComplete(conversation.searchParams);
  const isPagination = manager.detectPagination(text, conversation);

  if (!allFilled) {
    const content = safeQuestion || 'Расскажи подробнее, чтобы я мог подобрать тур.';
    if (onChunk) onChunk({ event: 'message_chunk', data: { content } });
    manager.appendAssistantMessage(conversation, content);
    memory.saveConversation(conversation);
    if (onChunk) {
      onChunk({
        event: 'final_message',
        data: { messages: conversation.messages, conversationId: conversation.id },
      });
    }
    return { conversationId: conversation.id, messages: conversation.messages };
  }

  const searchingText =
    safeQuestion ||
    (isPagination ? 'Ищу ещё варианты для тебя! 🔎' : 'Ищу подходящие отели для вас...');

  if (onChunk) onChunk({ event: 'message_chunk', data: { content: searchingText } });

  try {
    const { hotels } = await hotelSearch.runHotelSearch(
      conversation,
      conversation.searchParams,
      { isPagination },
    );

    const hotelText = hotelSearch.formatHotelsAsText(hotels);
    const fullContent = `${searchingText}\n\n${hotelText}`;
    manager.appendAssistantMessage(conversation, fullContent);

    if (conversation.searchParams.page_number) {
      conversation.searchSession = conversation.searchSession || {};
      conversation.searchSession.currentPage =
        conversation.searchParams.page_number;
    }
  } catch (searchErr) {
    console.error('[V2] Hotel search error:', searchErr);
    manager.appendAssistantMessage(
      conversation,
      'Произошла ошибка при поиске. Попробуйте ещё раз.',
    );
  }

  memory.saveConversation(conversation);

  if (onChunk) {
    onChunk({
      event: 'final_message',
      data: { messages: conversation.messages, conversationId: conversation.id },
    });
  }

  return {
    conversationId: conversation.id,
    messages: conversation.messages,
  };
}

function createConversation({ userId, title } = {}) {
  const conversation = memory.createEmptyConversation({ userId, title });
  memory.saveConversation(conversation);
  return {
    conversationId: conversation.id,
    messages: conversation.messages,
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
  if (userId && conversation.userId && conversation.userId !== userId) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }
  return {
    conversationId: conversation.id,
    messages: conversation.messages,
    conversation: {
      id: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt,
    },
  };
}

function listConversations({ userId } = {}) {
  return { conversations: memory.listConversations({ userId }) };
}

function deleteConversation(conversationId, { userId } = {}) {
  const conversation = memory.getConversation(conversationId);
  if (!conversation) {
    const err = new Error('Conversation not found');
    err.status = 404;
    throw err;
  }
  if (userId && conversation.userId && conversation.userId !== userId) {
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
