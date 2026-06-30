const { v4: uuidv4 } = require('uuid');
const repo = require('./repositories/conversationRepository');

const DEFAULT_SEARCH_PARAMS = {
  from_city: '',
  from_country: 'RU',
  to_country: '',
  to_city: '',
  hotel_name: '',
  search_intent: '',
  adults: '',
  kids: '0',
  kids_ages: [],
  start_date: '',
  nights: '',
  search_type: 'package',
  flex_dates: 2,
  hotel_ids: [],
  filter_price_max: '',
  filter_meals: '',
  filter_stars: '',
  destination_label: '',
  destination_label_prep: '',
  page_number: 1,
  page_limit: 3,
  sort_by: 'relevance',
};

function createEmptyConversation({ userId, title } = {}) {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    userId: userId || null,
    title: title || 'Новый чат',
    createdAt: now,
    updatedAt: now,
    messages: [],
    searchParams: { ...DEFAULT_SEARCH_PARAMS },
    searchSession: {
      requestId: null,
      readyOperators: [],
      currentPage: 0,
    },
  };
}

function getConversation(conversationId) {
  return repo.readConversation(conversationId);
}

function saveConversation(conversation) {
  conversation.updatedAt = new Date().toISOString();
  repo.writeConversation(conversation);
  return conversation;
}

function listConversations({ userId } = {}) {
  const files = repo.listConversationFiles();
  const items = [];
  for (const fp of files) {
    try {
      const data = JSON.parse(require('fs').readFileSync(fp, 'utf8'));
      if (userId && data.userId && String(data.userId) !== String(userId)) continue;
      const last = data.messages?.[data.messages.length - 1];
      items.push({
        id: data.id,
        title: data.title,
        updatedAt: data.updatedAt,
        preview: last?.content?.slice(0, 120) || '',
      });
    } catch (_) {
      /* skip corrupt file */
    }
  }
  return items.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function deleteConversation(conversationId) {
  repo.deleteConversation(conversationId);
}

module.exports = {
  DEFAULT_SEARCH_PARAMS,
  createEmptyConversation,
  getConversation,
  saveConversation,
  listConversations,
  deleteConversation,
};
