'use strict';

/**
 * Пропущенные звонки поддержки → уведомление `missed_call`.
 * index.js не меняется: httpGate (middleware/auth.js) вызывает tap-функции правил POLICY
 * до основного обработчика, а socketGate — attachSocket(). Логика самих звонков не затрагивается.
 *
 *   POST /api/calls               (агент/сотрудник → пользователь) — запоминаем звонок, таймер MISSED_AFTER_MS
 *   POST /api/calls/:id/answer,  socket 'answer'   — отвечен, таймер снимаем
 *   POST /api/calls/:id/reject                     — отклонён пользователем (не «пропущенный»)
 *   POST /api/calls/:id/end      (до ответа)       — звонящий положил трубку → пропущенный сразу
 */

const service = require('./service');

const MISSED_AFTER_MS = 45 * 1000;
const pending = new Map(); // callId → { timer, toLoyaltyId, callerName, at }

function normLoyalty(v) { return String(v || '').replace(/\s+/g, ''); }

function isSupportCaller(req) {
    const auth = req.auth;
    return Boolean(auth) && (auth.role === 'agent' || auth.role === 'staff');
}

async function fireMissed(callId, reason) {
    const p = pending.get(callId);
    if (!p) return;
    pending.delete(callId);
    clearTimeout(p.timer);
    if (!p.toLoyaltyId) return;
    try {
        const r = await service.notify({
            loyaltyId: p.toLoyaltyId,
            type: 'missed_call',
            title: 'Пропущенный звонок',
            body: 'Поддержка Totus звонила вам. Перезвоните из раздела «Аккаунт» или напишите нам в чат.',
            data: { callId: String(callId), reason },
            source: 'system',
            collapseKey: 'missed_call',
        });
        if (r.ok) console.log(`[notify] missed_call → loyalty ${p.toLoyaltyId} (${reason}) recipients=${r.recipients}`);
    } catch (e) {
        console.warn('[notify] missed_call failed:', e.message);
    }
}

function cancel(callId) {
    const p = pending.get(callId);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(callId);
}

/** tap для POST /api/calls */
function onCallCreated(req) {
    if (!isSupportCaller(req)) return;
    const b = req.body || {};
    const callId = b.callId ? String(b.callId) : null;
    if (!callId) return;
    const toLoyaltyId = normLoyalty(b.toLoyaltyId);
    if (!toLoyaltyId) return; // звонок по deviceId без loyalty — адресата не знаем
    cancel(callId);
    const timer = setTimeout(() => { fireMissed(callId, 'no_answer').catch(() => {}); }, MISSED_AFTER_MS);
    if (timer.unref) timer.unref();
    pending.set(callId, { timer, toLoyaltyId, callerName: b.callerName || null, at: Date.now() });
}

/** tap для POST /api/calls/:callId/(answer|reject|end) — match[1] = callId, match[2] = действие */
function onCallAction(req, match) {
    const callId = match && match[1] ? String(match[1]) : null;
    if (!callId || !pending.has(callId)) return;
    const action = match[2];
    if (action === 'answer' || action === 'reject') return cancel(callId);
    if (action === 'end') fireMissed(callId, 'caller_hangup').catch(() => {});
}

/** socket 'answer' от пользователя — звонок принят */
function attachSocket(socket) {
    socket.on('answer', (payload) => {
        const callId = payload && payload.callId ? String(payload.callId) : null;
        if (callId) cancel(callId);
    });
}

module.exports = { onCallCreated, onCallAction, attachSocket, MISSED_AFTER_MS, _pending: pending, _cancel: cancel, _fireMissed: fireMissed };
