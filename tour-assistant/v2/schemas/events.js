/** SSE event names exposed to the mobile client (no internal AI fields). */
const SSE_EVENTS = {
  TYPING: 'typing',
  MESSAGE_CHUNK: 'message_chunk',
  FINAL_MESSAGE: 'final_message',
  ERROR: 'error',
};

module.exports = { SSE_EVENTS };
