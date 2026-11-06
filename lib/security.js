'use strict';

/**
 * CORS-whitelist и rate-limit для calling_api_v2 (план SECURITY_JWT_PLAN_RU.md, п. 2.3).
 *
 * CORS_ORIGINS — CSV разрешённых origin'ов (дефолт: домены totus.club + localhost).
 * Запросы без Origin (приложение, curl) разрешены всегда.
 * AUTH_MODE=log — неизвестный origin пропускается с логом [CORS]; enforce — блокируется.
 */

const rateLimit = require('express-rate-limit');
const { authMode } = require('./auth');

const DEFAULT_ORIGINS = [
    'https://totus.club',
    'https://www.totus.club',
    'https://calling.totus.club',
    'https://admin.totus.club',
    'https://ai.totus.club',
    'http://localhost:3000',
    'http://localhost:3008',
    'http://localhost:3009',
];

function allowedOrigins() {
    const fromEnv = String(process.env.CORS_ORIGINS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return fromEnv.length ? fromEnv : DEFAULT_ORIGINS;
}

const corsLogState = new Map();
function logUnknownOrigin(origin) {
    const now = Date.now();
    if (now - (corsLogState.get(origin) || 0) < 60 * 1000) return;
    corsLogState.set(origin, now);
    console.warn(`[CORS] mode=${authMode()} unknown origin=${origin}`);
}

// (origin, cb) — формат, который понимают и `cors`, и socket.io
function corsOrigin(origin, cb) {
    if (!origin) return cb(null, true);
    const list = allowedOrigins();
    if (list.includes('*') || list.includes(origin)) return cb(null, true);
    if (authMode() === 'enforce') return cb(null, false);
    logUnknownOrigin(origin);
    return cb(null, true);
}

const corsOptions = {
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: false,
    preflightContinue: false,
    optionsSuccessStatus: 200,
    maxAge: 86400,
};

// 30 попыток входа за 15 минут с одного IP
const loginLimiter = rateLimit({
    windowMs: Number(process.env.AUTH_RATE_WINDOW_MS || 15 * 60 * 1000),
    limit: Number(process.env.AUTH_RATE_LIMIT || 30),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'too_many_requests' },
});

// H9 аудита: лимит на платные вызовы (TTS, ИИ-ассистент) с одного IP.
//   PAID_RATE_LIMIT — запросов за окно (по умолчанию 60; 0 — выключен), PAID_RATE_WINDOW_MS — окно (60 000),
//   PAID_RATE_MODE — log (по умолчанию: превышение только в лог [RATE]) | enforce (429).
const paidLogState = new Map();
function logPaidExceeded(req) {
    const key = `${req.ip} ${req.path}`;
    const now = Date.now();
    if (now - (paidLogState.get(key) || 0) < 60 * 1000) return;
    paidLogState.set(key, now);
    if (paidLogState.size > 5000) paidLogState.clear();
    console.warn(`[RATE] paid mode=${process.env.PAID_RATE_MODE === 'enforce' ? 'enforce' : 'log'} exceeded ip=${req.ip} ${req.method} ${req.originalUrl || req.path}`);
}

function paidLimiter() {
    const limit = Number(process.env.PAID_RATE_LIMIT ?? 60);
    if (!Number.isFinite(limit) || limit <= 0) return (req, res, next) => next();
    return rateLimit({
        windowMs: Number(process.env.PAID_RATE_WINDOW_MS || 60 * 1000),
        limit,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        handler: (req, res, next, options) => {
            logPaidExceeded(req);
            if (process.env.PAID_RATE_MODE === 'enforce') {
                return res.status(options.statusCode || 429).json({ error: 'too_many_requests' });
            }
            return next();
        },
    });
}

module.exports = { corsOrigin, corsOptions, loginLimiter, paidLimiter, allowedOrigins };
