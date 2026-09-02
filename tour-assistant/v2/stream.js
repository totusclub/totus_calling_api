const { SSE_EVENTS } = require('./schemas/events');
const service = require('./v2.service');

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function streamMessage(req, res) {
  const { conversationId } = req.params;
  const { text, userId } = req.body || {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ ok: false, error: 'text is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Heartbeat keeps the SSE connection alive during long searches so the
  // client never times out while the backend is still working.
  const heartbeat = setInterval(() => {
    try {
      writeSse(res, SSE_EVENTS.TYPING, { active: true });
    } catch (_) {
      clearInterval(heartbeat);
    }
  }, 8000);

  try {
    writeSse(res, SSE_EVENTS.TYPING, { active: true });

    const payload = await service.processUserMessage(conversationId, text.trim(), {
      userId,
      onChunk: ({ event, data }) => writeSse(res, event, data),
    });

    clearInterval(heartbeat);
    writeSse(res, 'final_message', { ok: true, ...payload });
    res.end();
  } catch (error) {
    clearInterval(heartbeat);
    console.error('[V2] Stream error:', error);
    writeSse(res, SSE_EVENTS.ERROR, {
      message: 'Ой, что-то пошло не так. Попробуйте ещё раз!',
    });
    res.end();
  }
}

module.exports = { streamMessage, writeSse };
