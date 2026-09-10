'use strict';

/**
 * Доставка через FCM (firebase-admin) — iOS и Android одним кодом.
 * Firebase инициализируется в index.js (default app по FIREBASE_CREDENTIALS_PATH);
 * здесь только проверяем admin.apps.length. Для iOS в консоли Firebase должен быть загружен
 * APNs-ключ (.p8) — настройка владельца; без него iOS-пуши через FCM не уходят.
 *
 * sendToDevices(devices, msg) → { sent: [tokens], dead: [tokens], failed: [tokens], errors: [...] }
 * msg: { title, body, data: {type, route, ...строки}, category, androidChannel, collapseKey, badge, ttlSeconds, silent }
 */

const BATCH = 500;
const DEAD_CODES = new Set([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
    'messaging/invalid-argument',
]);

function getAdmin() {
    let admin;
    try { admin = require('firebase-admin'); } catch (e) { return null; }
    if (!admin.apps || !admin.apps.length) return null;
    return admin;
}

function isEnabled() {
    return Boolean(getAdmin());
}

function toDataStrings(data) {
    const out = {};
    for (const [k, v] of Object.entries(data || {})) {
        if (v === undefined || v === null) continue;
        out[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return out;
}

function buildMessage(msg) {
    const data = toDataStrings({ ...msg.data, title: msg.title, body: msg.body });
    const ttl = Number.isFinite(msg.ttlSeconds) ? Math.max(0, msg.ttlSeconds) : 24 * 3600;
    const message = {
        data,
        android: {
            priority: 'high',
            ttl: ttl * 1000,
            collapseKey: msg.collapseKey || undefined,
            notification: msg.silent ? undefined : {
                channelId: msg.androidChannel || 'system',
                title: msg.title,
                body: msg.body,
                tag: msg.collapseKey || undefined,
                // clickAction не задаём: без intent-filter в манифесте тап по пушу ничего бы не открывал;
                // по умолчанию открывается launcher-Activity, а тап обрабатывает приложение (RNFB/notifee).
            },
        },
        apns: {
            headers: {
                'apns-priority': msg.silent ? '5' : '10',
                'apns-push-type': msg.silent ? 'background' : 'alert',
                'apns-expiration': String(Math.floor(Date.now() / 1000) + ttl),
                ...(msg.collapseKey ? { 'apns-collapse-id': String(msg.collapseKey).slice(0, 64) } : {}),
            },
            payload: {
                aps: msg.silent
                    ? { 'content-available': 1 }
                    : {
                        alert: { title: msg.title, body: msg.body },
                        sound: 'default',
                        badge: Number.isFinite(msg.badge) ? msg.badge : undefined,
                        'thread-id': msg.category || 'system',
                        'mutable-content': 1,
                    },
            },
        },
    };
    if (!msg.silent) message.notification = { title: msg.title, body: msg.body };
    return message;
}

async function sendToDevices(devices, msg) {
    const result = { sent: [], dead: [], failed: [], errors: [] };
    const admin = getAdmin();
    const tokens = devices.filter((d) => d.channel === 'fcm' && d.token).map((d) => d.token);
    if (!tokens.length) return result;
    if (!admin) {
        result.failed.push(...tokens);
        result.errors.push('fcm_disabled');
        return result;
    }
    const base = buildMessage(msg);
    for (let i = 0; i < tokens.length; i += BATCH) {
        const chunk = tokens.slice(i, i + BATCH);
        let resp;
        try {
            resp = await admin.messaging().sendEachForMulticast({ ...base, tokens: chunk });
        } catch (e) {
            result.failed.push(...chunk);
            result.errors.push(e.message);
            continue;
        }
        resp.responses.forEach((r, idx) => {
            const token = chunk[idx];
            if (r.success) { result.sent.push(token); return; }
            const code = r.error && r.error.code ? r.error.code : 'unknown';
            if (DEAD_CODES.has(code)) result.dead.push(token);
            else { result.failed.push(token); result.errors.push(code); }
        });
    }
    return result;
}

module.exports = { isEnabled, sendToDevices, buildMessage, DEAD_CODES, _toDataStrings: toDataStrings };
