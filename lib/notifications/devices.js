'use strict';

/**
 * Устройства для push (таблица push_devices, scripts/run-notifications-migration.js).
 * Несколько устройств на пользователя; upsert по токену; чужой токен пере-привязывается
 * к новому пользователю (вход на том же устройстве под другим аккаунтом).
 * users.voipToken не трогается — он остаётся только для VoIP-звонков.
 */

const { PLATFORMS, CHANNELS } = require('./types');

let pool = null;
function getPool() {
    if (!pool) pool = require('../../db').pool;
    return pool;
}

const TOKEN_MAX = 4096;
const FAIL_DISABLE_AFTER = 5;

function str(v, max) {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    if (!s) return null;
    return s.length > max ? s.slice(0, max) : s;
}

/** Валидация тела POST /api/push/devices. Возвращает { error } или { device }. */
function validateDevice(body) {
    const b = body || {};
    const platform = String(b.platform || '').toLowerCase();
    if (!PLATFORMS.includes(platform)) return { error: 'platform_invalid' };
    let channel = String(b.channel || '').toLowerCase();
    if (!channel) channel = platform === 'web' ? 'webpush' : 'fcm';
    if (!CHANNELS.includes(channel)) return { error: 'channel_invalid' };

    let token = null;
    let subscription = null;
    if (channel === 'webpush') {
        const s = b.subscription;
        if (!s || typeof s !== 'object' || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint)) return { error: 'subscription_invalid' };
        if (!s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') return { error: 'subscription_invalid' };
        token = s.endpoint.slice(0, TOKEN_MAX);
        subscription = { endpoint: s.endpoint, expirationTime: s.expirationTime || null, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
    } else {
        token = str(b.token, TOKEN_MAX);
        if (!token || token.length < 20 || /\s/.test(token)) return { error: 'token_invalid' };
    }
    return {
        device: {
            platform,
            channel,
            token,
            subscription,
            deviceId: str(b.deviceId, 64),
            appVersion: str(b.appVersion, 32),
            locale: str(b.locale, 8),
            deviceName: str(b.deviceName, 64),
        },
    };
}

/** Регистрация/обновление устройства пользователя. */
async function registerDevice(userId, device) {
    const sql = `INSERT INTO push_devices
        (user_id, platform, channel, token, subscription, device_id, device_name, app_version, locale, enabled, fail_count, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NOW())
        ON DUPLICATE KEY UPDATE
            user_id = VALUES(user_id), platform = VALUES(platform), channel = VALUES(channel),
            subscription = VALUES(subscription), device_id = COALESCE(VALUES(device_id), device_id),
            device_name = COALESCE(VALUES(device_name), device_name),
            app_version = COALESCE(VALUES(app_version), app_version), locale = COALESCE(VALUES(locale), locale),
            enabled = 1, fail_count = 0, last_seen_at = NOW()`;
    await getPool().query(sql, [
        userId, device.platform, device.channel, device.token,
        device.subscription ? JSON.stringify(device.subscription) : null,
        device.deviceId, device.deviceName, device.appVersion, device.locale,
    ]);
    // Один и тот же deviceId с новым токеном (onTokenRefresh) — старые записи этого устройства отключаем
    if (device.deviceId) {
        await getPool().query(
            'UPDATE push_devices SET enabled = 0 WHERE device_id = ? AND platform = ? AND token <> ? AND enabled = 1',
            [device.deviceId, device.platform, device.token],
        );
    }
    const [rows] = await getPool().query('SELECT * FROM push_devices WHERE token = ? LIMIT 1', [device.token]);
    return rows.length ? serializeDevice(rows[0]) : null;
}

/** Снятие устройства при выходе (только своё). */
async function removeDevice(userId, token) {
    const [r] = await getPool().query('DELETE FROM push_devices WHERE user_id = ? AND token = ?', [userId, token]);
    return r.affectedRows > 0;
}

async function removeDevicesByDeviceId(userId, deviceId) {
    const [r] = await getPool().query('DELETE FROM push_devices WHERE user_id = ? AND device_id = ?', [userId, deviceId]);
    return r.affectedRows;
}

async function listUserDevices(userId) {
    const [rows] = await getPool().query(
        'SELECT * FROM push_devices WHERE user_id = ? ORDER BY last_seen_at DESC, id DESC LIMIT 50',
        [userId],
    );
    return rows.map(serializeDevice);
}

/** Активные устройства для отправки (по одному или многим пользователям). */
async function activeDevicesForUsers(userIds) {
    if (!userIds.length) return [];
    const [rows] = await getPool().query(
        'SELECT id, user_id, platform, channel, token, subscription, locale, device_id FROM push_devices WHERE enabled = 1 AND user_id IN (?)',
        [userIds],
    );
    return rows.map((r) => ({ ...r, subscription: parseJson(r.subscription) }));
}

/** Мёртвые токены (FCM registration-token-not-registered, Web Push 404/410) — удаляем. */
async function dropTokens(tokens) {
    if (!tokens.length) return 0;
    const [r] = await getPool().query('DELETE FROM push_devices WHERE token IN (?)', [tokens]);
    return r.affectedRows;
}

/** Временные ошибки — считаем; после FAIL_DISABLE_AFTER подряд отключаем. */
async function bumpFailures(tokens) {
    if (!tokens.length) return;
    await getPool().query(
        'UPDATE push_devices SET fail_count = fail_count + 1, enabled = IF(fail_count + 1 >= ?, 0, enabled) WHERE token IN (?)',
        [FAIL_DISABLE_AFTER, tokens],
    );
}

async function markDelivered(tokens) {
    if (!tokens.length) return;
    await getPool().query('UPDATE push_devices SET fail_count = 0, last_push_at = NOW() WHERE token IN (?)', [tokens]);
}

function parseJson(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (e) { return null; }
}

function serializeDevice(row) {
    return {
        id: Number(row.id),
        platform: row.platform,
        channel: row.channel,
        deviceId: row.device_id || null,
        deviceName: row.device_name || null,
        appVersion: row.app_version || null,
        locale: row.locale || null,
        enabled: Number(row.enabled) === 1,
        tokenTail: row.token ? `…${String(row.token).slice(-8)}` : null, // токен наружу не отдаём
        lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
        lastPushAt: row.last_push_at ? new Date(row.last_push_at).toISOString() : null,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
}

module.exports = {
    validateDevice,
    registerDevice,
    removeDevice,
    removeDevicesByDeviceId,
    listUserDevices,
    activeDevicesForUsers,
    dropTokens,
    bumpFailures,
    markDelivered,
    serializeDevice,
    FAIL_DISABLE_AFTER,
};
