'use strict';

/**
 * Push сотрудникам поддержки о новых сообщениях пользователей (приложение Totus Support, iOS).
 *
 * Было (до 20.10.2026): сервер пушей сотрудникам не слал — Support App показывал локальное
 * уведомление, пока жив сокет чата. На iPhone iOS усыпляет приложение через несколько секунд
 * после блокировки экрана или сворачивания — сокет рвётся, уведомлений нет.
 *
 * Стало: сообщение пользователя → обычный (alert) APNs-пуш на устройства сотрудников.
 *   - Токены — таблица support_staff_push_devices (создаётся сама, как call_devices).
 *     Приложение регистрирует токен: POST /api/support/push-device {token, environment, bundleId}
 *     (agent-JWT), снимает при выходе: DELETE /api/support/push-device {token}.
 *   - Тот же ключ APNs (.p8), что и для VoIP (APN_KEY_PATH / APN_KEY_ID / APN_TEAM_ID); topic —
 *     bundle id приложения (club.totus.support), без «.voip». Окружение — по токену:
 *     production (TestFlight / App Store) или sandbox (сборка из Xcode).
 *   - Кому: диалог закреплён за агентом и у него есть устройство — только ему; иначе всем
 *     зарегистрированным сотрудникам.
 *   - Не шлём устройству, у которого приложение сейчас на экране: сокет чата сообщает
 *     support:presence {state:'foreground'|'background', pushToken}. На экране уведомление
 *     показывает само приложение.
 *   - Мёртвый токен (Unregistered / 410 / BadDeviceToken в обоих окружениях) удаляется.
 *   - APNs не настроен или таблицы нет — тихо пропускаем (лог), чат работает как раньше.
 */

const path = require('path');
const { env } = require('./env');

const TABLE = 'support_staff_push_devices';
const DEFAULT_BUNDLE = 'club.totus.support';
const ENVIRONMENTS = ['production', 'sandbox'];
const ENSURE_RETRY_MS = 60 * 1000;
const PUSH_TTL_SEC = 60 * 60; // сообщение старше часа уже не новость

// ---------------------------------------------------------------------------
// Зависимости (подменяются в scripts/check-staff-push.js)
// ---------------------------------------------------------------------------
let deps = { pool: null, apn: null };

function getPool() {
    if (!deps.pool) deps.pool = require('../db').pool;
    return deps.pool;
}

function getApn() {
    if (!deps.apn) deps.apn = require('apn');
    return deps.apn;
}

function _setDeps(next) {
    deps = { ...deps, ...next };
    providers.clear();
    tableReady = false;
    lastEnsureAt = 0;
}

// ---------------------------------------------------------------------------
// Таблица
// ---------------------------------------------------------------------------
let tableReady = false;
let lastEnsureAt = 0;

async function ensureTable() {
    if (tableReady) return true;
    const now = Date.now();
    if (lastEnsureAt && now - lastEnsureAt < ENSURE_RETRY_MS) return false;
    lastEnsureAt = now;
    try {
        await getPool().query(
            `CREATE TABLE IF NOT EXISTS ${TABLE} (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                role VARCHAR(16) NOT NULL DEFAULT 'agent',
                token VARCHAR(200) NOT NULL,
                bundle_id VARCHAR(128) NOT NULL DEFAULT '${DEFAULT_BUNDLE}',
                environment VARCHAR(16) NOT NULL DEFAULT 'production',
                platform VARCHAR(16) NOT NULL DEFAULT 'ios',
                created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_staff_push_token (token),
                KEY idx_staff_push_user (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        );
        tableReady = true;
        console.log(`[staff-push] ready (table ${TABLE})`);
    } catch (e) {
        console.error(`[staff-push] table ${TABLE} unavailable: ${e.message} — push сотрудникам выключен`);
    }
    return tableReady;
}

// ---------------------------------------------------------------------------
// Проверка входных данных
// ---------------------------------------------------------------------------
function normalizeToken(token) {
    const t = String(token || '').replace(/[\s<>]/g, '').toLowerCase();
    return /^[0-9a-f]{64,200}$/.test(t) ? t : null;
}

function normalizeEnvironment(v) {
    const s = String(v || '').toLowerCase();
    if (s === 'development' || s === 'dev' || s === 'sandbox') return 'sandbox';
    return 'production';
}

function normalizeBundle(v) {
    const s = String(v || '').trim();
    return /^[A-Za-z0-9][A-Za-z0-9.-]{2,127}$/.test(s) ? s : DEFAULT_BUNDLE;
}

// ---------------------------------------------------------------------------
// Регистрация устройств
// ---------------------------------------------------------------------------
async function registerDevice(auth, body) {
    const token = normalizeToken(body && body.token);
    if (!token) return { error: 'invalid_token' };
    if (!(await ensureTable())) return { error: 'staff_push_unavailable' };
    const environment = normalizeEnvironment(body.environment);
    const bundleId = normalizeBundle(body.bundleId);
    const platform = 'ios';
    // Токен принадлежит одному устройству: при входе другим сотрудником переезжает к нему
    await getPool().query(
        `INSERT INTO ${TABLE} (user_id, role, token, bundle_id, environment, platform)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), role = VALUES(role),
             bundle_id = VALUES(bundle_id), environment = VALUES(environment), platform = VALUES(platform)`,
        [Number(auth.id), String(auth.role || 'agent'), token, bundleId, environment, platform],
    );
    console.log(`[staff-push] device registered user=${auth.id} env=${environment} bundle=${bundleId} token=…${token.slice(-6)}`);
    return { ok: true, environment, bundleId };
}

/** Снять только это устройство (другие телефоны сотрудника продолжают получать пуши). */
async function unregisterDevice(auth, body) {
    const token = normalizeToken(body && body.token);
    if (!token) return { error: 'invalid_token' };
    if (!(await ensureTable())) return { ok: true };
    await getPool().query(`DELETE FROM ${TABLE} WHERE token = ? AND user_id = ?`, [token, Number(auth.id)]);
    clearPresenceByToken(token);
    return { ok: true };
}

async function removeToken(token, reason) {
    try {
        await getPool().query(`DELETE FROM ${TABLE} WHERE token = ?`, [token]);
        console.warn(`[staff-push] dead token removed (…${token.slice(-6)}, ${reason})`);
    } catch (e) {
        console.warn('[staff-push] dead token remove failed:', e.message);
    }
}

async function setEnvironment(token, environment) {
    try {
        await getPool().query(`UPDATE ${TABLE} SET environment = ? WHERE token = ?`, [environment, token]);
    } catch (e) { /* не критично */ }
}

// ---------------------------------------------------------------------------
// «Приложение на экране» (сокет чата Support App)
// ---------------------------------------------------------------------------
const presence = new Map(); // socketId -> { userId, token, foreground }

function setPresence(socketId, auth, payload) {
    if (!socketId || !auth) return;
    const p = payload || {};
    presence.set(socketId, {
        userId: Number(auth.id),
        token: normalizeToken(p.pushToken),
        foreground: p.state === 'foreground',
    });
}

function clearPresence(socketId) {
    presence.delete(socketId);
}

function clearPresenceByToken(token) {
    for (const [id, p] of presence) if (p.token === token) presence.delete(id);
}

function isForeground(token) {
    for (const p of presence.values()) if (p.token === token && p.foreground) return true;
    return false;
}

// ---------------------------------------------------------------------------
// APNs
// ---------------------------------------------------------------------------
const providers = new Map(); // environment -> apn.Provider | null

function apnConfigured() {
    return Boolean(env('APN_KEY_PATH') && env('APN_KEY_ID') && env('APN_TEAM_ID'));
}

function providerFor(environment) {
    if (providers.has(environment)) return providers.get(environment);
    let provider = null;
    if (apnConfigured()) {
        try {
            const apn = getApn();
            provider = new apn.Provider({
                token: { key: path.resolve(env('APN_KEY_PATH')), keyId: env('APN_KEY_ID'), teamId: env('APN_TEAM_ID') },
                production: environment === 'production',
            });
        } catch (e) {
            console.error(`[staff-push] APNs provider (${environment}) init failed:`, e.message);
            provider = null;
        }
    }
    providers.set(environment, provider);
    return provider;
}

function reasonOf(failure) {
    return (failure && failure.response && failure.response.reason) || (failure && failure.error && failure.error.message) || null;
}

function buildNote({ bundleId, title, body, chatId, messageId, badge }) {
    const apn = getApn();
    const note = new apn.Notification();
    note.topic = bundleId;
    note.pushType = 'alert';
    note.priority = 10;
    note.expiry = Math.floor(Date.now() / 1000) + PUSH_TTL_SEC;
    note.alert = { title, body };
    note.sound = 'default';
    note.threadId = `support-chat-${chatId}`;
    note.collapseId = `support-chat-${chatId}`;
    if (Number.isFinite(badge) && badge >= 0) note.badge = badge;
    note.payload = { type: 'support_message_staff', route: 'chat', chatId: String(chatId), messageId: String(messageId) };
    return note;
}

/** Один пуш на одно устройство. Возвращает 'sent' | 'skipped' | 'failed'. */
async function sendToDevice(device, content) {
    const env0 = ENVIRONMENTS.includes(device.environment) ? device.environment : 'production';
    const provider = providerFor(env0);
    if (!provider) return 'skipped';
    const note = buildNote({ ...content, bundleId: device.bundle_id || DEFAULT_BUNDLE });
    let result = await provider.send(note, device.token);
    if (result && result.sent && result.sent.length) return 'sent';

    let failure = result && result.failed && result.failed[0];
    let reason = reasonOf(failure);

    // Токен из другого окружения (сборка из Xcode против production и наоборот) — пробуем второе
    if (reason === 'BadDeviceToken') {
        const other = env0 === 'production' ? 'sandbox' : 'production';
        const otherProvider = providerFor(other);
        if (otherProvider) {
            result = await otherProvider.send(note, device.token);
            if (result && result.sent && result.sent.length) {
                await setEnvironment(device.token, other);
                console.log(`[staff-push] token …${device.token.slice(-6)} moved to ${other}`);
                return 'sent';
            }
            failure = result && result.failed && result.failed[0];
            reason = reasonOf(failure) || reason;
        }
    }

    const status = String((failure && failure.status) || '');
    if (reason === 'Unregistered' || reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic' || status === '410') {
        await removeToken(device.token, reason || status);
    } else {
        console.warn(`[staff-push] APNs failed (…${device.token.slice(-6)}): ${reason || status || 'unknown'}`);
    }
    return 'failed';
}

async function staffUnreadTotal() {
    try {
        const [rows] = await getPool().query(
            'SELECT SUM(staff_unread) AS total FROM support_chats WHERE last_message_id IS NOT NULL',
        );
        const n = Number((rows[0] && rows[0].total) || 0);
        return Number.isFinite(n) ? n : null;
    } catch (e) {
        return null;
    }
}

async function recipientsFor(chatRow) {
    const assignedAgent = chatRow && chatRow.assigned_role === 'agent' && chatRow.assigned_id
        ? Number(chatRow.assigned_id) : null;
    if (assignedAgent) {
        const [mine] = await getPool().query(`SELECT * FROM ${TABLE} WHERE user_id = ?`, [assignedAgent]);
        if (mine.length) return mine;
    }
    const [all] = await getPool().query(`SELECT * FROM ${TABLE}`);
    return all;
}

/**
 * Новое сообщение пользователя → пуш сотрудникам (вызывает lib/supportChat.js sendMessage).
 * chatRow — строка support_chats (с assigned_*); userName — имя пользователя для заголовка.
 */
async function notifyStaff({ chatRow, message, userName }) {
    if (!chatRow || !message) return { sent: 0, skipped: 0, failed: 0, total: 0 };
    if (!apnConfigured()) {
        return { sent: 0, skipped: 0, failed: 0, total: 0, reason: 'apns_not_configured' };
    }
    if (!(await ensureTable())) return { sent: 0, skipped: 0, failed: 0, total: 0, reason: 'no_table' };

    const devices = await recipientsFor(chatRow);
    const out = { sent: 0, skipped: 0, failed: 0, total: devices.length };
    if (!devices.length) return out;

    const text = String(message.body || '').replace(/\s+/g, ' ').trim();
    const content = {
        title: userName || 'Новое сообщение',
        body: text.length > 180 ? `${text.slice(0, 179)}…` : text,
        chatId: Number(chatRow.id),
        messageId: Number(message.id),
        badge: await staffUnreadTotal(),
    };

    for (const device of devices) {
        if (isForeground(device.token)) { out.skipped += 1; continue; }
        try {
            const r = await sendToDevice(device, content);
            out[r] += 1;
        } catch (e) {
            out.failed += 1;
            console.warn('[staff-push] send error:', e.message);
        }
    }
    console.log(`[staff-push] chat=${chatRow.id} message=${message.id} sent=${out.sent} skipped=${out.skipped} failed=${out.failed} of ${out.total}`);
    return out;
}

module.exports = {
    TABLE,
    registerDevice,
    unregisterDevice,
    notifyStaff,
    setPresence,
    clearPresence,
    _internal: { normalizeToken, normalizeEnvironment, normalizeBundle, isForeground, presence, buildNote, _setDeps, providers },
};
