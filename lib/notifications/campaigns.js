'use strict';

/**
 * Рассылки из Totus_admin (таблица push_campaigns) и история/статистика для раздела «Уведомления».
 * Сегменты аудитории (segment JSON):
 *   { platforms: ['ios','android','web','desktop'], hasOrders: true, departureFrom: 'YYYY-MM-DD',
 *     departureTo: 'YYYY-MM-DD', userIds: [..] }   — пусто = все пользователи.
 * Маркетинг (type=promo) уходит только opt-in пользователям (notify() фильтрует по prefs.promo)
 * и с учётом тихих часов (respect_quiet → перенос на 09:00 МСК).
 */

const service = require('./service');
const { TYPES, categoryOf, TITLE_MAX, BODY_MAX } = require('./types');

const STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'];
const CAMPAIGN_TYPES = ['promo', 'system'];
const SEND_CHUNK = 1000;
const LIST_MAX = 100;

// Дата вылета/заезда из JSON заказа Level.Travel (orders.package). Если в БД появится отдельная
// колонка — поменять здесь и в reminders.js (orderFacts).
const DEPARTURE_SQL = "JSON_UNQUOTE(JSON_EXTRACT(o.package, '$.start_date'))";

function pool() { return service.getPool(); }

function parseJson(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (e) { return null; }
}

function isoDate(v) {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/** Нормализация сегмента; { error } при мусоре. */
function normalizeSegment(input) {
    const s = input && typeof input === 'object' ? input : {};
    const out = {};
    if (Array.isArray(s.platforms)) {
        const p = s.platforms.map((x) => String(x).toLowerCase()).filter((x) => ['ios', 'android', 'web', 'desktop'].includes(x));
        if (p.length) out.platforms = [...new Set(p)];
    }
    if (s.hasOrders === true) out.hasOrders = true;
    if (s.departureFrom !== undefined && s.departureFrom !== null && s.departureFrom !== '') {
        const d = isoDate(s.departureFrom);
        if (!d) return { error: 'segment_departure_invalid' };
        out.departureFrom = d;
    }
    if (s.departureTo !== undefined && s.departureTo !== null && s.departureTo !== '') {
        const d = isoDate(s.departureTo);
        if (!d) return { error: 'segment_departure_invalid' };
        out.departureTo = d;
    }
    if (Array.isArray(s.userIds)) {
        const ids = [...new Set(s.userIds.map(Number).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 5000);
        if (ids.length) out.userIds = ids;
    }
    return { segment: out };
}

/** SQL для выборки пользователей сегмента. Возвращает { sql, args } — только id. */
function segmentQuery(segment, category) {
    const where = ['u.id IS NOT NULL'];
    const args = [];
    if (segment.userIds) { where.push('u.id IN (?)'); args.push(segment.userIds); }
    if (segment.platforms) { where.push('EXISTS (SELECT 1 FROM push_devices d WHERE d.user_id = u.id AND d.enabled = 1 AND d.platform IN (?))'); args.push(segment.platforms); }
    if (segment.hasOrders) where.push('EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)');
    if (segment.departureFrom || segment.departureTo) {
        const parts = [];
        if (segment.departureFrom) { parts.push(`${DEPARTURE_SQL} >= ?`); args.push(segment.departureFrom); }
        if (segment.departureTo) { parts.push(`${DEPARTURE_SQL} <= ?`); args.push(segment.departureTo); }
        where.push(`EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND JSON_VALID(o.package) AND ${parts.join(' AND ')})`);
    }
    // opt-in для необязательных категорий (promo/reminders/support): нет строки настроек → значение по умолчанию
    if (category === 'promo') {
        where.push("EXISTS (SELECT 1 FROM notification_settings s WHERE s.user_id = u.id AND JSON_EXTRACT(s.prefs, '$.promo') = true)");
    } else if (category && category !== 'orders' && category !== 'documents' && category !== 'system') {
        where.push(`NOT EXISTS (SELECT 1 FROM notification_settings s WHERE s.user_id = u.id AND JSON_EXTRACT(s.prefs, '$.${category}') = false)`);
    }
    return { sql: `FROM users u WHERE ${where.join(' AND ')}`, args };
}

/** Подсчёт аудитории: пользователей и активных устройств. */
async function countAudience(segment, category) {
    const q = segmentQuery(segment, category);
    const [[u]] = await pool().query(`SELECT COUNT(*) AS n ${q.sql}`, q.args);
    const [[d]] = await pool().query(`SELECT COUNT(*) AS n FROM push_devices pd WHERE pd.enabled = 1 AND pd.user_id IN (SELECT u.id ${q.sql})`, q.args);
    return { users: Number(u.n || 0), devices: Number(d.n || 0) };
}

async function audienceIds(segment, category) {
    const q = segmentQuery(segment, category);
    const [rows] = await pool().query(`SELECT u.id ${q.sql} ORDER BY u.id`, q.args);
    return rows.map((r) => Number(r.id));
}

function serializeCampaign(row) {
    return {
        id: Number(row.id),
        title: row.title,
        body: row.body,
        type: row.type,
        data: parseJson(row.data) || {},
        segment: parseJson(row.segment) || {},
        status: row.status,
        respectQuietHours: Number(row.respect_quiet) === 1,
        scheduledAt: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
        audienceCount: Number(row.audience_count || 0),
        deviceCount: Number(row.device_count || 0),
        sentCount: Number(row.sent_count || 0),
        failedCount: Number(row.failed_count || 0),
        openedCount: Number(row.opened_count || 0),
        inappCount: Number(row.inapp_count || 0),
        error: row.error || null,
        staff: { id: row.staff_id === null ? null : Number(row.staff_id), name: row.staff_name || null },
        startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
        finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
}

const CAMPAIGN_SELECT = `SELECT c.*,
    (SELECT COUNT(*) FROM notifications n WHERE n.campaign_id = c.id AND n.opened_at IS NOT NULL) AS opened_count,
    (SELECT COUNT(*) FROM notifications n WHERE n.campaign_id = c.id) AS inapp_count
    FROM push_campaigns c`;

async function getCampaign(id) {
    const [rows] = await pool().query(`${CAMPAIGN_SELECT} WHERE c.id = ? LIMIT 1`, [id]);
    return rows.length ? serializeCampaign(rows[0]) : null;
}

async function listCampaigns(opts = {}) {
    let limit = Number(opts.limit) || 20;
    if (limit > LIST_MAX) limit = LIST_MAX;
    const where = [];
    const args = [];
    if (opts.before) { where.push('c.id < ?'); args.push(Number(opts.before)); }
    if (opts.status && STATUSES.includes(opts.status)) { where.push('c.status = ?'); args.push(opts.status); }
    const [rows] = await pool().query(
        `${CAMPAIGN_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.id DESC LIMIT ?`,
        [...args, limit + 1],
    );
    return { items: rows.slice(0, limit).map(serializeCampaign), hasMore: rows.length > limit };
}

/** Валидация тела рассылки. */
function validateCampaign(body) {
    const b = body || {};
    const type = CAMPAIGN_TYPES.includes(b.type) ? b.type : 'promo';
    const title = service._internal.cleanText(b.title, TITLE_MAX);
    const text = service._internal.cleanText(b.body, BODY_MAX);
    if (!title) return { error: 'title_required' };
    if (!text) return { error: 'body_required' };
    const seg = normalizeSegment(b.segment);
    if (seg.error) return { error: seg.error };
    let scheduledAt = null;
    if (b.scheduledAt) {
        const d = new Date(b.scheduledAt);
        if (Number.isNaN(d.getTime())) return { error: 'scheduled_at_invalid' };
        scheduledAt = d;
    }
    return {
        type,
        title,
        body: text,
        data: service.sanitizeData(b.data, type),
        segment: seg.segment,
        respectQuietHours: b.respectQuietHours !== false,
        scheduledAt,
    };
}

async function createCampaign(staff, v, status) {
    const [r] = await pool().query(
        `INSERT INTO push_campaigns (staff_id, staff_name, title, body, type, data, segment, respect_quiet, scheduled_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [staff.id, staff.name, v.title, v.body, v.type, JSON.stringify(v.data), JSON.stringify(v.segment), v.respectQuietHours ? 1 : 0, v.scheduledAt, status],
    );
    return getCampaign(r.insertId);
}

async function updateCampaign(id, v) {
    // Дата в будущем → запланирована (таймер runScheduled отправит), без даты → черновик
    const status = v.scheduledAt && v.scheduledAt.getTime() > Date.now() ? 'scheduled' : 'draft';
    await pool().query(
        `UPDATE push_campaigns SET title = ?, body = ?, type = ?, data = ?, segment = ?, respect_quiet = ?, scheduled_at = ?, status = ?
         WHERE id = ? AND status IN ('draft','scheduled')`,
        [v.title, v.body, v.type, JSON.stringify(v.data), JSON.stringify(v.segment), v.respectQuietHours ? 1 : 0, v.scheduledAt, status, id],
    );
    return getCampaign(id);
}

async function setStatus(id, status, extra = {}) {
    const sets = ['status = ?'];
    const args = [status];
    for (const [k, val] of Object.entries(extra)) { sets.push(`${k} = ?`); args.push(val); }
    args.push(id);
    await pool().query(`UPDATE push_campaigns SET ${sets.join(', ')} WHERE id = ?`, args);
}

const running = new Set();

/** Отправка кампании (асинхронно; статусы sending → sent/failed). */
async function sendCampaign(id) {
    if (running.has(id)) return { error: 'already_sending' };
    const c = await getCampaign(id);
    if (!c) return { error: 'not_found' };
    if (!['draft', 'scheduled'].includes(c.status)) return { error: 'campaign_status_invalid' };
    running.add(id);
    const category = categoryOf(c.type);
    try {
        const ids = await audienceIds(c.segment, category);
        const counts = await countAudience(c.segment, category);
        await setStatus(id, 'sending', { started_at: new Date(), audience_count: counts.users, device_count: counts.devices, sent_count: 0, failed_count: 0, error: null });
        let sent = 0;
        let failed = 0;
        let deferred = 0;
        for (let i = 0; i < ids.length; i += SEND_CHUNK) {
            const chunk = ids.slice(i, i + SEND_CHUNK);
            const r = await service.notify({
                userIds: chunk,
                type: c.type,
                title: c.title,
                body: c.body,
                data: { ...c.data, campaignId: String(id) },
                source: `campaign:${id}`,
                campaignId: id,
                collapseKey: `campaign_${id}`,
                respectQuietHours: c.respectQuietHours,
                ttlSeconds: 12 * 3600,
            });
            if (!r.ok) throw new Error(r.error);
            sent += r.push.sent || 0;
            failed += (r.push.failed || 0) + (r.push.dead || 0);
            deferred += r.deferred || 0;
            await setStatus(id, 'sending', { sent_count: sent, failed_count: failed });
        }
        await setStatus(id, 'sent', { finished_at: new Date(), sent_count: sent, failed_count: failed, error: deferred ? `deferred:${deferred}` : null });
        console.log(`[notify] campaign #${id} sent: users=${ids.length} push=${sent} failed=${failed} deferred=${deferred}`);
        return { ok: true, users: ids.length, sent, failed, deferred };
    } catch (e) {
        console.error(`[notify] campaign #${id} failed:`, e.message);
        await setStatus(id, 'failed', { finished_at: new Date(), error: String(e.message).slice(0, 255) });
        return { error: 'send_failed', message: e.message };
    } finally {
        running.delete(id);
    }
}

async function cancelCampaign(id) {
    const c = await getCampaign(id);
    if (!c) return { error: 'not_found' };
    if (!['draft', 'scheduled'].includes(c.status)) return { error: 'campaign_status_invalid' };
    await setStatus(id, 'cancelled');
    return { ok: true };
}

async function deleteCampaign(id) {
    const [r] = await pool().query("DELETE FROM push_campaigns WHERE id = ? AND status IN ('draft','cancelled','failed')", [id]);
    return r.affectedRows > 0;
}

/** Таймер: отправить запланированные, у которых пришло время. */
async function runScheduled() {
    const [rows] = await pool().query("SELECT id FROM push_campaigns WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW() ORDER BY id LIMIT 5");
    for (const r of rows) await sendCampaign(Number(r.id));
    return rows.length;
}

// ---------------------------------------------------------------------------
// История и сводка (staff)
// ---------------------------------------------------------------------------
function periodWhere(opts, col, where, args) {
    if (opts.from) { const d = new Date(opts.from); if (!Number.isNaN(d.getTime())) { where.push(`${col} >= ?`); args.push(d); } }
    if (opts.to) { const d = new Date(opts.to); if (!Number.isNaN(d.getTime())) { where.push(`${col} <= ?`); args.push(d); } }
}

async function history(opts = {}) {
    let limit = Number(opts.limit) || 50;
    if (limit > LIST_MAX) limit = LIST_MAX;
    const where = ['1=1'];
    const args = [];
    if (opts.before) { where.push('n.id < ?'); args.push(Number(opts.before)); }
    if (opts.type && TYPES[opts.type]) { where.push('n.type = ?'); args.push(opts.type); }
    if (opts.category) { where.push('n.category = ?'); args.push(String(opts.category)); }
    if (opts.status) { where.push('n.push_status = ?'); args.push(String(opts.status)); }
    if (opts.userId) { where.push('n.user_id = ?'); args.push(Number(opts.userId)); }
    if (opts.campaignId) { where.push('n.campaign_id = ?'); args.push(Number(opts.campaignId)); }
    if (opts.ruleId) { where.push('n.rule_id = ?'); args.push(Number(opts.ruleId)); }
    if (opts.source) { where.push('n.source = ?'); args.push(String(opts.source)); }
    if (opts.q) {
        const q = `%${String(opts.q).trim().slice(0, 64)}%`;
        where.push('(n.title LIKE ? OR n.body LIKE ? OR u.email LIKE ? OR u.name LIKE ? OR u.f_name LIKE ? OR u.l_name LIKE ? OR u.loyalty_id LIKE ?)');
        args.push(q, q, q, q, q, q, q);
    }
    periodWhere(opts, 'n.created_at', where, args);
    const [rows] = await pool().query(
        `SELECT n.*, u.name AS u_name, u.f_name AS u_f_name, u.l_name AS u_l_name, u.email AS u_email, u.loyalty_id AS u_loyalty_id
         FROM notifications n LEFT JOIN users u ON u.id = n.user_id
         WHERE ${where.join(' AND ')} ORDER BY n.id DESC LIMIT ?`,
        [...args, limit + 1],
    );
    const items = rows.slice(0, limit).map((r) => ({
        ...service.serializeNotification(r),
        userId: Number(r.user_id),
        user: {
            name: [r.u_f_name || r.u_name, r.u_l_name].filter(Boolean).join(' ').trim() || r.u_name || r.u_email || `#${r.user_id}`,
            email: r.u_email || null,
            loyaltyId: r.u_loyalty_id || null,
        },
        campaignId: r.campaign_id === null ? null : Number(r.campaign_id),
        ruleId: r.rule_id === null ? null : Number(r.rule_id),
        pushStatus: r.push_status,
        pushSent: Number(r.push_sent || 0),
        pushFailed: Number(r.push_failed || 0),
        pushedAt: r.pushed_at ? new Date(r.pushed_at).toISOString() : null,
        deliverAfter: r.deliver_after ? new Date(r.deliver_after).toISOString() : null,
    }));
    return { items, hasMore: rows.length > limit };
}

async function stats(opts = {}) {
    const where = ['1=1'];
    const args = [];
    periodWhere(opts, 'created_at', where, args);
    if (!opts.from && !opts.to) { where.push('created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)'); }
    const [[row]] = await pool().query(
        `SELECT COUNT(*) AS total,
                SUM(inapp = 1) AS inapp,
                SUM(push_status = 'sent') AS push_sent,
                SUM(push_status = 'failed') AS push_failed,
                SUM(push_status = 'deferred') AS push_deferred,
                SUM(push_status = 'no_devices') AS no_devices,
                SUM(opened_at IS NOT NULL) AS opened,
                SUM(read_at IS NOT NULL) AS `read`,
                COALESCE(SUM(push_failed), 0) AS token_errors
         FROM notifications WHERE ${where.join(' AND ')}`,
        args,
    );
    const [[dev]] = await pool().query(
        `SELECT COUNT(*) AS total, SUM(enabled = 1) AS enabled,
                SUM(platform = 'ios' AND enabled = 1) AS ios, SUM(platform = 'android' AND enabled = 1) AS android,
                SUM(platform = 'web' AND enabled = 1) AS web, SUM(platform = 'desktop' AND enabled = 1) AS desktop
         FROM push_devices`,
    );
    const [byType] = await pool().query(
        `SELECT type, COUNT(*) AS n, SUM(push_status = 'sent') AS sent, SUM(opened_at IS NOT NULL) AS opened
         FROM notifications WHERE ${where.join(' AND ')} GROUP BY type ORDER BY n DESC`,
        args,
    );
    const num = (v) => Number(v || 0);
    return {
        period: { from: opts.from || null, to: opts.to || null },
        notifications: {
            total: num(row.total), inapp: num(row.inapp), pushSent: num(row.push_sent), pushFailed: num(row.push_failed),
            pushDeferred: num(row.push_deferred), noDevices: num(row.no_devices), opened: num(row.opened), read: num(row.read), tokenErrors: num(row.token_errors),
        },
        devices: { total: num(dev.total), enabled: num(dev.enabled), ios: num(dev.ios), android: num(dev.android), web: num(dev.web), desktop: num(dev.desktop) },
        byType: byType.map((t) => ({ type: t.type, count: num(t.n), sent: num(t.sent), opened: num(t.opened) })),
    };
}

module.exports = {
    STATUSES,
    CAMPAIGN_TYPES,
    DEPARTURE_SQL,
    normalizeSegment,
    segmentQuery,
    countAudience,
    audienceIds,
    validateCampaign,
    createCampaign,
    updateCampaign,
    getCampaign,
    listCampaigns,
    sendCampaign,
    cancelCampaign,
    deleteCampaign,
    runScheduled,
    history,
    stats,
    serializeCampaign,
};
