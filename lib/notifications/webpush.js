'use strict';

/**
 * Web Push (VAPID) для сайта totus.club — пакет `web-push`.
 * Ключи: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT (mailto: или https://) в .env;
 * сгенерировать: node scripts/generate-vapid-keys.js. Публичный ключ отдаётся сайту
 * через GET /api/push/vapid-public-key (публичный эндпоинт — это не секрет).
 *
 * Подписка хранится в push_devices.subscription ({endpoint, keys:{p256dh, auth}}), token = endpoint.
 */

const { env } = require('../env');

let lib = null;
let configured = false;
let configuredFor = null;

function getLib() {
    if (lib === null) {
        try { lib = require('web-push'); } catch (e) { lib = false; }
    }
    return lib || null;
}

function publicKey() {
    return env('VAPID_PUBLIC_KEY') || null;
}

function isEnabled() {
    return Boolean(getLib() && env('VAPID_PUBLIC_KEY') && env('VAPID_PRIVATE_KEY'));
}

function ensureConfigured() {
    const wp = getLib();
    if (!wp) return false;
    const pub = env('VAPID_PUBLIC_KEY');
    const priv = env('VAPID_PRIVATE_KEY');
    if (!pub || !priv) return false;
    const subject = env('VAPID_SUBJECT') || 'mailto:support@totus.club';
    const key = `${subject}|${pub}`;
    if (!configured || configuredFor !== key) {
        wp.setVapidDetails(subject, pub, priv);
        configured = true;
        configuredFor = key;
    }
    return true;
}

/** Полезная нагрузка для public/sw.js сайта (см. docs/NOTIFICATIONS_API.md). */
function buildPayload(msg) {
    return JSON.stringify({
        title: msg.title,
        body: msg.body,
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        tag: msg.collapseKey || undefined,
        renotify: Boolean(msg.collapseKey),
        data: { ...msg.data, title: msg.title, body: msg.body },
    });
}

/**
 * sendToDevices(devices, msg) → { sent, dead, failed, errors } (по token = endpoint)
 */
async function sendToDevices(devices, msg) {
    const result = { sent: [], dead: [], failed: [], errors: [] };
    const targets = devices.filter((d) => d.channel === 'webpush' && d.subscription && d.subscription.endpoint);
    if (!targets.length) return result;
    if (!ensureConfigured()) {
        result.failed.push(...targets.map((d) => d.token));
        result.errors.push('webpush_disabled');
        return result;
    }
    const wp = getLib();
    const payload = buildPayload(msg);
    const ttl = Number.isFinite(msg.ttlSeconds) ? Math.max(60, msg.ttlSeconds) : 24 * 3600;
    const opts = { TTL: ttl, urgency: msg.silent ? 'low' : 'high', topic: msg.collapseKey ? String(msg.collapseKey).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined : undefined };

    // По 20 параллельно — сайтовых подписок немного, а ответы push-сервисов небыстрые
    const CONC = 20;
    for (let i = 0; i < targets.length; i += CONC) {
        const chunk = targets.slice(i, i + CONC);
        await Promise.all(chunk.map(async (d) => {
            try {
                await wp.sendNotification(d.subscription, payload, opts);
                result.sent.push(d.token);
            } catch (e) {
                const code = Number(e && e.statusCode);
                if (code === 404 || code === 410) result.dead.push(d.token);
                else { result.failed.push(d.token); result.errors.push(`webpush_${code || 'error'}`); }
            }
        }));
    }
    return result;
}

module.exports = { isEnabled, publicKey, sendToDevices, buildPayload };
