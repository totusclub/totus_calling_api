const controller = require('./v2.controller');
const { streamMessage } = require('./stream');

const BASE = '/api/v2/tour-assistant';

function mountTourAssistantV2Routes(app) {
  app.post(`${BASE}/conversations`, controller.createConversation);
  app.get(`${BASE}/conversations`, controller.listConversations);
  app.get(`${BASE}/conversations/:conversationId`, controller.getConversation);
  app.delete(`${BASE}/conversations/:conversationId`, controller.deleteConversation);

  app.post(`${BASE}/conversations/:conversationId/messages`, controller.sendMessage);
  app.post(`${BASE}/conversations/:conversationId/messages/stream`, streamMessage);

  console.log('[TourAssistant V2] Routes mounted at', BASE);
}

module.exports = { mountTourAssistantV2Routes };
