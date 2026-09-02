const fs = require('fs');
const path = require('path');
const { CONVERSATIONS_DIR } = require('../config');

function ensureDir() {
  if (!fs.existsSync(CONVERSATIONS_DIR)) {
    fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
  }
}

function filePath(conversationId) {
  return path.join(CONVERSATIONS_DIR, `${conversationId}.json`);
}

function readConversation(conversationId) {
  ensureDir();
  const fp = filePath(conversationId);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    console.error('[V2] Failed to read conversation', conversationId, e);
    return null;
  }
}

function writeConversation(conversation) {
  ensureDir();
  fs.writeFileSync(filePath(conversation.id), JSON.stringify(conversation, null, 2), 'utf8');
}

function listConversationFiles() {
  ensureDir();
  return fs
    .readdirSync(CONVERSATIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(CONVERSATIONS_DIR, f));
}

function deleteConversation(conversationId) {
  const fp = filePath(conversationId);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

module.exports = {
  readConversation,
  writeConversation,
  listConversationFiles,
  deleteConversation,
};
