'use strict';

/**
 * Ядро хаба уведомлений: notify() → настройки пользователя → запись в `notifications`
 * (центр уведомлений) → socket `notify:new` / `notify:badge` (комната u:<userId>) →
 * push по устройствам из `push_devices` (FCM для iOS/Android, Web Push для сайта).
 *
 * План: claude/PUSH_NOTIFICATIONS_PLAN_RU.md §1, §3. Таблицы: scripts/run-notifications-migration.js.
 * В payload пушей — без персональных данных (только тип, маршрут, номер заказа, chatId, url).
 */

const { env } = require('../env');
const types = require('./types');
const devices = require('./devices');
const fcm = require('./fcm');
const webpush = require('./webpush');

const { TYPES, CATEGORIES, ROUTES, TITLE_MAX, BODY_MAX, categoryOf, normalizePrefs, defaultPrefs } = types;

const MSK_OFFSET_MIN = 3 * 60;           // Москва без перехода на летнее время
const DATA_KEY_RE = /^[a-zA-Z0-9_]{1,32}$/;
const DATA_VALUE_MAX = 512;
const DATA_KEYS_MAX = 20;
const PER_USER_BADGE_LIMIT = 20;         // до стольких получателей — отдельный пуш на пользователя с бейджем
const DEFERRED_BATCH = 200;
const LIST_LIMIT_DEFAULT = 30;
const LIST_LIMIT_MAX = 100;

const roomUser = (userId) => `u:${userId}`;

// ---------------------------------------------------------------------------
// Состояние модуля
// ---------------------------------------------------------------------------
let pool = null;
let io = null;
let ready = false;
let readyChecked = false;

function getPool() {
    if (!pool) pool = require('../../db').pool;
    return pool;
}

function setIo(server) { if (server && !io) io = server; }
function getIo() { return io; }

async function ensureReady() {
    if (readyChecked) return ready;
    readyChecked = true;
    try {
        await getPool().query('SELECT 1 FROM push_devices LIMIT 1');
        await getPool().query('SELECT 1 FROM notifications LIMIT 1');
        await getPool().query('SELECT 1 FROM notification_settings LIMIT 1');
        await getPool().query('SELECT 1 FROM push_campaigns LIMIT 1');
        await getPool().query('SELECT 1 FROM push_reminder_rules LIMIT 1');
        ready = true;
        console.log(`[notify] ready (fcm=${fcm.isEnabled() ? 'on' : 'off'}, webpush=${webpush.isEnabled() ? 'on' : 'off'}, quiet=${quietHoursText()})`);
    } catch (e) {
        ready = false;
        console.error(`[notify] DISABLED — tables missing (${e.message}). Run: node scripts/run-notifications-migration.js && pm2 restart api_calling`);
    }
    return ready;
}

async function isReady() {
    if (ready) return true;
    if (!readyChecked) return ensureReady();
    readyChecked = false;
    return ensureReady();
}

// ---------------------------------------------------------------------------
// Тихие часы (МСК)
// ---------------------------------------------------------------------------
function parseQuiet() {
    const raw = env('PUSH_QUIET_HOURS') || '21:00-09:00';
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(raw.trim());
    if (!m) return { from: 21 * 60, to: 9 * 60, raw: '21:00-09:00' };
    return { from: Number(m[1]) * 60 + Number(m[2]), to: Number(m[3]) * 60 + Number(m[4]), raw: raw.trim() };
}

function quietHoursText() { return parseQuiet().raw; }

function mskMinutes(date) {
    const d = date || new Date();
    const utc = d.getUTCHours() * 60 + d.getUTCMinutes();
    return (utc + MSK_OFFSET_MIN) % (24 * 60);
}

/** Сейчас тихие часы? (для маркетинга/напоминаний с behaviour=shift/skip) */
function isQuietNow(date) {
    const q = parseQuiet();
    if (q.from === q.to) return false;
    const now = mskMinutes(date);
    if (q.from < q.to) return now >= q.from && now < q.to;
    return now >= q.from || now < q.to; // интервал через полночь
}

/** Ближайший момент, когда тихие часы закончатся (Date, UTC). */
function nextAllowedTime(date) {
    const d = date || new Date();
    if (!isQuietNow(d)) return d;
    const q = parseQuiet();
    const now = mskMinutes(d);
    let delta = q.to - now;
    if (delta <= 0) delta += 24 * 60;
    const out = new Date(d.getTime() + delta * 60 * 1000);
    out.setUTCSeconds(0, 0);
    return out;
}

// ---------------------------------------------------------------------------
// Настройки пользователя
// ---------------------------------------------------------------------------
function parseJson(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (e) { return null; }
}

function serializeSettings(row) {
    const prefs = normalizePrefs(row ? parseJson(row.prefs) : null);
    const raw = row ? parseJson(row.prefs) || {} : {};
    return {
        prefs,
        email: raw.email !== false,
        sound: raw.sound !== false,
        categories: Object.entries(CATEGORIES).map(([key, c]) => ({ key, title: c.title, mandatory: c.mandatory, enabled: prefs[key] })),
        quietHours: quietHoursText(),
        updatedAt: row && row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
}

async function getSettings(userId) {
    const [rows] = await getPool().query('SELECT * FROM notification_settings WHERE user_id = ? LIMIT 1', [userId]);
    return serializeSettings(rows[0] || null);
}

async function updateSettings(userId, body) {
    const b = body || {};
    const current = await getSettings(userId);
    const prefs = normalizePrefs({ ...current.prefs, ...(b.prefs && typeof b.prefs === 'object' ? b.prefs : {}) });
    const stored = { ...prefs };
    stored.email = typeof b.email === 'boolean' ? b.email : current.email;
    stored.sound = typeof b.sound === 'boolean' ? b.sound : current.sound;
    await getPool().query(
        'INSERT INTO notification_settings (user_id, prefs) VALUES (?, ?) ON DUPLICATE KEY UPDATE prefs = VALUES(prefs)',
        [userId, JSON.stringify(stored)],
    );
    return getSettings(userId);
}

/** prefs для набора пользователей: Map userId → prefs (у кого нет строки — defaults). */
async function prefsForUsers(userIds) {
    const map = new Map();
    for (const id of userIds) map.set(id, defaultPrefs());
    if (!userIds.length) return map;
    const [rows] = await getPool().query('SELECT user_id, prefs FROM notification_settings WHERE user_id IN (?)', [userIds]);
    for (const r of rows) map.set(Number(r.user_id), normalizePrefs(parseJson(r.prefs)));
    return map;
}

// ---------------------------------------------------------------------------
// Валидация входа notify()
// ---------------------------------------------------------------------------
function cleanText(v, max) {
    const s = String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function sanitizeData(input, type) {
    const info = TYPES[type];
    const out = { type, route: info ? info.route : 'home' };
    if (input && typeof input === 'object') {
        let n = 0;
        for (const [k, v] of Object.entries(input)) {
            if (!DATA_KEY_RE.test(k)) continue;
            if (k === 'type') continue;
            if (v === undefined || v === null) continue;
            if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
            if (++n > DATA_KEYS_MAX) break;
            out[k] = String(v).slice(0, DATA_VALUE_MAX);
        }
    }
    if (!ROUTES.includes(out.route)) out.route = info ? info.route : 'home';
    if (out.url && !/^https?:\/\//.test(out.url)) delete out.url;
    return out;
}

/** Возвращает { error } или нормализованный объект. */
function validateNotify(input) {
    const o = input || {};
    const type = String(o.type || '').trim();
    if (!TYPES[type]) return { error: 'type_invalid' };
    let userIds = [];
    if (Array.isArray(o.userIds)) userIds = o.userIds;
    else if (o.userId !== undefined && o.userId !== null) userIds = [o.userId];
    userIds = [...new Set(userIds.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0))];
    if (!userIds.length && !o.loyaltyId) return { error: 'user_required' };
    const title = cleanText(o.title || TYPES[type].title, TITLE_MAX);
    const body = cleanText(o.body, BODY_MAX);
    if (!body) return { error: 'body_required' };
    const channels = { inapp: true, push: true, ...(o.channels && typeof o.channels === 'object' ? o.channels : {}) };
    return {
        type,
        category: categoryOf(type),
        userIds,
        loyaltyId: o.loyaltyId ? String(o.loyaltyId).replace(/\s+/g, '') : null,
        title,
        body,
        data: sanitizeData(o.data, type),
        channels: { inapp: channels.inapp !== false, push: channels.push !== false },
        source: o.source ? String(o.source).slice(0, 64) : 'system',
        campaignId: o.campaignId ? Number(o.campaignId) : null,
        ruleId: o.ruleId ? Number(o.ruleId) : null,
        collapseKey: o.collapseKey ? String(o.collapseKey).slice(0, 64) : null,
        respectQuietHours: o.respectQuietHours === true || (o.respectQuietHours === undefined && categoryOf(type) === 'promo'),
        silent: o.silent === true,
        ttlSeconds: Number.isFinite(Number(o.ttlSeconds)) ? Number(o.ttlSeconds) : undefined,
        skipIfOnline: o.skipIfOnline === true,
    };
}

// ---------------------------------------------------------------------------
// Центр уведомлений (in-app)
// ---------------------------------------------------------------------------
function serializeNotification(row) {
    return {
        id: Number(row.id),
        type: row.type,
        category: row.category,
        title: row.title,
        body: row.body,
        data: parseJson(row.data) || {},
        source: row.source || 'system',
        readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
        openedAt: row.opened_at ? new Date(row.opened_at).toISOString() : null,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
}

async function unreadCount(userId) {
    const [rows] = await getPool().query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL AND inapp = 1', [userId]);
    return Number(rows[0].n || 0);
}

async function listNotifications(userId, opts = {}) {
    let limit = Number(opts.limit) || LIST_LIMIT_DEFAULT;
    if (limit > LIST_LIMIT_MAX) limit = LIST_LIMIT_MAX;
    if (limit < 1) limit = 1;
    const where = ['user_id = ?', 'inapp = 1'];
    const args = [userId];
    if (opts.before && Number.isInteger(Number(opts.before))) { where.push('id < ?'); args.push(Number(opts.before)); }
    if (opts.category && CATEGORIES[opts.category]) { where.push('category = ?'); args.push(opts.category); }
    if (opts.unread === true || opts.unread === '1' || opts.unread === 'true') where.push('read_at IS NULL');
    const [rows] = await getPool().query(
        `SELECT * FROM notifications WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
        [...args, limit + 1],
    );
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(serializeNotification);
    return { items, hasMore, unread: await unreadCount(userId) };
}

async function markRead(userId, ids) {
    if (ids === 'all') {
        await getPool().query('UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL', [userId]);
    } else {
        const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter((x) => Number.isInteger(x) && x > 0);
        if (!list.length) return { unread: await unreadCount(userId) };
        await getPool().query('UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL AND id IN (?)', [userId, list]);
    }
    const unread = await unreadCount(userId);
    emitBadge(userId, unread);
    return { unread };
}

/** Тап по уведомлению (из пуша или из центра) — для статистики «открыто». */
async function markOpened(userId, id) {
    const nid = Number(id);
    if (!Number.isInteger(nid) || nid <= 0) return { unread: await unreadCount(userId) };
    await getPool().query(
        'UPDATE notifications SET opened_at = COALESCE(opened_at, NOW()), read_at = COALESCE(read_at, NOW()) WHERE user_id = ? AND id = ?',
        [userId, nid],
    );
    const unread = await unreadCount(userId);
    emitBadge(userId, unread);
    return { unread };
}

async function deleteNotification(userId, id) {
    const nid = Number(id);
    if (!Number.isInteger(nid) || nid <= 0) return false;
    const [r] = await getPool().query('DELETE FROM notifications WHERE user_id = ? AND id = ?', [userId, nid]);
    return r.affectedRows > 0;
}

function emitBadge(userId, unread) {
    if (!io) return;
    try { io.to(roomUser(userId)).emit('notify:badge', { unread }); } catch (e) { /* ignore */ }
}

async function userHasLiveSocket(userId) {
    if (!io) return false;
    try {
        const sockets = await io.in(roomUser(userId)).fetchSockets();
        return sockets.length > 0;
    } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// Отправка
// ---------------------------------------------------------------------------
async function resolveUserIdsByLoyalty(loyaltyId) {
    const [rows] = await getPool().query('SELECT id FROM users WHERE REPLACE(loyalty_id, " ", "") = ? LIMIT 5', [loyaltyId]);
    return rows.map((r) => Number(r.id));
}

/**
 * Доставка push по устройствам. userDevices: Map userId → devices[]; badges: Map userId → unread.
 * Возвращает { sent, failed, dead, errors }.
 */
async function deliverPush(userDevices, n, badges) {
    const totals = { sent: 0, failed: 0, dead: 0, errors: [] };
    const base = {
        title: n.title,
        body: n.body,
        data: n.data,
        category: n.category,
        androidChannel: TYPES[n.type].androidChannel,
        collapseKey: n.collapseKey,
        ttlSeconds: n.ttlSeconds,
        silent: n.silent,
    };
    const groups = [];
    if (userDevices.size <= PER_USER_BADGE_LIMIT) {
        for (const [uid, devs] of userDevices) groups.push({ devs, msg: { ...base, badge: badges.get(uid), data: { ...base.data, notificationId: n.idsByUser ? String(n.idsByUser.get(uid) || '') : undefined } } });
    } else {
        const all = [];
        for (const devs of userDevices.values()) all.push(...devs);
        groups.push({ devs: all, msg: base });
    }
    const dead = [];
    const failed = [];
    const sent = [];
    for (const g of groups) {
        const [a, b] = await Promise.all([fcm.sendToDevices(g.devs, g.msg), webpush.sendToDevices(g.devs, g.msg)]);
        for (const r of [a, b]) {
            sent.push(...r.sent); dead.push(...r.dead); failed.push(...r.failed);
            totals.errors.push(...r.errors);
        }
    }
    totals.sent = sent.length; totals.failed = failed.length; totals.dead = dead.length;
    try {
        await devices.markDelivered(sent);
        await devices.dropTokens(dead);
        await devices.bumpFailures(failed);
    } catch (e) { console.warn('[notify] device bookkeeping failed:', e.message); }
    if (totals.errors.length) {
        const uniq = [...new Set(totals.errors)].slice(0, 5).join(', ');
        console.warn(`[notify] push ${n.type}: sent=${totals.sent} failed=${totals.failed} dead=${totals.dead} errors=${uniq}`);
    }
    return totals;
}

/**
 * Главная точка входа. Возвращает { ok, recipients, inapp, push: {sent, failed, dead}, deferred, skipped }.
 */
async function notify(input) {
    const v = validateNotify(input);
    if (v.error) return { ok: false, error: v.error };
    if (!(await isReady())) return { ok: false, error: 'notifications_not_migrated' };

    let userIds = v.userIds;
    if (!userIds.length && v.loyaltyId) userIds = await resolveUserIdsByLoyalty(v.loyaltyId);
    if (!userIds.length) return { ok: false, error: 'user_not_found' };

    const prefs = await prefsForUsers(userIds);
    const recipients = userIds.filter((uid) => prefs.get(uid)[v.category] !== false);
    const skipped = userIds.length - recipients.length;
    if (!recipients.length) return { ok: true, recipients: 0, inapp: 0, push: { sent: 0, failed: 0, dead: 0 }, deferred: 0, skipped };

    // Пуш только когда нет живого сокета (сообщения поддержки) — in-app при этом всё равно пишем
    let pushTargets = recipients;
    if (v.skipIfOnline) {
        const online = await Promise.all(recipients.map((uid) => userHasLiveSocket(uid)));
        pushTargets = recipients.filter((_, i) => !online[i]);
    }

    const deferred = v.channels.push && v.respectQuietHours && isQuietNow();
    const deliverAfter = deferred ? nextAllowedTime() : null;
    const pushStatus = !v.channels.push ? 'none' : deferred ? 'deferred' : 'pending';

    // 1. Запись в центр уведомлений (по строке на пользователя — и для in-app, и как журнал пушей)
    const idsByUser = new Map();
    const dataJson = JSON.stringify(v.data);
    const CHUNK = 500;
    for (let i = 0; i < recipients.length; i += CHUNK) {
        const chunk = recipients.slice(i, i + CHUNK);
        const values = chunk.map((uid) => [uid, v.type, v.category, v.title, v.body, dataJson, v.source, v.campaignId, v.ruleId, v.channels.inapp ? 1 : 0, pushStatus, deliverAfter]);
        const [r] = await getPool().query(
            `INSERT INTO notifications (user_id, type, category, title, body, data, source, campaign_id, rule_id, inapp, push_status, deliver_after)
             VALUES ?`,
            [values],
        );
        // insertId — первый id батча; при auto_increment_increment=1 остальные идут подряд
        chunk.forEach((uid, idx) => idsByUser.set(uid, Number(r.insertId) + idx));
    }

    // 2. Socket: in-app мгновенно
    if (v.channels.inapp && io) {
        for (const uid of recipients) {
            const id = idsByUser.get(uid);
            const payload = { id, type: v.type, category: v.category, title: v.title, body: v.body, data: { ...v.data, notificationId: String(id) }, createdAt: new Date().toISOString() };
            try {
                io.to(roomUser(uid)).emit('notify:new', payload);
                emitBadge(uid, await unreadCount(uid));
            } catch (e) { /* ignore */ }
        }
    }

    // 3. Push
    let push = { sent: 0, failed: 0, dead: 0 };
    if (v.channels.push && !deferred && pushTargets.length) {
        push = await sendPushForNotification({ ...v, idsByUser }, pushTargets);
        await updatePushStatus(pushTargets.map((uid) => idsByUser.get(uid)), push);
    } else if (!v.channels.push || !pushTargets.length) {
        const ids = recipients.map((uid) => idsByUser.get(uid));
        if (ids.length) await getPool().query('UPDATE notifications SET push_status = ? WHERE id IN (?)', [pushTargets.length ? 'none' : 'skipped', ids]);
    }

    return {
        ok: true,
        recipients: recipients.length,
        inapp: v.channels.inapp ? recipients.length : 0,
        push,
        deferred: deferred ? pushTargets.length : 0,
        skipped,
        ids: recipients.length === 1 ? [idsByUser.get(recipients[0])] : undefined,
    };
}

async function sendPushForNotification(n, userIds) {
    const devs = await devices.activeDevicesForUsers(userIds);
    if (!devs.length) return { sent: 0, failed: 0, dead: 0, noDevices: true };
    const userDevices = new Map();
    for (const d of devs) {
        const uid = Number(d.user_id);
        if (!userDevices.has(uid)) userDevices.set(uid, []);
        userDevices.get(uid).push(d);
    }
    const badges = new Map();
    if (userDevices.size <= PER_USER_BADGE_LIMIT) {
        for (const uid of userDevices.keys()) badges.set(uid, await unreadCount(uid));
    }
    return deliverPush(userDevices, n, badges);
}

async function updatePushStatus(ids, push) {
    if (!ids.length) return;
    const status = push.noDevices ? 'no_devices' : push.sent > 0 ? 'sent' : 'failed';
    await getPool().query('UPDATE notifications SET push_status = ?, push_sent = ?, push_failed = ?, pushed_at = NOW() WHERE id IN (?)', [status, push.sent || 0, (push.failed || 0) + (push.dead || 0), ids]);
}

/** Отложенные пуши (тихие часы): вызывается таймером раз в минуту. */
async function flushDeferred() {
    if (!(await isReady())) return 0;
    if (isQuietNow()) return 0;
    const [rows] = await getPool().query(
        `SELECT * FROM notifications WHERE push_status = 'deferred' AND (deliver_after IS NULL OR deliver_after <= NOW()) ORDER BY id LIMIT ?`,
        [DEFERRED_BATCH],
    );
    if (!rows.length) return 0;
    // группируем по одинаковому содержимому (одна рассылка → один multicast)
    const groups = new Map();
    for (const r of rows) {
        const key = `${r.type}|${r.title}|${r.body}|${r.data}|${r.campaign_id || ''}|${r.rule_id || ''}`;
        if (!groups.has(key)) groups.set(key, { rows: [], row: r });
        groups.get(key).rows.push(r);
    }
    let done = 0;
    for (const g of groups.values()) {
        const r = g.row;
        const idsByUser = new Map(g.rows.map((x) => [Number(x.user_id), Number(x.id)]));
        const n = {
            type: r.type, category: r.category, title: r.title, body: r.body,
            data: parseJson(r.data) || { type: r.type }, collapseKey: r.campaign_id ? `campaign_${r.campaign_id}` : null,
            silent: false, ttlSeconds: undefined, idsByUser,
        };
        const push = await sendPushForNotification(n, [...idsByUser.keys()]);
        await updatePushStatus([...idsByUser.values()], push);
        done += g.rows.length;
    }
    console.log(`[notify] deferred flushed: ${done}`);
    return done;
}

// ---------------------------------------------------------------------------
// Socket.io: комната пользователя и события notify:*
// ---------------------------------------------------------------------------
function attachSocket(socket) {
    setIo(socket.server);
    const auth = socket.data && socket.data.auth;
    if (!auth || auth.role === 'staff') return;
    socket.join(roomUser(auth.id));

    const reply = (cb, data) => { if (typeof cb === 'function') { try { cb(data); } catch (e) { /* ignore */ } } };

    socket.on('notify:badge', (payload, cb) => {
        const done = typeof payload === 'function' ? payload : cb;
        isReady().then(async (ok) => {
            if (!ok) return reply(done, { ok: false, error: 'notifications_not_migrated' });
            reply(done, { ok: true, unread: await unreadCount(auth.id) });
        }).catch(() => reply(done, { ok: false, error: 'internal_error' }));
    });

    socket.on('notify:read', (payload, cb) => {
        const p = payload || {};
        isReady().then(async (ok) => {
            if (!ok) return reply(cb, { ok: false, error: 'notifications_not_migrated' });
            const r = await markRead(auth.id, p.all ? 'all' : p.ids || p.id);
            reply(cb, { ok: true, unread: r.unread });
        }).catch(() => reply(cb, { ok: false, error: 'internal_error' }));
    });

    socket.on('notify:opened', (payload, cb) => {
        const p = payload || {};
        isReady().then(async (ok) => {
            if (!ok) return reply(cb, { ok: false, error: 'notifications_not_migrated' });
            const r = await markOpened(auth.id, p.id);
            reply(cb, { ok: true, unread: r.unread });
        }).catch(() => reply(cb, { ok: false, error: 'internal_error' }));
    });
}

module.exports = {
    roomUser,
    getPool,
    setIo,
    getIo,
    ensureReady,
    isReady,
    isQuietNow,
    nextAllowedTime,
    quietHoursText,
    getSettings,
    updateSettings,
    prefsForUsers,
    validateNotify,
    sanitizeData,
    notify,
    flushDeferred,
    listNotifications,
    unreadCount,
    markRead,
    markOpened,
    deleteNotification,
    serializeNotification,
    userHasLiveSocket,
    attachSocket,
    _internal: { cleanText, parseQuiet, mskMinutes, serializeSettings },
};
