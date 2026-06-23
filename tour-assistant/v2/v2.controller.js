const v2Service = require('./v2.service');

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
    const result = v2Service.createConversation({ userId, title });
    res.json(result);
  } catch (e) {
    handleError(res, e);
  }
}

async function listConversations(req, res) {
  try {
    const userId = req.query.userId || req.body?.userId;
    const result = v2Service.listConversations({ userId });
    res.json(result);
  } catch (e) {
    handleError(res, e);
  }
}

async function getConversation(req, res) {
  try {
    const { conversationId } = req.params;
    const userId = req.query.userId;
    const result = v2Service.getConversationMessages(conversationId, { userId });
    res.json(result);
  } catch (e) {
    handleError(res, e);
  }
}

async function deleteConversation(req, res) {
  try {
    const { conversationId } = req.params;
    const userId = req.query.userId || req.body?.userId;
    const result = v2Service.deleteConversation(conversationId, { userId });
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
    const payload = await v2Service.processUserMessage(conversationId, text.trim(), {
      userId,
    });
    res.json({ ok: true, ...payload });
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
