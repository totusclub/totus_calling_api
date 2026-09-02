'use strict';

/**
 * Единое auth-ядро (копия totus_API/lib/auth.js; план SECURITY_JWT_PLAN_RU.md, волна 3).
 * Держать в синхроне с totus_API — один JWT_SECRET / JWT_REFRESH_SECRET на все сервисы.
 *
 * Три роли: user (сайт/приложение), agent (панель звонков; тоже строка users),
 * staff (админка, таблица staff). Все access-токены подписаны JWT_SECRET,
 * refresh-токены — JWT_REFRESH_SECRET.
 *
 * AUTH_MODE:
 *   log      — (по умолчанию) запросы без валидного токена пропускаются,
 *              но пишутся в лог: [AUTH] reason=missing|invalid|forbidden …
 *   enforce  — 401/403 как положено.
 * AUTH_LOG_ONLY_PATHS — CSV префиксов путей, которые остаются в режиме log
 *              даже при enforce (чтобы включать проверку постепенно).
 * requireAuth(roles, { strict: true }) — всегда enforce, независимо от AUTH_MODE
 *              (для эндпоинтов, рождённых защищёнными: order-requests и т.п.).
 */

try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch (e) { /* dotenv optional */ }
const jwt = require('jsonwebtoken');

const USER_ACCESS_TTL = process.env.USER_ACCESS_TTL || '30d';   // пока приложение старое — 30d
const USER_REFRESH_TTL = process.env.USER_REFRESH_TTL || '90d';
const AGENT_ACCESS_TTL = process.env.AGENT_ACCESS_TTL || '12h';
const AGENT_REFRESH_TTL = process.env.AGENT_REFRESH_TTL || '30d';
const STAFF_ACCESS_TTL = process.env.STAFF_ACCESS_TTL || '12h';
const STAFF_REFRESH_TTL = process.env.STAFF_REFRESH_TTL || '30d';

function authMode() {
    return process.env.AUTH_MODE === 'enforce' ? 'enforce' : 'log';
}

function logOnlyPaths() {
    return String(process.env.AUTH_LOG_ONLY_PATHS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function requestPath(req) {
    return `${req.baseUrl || ''}${req.path || ''}` || req.originalUrl || '';
}

function isLogOnlyPath(req) {
    const p = requestPath(req);
    return logOnlyPaths().some((prefix) => p.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Токены
// ---------------------------------------------------------------------------

function extractBearerToken(req) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return null;
    const token = header.slice(7).trim();
    return token || null;
}

// Поля строки users, которые можно класть в токен (сайт/приложение читают
// профиль из payload — см. план, п. 2.7). Никаких code/password/voipToken/socketId.
const USER_PUBLIC_FIELDS = ['id', 'name', 'f_name', 'l_name', 'email', 'phone', 'loyalty_id', 'date'];

function publicUser(row) {
    const out = {};
    for (const key of USER_PUBLIC_FIELDS) {
        if (row && row[key] !== undefined) out[key] = row[key];
    }
    return out;
}

function roleOfUserRow(row) {
    return row && String(row.role || '').toLowerCase() === 'agent' ? 'agent' : 'user';
}

function signUserToken(row) {
    const payload = { ...publicUser(row), role: roleOfUserRow(row), scope: 'user' };
    return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: USER_ACCESS_TTL });
}

function signAgentToken(row) {
    const payload = { ...publicUser(row), role: 'agent', scope: 'agent' };
    return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: AGENT_ACCESS_TTL });
}

function signStaffToken(staff) {
    return jwt.sign(
        { id: staff.id, email: staff.email, role: 'staff', scope: 'staff' },
        process.env.JWT_SECRET,
        { expiresIn: STAFF_ACCESS_TTL },
    );
}

function signRefreshToken(id, scope) {
    const ttl = scope === 'staff' ? STAFF_REFRESH_TTL : scope === 'agent' ? AGENT_REFRESH_TTL : USER_REFRESH_TTL;
    return jwt.sign({ id, scope, typ: 'refresh' }, process.env.JWT_REFRESH_SECRET, { expiresIn: ttl });
}

function verifyAccessToken(token) {
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        if (!payload || typeof payload !== 'object') return null;
        if (payload.typ === 'refresh') return null; // refresh не является access
        if (!Number.isFinite(Number(payload.id))) return null;
        return payload;
    } catch (err) {
        return null;
    }
}

function verifyRefreshToken(token) {
    try {
        const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
        if (!payload || typeof payload !== 'object') return null;
        if (payload.typ !== 'refresh') return null;
        if (!Number.isFinite(Number(payload.id))) return null;
        return payload;
    } catch (err) {
        return null;
    }
}

// Роль из payload. Легаси user-токены (payload = вся строка users, без scope)
// считаются user; если в строке role='agent' — agent.
function roleOf(payload) {
    if (payload.scope === 'staff') return 'staff';
    if (payload.scope === 'agent') return 'agent';
    return String(payload.role || '').toLowerCase() === 'agent' ? 'agent' : 'user';
}

// agent — это тоже строка users, поэтому удовлетворяет требованию 'user'.
function satisfies(role, allowed) {
    if (!allowed || allowed.length === 0) return true;
    if (allowed.includes(role)) return true;
    if (role === 'agent' && allowed.includes('user')) return true;
    return false;
}

function buildAuth(payload) {
    return { id: Number(payload.id), role: roleOf(payload), scope: payload.scope || 'user', payload };
}

function attachAuth(req, auth) {
    req.auth = auth;
    // Совместимость с контроллерами order-requests (req.authUser / req.authStaff)
    if (auth.role === 'staff') req.authStaff = auth.payload;
    else req.authUser = auth.payload;
}

// ---------------------------------------------------------------------------
// Лог режима наблюдения (с троттлингом, чтобы не заливать pm2-логи)
// ---------------------------------------------------------------------------

const logState = new Map(); // key -> { count, lastAt }
const LOG_EVERY_MS = 60 * 1000;

function logAuth(req, reason, auth) {
    const key = `${reason} ${req.method} ${requestPath(req)}`;
    const now = Date.now();
    const st = logState.get(key) || { count: 0, lastAt: 0 };
    st.count += 1;
    if (now - st.lastAt < LOG_EVERY_MS) {
        logState.set(key, st);
        return;
    }
    st.lastAt = now;
    logState.set(key, st);
    const origin = req.headers.origin || '-';
    const ua = String(req.headers['user-agent'] || '-').slice(0, 80);
    const who = auth ? `${auth.role}#${auth.id}` : '-';
    console.warn(
        `[AUTH] mode=${authMode()} reason=${reason} ${req.method} ${requestPath(req)} ` +
        `auth=${who} origin=${origin} ip=${req.ip} ua="${ua}" count=${st.count}`,
    );
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

function sendAuthError(res, reason) {
    if (reason === 'forbidden') return res.status(403).json({ error: 'forbidden' });
    return res.status(401).json({ error: 'unauthorized' });
}

/**
 * requireAuth(['user']) / requireAuth(['staff']) / requireAuth(['user','staff'])
 * opts.strict — всегда enforce (не зависит от AUTH_MODE).
 */
function requireAuth(allowed = [], opts = {}) {
    const strict = Boolean(opts.strict);
    return function authMiddleware(req, res, next) {
        if (!process.env.JWT_SECRET) {
            return res.status(503).json({ error: 'auth_not_configured' });
        }

        const token = extractBearerToken(req);
        let auth = null;
        let reason = null;

        if (!token) {
            reason = 'missing';
        } else {
            const payload = verifyAccessToken(token);
            if (!payload) {
                reason = 'invalid';
            } else {
                auth = buildAuth(payload);
                if (!satisfies(auth.role, allowed)) reason = 'forbidden';
            }
        }

        if (!reason) {
            attachAuth(req, auth);
            return next();
        }

        const enforce = strict || (authMode() === 'enforce' && !isLogOnlyPath(req));
        if (enforce) return sendAuthError(res, reason);

        logAuth(req, reason, auth);
        if (auth) attachAuth(req, auth); // роль не подошла, но личность известна
        else req.auth = null;
        return next();
    };
}

// Токен разбирается, если есть; отсутствие — не ошибка и не лог.
function optionalAuth(req, res, next) {
    const token = extractBearerToken(req);
    if (token && process.env.JWT_SECRET) {
        const payload = verifyAccessToken(token);
        if (payload) attachAuth(req, buildAuth(payload));
        else req.auth = null;
    } else {
        req.auth = null;
    }
    next();
}

/**
 * Владелец ресурса — из токена, не из запроса.
 * Возвращает id пользователя, чьи данные можно отдавать, или null, если
 * ответ 403 уже отправлен.
 *   staff  → requested (любой пользователь)
 *   user   → свой id; чужой requested — 403 в enforce, лог в log-режиме
 *   нет auth (только log-режим) → requested как раньше
 */
function resolveOwnerId(req, res, requested) {
    const auth = req.auth;
    const wanted = requested === undefined || requested === null || requested === '' ? null : requested;

    if (!auth) return wanted;
    if (auth.role === 'staff') return wanted;

    if (wanted !== null && String(wanted) !== String(auth.id)) {
        const enforce = authMode() === 'enforce' && !isLogOnlyPath(req);
        if (enforce) {
            res.status(403).json({ error: 'forbidden' });
            return null;
        }
        logAuth(req, 'owner_mismatch', auth);
        return wanted; // log-режим: поведение как раньше
    }
    return auth.id;
}

/**
 * Проверка, что заказ принадлежит вызывающему (для /orders?order_id=…).
 * orderUserId — orders.user_id из БД (может быть null у старых/гостевых заказов).
 */
function assertOrderOwner(req, res, orderUserId) {
    const auth = req.auth;
    if (!auth || auth.role === 'staff') return true;
    if (orderUserId === null || orderUserId === undefined) return true;
    if (String(orderUserId) === String(auth.id)) return true;

    const enforce = authMode() === 'enforce' && !isLogOnlyPath(req);
    if (enforce) {
        res.status(403).json({ error: 'forbidden' });
        return false;
    }
    logAuth(req, 'owner_mismatch', auth);
    return true;
}

module.exports = {
    authMode,
    extractBearerToken,
    publicUser,
    signUserToken,
    signAgentToken,
    signStaffToken,
    signRefreshToken,
    verifyAccessToken,
    verifyRefreshToken,
    roleOf,
    requireAuth,
    optionalAuth,
    resolveOwnerId,
    assertOrderOwner,
    logAuth,
    TTL: {
        USER_ACCESS_TTL, USER_REFRESH_TTL, AGENT_ACCESS_TTL, AGENT_REFRESH_TTL, STAFF_ACCESS_TTL, STAFF_REFRESH_TTL,
    },
};
