'use strict';

/**
 * Выдача ICE-серверов (STUN/TURN) клиентам вместо кредов, зашитых в бандлы
 * (Б.1, SECURITY_AUDIT_SECRETS_RU.md, находки #25/#29).
 *
 * Режимы (по .env):
 *  - ephemeral  — задан TURN_SECRET: coturn в режиме use-auth-secret
 *                 (static-auth-secret=TURN_SECRET). Креды временные:
 *                 username = "<unix-expiry>:<userId>", credential = base64(HMAC-SHA1(secret, username)).
 *  - static     — заданы TURN_STATIC_USERNAME/TURN_STATIC_CREDENTIAL: отдаём их
 *                 (переходный вариант: пара хранится в .env, а не в клиентах, и выдаётся по JWT).
 *  - stun-only  — ничего не задано: только STUN (relay не работает, лог-предупреждение).
 *
 * URL-ы серверов — TURN_URLS / STUN_URLS (CSV) с дефолтами на totus.club.
 */

const crypto = require('crypto');
const { env } = require('./env');

const DEFAULT_STUN_URLS = [
    'stun:stun1.totus.club:3478',
    'stun:stun2.totus.club:3478',
];
const DEFAULT_TURN_URLS = [
    'turn:turn1.totus.club:3478?transport=udp',
    'turn:turn1.totus.club:3478?transport=tcp',
    'turns:turn1.totus.club:5349?transport=tcp',
    'turn:turn2.totus.club:3478?transport=udp',
    'turn:turn2.totus.club:3478?transport=tcp',
    'turns:turn2.totus.club:5349?transport=tcp',
];

function csv(name, fallback) {
    const raw = env(name);
    if (!raw) return fallback;
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return list.length ? list : fallback;
}

let warnedStunOnly = false;

function buildIceServers(userId) {
    const stunUrls = csv('STUN_URLS', DEFAULT_STUN_URLS);
    const turnUrls = csv('TURN_URLS', DEFAULT_TURN_URLS);
    const iceServers = stunUrls.map((urls) => ({ urls }));

    const secret = env('TURN_SECRET');
    const staticUser = env('TURN_STATIC_USERNAME');
    const staticCred = env('TURN_STATIC_CREDENTIAL');

    const ttl = Math.max(300, Number(env('TURN_TTL_SECONDS') || 43200)); // default 12h
    const expiresAt = Math.floor(Date.now() / 1000) + ttl;

    let mode = 'stun-only';
    let username = null;
    let credential = null;

    if (secret) {
        mode = 'ephemeral';
        username = `${expiresAt}:${userId || 'anon'}`;
        credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
    } else if (staticUser && staticCred) {
        mode = 'static';
        username = staticUser;
        credential = staticCred;
    } else if (!warnedStunOnly) {
        warnedStunOnly = true;
        console.warn('[ice] TURN_SECRET / TURN_STATIC_* not set — отдаю только STUN, relay не работает (см. .env.example)');
    }

    if (username) {
        for (const urls of turnUrls) iceServers.push({ urls, username, credential });
    }

    return {
        ok: true,
        mode,
        iceServers,
        // клиенты кэшируют до expiresAt минус запас; для static тоже отдаём срок,
        // чтобы клиентский код не различал режимы
        ttl,
        expiresAt,
    };
}

/** GET /api/ice-servers — вызывается из httpGate после проверки токена (roles: user). */
function iceServersHandler(req, res) {
    const userId = req.auth && req.auth.id ? String(req.auth.id) : null;
    res.json(buildIceServers(userId));
}

module.exports = { buildIceServers, iceServersHandler };
