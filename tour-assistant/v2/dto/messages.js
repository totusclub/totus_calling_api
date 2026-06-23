const { v4: uuidv4 } = require('uuid');
const { stripMetaLanguage } = require('../response.composer');

/**
 * @typedef {'user'|'assistant'} TourAssistantV2Role
 * @typedef {'text'|'hotels'} TourAssistantV2MessageType
 */

function createTextMessage({ role, content }) {
  return {
    id: uuidv4(),
    role,
    type: 'text',
    content: stripMetaLanguage(String(content || '').trim()),
    createdAt: new Date().toISOString(),
  };
}

function createAssistantMessage({ content, hotels = [] }) {
  const cleanContent = stripMetaLanguage(String(content || '').trim());
  const hasHotels = Array.isArray(hotels) && hotels.length > 0;
  return {
    id: uuidv4(),
    role: 'assistant',
    type: hasHotels ? 'hotels' : 'text',
    content: cleanContent,
    hotels: hasHotels ? hotels : undefined,
    createdAt: new Date().toISOString(),
  };
}

function sanitizeAssistantText(text) {
  return stripMetaLanguage(text);
}

module.exports = { createTextMessage, createAssistantMessage, sanitizeAssistantText };
