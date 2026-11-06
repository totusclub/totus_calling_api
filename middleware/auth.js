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
 *
 * Хаб уведомлений (lib/notifications) — так же: handler для /api/push*, /api/notifications*, /internal/*
 * (роутеры сами проверяют JWT strict / X-Internal-Key), attachSocket() в socketGate, а для пропущенных
 * звонков — tap-функции правил /api/calls* (вызываются до основного обработчика index.js, ответ не трогают).
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
const { paidLimiter } = require('../lib/security');
const supportChat = require('../lib/supportChat');
const notifications = require('../lib/notifications');
const { userDb, contactDb } = require('../db');

// SECURITY_AUDIT_2026-11 (H2/H3/M5/H9): правки сделаны здесь, а не в index.js (гейт стоит перед всеми
// маршрутами и сокетами). В AUTH_MODE=log запросы без токена проходят как раньше; с токеном роли user
// чужие профили урезаются, личность звонящего берётся из токена, сигналинг сверяется с устройством сокета.
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS || 1);
const paidLimit = paidLimiter();

function normLoyalty(v) {
    return String(v || '').replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------
// Политика
// ---------------------------------------------------------------------------
// m — метод (опц.), re — regexp по req.path, roles — допустимые роли,
// public — без проверки, ownerUser — {param:N} | {body:'field'} (сравнение с auth.id),
// ownerLoyalty — {body:[...fields]} (сравнение с auth.payload.loyalty_id),
// handler — ответ формируется здесь (index.js не участвует), tap — наблюдатель (req, match) перед index.js
const POLICY = [
    { m: 'POST', re: /^\/api\/web\/login$/, public: true },
    { re: /^\/api\/health$/, public: true },

    { m: 'PATCH', re: /^\/api\/users\/[^/]+\/access$/, roles: ['agent', 'staff'] },
    // H2 аудита: профиль по id — только свой (agent/staff — любой)
    { m: 'GET', re: /^\/api\/users\/by-id\/([^/]+)$/, roles: ['user'], ownerUser: { param: 1 }, stripContacts: true },
    // H2: поиск нужен, чтобы добавить контакт, — email/phone чужого пользователя обычному user не отдаём
    { m: 'GET', re: /^\/api\/users\/search\/[^/]+$/, roles: ['user'], stripContacts: true },
    { m: 'GET', re: /^\/api\/users\/([^/]+)$/, roles: ['user'], ownerLoyalty: { param: 1 }, stripContacts: true },
    { m: 'GET', re: /^\/api\/users$/, roles: ['agent', 'staff'] },

    // ICE-серверы для WebRTC (Б.1): обрабатывается прямо здесь (handler), чтобы не трогать index.js
    { m: 'GET', re: /^\/api\/ice-servers$/, roles: ['user'], handler: iceServersHandler },

    // Support Chat (lib/supportChat.js): сторона пользователя и сторона поддержки.
    // Роуты сами проверяют токен в strict-режиме; правила здесь — для полноты политики.
    { re: /^\/api\/support\/chat(\/|$)/, roles: ['user'], handler: supportChat.httpHandler },
    { re: /^\/api\/support(\/|$)/, roles: ['agent', 'staff'], handler: supportChat.httpHandler },

    // Хаб уведомлений (lib/notifications): роутеры сами проверяют JWT (user — устройства и центр уведомлений,
    // staff — рассылки/напоминания/история) и X-Internal-Key для /internal/*; правило — только маршрутизация.
    { re: /^\/(api\/push|api\/notifications|internal)(\/|$)/, public: true, handler: notifications.httpHandler },

    { m: 'POST', re: /^\/api\/(register-device|unregister-device)$/, roles: ['user'], ownerLoyalty: { body: ['loyaltyId', 'userId'] } },
    // Пропущенные звонки поддержки → missed_call (tap не меняет ответ index.js)
    // H3: fromLoyaltyId звонящего — из токена (user/agent), а не из тела запроса
    { m: 'POST', re: /^\/api\/calls\/by-loyalty$/, roles: ['user'], identity: 'fromLoyaltyId' },
    { m: 'POST', re: /^\/api\/calls$/, roles: ['user'], identity: 'fromLoyaltyId', tap: notifications.calls.onCallCreated },
    { m: 'POST', re: /^\/api\/calls\/([^/]+)\/(answer|reject|end)$/, roles: ['user'], tap: notifications.calls.onCallAction },
    { re: /^\/api\/calls/, roles: ['user'] },

    { m: 'GET', re: /^\/api\/contacts\/check\/([^/]+)\/[^/]+$/, roles: ['user'], ownerUser: { param: 1 } },
    { m: 'GET', re: /^\/api\/contacts\/([^/]+)$/, roles: ['user'], ownerUser: { param: 1 } },
    { m: 'POST', re: /^\/api\/contacts$/, roles: ['user'], ownerUser: { body: 'userId' } },

    { re: /^\/api\/favorites\/([^/]+)/, roles: ['user'], ownerUser: { param: 1 } },
    { re: /^\/api\/favorites$/, roles: ['user'], ownerUser: { body: 'userId' } },

    // H9: лимит платных вызовов (PAID_RATE_LIMIT / PAID_RATE_MODE, lib/security.js); путь файла TTS — только сервер
    { m: 'POST', re: /^\/api\/tts\/synthesize-to-file$/, roles: ['user'], limiter: paidLimit, stripBody: ['outputPath'] },
    { re: /^\/api\/(tts|tour-assistant|v2)(\/|$)/, roles: ['user'], limiter: paidLimit },
];

function isPrivileged(auth) {
    return Boolean(auth && (auth.role === 'agent' || auth.role === 'staff'));
}

// Чужой профиль без контактов: user с токеном видит email/phone только у себя; без токена — как раньше (log) / урезано (enforce).
function stripContactsForViewer(req, body) {
    const auth = req.auth;
    if (!body || typeof body !== 'object' || !body.user || typeof body.user !== 'object') return body;
    if (isPrivileged(auth)) return body;
    if (!auth && authMode() !== 'enforce') return body;
    if (auth && String(body.user.id) === String(auth.id)) return body;
    const { email, phone, ...rest } = body.user;
    return { ...body, user: rest };
}

function wrapJsonStripContacts(req, res) {
    const orig = res.json.bind(res);
    res.json = (body) => orig(stripContactsForViewer(req, body));
}

// Личность вызывающего — из токена (staff и запросы без токена не подменяются)
function applyIdentity(req, field) {
    const auth = req.auth;
    if (!auth || auth.role === 'staff') return;
    const mine = normLoyalty(auth.payload && auth.payload.loyalty_id);
    if (!mine || !req.body || typeof req.body !== 'object') return;
    const given = req.body[field];
    if (given && normLoyalty(given) !== mine) {
        console.warn(`[AUTH] ${req.method} ${req.path}: ${field} differs from token — using token identity (auth=${auth.role}#${auth.id})`);
    }
    req.body[field] = auth.payload.loyalty_id;
}

const trustProxyApplied = new WeakSet();
// M5: за nginx один хоп. `app.set('trust proxy', true)` в index.js позволяет подставить IP через X-Forwarded-For;
// express читает настройку при каждом обращении к req.ip, поэтому переопределение здесь действует на все запросы.
function applyTrustProxy(req) {
    const app = req.app;
    if (!app || typeof app.set !== 'function' || trustProxyApplied.has(app)) return;
    trustProxyApplied.add(app);
    if (Number.isFinite(TRUST_PROXY_HOPS) && TRUST_PROXY_HOPS >= 0) app.set('trust proxy', TRUST_PROXY_HOPS);
}

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
    applyTrustProxy(req);
    if (req.method === 'OPTIONS') return next();
    const found = findRule(req);
    if (!found) return next();
    const { rule, match } = found;
    if (rule.public) return rule.handler ? rule.handler(req, res) : next();
    return mwFor(rule.roles)(req, res, (err) => {
        if (err) return next(err);
        if (!checkOwner(req, res, rule, match)) return;
        if (rule.identity) applyIdentity(req, rule.identity);
        if (rule.stripBody && req.body && !isPrivileged(req.auth)) {
            for (const f of rule.stripBody) if (req.body[f] !== undefined) { delete req.body[f]; console.warn(`[AUTH] ${req.method} ${req.path}: body.${f} ignored`); }
        }
        if (rule.stripContacts) wrapJsonStripContacts(req, res);
        const proceed = () => {
            if (rule.tap) { try { rule.tap(req, match); } catch (e) { console.error('[AUTH] tap failed:', e); } }
            if (rule.handler) return rule.handler(req, res);
            next();
        };
        if (rule.limiter) return rule.limiter(req, res, (limErr) => (limErr ? next(limErr) : proceed()));
        return proceed();
    });
}

// ---------------------------------------------------------------------------
// H2/H3 для Socket.io: сигналинг только от своего устройства; статусы — только свои и контактов
// ---------------------------------------------------------------------------
const SIGNALING_EVENTS = new Set(['offer', 'answer', 'ice-candidate']);

/** Сокет вправе слать сигналинг от имени fromDeviceId (зарегистрировано им через registerDevice). */
function socketMayActAs(socket, event, fromDeviceId) {
    if (!fromDeviceId) return true;
    const registered = socket.data && socket.data.deviceId;
    if (!registered) return true; // старый клиент без registerDevice — поведение как раньше
    if (registered === fromDeviceId) return true;
    const auth = socket.data.auth;
    const enforce = authMode() === 'enforce';
    console.warn(`[socket:${event}] fromDeviceId mismatch socket=${socket.id} registered=${registered} from=${fromDeviceId} auth=${auth ? `${auth.role}#${auth.id}` : '-'}${enforce ? ' — ignored' : ''}`);
    return !enforce;
}

/** 'get-users-status' для обычного пользователя: только он сам и его контакты. true — событие обработано здесь. */
async function handleUsersStatus(socket) {
    const auth = socket.data && socket.data.auth;
    if (isPrivileged(auth)) return false;
    if (!auth && authMode() !== 'enforce') return false; // log-режим без токена — как раньше (index.js)
    let users = [];
    try {
        if (auth) {
            const [all, contacts] = await Promise.all([userDb.getAllUsers(), contactDb.getUserContacts(auth.id).catch(() => [])]);
            const allowed = new Set(contacts.map((c) => normLoyalty(c.loyalty_id)));
            users = all.filter((u) => u.id === auth.id || allowed.has(normLoyalty(u.loyalty_id)));
        }
    } catch (e) {
        console.error('[socket:get-users-status] error:', e);
    }
    socket.emit('users-status', { users: users.map((u) => ({ id: u.id, loyaltyId: u.loyalty_id, online: u.online === 1 })) });
    return true;
}

function attachSocketGuards(socket) {
    socket.on('registerDevice', (payload) => {
        if (payload && payload.deviceId) socket.data.deviceId = String(payload.deviceId);
    });
    socket.use((packet, next) => {
        const [event, payload] = Array.isArray(packet) ? packet : [];
        if (SIGNALING_EVENTS.has(event)) {
            const from = payload && typeof payload === 'object' ? payload.fromDeviceId : null;
            if (!socketMayActAs(socket, event, from)) return; // пакет отброшен
            return next();
        }
        if (event === 'get-users-status') {
            handleUsersStatus(socket).then((handled) => { if (!handled) next(); }).catch(() => next());
            return;
        }
        return next();
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
    try { attachSocketGuards(socket); } catch (e) { console.error('[AUTH] socket guards failed:', e); }

    // Support Chat: комнаты и обработчики support:* (только при валидном токене)
    try { supportChat.attachSocket(socket); } catch (e) { console.error('[support-chat] attachSocket failed:', e); }
    // Уведомления: комната u:<userId>, события notify:*, отслеживание ответа на звонок
    try { notifications.attachSocket(socket); } catch (e) { console.error('[notify] attachSocket failed:', e); }

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
// Хаб уведомлений: проверка таблиц + таймеры (отложенные пуши, запланированные рассылки, напоминания)
notifications.start();

module.exports = { httpGate, socketGate, socketLoyaltyId, POLICY, findRule, stripContactsForViewer, applyIdentity, socketMayActAs, handleUsersStatus };
