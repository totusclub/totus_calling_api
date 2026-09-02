const service = require('./service');

function handleError(res, error) {
  const status = error.status || 500;
  res.status(status).json({
    ok: false,
    error: error.message || 'Internal server error',
  });
}

async function createConversation(req, res) {
  try {
    const { userId, title } = req.body || {};
    const result = service.createConversation({ userId, title });
    res.json({ ok: true, ...result });
  } catch (e) {
    handleError(res, e);
  }
}

async function listConversations(req, res) {
  try {
    const userId = req.query.userId || req.body?.userId;
    const result = service.listConversations({ userId });
    res.json({ ok: true, ...result });
  } catch (e) {
    handleError(res, e);
  }
}

async function getConversation(req, res) {
  try {
    const { conversationId } = req.params;
    const userId = req.query.userId;
    const result = service.getConversationMessages(conversationId, { userId });
    res.json({ ok: true, ...result });
  } catch (e) {
    handleError(res, e);
  }
}

async function deleteConversation(req, res) {
  try {
    const { conversationId } = req.params;
    const userId = req.query.userId || req.body?.userId;
    const result = service.deleteConversation(conversationId, { userId });
    res.json(result);
  } catch (e) {
    handleError(res, e);
  }
}

async function sendMessage(req, res) {
  try {
    const { conversationId } = req.params;
    const { text, userId } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ ok: false, error: 'text is required' });
    }
    const result = await service.processUserMessage(conversationId, text.trim(), {
      userId,
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    handleError(res, e);
  }
}

module.exports = {
  createConversation,
  listConversations,
  getConversation,
  deleteConversation,
  sendMessage,
};
