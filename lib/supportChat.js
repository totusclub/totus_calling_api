'use strict';

/**
 * Support Chat — переписка пользователя (сайт / приложение / desktop) со службой поддержки.
 * План: claude/SUPPORT_CHAT_PLAN_RU.md (проект Totus Dev).
 *
 * Хранение — MySQL kedam: support_chats (один диалог на пользователя) и support_messages
 * (scripts/run-support-chat-migration.js). Звонки при этом остаются in-memory и не затрагиваются.
 *
 * Транспорт:
 *   REST  /api/support/chat*   — сторона пользователя (роль user; agent тоже удовлетворяет user)
 *         /api/support/chats*  — сторона поддержки (роли agent — панель calling_v2, staff — админка)
 *         /api/support/summary — счётчики для бейджа
 *   Socket (тот же namespace, что и звонки): события support:* и комнаты
 *         u:<userId>       — все сокеты пользователя (телефон + сайт + desktop одновременно)
 *         support:staff    — все сокеты сотрудников поддержки
 *         chat:<chatId>    — сотрудники, открывшие конкретный диалог (typing/read)
 *   Карты устройств звонков (devices / deviceSockets / loyaltyIdToDeviceId) не используются.
 *
 * Подключение — через гейты middleware/auth.js (index.js не меняется):
 *   POLICY-правило с handler: httpHandler (как /api/ice-servers) и socketGate → attachSocket(socket).
 * Все REST-роуты защищены requireAuth(..., { strict: true }) — работают и при AUTH_MODE=log.
 *
 * Push: пользователю без живого сокета — через хаб уведомлений lib/notifications (notify(), тип
 * support_message: центр уведомлений + FCM iOS/Android + Web Push). До миграции хаба — FCM (Android)
 * по users.voipToken, как раньше.
 * Сотрудникам (приложение Totus Support) о сообщении пользователя — APNs через lib/staffPush.js
 * (с 20.10.2026; раньше только сокет + локальное уведомление, на заблокированном iPhone — ничего).
 */

const express = require('express');
const { requireAuth } = require('./auth');
const { env } = require('./env');
const staffPush = require('./staffPush');

const MAX_BODY_LENGTH = 4000;
const PAGE_LIMIT_DEFAULT = 50;
const PAGE_LIMIT_MAX = 200;
const LIST_LIMIT_MAX = 200;
const RATE_WINDOW_MS = 60 * 1000;

const SUPPORT_ROLES = ['agent', 'staff'];
const ROOM_STAFF = 'support:staff';
const roomUser = (userId) => `u:${userId}`;
const roomChat = (chatId) => `chat:${chatId}`;

const STATUSES = ['open', 'pending', 'closed'];

// ---------------------------------------------------------------------------
// Состояние модуля
// ---------------------------------------------------------------------------
let pool = null;
let io = null;
let ready = false;          // таблицы существуют
let readyChecked = false;
const rateState = new Map(); // userId -> [timestamps]

function rateLimitPerMinute() {
    const v = Number(env('SUPPORT_CHAT_RATE_LIMIT') || 30);
    return Number.isFinite(v) && v > 0 ? v : 30;
}

function supportHours() {
    return {
        open: env('SUPPORT_HOURS_OPEN') || '09:00',
        close: env('SUPPORT_HOURS_CLOSE') || '21:00',
        tz: 'MSK',
        text: env('SUPPORT_HOURS_TEXT') || 'Служба поддержки Totus Club отвечает ежедневно с 9:00 до 21:00 (МСК). Среднее время ответа — 5 минут.',
    };
}

function getPool() {
    if (!pool) pool = require('../db').pool;
    return pool;
}

/** Проверка таблиц (один раз). При отсутствии — понятное сообщение в лог и 503 на роутах. */
async function ensureReady() {
    if (readyChecked) return ready;
    readyChecked = true;
    try {
        await getPool().query('SELECT 1 FROM support_chats LIMIT 1');
        await getPool().query('SELECT 1 FROM support_messages LIMIT 1');
        ready = true;
        console.log('[support-chat] ready (tables support_chats / support_messages found)');
    } catch (e) {
        ready = false;
        console.error(
            `[support-chat] DISABLED — tables missing (${e.message}). ` +
            'Run: node scripts/run-support-chat-migration.js && pm2 restart api_calling',
        );
    }
    return ready;
}

// Повторная проверка, если при старте таблиц не было (после миграции без рестарта)
async function isReady() {
    if (ready) return true;
    if (!readyChecked) return ensureReady();
    readyChecked = false;
    return ensureReady();
}

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------
function displayName(row, fallback) {
    if (!row) return fallback;
    const full = [row.f_name || row.name, row.l_name || row.lastname].filter(Boolean).join(' ').trim();
    return full || row.name || row.email || fallback;
}

function preview(body) {
    const s = String(body || '').replace(/\s+/g, ' ').trim();
    return s.length > 255 ? `${s.slice(0, 252)}…` : s;
}

function parseMeta(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (e) { return null; }
}

function toIso(d) {
    if (!d) return null;
    return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function serializeMessage(row) {
    return {
        id: Number(row.id),
        chatId: Number(row.chat_id),
        senderRole: row.sender_role,
        senderId: Number(row.sender_id),
        senderName: row.sender_name || null,
        body: row.body,
        meta: parseMeta(row.meta),
        clientMsgId: row.client_msg_id || null,
        readAt: toIso(row.read_at),
        createdAt: toIso(row.created_at),
    };
}

function serializeChat(row) {
    const out = {
        id: Number(row.id),
        userId: Number(row.user_id),
        status: row.status,
        assignedId: row.assigned_id === null || row.assigned_id === undefined ? null : Number(row.assigned_id),
        assignedRole: row.assigned_role || null,
        assignedName: row.assigned_name || null,
        subject: row.subject || null,
        orderId: row.order_id || null,
        lastMessageId: row.last_message_id === null || row.last_message_id === undefined ? null : Number(row.last_message_id),
        lastMessageAt: toIso(row.last_message_at),
        lastMessagePreview: row.last_message_preview || null,
        userUnread: Number(row.user_unread || 0),
        staffUnread: Number(row.staff_unread || 0),
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
    };
    if (row.u_id !== undefined) {
        out.user = {
            id: Number(row.u_id),
            name: displayName({ name: row.u_name, f_name: row.u_f_name, l_name: row.u_l_name, email: row.u_email }, `Пользователь #${row.u_id}`),
            email: row.u_email || null,
            phone: row.u_phone || null,
            loyaltyId: row.u_loyalty_id || null,
            online: Number(row.u_online || 0) === 1,
        };
    }
    return out;
}

const CHAT_SELECT = `
    SELECT c.*,
           s.name AS s_name, s.lastname AS s_lastname, s.email AS s_email,
           a.name AS a_name, a.f_name AS a_f_name, a.l_name AS a_l_name, a.email AS a_email,
           u.id AS u_id, u.name AS u_name, u.f_name AS u_f_name, u.l_name AS u_l_name,
           u.email AS u_email, u.phone AS u_phone, u.loyalty_id AS u_loyalty_id, u.online AS u_online
    FROM support_chats c
    LEFT JOIN users u ON u.id = c.user_id
    LEFT JOIN staff s ON c.assigned_role = 'staff' AND s.id = c.assigned_id
    LEFT JOIN users a ON c.assigned_role = 'agent' AND a.id = c.assigned_id`;

function withAssignedName(row) {
    if (!row) return row;
    if (!row.assigned_id) row.assigned_name = null;
    else if (row.assigned_role === 'staff') row.assigned_name = displayName({ name: row.s_name, lastname: row.s_lastname, email: row.s_email }, `Сотрудник #${row.assigned_id}`);
    else row.assigned_name = displayName({ name: row.a_name, f_name: row.a_f_name, l_name: row.a_l_name, email: row.a_email }, `Сотрудник #${row.assigned_id}`);
    return row;
}

// ---------------------------------------------------------------------------
// Доступ к данным
// ---------------------------------------------------------------------------
async function getChatById(chatId) {
    const [rows] = await getPool().query(`${CHAT_SELECT} WHERE c.id = ? LIMIT 1`, [chatId]);
    return rows.length ? withAssignedName(rows[0]) : null;
}

async function getChatByUserId(userId) {
    const [rows] = await getPool().query(`${CHAT_SELECT} WHERE c.user_id = ? ORDER BY c.id DESC LIMIT 1`, [userId]);
    return rows.length ? withAssignedName(rows[0]) : null;
}

/** Диалог пользователя (создаётся пустым при первом обращении). */
async function getOrCreateUserChat(userId) {
    const existing = await getChatByUserId(userId);
    if (existing) return existing;
    await getPool().query('INSERT INTO support_chats (user_id, status) VALUES (?, ?)', [userId, 'open']);
    return getChatByUserId(userId);
}

async function listMessages(chatId, { before, limit } = {}) {
    const lim = Math.min(Math.max(Number(limit) || PAGE_LIMIT_DEFAULT, 1), PAGE_LIMIT_MAX);
    const params = [chatId];
    let where = 'chat_id = ?';
    if (before) { where += ' AND id < ?'; params.push(Number(before)); }
    params.push(lim + 1);
    const [rows] = await getPool().query(
        `SELECT * FROM support_messages WHERE ${where} ORDER BY id DESC LIMIT ?`, params,
    );
    const hasMore = rows.length > lim;
    const page = rows.slice(0, lim).reverse(); // по возрастанию id
    return { messages: page.map(serializeMessage), hasMore };
}

async function senderNameFor(role, id) {
    try {
        if (role === 'staff') {
            const [rows] = await getPool().query('SELECT id, name, lastname, email FROM staff WHERE id = ? LIMIT 1', [id]);
            return rows.length ? displayName(rows[0], 'Поддержка Totus') : 'Поддержка Totus';
        }
        const [rows] = await getPool().query('SELECT id, name, f_name, l_name, email FROM users WHERE id = ? LIMIT 1', [id]);
        return rows.length ? displayName(rows[0], role === 'agent' ? 'Поддержка Totus' : `Пользователь #${id}`) : null;
    } catch (e) {
        return null;
    }
}

function checkRate(userId) {
    const now = Date.now();
    const arr = (rateState.get(userId) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (arr.length >= rateLimitPerMinute()) { rateState.set(userId, arr); return false; }
    arr.push(now);
    rateState.set(userId, arr);
    return true;
}

function validateBody(body) {
    const text = typeof body === 'string' ? body.replace(/\r\n/g, '\n').trim() : '';
    if (!text) return { error: 'body_required' };
    if (text.length > MAX_BODY_LENGTH) return { error: 'message_too_long' };
    return { text };
}

function sanitizeMeta(meta) {
    if (!meta || typeof meta !== 'object') return null;
    const out = {};
    if (meta.orderId !== undefined && meta.orderId !== null && String(meta.orderId).length <= 64) out.orderId = String(meta.orderId);
    if (typeof meta.orderTitle === 'string' && meta.orderTitle.length <= 255) out.orderTitle = meta.orderTitle;
    if (typeof meta.orderSubtitle === 'string' && meta.orderSubtitle.length <= 255) out.orderSubtitle = meta.orderSubtitle;
    if (typeof meta.topic === 'string' && meta.topic.length <= 64) out.topic = meta.topic;
    return Object.keys(out).length ? out : null;
}

/**
 * Единая точка отправки (REST и сокет).
 * sender: { role: 'user'|'agent'|'staff', id }
 * Возвращает { chat, message } или { error }.
 */
async function sendMessage({ chatId, sender, body, clientMsgId, meta }) {
    const v = validateBody(body);
    if (v.error) return { error: v.error };
    const isSupportSide = SUPPORT_ROLES.includes(sender.role) && sender.role !== 'user';

    let chat;
    if (sender.role === 'user' || !chatId) {
        if (!checkRate(sender.id)) return { error: 'rate_limited' };
        chat = await getOrCreateUserChat(sender.id);
    } else {
        chat = await getChatById(chatId);
        if (!chat) return { error: 'chat_not_found' };
    }

    const cleanMeta = sanitizeMeta(meta);
    const cleanClientId = typeof clientMsgId === 'string' && clientMsgId.length <= 64 ? clientMsgId : null;

    // Идемпотентность (повтор с мобильного после обрыва сети)
    if (cleanClientId) {
        const [dup] = await getPool().query(
            'SELECT * FROM support_messages WHERE chat_id = ? AND client_msg_id = ? LIMIT 1', [chat.id, cleanClientId],
        );
        if (dup.length) return { chat: serializeChat(chat), message: serializeMessage(dup[0]), duplicate: true };
    }

    const senderName = await senderNameFor(sender.role, sender.id);
    const [ins] = await getPool().query(
        `INSERT INTO support_messages (chat_id, sender_role, sender_id, sender_name, body, meta, client_msg_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [chat.id, sender.role, sender.id, senderName, v.text, cleanMeta ? JSON.stringify(cleanMeta) : null, cleanClientId],
    );

    // Обновление шапки диалога и счётчиков непрочитанного
    if (isSupportSide) {
        await getPool().query(
            `UPDATE support_chats SET status = 'pending', last_message_id = ?, last_message_at = NOW(),
                last_message_preview = ?, user_unread = user_unread + 1,
                assigned_role = COALESCE(assigned_role, ?), assigned_id = COALESCE(assigned_id, ?)
             WHERE id = ?`,
            [ins.insertId, preview(v.text), sender.role, sender.id, chat.id],
        );
    } else {
        await getPool().query(
            `UPDATE support_chats SET status = 'open', last_message_id = ?, last_message_at = NOW(),
                last_message_preview = ?, staff_unread = staff_unread + 1, order_id = COALESCE(?, order_id)
             WHERE id = ?`,
            [ins.insertId, preview(v.text), cleanMeta && cleanMeta.orderId ? cleanMeta.orderId : null, chat.id],
        );
    }

    const [msgRows] = await getPool().query('SELECT * FROM support_messages WHERE id = ?', [ins.insertId]);
    const fresh = await getChatById(chat.id);
    const result = { chat: serializeChat(fresh), message: serializeMessage(msgRows[0]) };

    broadcastMessage(result);
    if (isSupportSide) notifyUserOffline(fresh, result.message).catch((e) => console.warn('[support-chat] push failed:', e.message));
    else notifyStaffPush(fresh, result).catch((e) => console.warn('[support-chat] staff push failed:', e.message));
    return result;
}

async function markRead(chatId, side, lastMessageId) {
    const chat = await getChatById(chatId);
    if (!chat) return { error: 'chat_not_found' };
    const otherRoles = side === 'user' ? "('staff','agent','system')" : "('user')";
    const params = [chatId];
    let idCond = '';
    if (lastMessageId) { idCond = ' AND id <= ?'; params.push(Number(lastMessageId)); }
    await getPool().query(
        `UPDATE support_messages SET read_at = NOW() WHERE chat_id = ? AND read_at IS NULL AND sender_role IN ${otherRoles}${idCond}`,
        params,
    );
    await getPool().query(
        `UPDATE support_chats SET ${side === 'user' ? 'user_unread' : 'staff_unread'} = 0 WHERE id = ?`, [chatId],
    );
    const fresh = await getChatById(chatId);
    const payload = { chatId: Number(chatId), by: side, lastMessageId: lastMessageId ? Number(lastMessageId) : null, chat: serializeChat(fresh) };
    if (io) {
        if (side === 'user') io.to(ROOM_STAFF).emit('support:read', payload);
        else io.to(roomUser(fresh.user_id)).emit('support:read', payload);
    }
    return payload;
}

async function listChats({ status, q, limit, offset, assigned } = {}) {
    // Пустые диалоги (создаются при первом GET /api/support/chat, без сообщений) поддержке не показываем
    const where = ['c.last_message_id IS NOT NULL'];
    const params = [];
    if (status && status !== 'all') {
        if (!STATUSES.includes(status)) return { error: 'invalid_status' };
        where.push('c.status = ?'); params.push(status);
    }
    if (assigned && typeof assigned === 'object') {
        where.push('c.assigned_role = ? AND c.assigned_id = ?'); params.push(assigned.role, Number(assigned.id));
    } else if (assigned === 'none') {
        where.push('c.assigned_id IS NULL');
    }
    if (q && String(q).trim()) {
        const like = `%${String(q).trim()}%`;
        const digits = String(q).replace(/\s+/g, '');
        where.push('(u.name LIKE ? OR u.f_name LIKE ? OR u.l_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR REPLACE(u.loyalty_id, " ", "") LIKE ?)');
        params.push(like, like, like, like, like, `%${digits}%`);
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const lim = Math.min(Math.max(Number(limit) || 50, 1), LIST_LIMIT_MAX);
    const off = Math.max(Number(offset) || 0, 0);

    const [countRows] = await getPool().query(
        `SELECT COUNT(*) AS total FROM support_chats c LEFT JOIN users u ON u.id = c.user_id${whereSql}`, params,
    );
    const [rows] = await getPool().query(
        `${CHAT_SELECT}${whereSql}
         ORDER BY (c.staff_unread > 0) DESC, c.last_message_at DESC, c.id DESC
         LIMIT ? OFFSET ?`,
        [...params, lim, off],
    );
    return { data: rows.map((r) => serializeChat(withAssignedName(r))), total: Number(countRows[0].total || 0), limit: lim, offset: off };
}

async function summary() {
    const [rows] = await getPool().query(
        `SELECT
            SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
            SUM(staff_unread) AS unread_total,
            SUM(CASE WHEN staff_unread > 0 THEN 1 ELSE 0 END) AS unread_chats
         FROM support_chats WHERE last_message_id IS NOT NULL`,
    );
    const r = rows[0] || {};
    return {
        openCount: Number(r.open_count || 0),
        pendingCount: Number(r.pending_count || 0),
        unreadTotal: Number(r.unread_total || 0),
        unreadChats: Number(r.unread_chats || 0),
    };
}

async function assignChat(chatId, assignee) {
    const chat = await getChatById(chatId);
    if (!chat) return { error: 'chat_not_found' };
    await getPool().query(
        'UPDATE support_chats SET assigned_role = ?, assigned_id = ? WHERE id = ?',
        [assignee ? assignee.role : null, assignee ? assignee.id : null, chatId],
    );
    const fresh = serializeChat(await getChatById(chatId));
    broadcastChatUpdated(fresh);
    return { chat: fresh };
}

async function setStatus(chatId, status) {
    if (!STATUSES.includes(status)) return { error: 'invalid_status' };
    const chat = await getChatById(chatId);
    if (!chat) return { error: 'chat_not_found' };
    await getPool().query('UPDATE support_chats SET status = ? WHERE id = ?', [status, chatId]);
    const fresh = serializeChat(await getChatById(chatId));
    broadcastChatUpdated(fresh);
    return { chat: fresh };
}

// ---------------------------------------------------------------------------
// Доставка: сокет + push
// ---------------------------------------------------------------------------
function broadcastMessage({ chat, message }) {
    if (!io) return;
    const payload = { chat, message };
    io.to(roomUser(chat.userId)).emit('support:message', payload);
    io.to(ROOM_STAFF).emit('support:message', payload);
}

function broadcastChatUpdated(chat) {
    if (!io) return;
    io.to(roomUser(chat.userId)).emit('support:chat-updated', { chat });
    io.to(ROOM_STAFF).emit('support:chat-updated', { chat });
}

async function userHasLiveSocket(userId) {
    if (!io) return false;
    try {
        const sockets = await io.in(roomUser(userId)).fetchSockets();
        return sockets.length > 0;
    } catch (e) {
        return false;
    }
}

// FCM-токен (Android) — содержит ':' и не является hex-строкой APNs (см. detectPhonePlatformFromToken в index.js)
function looksLikeFcmToken(token) {
    if (!token || typeof token !== 'string') return false;
    if (token === 'web') return false;
    if (/^[a-fA-F0-9]{40,}$/.test(token)) return false; // APNs VoIP (PushKit) — для сообщений непригоден
    return token.includes(':') && token.length > 60;
}

/**
 * Уведомление пользователю о сообщении поддержки — через хаб уведомлений (lib/notifications):
 * запись в центр уведомлений + FCM (iOS/Android) + Web Push по устройствам из push_devices.
 * «Онлайн» решает хаб по каждому устройству (skipIfOnline → lib/notifications/presence.js):
 * открытый сайт или iPhone больше не отменяют пуш закрытому Android.
 * Пока таблицы хаба не созданы (миграция), fallback — прежний FCM по users.voipToken (Android),
 * только когда у пользователя нет живого сокета (как раньше).
 */
async function notifyUserOffline(chatRow, message) {
    const userId = Number(chatRow.user_id);
    let hub = null;
    try { hub = require('./notifications'); } catch (e) { hub = null; }
    if (hub && await hub.isReady()) {
        const r = await hub.notify({
            userId,
            type: 'support_message',
            title: 'Поддержка Totus',
            body: preview(message.body).slice(0, 180),
            data: { chatId: String(chatRow.id), messageId: String(message.id) },
            source: 'support_chat',
            collapseKey: `support_chat_${chatRow.id}`,
            skipIfOnline: true,
        });
        if (r.ok) console.log('[support-chat] hub notify user', userId, 'push', JSON.stringify(r.push));
        else console.warn('[support-chat] hub notify failed:', r.error);
        return;
    }
    if (await userHasLiveSocket(userId)) return;
    await legacyFcm(userId, chatRow, message);
}

/** Сообщение пользователя → APNs-пуш сотрудникам (lib/staffPush.js). */
async function notifyStaffPush(chatRow, result) {
    const userName = result.chat && result.chat.user ? result.chat.user.name : null;
    return staffPush.notifyStaff({ chatRow, message: result.message, userName });
}

// Fallback до миграции хаба: FCM (Android) по users.voipToken
async function legacyFcm(userId, chatRow, message) {
    const [rows] = await getPool().query('SELECT voipToken FROM users WHERE id = ? LIMIT 1', [userId]);
    const token = rows.length ? rows[0].voipToken : null;
    if (!looksLikeFcmToken(token)) return;
    let admin;
    try { admin = require('firebase-admin'); } catch (e) { return; }
    if (!admin.apps || !admin.apps.length) return; // Firebase не инициализирован (см. index.js)
    try {
        await admin.messaging().send({
            token,
            notification: { title: 'Поддержка Totus', body: preview(message.body).slice(0, 180) },
            data: { type: 'support_message', route: 'support_chat', chatId: String(chatRow.id), messageId: String(message.id) },
            android: { priority: 'high', notification: { channelId: 'support_chat' } },
        });
        console.log('[support-chat] FCM sent to user', userId);
    } catch (e) {
        console.warn('[support-chat] FCM send failed:', e.message);
    }
}

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------
function isSupportAuth(auth) {
    return Boolean(auth) && SUPPORT_ROLES.includes(auth.role);
}

/**
 * Вызывается из socketGate для каждого нового сокета (после разбора JWT).
 * Комнаты выдаются только по токену — без токена (log-режим, старое приложение)
 * чат работает через REST, без realtime.
 */
function attachSocket(socket) {
    if (!io && socket.server) io = socket.server;
    const auth = socket.data && socket.data.auth;
    if (!auth) return;

    if (auth.role === 'user' || auth.role === 'agent') socket.join(roomUser(auth.id));
    if (isSupportAuth(auth)) socket.join(ROOM_STAFF);

    const reply = (cb, data) => { if (typeof cb === 'function') { try { cb(data); } catch (e) { /* ignore */ } } };
    const guard = async (cb, fn) => {
        if (!(await isReady())) return reply(cb, { ok: false, error: 'support_chat_not_migrated' });
        try { return await fn(); } catch (e) {
            console.error('[support-chat] socket handler error:', e);
            return reply(cb, { ok: false, error: 'internal_error' });
        }
    };

    socket.on('support:send', (payload, cb) => guard(cb, async () => {
        const p = payload || {};
        if (isSupportAuth(auth) && !p.chatId) return reply(cb, { ok: false, error: 'chat_id_required' });
        const sender = { role: isSupportAuth(auth) ? auth.role : 'user', id: auth.id };
        const result = await sendMessage({ chatId: p.chatId, sender, body: p.body, clientMsgId: p.clientMsgId, meta: p.meta });
        if (result.error) return reply(cb, { ok: false, error: result.error });
        return reply(cb, { ok: true, chat: result.chat, message: result.message, duplicate: Boolean(result.duplicate) });
    }));

    socket.on('support:read', (payload, cb) => guard(cb, async () => {
        const p = payload || {};
        let chatId = p.chatId;
        if (isSupportAuth(auth) && !chatId) return reply(cb, { ok: false, error: 'chat_id_required' });
        const side = isSupportAuth(auth) ? 'staff' : 'user';
        if (side === 'user') {
            const chat = await getChatByUserId(auth.id);
            if (!chat) return reply(cb, { ok: true });
            chatId = chat.id;
        }
        const r = await markRead(chatId, side, p.lastMessageId);
        return reply(cb, r.error ? { ok: false, error: r.error } : { ok: true });
    }));

    socket.on('support:typing', async (payload) => {
        const p = payload || {};
        if (!io) return;
        try {
            if (isSupportAuth(auth)) {
                if (!p.chatId) return;
                const chat = await getChatById(p.chatId);
                if (chat) io.to(roomUser(chat.user_id)).emit('support:typing', { chatId: chat.id, from: 'staff', typing: Boolean(p.typing) });
            } else {
                const chat = await getChatByUserId(auth.id);
                if (chat) io.to(roomChat(chat.id)).to(ROOM_STAFF).emit('support:typing', { chatId: chat.id, from: 'user', userId: auth.id, typing: Boolean(p.typing) });
            }
        } catch (e) { /* ignore */ }
    });

    // Support App: приложение на экране / свёрнуто — на экране пуш этому устройству не шлём
    if (isSupportAuth(auth)) {
        socket.on('support:presence', (payload) => staffPush.setPresence(socket.id, auth, payload));
        socket.on('disconnect', () => staffPush.clearPresence(socket.id));
    }

    // Сотрудник открыл / закрыл конкретный диалог (для адресных typing-событий)
    socket.on('support:subscribe', (payload) => {
        const chatId = payload && Number(payload.chatId);
        if (isSupportAuth(auth) && chatId) socket.join(roomChat(chatId));
    });
    socket.on('support:unsubscribe', (payload) => {
        const chatId = payload && Number(payload.chatId);
        if (chatId) socket.leave(roomChat(chatId));
    });
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------
function sendError(res, error) {
    const code = { body_required: 400, message_too_long: 400, invalid_status: 400, chat_id_required: 400, rate_limited: 429, chat_not_found: 404, support_chat_not_migrated: 503 }[error] || 400;
    return res.status(code).json({ error });
}

const readyGuard = async (req, res, next) => {
    if (await isReady()) return next();
    return sendError(res, 'support_chat_not_migrated');
};

function wrap(fn) {
    return (req, res) => fn(req, res).catch((e) => {
        console.error('[support-chat] route error:', e);
        if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    });
}

function buildRouter() {
    const router = express.Router();
    router.use(readyGuard);

    // ---- сторона пользователя -------------------------------------------------
    const user = express.Router();
    user.use(requireAuth(['user'], { strict: true }));

    user.get('/', wrap(async (req, res) => {
        const chat = await getOrCreateUserChat(req.auth.id);
        const page = await listMessages(chat.id, { limit: req.query.limit });
        res.json({ chat: serializeChat(chat), messages: page.messages, hasMore: page.hasMore, hours: supportHours() });
    }));

    user.get('/messages', wrap(async (req, res) => {
        const chat = await getChatByUserId(req.auth.id);
        if (!chat) return res.json({ messages: [], hasMore: false });
        const page = await listMessages(chat.id, { before: req.query.before, limit: req.query.limit });
        res.json(page);
    }));

    user.post('/messages', wrap(async (req, res) => {
        const b = req.body || {};
        const r = await sendMessage({ sender: { role: 'user', id: req.auth.id }, body: b.body, clientMsgId: b.clientMsgId, meta: b.meta });
        if (r.error) return sendError(res, r.error);
        res.status(r.duplicate ? 200 : 201).json({ ok: true, chat: r.chat, message: r.message });
    }));

    user.post('/read', wrap(async (req, res) => {
        const chat = await getChatByUserId(req.auth.id);
        if (!chat) return res.json({ ok: true });
        const r = await markRead(chat.id, 'user', (req.body || {}).lastMessageId);
        if (r.error) return sendError(res, r.error);
        res.json({ ok: true, chat: r.chat });
    }));

    // ---- сторона поддержки ----------------------------------------------------
    const staff = express.Router();
    staff.use(requireAuth(SUPPORT_ROLES, { strict: true }));

    staff.get('/summary', wrap(async (req, res) => res.json(await summary())));

    staff.get('/chats', wrap(async (req, res) => {
        const assigned = req.query.assigned === 'me' ? { role: req.auth.role, id: req.auth.id } : (req.query.assigned === 'none' ? 'none' : undefined);
        const r = await listChats({ status: req.query.status || 'all', q: req.query.q, limit: req.query.limit, offset: req.query.offset, assigned });
        if (r.error) return sendError(res, r.error);
        res.json(r);
    }));

    staff.get('/chats/:id', wrap(async (req, res) => {
        const chat = await getChatById(Number(req.params.id));
        if (!chat) return sendError(res, 'chat_not_found');
        const page = await listMessages(chat.id, { limit: req.query.limit });
        res.json({ chat: serializeChat(chat), messages: page.messages, hasMore: page.hasMore });
    }));

    staff.get('/chats/:id/messages', wrap(async (req, res) => {
        const chat = await getChatById(Number(req.params.id));
        if (!chat) return sendError(res, 'chat_not_found');
        res.json(await listMessages(chat.id, { before: req.query.before, limit: req.query.limit }));
    }));

    staff.post('/chats/:id/messages', wrap(async (req, res) => {
        const b = req.body || {};
        const r = await sendMessage({ chatId: Number(req.params.id), sender: { role: req.auth.role, id: req.auth.id }, body: b.body, clientMsgId: b.clientMsgId, meta: b.meta });
        if (r.error) return sendError(res, r.error);
        res.status(201).json({ ok: true, chat: r.chat, message: r.message });
    }));

    staff.post('/chats/:id/read', wrap(async (req, res) => {
        const r = await markRead(Number(req.params.id), 'staff', (req.body || {}).lastMessageId);
        if (r.error) return sendError(res, r.error);
        res.json({ ok: true, chat: r.chat });
    }));

    staff.post('/chats/:id/assign', wrap(async (req, res) => {
        const b = req.body || {};
        // {unassign:true} — снять; иначе взять себе (роль и id из токена)
        const r = await assignChat(Number(req.params.id), b.unassign ? null : { role: req.auth.role, id: req.auth.id });
        if (r.error) return sendError(res, r.error);
        res.json({ ok: true, chat: r.chat });
    }));

    // Push сотрудникам (Totus Support, iOS): APNs-токен устройства
    staff.post('/push-device', wrap(async (req, res) => {
        const r = await staffPush.registerDevice(req.auth, req.body || {});
        if (r.error) return res.status(r.error === 'invalid_token' ? 400 : 503).json({ error: r.error });
        res.json(r);
    }));

    staff.delete('/push-device', wrap(async (req, res) => {
        const r = await staffPush.unregisterDevice(req.auth, req.body || {});
        if (r.error) return res.status(400).json({ error: r.error });
        res.json(r);
    }));

    staff.post('/chats/:id/status', wrap(async (req, res) => {
        const r = await setStatus(Number(req.params.id), String((req.body || {}).status || ''));
        if (r.error) return sendError(res, r.error);
        res.json({ ok: true, chat: r.chat });
    }));

    router.use('/api/support/chat', user);
    router.use('/api/support', staff);
    return router;
}

let routerInstance = null;
/** Обработчик для POLICY (middleware/auth.js): весь /api/support/* обслуживается здесь. */
function httpHandler(req, res) {
    if (!routerInstance) routerInstance = buildRouter();
    routerInstance(req, res, (err) => {
        if (err) {
            console.error('[support-chat] router error:', err);
            if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
            return;
        }
        if (!res.headersSent) res.status(404).json({ error: 'not_found' });
    });
}

module.exports = {
    SUPPORT_ROLES,
    ROOM_STAFF,
    roomUser,
    roomChat,
    attachSocket,
    httpHandler,
    ensureReady,
    // для тестов
    _internal: { validateBody, sanitizeMeta, looksLikeFcmToken, preview, serializeChat, serializeMessage, displayName, checkRate },
};
