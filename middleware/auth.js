'use strict';

/**
 * HTTP- и Socket.io-гейт для calling_api_v2 (план SECURITY_JWT_PLAN_RU.md, п. 2.3).
 *
 * Политика по путям (первое совпадение выигрывает). Роли:
 *   user  — сайт/приложение (agent тоже удовлетворяет 'user')
 *   agent — панель звонков calling_v2
 *   staff — админка
 * Владелец проверяется по id (userId в пути/теле) или по loyalty_id (register-device,
 * calls) — для роли user; agent/staff могут работать с чужими id.
 *
 * AUTH_MODE=log (по умолчанию) — ничего не блокируется, только лог [AUTH] …;
 * AUTH_MODE=enforce — 401/403. AUTH_LOG_ONLY_PATHS — исключения при enforce.
 *
 * Support Chat (lib/supportChat.js) подключается здесь же: HTTP — через handler в POLICY
 * (как /api/ice-servers), сокет — attachSocket() в socketGate. Его роуты защищены strict-режимом
 * независимо от AUTH_MODE.
 */

const {
    authMode,
    extractBearerToken,
    verifyAccessToken,
    roleOf,
    requireAuth,
    logAuth,
} = require('../lib/auth');
const { iceServersHandler } = require('../lib/iceServers');
const supportChat = require('../lib/supportChat');

function normLoyalty(v) {
    return String(v || '').replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------
// Политика
// ---------------------------------------------------------------------------
// m — метод (опц.), re — regexp по req.path, roles — допустимые роли,
// public — без проверки, ownerUser — {param:N} | {body:'field'} (сравнение с auth.id),
// ownerLoyalty — {body:[...fields]} (сравнение с auth.payload.loyalty_id)
const POLICY = [
    { m: 'POST', re: /^\/api\/web\/login$/, public: true },
    { re: /^\/api\/health$/, public: true },

    { m: 'PATCH', re: /^\/api\/users\/[^/]+\/access$/, roles: ['agent', 'staff'] },
    { m: 'GET', re: /^\/api\/users\/by-id\/[^/]+$/, roles: ['user'] },
    { m: 'GET', re: /^\/api\/users\/search\/[^/]+$/, roles: ['user'] },
    { m: 'GET', re: /^\/api\/users\/([^/]+)$/, roles: ['user'], ownerLoyalty: { param: 1 } },
    { m: 'GET', re: /^\/api\/users$/, roles: ['agent', 'staff'] },

    // ICE-серверы для WebRTC (Б.1): обрабатывается прямо здесь (handler), чтобы не трогать index.js
    { m: 'GET', re: /^\/api\/ice-servers$/, roles: ['user'], handler: iceServersHandler },

    // Support Chat (lib/supportChat.js): сторона пользователя и сторона поддержки.
    // Роуты сами проверяют токен в strict-режиме; правила здесь — для полноты политики.
    { re: /^\/api\/support\/chat(\/|$)/, roles: ['user'], handler: supportChat.httpHandler },
    { re: /^\/api\/support(\/|$)/, roles: ['agent', 'staff'], handler: supportChat.httpHandler },

    { m: 'POST', re: /^\/api\/(register-device|unregister-device)$/, roles: ['user'], ownerLoyalty: { body: ['loyaltyId', 'userId'] } },
    { re: /^\/api\/calls/, roles: ['user'] },

    { m: 'GET', re: /^\/api\/contacts\/check\/([^/]+)\/[^/]+$/, roles: ['user'], ownerUser: { param: 1 } },
    { m: 'GET', re: /^\/api\/contacts\/([^/]+)$/, roles: ['user'], ownerUser: { param: 1 } },
    { m: 'POST', re: /^\/api\/contacts$/, roles: ['user'], ownerUser: { body: 'userId' } },

    { re: /^\/api\/favorites\/([^/]+)/, roles: ['user'], ownerUser: { param: 1 } },
    { re: /^\/api\/favorites$/, roles: ['user'], ownerUser: { body: 'userId' } },

    { re: /^\/api\/(tts|tour-assistant|v2)(\/|$)/, roles: ['user'] },
];

function findRule(req) {
    for (const rule of POLICY) {
        if (rule.m && rule.m !== req.method) continue;
        const match = rule.re.exec(req.path || '');
        if (match) return { rule, match };
    }
    return null;
}

// Кэш middleware по набору ролей
const mwCache = new Map();
function mwFor(roles) {
    const key = roles.join(',');
    if (!mwCache.has(key)) mwCache.set(key, requireAuth(roles));
    return mwCache.get(key);
}

function isEnforced(req) {
    if (authMode() !== 'enforce') return false;
    const p = req.path || '';
    const logOnly = String(process.env.AUTH_LOG_ONLY_PATHS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return !logOnly.some((prefix) => p.startsWith(prefix));
}

// Проверка владельца после requireAuth. true — можно продолжать, false — ответ уже отправлен.
function checkOwner(req, res, rule, match) {
    const auth = req.auth;
    if (!auth) return true;                       // log-режим без токена — как раньше
    if (auth.role === 'staff' || auth.role === 'agent') return true;

    let ok = true;
    if (rule.ownerUser) {
        const requested = rule.ownerUser.param !== undefined
            ? match[rule.ownerUser.param]
            : req.body?.[rule.ownerUser.body];
        if (requested !== undefined && requested !== null && requested !== '' && String(requested) !== String(auth.id)) ok = false;
    }
    if (ok && rule.ownerLoyalty) {
        const mine = normLoyalty(auth.payload.loyalty_id);
        let requested = null;
        if (rule.ownerLoyalty.param !== undefined) requested = match[rule.ownerLoyalty.param];
        else for (const f of rule.ownerLoyalty.body) { if (req.body?.[f]) { requested = req.body[f]; break; } }
        if (requested && mine && normLoyalty(requested) !== mine) ok = false;
    }
    if (ok) return true;

    if (isEnforced(req)) {
        res.status(403).json({ error: 'forbidden' });
        return false;
    }
    logAuth(req, 'owner_mismatch', auth);
    return true;
}

function httpGate(req, res, next) {
    if (req.method === 'OPTIONS') return next();
    const found = findRule(req);
    if (!found || found.rule.public) return next();
    const { rule, match } = found;
    return mwFor(rule.roles)(req, res, (err) => {
        if (err) return next(err);
        if (!checkOwner(req, res, rule, match)) return;
        if (rule.handler) return rule.handler(req, res);
        next();
    });
}

// ---------------------------------------------------------------------------
// Socket.io: токен в handshake.auth.token (или ?token= — для старых клиентов)
// ---------------------------------------------------------------------------
function socketGate(socket, next) {
    const hs = socket.handshake || {};
    const token = hs.auth?.token || hs.query?.token || extractBearerToken({ headers: hs.headers || {} });
    let auth = null;
    let reason = null;

    if (!token) reason = 'missing';
    else {
        const payload = verifyAccessToken(token);
        if (!payload) reason = 'invalid';
        else auth = { id: Number(payload.id), role: roleOf(payload), scope: payload.scope || 'user', payload };
    }
    socket.data = socket.data || {};
    socket.data.auth = auth;

    // Support Chat: комнаты и обработчики support:* (только при валидном токене)
    try { supportChat.attachSocket(socket); } catch (e) { console.error('[support-chat] attachSocket failed:', e); }

    if (!reason) return next();
    if (authMode() === 'enforce') return next(new Error('unauthorized'));

    logAuth(
        { method: 'WS', baseUrl: '', path: '/socket.io', headers: hs.headers || {}, ip: hs.address },
        reason,
        auth,
    );
    return next();
}

// loyalty_id из токена сокета (для registerDevice): user/agent — свой, staff — не подменяем
function socketLoyaltyId(socket) {
    const auth = socket.data?.auth;
    if (!auth || auth.role === 'staff') return null;
    return auth.payload?.loyalty_id || null;
}

// Проверка таблиц Support Chat после старта (лог-подсказка про миграцию, процесс не роняем)
setTimeout(() => { supportChat.ensureReady().catch(() => {}); }, 3000).unref();

module.exports = { httpGate, socketGate, socketLoyaltyId, POLICY, findRule };
