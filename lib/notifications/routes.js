'use strict';

/**
 * REST хаба уведомлений (docs/NOTIFICATIONS_API.md). Подключается из middleware/auth.js как handler
 * правил POLICY (index.js не меняется). Все роуты — strict JWT независимо от AUTH_MODE:
 *   пользователь (user/agent):  /api/push/devices*, /api/notifications*
 *   сотрудник (staff):          /api/push/campaigns*, /reminders*, /history, /stats, /test, /users/:id/devices, /status
 *   публично:                   GET /api/push/vapid-public-key
 *   внутренний (totus_API):     POST /internal/notify — заголовок X-Internal-Key = INTERNAL_API_KEY
 */

const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../auth');
const { env } = require('../env');
const service = require('./service');
const devices = require('./devices');
const campaigns = require('./campaigns');
const reminders = require('./reminders');
const fcm = require('./fcm');
const webpush = require('./webpush');
const { CATEGORIES, TYPES, ROUTES } = require('./types');

const ERROR_STATUS = {
    notifications_not_migrated: 503,
    not_found: 404,
    campaign_status_invalid: 409,
    already_sending: 409,
    user_not_found: 404,
    unauthorized: 401,
    forbidden: 403,
    internal_error: 500,
    send_failed: 502,
};

function sendError(res, error, extra) {
    const status = ERROR_STATUS[error] || 400;
    res.status(status).json({ error, ...(extra || {}) });
}

const STAFF_RE = /^\/(campaigns|reminders|history|stats|test|users|status)(\/|$)/;

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function readyGuard(req, res, next) {
    if (await service.isReady()) return next();
    return sendError(res, 'notifications_not_migrated');
}

function intParam(v) {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Пользователь
// ---------------------------------------------------------------------------
function userRouter() {
    const r = express.Router();
    r.use(requireAuth(['user'], { strict: true }));
    r.use(readyGuard);

    // Устройства
    r.get('/push/devices', wrap(async (req, res) => {
        res.json({ devices: await devices.listUserDevices(req.auth.id) });
    }));

    r.post('/push/devices', wrap(async (req, res) => {
        const v = devices.validateDevice(req.body);
        if (v.error) return sendError(res, v.error);
        const device = await devices.registerDevice(req.auth.id, v.device);
        res.json({ ok: true, device, unread: await service.unreadCount(req.auth.id) });
    }));

    r.delete('/push/devices', wrap(async (req, res) => {
        const b = req.body || {};
        const token = b.token || (b.subscription && b.subscription.endpoint) || null;
        let removed = 0;
        if (token) removed += (await devices.removeDevice(req.auth.id, String(token))) ? 1 : 0;
        if (b.deviceId) removed += await devices.removeDevicesByDeviceId(req.auth.id, String(b.deviceId).slice(0, 64));
        if (!token && !b.deviceId) return sendError(res, 'token_required');
        res.json({ ok: true, removed });
    }));

    r.delete('/push/devices/:token', wrap(async (req, res) => {
        const removed = await devices.removeDevice(req.auth.id, decodeURIComponent(req.params.token));
        res.json({ ok: true, removed: removed ? 1 : 0 });
    }));

    // Центр уведомлений
    r.get('/notifications', wrap(async (req, res) => {
        const q = req.query || {};
        const page = await service.listNotifications(req.auth.id, { before: q.before, limit: q.limit, category: q.category, unread: q.unread });
        res.json(page);
    }));

    r.get('/notifications/unread', wrap(async (req, res) => {
        res.json({ unread: await service.unreadCount(req.auth.id) });
    }));

    r.get('/notifications/meta', (req, res) => {
        res.json({
            categories: Object.entries(CATEGORIES).map(([key, c]) => ({ key, title: c.title, mandatory: c.mandatory, default: c.default })),
            types: Object.entries(TYPES).map(([key, t]) => ({ key, category: t.category, route: t.route })),
            routes: ROUTES,
            quietHours: service.quietHoursText(),
            push: { fcm: fcm.isEnabled(), webpush: webpush.isEnabled(), vapidPublicKey: webpush.publicKey() },
        });
    });

    r.post('/notifications/read', wrap(async (req, res) => {
        const b = req.body || {};
        const r2 = await service.markRead(req.auth.id, b.all === true ? 'all' : b.ids || b.id);
        res.json({ ok: true, unread: r2.unread });
    }));

    r.post('/notifications/opened', wrap(async (req, res) => {
        const b = req.body || {};
        const r2 = await service.markOpened(req.auth.id, b.id);
        res.json({ ok: true, unread: r2.unread });
    }));

    r.get('/notifications/settings', wrap(async (req, res) => {
        res.json({ settings: await service.getSettings(req.auth.id), devices: await devices.listUserDevices(req.auth.id) });
    }));

    r.put('/notifications/settings', wrap(async (req, res) => {
        res.json({ ok: true, settings: await service.updateSettings(req.auth.id, req.body) });
    }));

    r.delete('/notifications/:id', wrap(async (req, res) => {
        const ok = await service.deleteNotification(req.auth.id, req.params.id);
        if (!ok) return sendError(res, 'not_found');
        res.json({ ok: true, unread: await service.unreadCount(req.auth.id) });
    }));

    return r;
}

// ---------------------------------------------------------------------------
// Сотрудник (Totus_admin)
// ---------------------------------------------------------------------------
function staffName(auth) {
    const p = auth.payload || {};
    return [p.name, p.lastname].filter(Boolean).join(' ').trim() || p.email || `staff#${auth.id}`;
}

/** Получатель тестового пуша: userId | loyaltyId | email; по умолчанию — пользователь с e-mail сотрудника. */
async function resolveTestUser(req) {
    const b = req.body || {};
    const pool = service.getPool();
    if (intParam(b.userId)) return intParam(b.userId);
    if (b.loyaltyId) {
        const [rows] = await pool.query('SELECT id FROM users WHERE REPLACE(loyalty_id, " ", "") = ? LIMIT 1', [String(b.loyaltyId).replace(/\s+/g, '')]);
        return rows.length ? Number(rows[0].id) : null;
    }
    const email = String(b.email || (req.auth.payload && req.auth.payload.email) || '').trim().toLowerCase();
    if (!email) return null;
    const [rows] = await pool.query('SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1', [email]);
    return rows.length ? Number(rows[0].id) : null;
}

function staffRouter() {
    const r = express.Router();
    // /api/push/devices — пользователь (userRouter); всё остальное под /api/push — сотрудник
    r.use((req, res, next) => (STAFF_RE.test(req.path) ? next() : next('router')));
    r.use(requireAuth(['staff'], { strict: true }));
    r.use(readyGuard);

    r.get('/status', (req, res) => {
        res.json({
            fcm: fcm.isEnabled(), webpush: webpush.isEnabled(), vapidPublicKey: webpush.publicKey(),
            internalKey: Boolean(env('INTERNAL_API_KEY')), quietHours: service.quietHoursText(), quietNow: service.isQuietNow(),
            categories: Object.entries(CATEGORIES).map(([key, c]) => ({ key, title: c.title, mandatory: c.mandatory })),
            types: Object.keys(TYPES), routes: ROUTES,
            reminders: { events: reminders.EVENTS, units: reminders.UNITS, directions: reminders.DIRECTIONS, quiet: reminders.QUIET, audiences: reminders.AUDIENCES },
        });
    });

    r.get('/stats', wrap(async (req, res) => { res.json(await campaigns.stats(req.query || {})); }));
    r.get('/history', wrap(async (req, res) => { res.json(await campaigns.history(req.query || {})); }));

    r.get('/users/:id/devices', wrap(async (req, res) => {
        const id = intParam(req.params.id);
        if (!id) return sendError(res, 'user_id_invalid');
        res.json({ devices: await devices.listUserDevices(id), settings: await service.getSettings(id), unread: await service.unreadCount(id) });
    }));

    r.post('/test', wrap(async (req, res) => {
        const userId = await resolveTestUser(req);
        if (!userId) return sendError(res, 'user_not_found', { hint: 'Укажите userId, loyaltyId или email пользователя (по умолчанию — e-mail сотрудника)' });
        const b = req.body || {};
        const result = await service.notify({
            userId,
            type: TYPES[b.type] ? b.type : 'system',
            title: b.title || 'Тестовое уведомление',
            body: b.body || 'Если вы видите это сообщение — push-уведомления Totus работают.',
            data: b.data,
            source: 'test',
            respectQuietHours: false,
        });
        if (!result.ok) return sendError(res, result.error);
        res.json({ ok: true, userId, result });
    }));

    // Рассылки
    r.get('/campaigns', wrap(async (req, res) => { res.json(await campaigns.listCampaigns(req.query || {})); }));

    r.post('/campaigns/audience', wrap(async (req, res) => {
        const seg = campaigns.normalizeSegment((req.body || {}).segment);
        if (seg.error) return sendError(res, seg.error);
        const type = campaigns.CAMPAIGN_TYPES.includes((req.body || {}).type) ? req.body.type : 'promo';
        res.json({ segment: seg.segment, type, audience: await campaigns.countAudience(seg.segment, type === 'promo' ? 'promo' : 'system') });
    }));

    r.post('/campaigns', wrap(async (req, res) => {
        const b = req.body || {};
        const v = campaigns.validateCampaign(b);
        if (v.error) return sendError(res, v.error);
        const category = v.type === 'promo' ? 'promo' : 'system';
        if (b.dryRun === true) return res.json({ dryRun: true, audience: await campaigns.countAudience(v.segment, category), quietNow: service.isQuietNow() });
        const staff = { id: req.auth.id, name: staffName(req.auth) };
        if (b.draft === true) return res.json({ ok: true, campaign: await campaigns.createCampaign(staff, v, 'draft') });
        if (v.scheduledAt && v.scheduledAt.getTime() > Date.now()) return res.json({ ok: true, campaign: await campaigns.createCampaign(staff, v, 'scheduled') });
        const c = await campaigns.createCampaign(staff, v, 'draft');
        campaigns.sendCampaign(c.id).catch((e) => console.error('[notify] campaign send error:', e));
        res.json({ ok: true, campaign: { ...c, status: 'sending' } });
    }));

    r.get('/campaigns/:id', wrap(async (req, res) => {
        const c = await campaigns.getCampaign(intParam(req.params.id));
        if (!c) return sendError(res, 'not_found');
        res.json({ campaign: c });
    }));

    r.put('/campaigns/:id', wrap(async (req, res) => {
        const id = intParam(req.params.id);
        const c = await campaigns.getCampaign(id);
        if (!c) return sendError(res, 'not_found');
        if (!['draft', 'scheduled'].includes(c.status)) return sendError(res, 'campaign_status_invalid');
        const v = campaigns.validateCampaign(req.body);
        if (v.error) return sendError(res, v.error);
        res.json({ ok: true, campaign: await campaigns.updateCampaign(id, v) });
    }));

    r.post('/campaigns/:id/send', wrap(async (req, res) => {
        const id = intParam(req.params.id);
        const c = await campaigns.getCampaign(id);
        if (!c) return sendError(res, 'not_found');
        if (!['draft', 'scheduled'].includes(c.status)) return sendError(res, 'campaign_status_invalid');
        campaigns.sendCampaign(id).catch((e) => console.error('[notify] campaign send error:', e));
        res.json({ ok: true, campaign: { ...c, status: 'sending' } });
    }));

    r.post('/campaigns/:id/cancel', wrap(async (req, res) => {
        const r2 = await campaigns.cancelCampaign(intParam(req.params.id));
        if (r2.error) return sendError(res, r2.error);
        res.json({ ok: true, campaign: await campaigns.getCampaign(intParam(req.params.id)) });
    }));

    r.delete('/campaigns/:id', wrap(async (req, res) => {
        const ok = await campaigns.deleteCampaign(intParam(req.params.id));
        if (!ok) return sendError(res, 'campaign_status_invalid');
        res.json({ ok: true });
    }));

    // Напоминания (правила)
    r.get('/reminders', wrap(async (req, res) => { res.json({ rules: await reminders.listRules() }); }));

    r.post('/reminders/preview', (req, res) => {
        const v = reminders.validateRule({ name: 'preview', event: 'departure', offsetValue: 1, ...(req.body || {}) });
        if (v.error) return sendError(res, v.error);
        res.json({ preview: reminders.previewRule(v) });
    });

    r.post('/reminders', wrap(async (req, res) => {
        const v = reminders.validateRule(req.body);
        if (v.error) return sendError(res, v.error);
        res.json({ ok: true, rule: await reminders.createRule(v, staffName(req.auth)) });
    }));

    r.get('/reminders/:id', wrap(async (req, res) => {
        const rule = await reminders.getRule(intParam(req.params.id));
        if (!rule) return sendError(res, 'not_found');
        res.json({ rule });
    }));

    r.put('/reminders/:id', wrap(async (req, res) => {
        const id = intParam(req.params.id);
        if (!(await reminders.getRule(id))) return sendError(res, 'not_found');
        const v = reminders.validateRule(req.body);
        if (v.error) return sendError(res, v.error);
        res.json({ ok: true, rule: await reminders.updateRule(id, v) });
    }));

    r.post('/reminders/:id/toggle', wrap(async (req, res) => {
        const id = intParam(req.params.id);
        const rule = await reminders.getRule(id);
        if (!rule) return sendError(res, 'not_found');
        const enabled = typeof (req.body || {}).enabled === 'boolean' ? req.body.enabled : !rule.enabled;
        res.json({ ok: true, rule: await reminders.setEnabled(id, enabled) });
    }));

    r.post('/reminders/:id/test', wrap(async (req, res) => {
        const id = intParam(req.params.id);
        if (!(await reminders.getRule(id))) return sendError(res, 'not_found');
        const userId = await resolveTestUser(req);
        if (!userId) return sendError(res, 'user_not_found', { hint: 'Укажите userId, loyaltyId или email пользователя' });
        const r2 = await reminders.testRule(id, userId);
        if (r2.error) return sendError(res, r2.error);
        res.json({ ok: true, userId, ...r2 });
    }));

    r.post('/reminders/run', wrap(async (req, res) => { res.json({ ok: true, ...(await reminders.runReminders()) }); }));

    r.delete('/reminders/:id', wrap(async (req, res) => {
        const ok = await reminders.deleteRule(intParam(req.params.id));
        if (!ok) return sendError(res, 'not_found');
        res.json({ ok: true });
    }));

    return r;
}

// ---------------------------------------------------------------------------
// Внутренний API (totus_API → хаб)
// ---------------------------------------------------------------------------
function internalKeyOk(req) {
    const expected = env('INTERNAL_API_KEY');
    if (!expected) return false;
    const got = String(req.headers['x-internal-key'] || '');
    if (!got || got.length !== expected.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected)); } catch (e) { return false; }
}

function internalRouter() {
    const r = express.Router();
    r.use((req, res, next) => {
        if (!env('INTERNAL_API_KEY')) return res.status(503).json({ error: 'internal_key_not_configured' });
        if (!internalKeyOk(req)) return res.status(401).json({ error: 'unauthorized' });
        next();
    });
    r.use(readyGuard);

    r.get('/health', (req, res) => res.json({ ok: true, fcm: fcm.isEnabled(), webpush: webpush.isEnabled(), quietNow: service.isQuietNow() }));

    // Одно уведомление или массив (до 100) — { userId | userIds | loyaltyId, type, title?, body, data?, channels?, collapseKey?, respectQuietHours?, skipIfOnline? }
    r.post('/notify', wrap(async (req, res) => {
        const body = req.body;
        const list = Array.isArray(body) ? body.slice(0, 100) : [body];
        const results = [];
        for (const item of list) {
            const v = service.validateNotify(item);
            if (v.error) { results.push({ ok: false, error: v.error }); continue; }
            results.push(await service.notify({ ...item, source: item && item.source ? String(item.source).slice(0, 64) : 'totus_api' }));
        }
        if (!Array.isArray(body)) {
            const one = results[0];
            if (!one.ok) return sendError(res, one.error);
            return res.json(one);
        }
        res.json({ ok: true, results });
    }));

    return r;
}

// ---------------------------------------------------------------------------
// Сборка и handler для POLICY
// ---------------------------------------------------------------------------
let routerInstance = null;

function buildRouter() {
    const router = express.Router();
    router.get('/api/push/vapid-public-key', (req, res) => {
        const key = webpush.publicKey();
        if (!key) return res.status(404).json({ error: 'webpush_disabled' });
        res.json({ publicKey: key });
    });
    router.use('/api/push', staffRouter());
    router.use('/api', userRouter());
    router.use('/internal', internalRouter());
    return router;
}

function httpHandler(req, res) {
    if (!routerInstance) routerInstance = buildRouter();
    routerInstance(req, res, (err) => {
        if (err) {
            console.error('[notify] router error:', err);
            if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
            return;
        }
        if (!res.headersSent) res.status(404).json({ error: 'not_found' });
    });
}

module.exports = { httpHandler, buildRouter, internalKeyOk, sendError, _STAFF_RE: STAFF_RE };
