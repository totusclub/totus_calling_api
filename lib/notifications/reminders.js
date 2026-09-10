'use strict';

/**
 * Динамические напоминания о поездке — правила из Totus_admin (таблица push_reminder_rules)
 * и движок, который раз в REMINDER_INTERVAL проходит по заказам и отправляет через notify().
 * Отправленное фиксируется в push_reminder_log (rule_id + order_id) — повторов не бывает.
 *
 * Правило: событие (departure — вылет / checkin — заезд / trip_end — окончание / order_created — создание заказа),
 * смещение N часов/дней до/после, время отправки (МСК, для смещения в днях), поведение в тихие часы
 * (shift — перенести пуш на утро, skip — не отправлять, send — отправить), тип уведомления, заголовок,
 * текст с переменными {имя} {номер} {город} {страна} {отель} {дата_вылета} {время_вылета} {аэропорт} {ночей},
 * каналы (push / inapp; email — записывается, письма шлёт totus_API), аудитория (paid — оплаченные заказы / all).
 *
 * Факты о заказе берутся из orders.package (JSON заказа Level.Travel) — см. orderFacts(); поля, которых нет,
 * подставляются пустыми.
 */

const service = require('./service');
const { TYPES, TITLE_MAX, BODY_MAX } = require('./types');

const EVENTS = ['departure', 'checkin', 'trip_end', 'order_created'];
const UNITS = ['hours', 'days'];
const DIRECTIONS = ['before', 'after'];
const QUIET = ['shift', 'skip', 'send'];
const AUDIENCES = ['paid', 'all'];
const FIRE_WINDOW_MS = 24 * 3600 * 1000;   // если момент отправки пропущен больше чем на сутки — не шлём
const MSK_OFFSET_MS = 3 * 3600 * 1000;
const DEFAULT_SEND_TIME = '10:00';
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function pool() { return service.getPool(); }

function parseJson(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// Факты о заказе из JSON Level.Travel
// ---------------------------------------------------------------------------
function pick(obj, paths) {
    for (const p of paths) {
        let cur = obj;
        for (const k of p.split('.')) { cur = cur && typeof cur === 'object' ? cur[k] : undefined; if (cur === undefined) break; }
        if (cur !== undefined && cur !== null && cur !== '') return cur;
    }
    return null;
}

/** 'YYYY-MM-DD' | 'DD.MM.YYYY' | ISO → Date (полночь МСК) или null */
function parseDate(v) {
    if (!v) return null;
    const s = String(v).trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) - MSK_OFFSET_MS);
    m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(s);
    if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]) - MSK_OFFSET_MS);
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
}

function parseTime(v) {
    const m = /(\d{1,2}):(\d{2})/.exec(String(v || ''));
    return m ? { h: +m[1], m: +m[2] } : null;
}

/** Факты для шаблонов и расчёта событий. pkg — orders.package (объект). */
function orderFacts(pkg, row) {
    const p = pkg && typeof pkg === 'object' ? pkg : {};
    const startRaw = pick(p, ['start_date', 'date_start', 'departure_date', 'tour.start_date', 'package.start_date', 'hotel.check_in', 'check_in']);
    const endRaw = pick(p, ['end_date', 'date_end', 'return_date', 'tour.end_date', 'package.end_date', 'hotel.check_out', 'check_out']);
    const nights = Number(pick(p, ['nights', 'tour.nights', 'package.nights', 'hotel.nights'])) || null;
    const start = parseDate(startRaw);
    let end = parseDate(endRaw);
    if (!end && start && nights) end = new Date(start.getTime() + nights * 86400000);
    const depTimeRaw = pick(p, ['flights.to.departure_time', 'flights.to.departure', 'flight.departure_time', 'flight_to.departure_time', 'departure_time', 'flights.0.departure_time', 'flights.0.departure']);
    const depTime = parseTime(depTimeRaw && String(depTimeRaw).length > 8 && /\d{2}:\d{2}/.test(depTimeRaw) ? String(depTimeRaw).match(/\d{2}:\d{2}/)[0] : depTimeRaw);
    const departure = start && depTime ? new Date(start.getTime() + (depTime.h * 60 + depTime.m) * 60000) : start;
    return {
        orderId: row ? String(row.order_id || '') : '',
        start,
        end,
        departure,
        departureTime: depTime ? `${String(depTime.h).padStart(2, '0')}:${String(depTime.m).padStart(2, '0')}` : '',
        nights: nights || '',
        hotel: String(pick(p, ['hotel.name', 'hotel_name', 'hotel.title', 'tour.hotel.name']) || ''),
        city: String(pick(p, ['hotel.city', 'city', 'resort', 'hotel.resort', 'to_city', 'tour.city']) || ''),
        country: String(pick(p, ['hotel.country', 'country', 'to_country', 'tour.country', 'country_name']) || ''),
        airport: String(pick(p, ['flights.to.departure_airport', 'flights.to.from_airport', 'flight.departure_airport', 'from_airport', 'departure_airport']) || ''),
        created: row && row.created_at ? new Date(row.created_at) : null,
        paid: row ? String(row.pay_status || '').toUpperCase() === 'RECONCILED' : false,
        state: row ? String(row.order_state || '') : '',
    };
}

function formatDate(d) {
    if (!d) return '';
    const msk = new Date(d.getTime() + MSK_OFFSET_MS);
    return `${msk.getUTCDate()} ${MONTHS[msk.getUTCMonth()]}`;
}

function render(template, facts, user) {
    const name = user ? String(user.f_name || user.name || '').trim() : '';
    const vars = {
        'имя': name,
        'номер': facts.orderId || '',
        'город': facts.city || '',
        'страна': facts.country || '',
        'отель': facts.hotel || '',
        'дата_вылета': formatDate(facts.departure || facts.start),
        'время_вылета': facts.departureTime || '',
        'аэропорт': facts.airport || '',
        'ночей': facts.nights ? String(facts.nights) : '',
        'дата_окончания': formatDate(facts.end),
    };
    return String(template || '')
        .replace(/\{([а-яёa-z_]+)\}/gi, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k.toLowerCase()) ? vars[k.toLowerCase()] : m))
        .replace(/,\s*(?=[,.!?])/g, '')      // «Привет, {имя}!» без имени → «Привет!»
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+([,.!?])/g, '$1')
        .trim();
}

/** Момент события по правилу. */
function eventTime(rule, facts) {
    switch (rule.event) {
        case 'departure': return facts.departure || facts.start;
        case 'checkin': return facts.start;
        case 'trip_end': return facts.end;
        case 'order_created': return facts.created;
        default: return null;
    }
}

/** Момент отправки для правила и заказа (Date UTC) или null. */
function triggerTime(rule, facts) {
    const ev = eventTime(rule, facts);
    if (!ev) return null;
    const sign = rule.offsetDirection === 'after' ? 1 : -1;
    const ms = rule.offsetUnit === 'days' ? rule.offsetValue * 86400000 : rule.offsetValue * 3600000;
    let t = new Date(ev.getTime() + sign * ms);
    if (rule.offsetUnit === 'days') {
        const st = parseTime(rule.sendTime || DEFAULT_SEND_TIME) || parseTime(DEFAULT_SEND_TIME);
        const msk = new Date(t.getTime() + MSK_OFFSET_MS);
        t = new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate(), st.h, st.m) - MSK_OFFSET_MS);
    }
    return t;
}

// ---------------------------------------------------------------------------
// Правила: валидация и CRUD
// ---------------------------------------------------------------------------
function validateRule(body) {
    const b = body || {};
    const name = service._internal.cleanText(b.name, 120);
    if (!name) return { error: 'name_required' };
    const event = EVENTS.includes(b.event) ? b.event : null;
    if (!event) return { error: 'event_invalid' };
    const offsetValue = Number(b.offsetValue);
    if (!Number.isInteger(offsetValue) || offsetValue < 0 || offsetValue > 365) return { error: 'offset_invalid' };
    const offsetUnit = UNITS.includes(b.offsetUnit) ? b.offsetUnit : 'days';
    const offsetDirection = DIRECTIONS.includes(b.offsetDirection) ? b.offsetDirection : 'before';
    let sendTime = null;
    if (b.sendTime) {
        const t = parseTime(b.sendTime);
        if (!t || t.h > 23 || t.m > 59) return { error: 'send_time_invalid' };
        sendTime = `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;
    }
    const quietBehavior = QUIET.includes(b.quietBehavior) ? b.quietBehavior : 'shift';
    const type = TYPES[b.type] ? b.type : 'trip_reminder';
    const title = service._internal.cleanText(b.title, TITLE_MAX);
    const text = service._internal.cleanText(b.body, BODY_MAX);
    if (!title) return { error: 'title_required' };
    if (!text) return { error: 'body_required' };
    const ch = b.channels && typeof b.channels === 'object' ? b.channels : {};
    const channels = { push: ch.push !== false, inapp: ch.inapp !== false, email: ch.email === true };
    const audience = AUDIENCES.includes(b.audience) ? b.audience : 'paid';
    return {
        name, event, offsetValue, offsetUnit, offsetDirection, sendTime, quietBehavior, type, title, body: text, channels, audience,
        enabled: b.enabled !== false,
    };
}

function serializeRule(row) {
    return {
        id: Number(row.id),
        name: row.name,
        enabled: Number(row.enabled) === 1,
        event: row.event,
        offsetValue: Number(row.offset_value),
        offsetUnit: row.offset_unit,
        offsetDirection: row.offset_direction,
        sendTime: row.send_time || null,
        quietBehavior: row.quiet_behavior,
        type: row.type,
        title: row.title,
        body: row.body,
        channels: parseJson(row.channels) || { push: true, inapp: true, email: false },
        audience: row.audience,
        sentCount: Number(row.sent_count || 0),
        openedCount: Number(row.opened_count || 0),
        lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
        lastSentAt: row.last_sent_at ? new Date(row.last_sent_at).toISOString() : null,
        createdBy: row.created_by || null,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
}

const RULE_SELECT = `SELECT r.*, (SELECT COUNT(*) FROM notifications n WHERE n.rule_id = r.id AND n.opened_at IS NOT NULL) AS opened_count FROM push_reminder_rules r`;

async function listRules() {
    const [rows] = await pool().query(`${RULE_SELECT} ORDER BY r.id`);
    return rows.map(serializeRule);
}

async function getRule(id) {
    const [rows] = await pool().query(`${RULE_SELECT} WHERE r.id = ? LIMIT 1`, [id]);
    return rows.length ? serializeRule(rows[0]) : null;
}

async function createRule(v, staffName) {
    const [r] = await pool().query(
        `INSERT INTO push_reminder_rules (name, enabled, event, offset_value, offset_unit, offset_direction, send_time, quiet_behavior, type, title, body, channels, audience, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [v.name, v.enabled ? 1 : 0, v.event, v.offsetValue, v.offsetUnit, v.offsetDirection, v.sendTime, v.quietBehavior, v.type, v.title, v.body, JSON.stringify(v.channels), v.audience, staffName || null],
    );
    return getRule(r.insertId);
}

async function updateRule(id, v) {
    await pool().query(
        `UPDATE push_reminder_rules SET name = ?, enabled = ?, event = ?, offset_value = ?, offset_unit = ?, offset_direction = ?, send_time = ?,
            quiet_behavior = ?, type = ?, title = ?, body = ?, channels = ?, audience = ? WHERE id = ?`,
        [v.name, v.enabled ? 1 : 0, v.event, v.offsetValue, v.offsetUnit, v.offsetDirection, v.sendTime, v.quietBehavior, v.type, v.title, v.body, JSON.stringify(v.channels), v.audience, id],
    );
    return getRule(id);
}

async function setEnabled(id, enabled) {
    await pool().query('UPDATE push_reminder_rules SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
    return getRule(id);
}

async function deleteRule(id) {
    const [r] = await pool().query('DELETE FROM push_reminder_rules WHERE id = ?', [id]);
    return r.affectedRows > 0;
}

// ---------------------------------------------------------------------------
// Движок
// ---------------------------------------------------------------------------
let ordersColumnsWarned = false;

async function loadOrders() {
    // created_at может отсутствовать в orders — тогда событие order_created недоступно
    try {
        const [rows] = await pool().query('SELECT order_id, user_id, package, pay_status, order_state, created_at FROM orders WHERE user_id IS NOT NULL AND user_id > 0 AND package IS NOT NULL');
        return rows;
    } catch (e) {
        if (!ordersColumnsWarned) { ordersColumnsWarned = true; console.warn('[notify] reminders: orders.created_at unavailable, retrying without it:', e.message); }
        const [rows] = await pool().query('SELECT order_id, user_id, package, pay_status, order_state FROM orders WHERE user_id IS NOT NULL AND user_id > 0 AND package IS NOT NULL');
        return rows;
    }
}

async function alreadySent(ruleId, orderIds) {
    if (!orderIds.length) return new Set();
    const [rows] = await pool().query('SELECT order_id FROM push_reminder_log WHERE rule_id = ? AND order_id IN (?)', [ruleId, orderIds]);
    return new Set(rows.map((r) => String(r.order_id)));
}

function isCancelled(facts) {
    return /cancel|отмен|refund/i.test(facts.state);
}

async function sendForOrder(rule, order, facts, user, opts = {}) {
    const title = render(rule.title, facts, user);
    const body = render(rule.body, facts, user);
    const respectQuietHours = rule.quietBehavior === 'shift';
    return service.notify({
        userId: Number(order.user_id),
        type: rule.type,
        title,
        body,
        data: { orderId: facts.orderId, ruleId: String(rule.id), event: rule.event },
        source: `reminder:${rule.id}`,
        ruleId: rule.id,
        channels: { push: rule.channels.push !== false, inapp: rule.channels.inapp !== false },
        collapseKey: `reminder_${rule.id}_${facts.orderId}`,
        respectQuietHours,
        ttlSeconds: 12 * 3600,
        ...opts,
    });
}

/** Один проход движка. Возвращает { rules, checked, sent, skipped }. */
async function runReminders(now = new Date()) {
    if (!(await service.isReady())) return { rules: 0, checked: 0, sent: 0, skipped: 0 };
    const rules = (await listRules()).filter((r) => r.enabled);
    const out = { rules: rules.length, checked: 0, sent: 0, skipped: 0 };
    if (!rules.length) return out;
    const orders = await loadOrders();
    const quietNow = service.isQuietNow(now);
    const userCache = new Map();
    const getUser = async (id) => {
        if (!userCache.has(id)) {
            const [rows] = await pool().query('SELECT id, name, f_name FROM users WHERE id = ? LIMIT 1', [id]);
            userCache.set(id, rows[0] || null);
        }
        return userCache.get(id);
    };

    for (const rule of rules) {
        const due = [];
        for (const o of orders) {
            const pkg = parseJson(o.package);
            if (!pkg) continue;
            const facts = orderFacts(pkg, o);
            if (isCancelled(facts)) continue;
            if (rule.audience === 'paid' && !facts.paid) continue;
            const t = triggerTime(rule, facts);
            if (!t) continue;
            out.checked += 1;
            const delta = now.getTime() - t.getTime();
            if (delta < 0 || delta > FIRE_WINDOW_MS) continue;
            due.push({ o, facts });
        }
        if (!due.length) { await pool().query('UPDATE push_reminder_rules SET last_run_at = NOW() WHERE id = ?', [rule.id]); continue; }
        const sentSet = await alreadySent(rule.id, due.map((d) => d.facts.orderId));
        let sentHere = 0;
        for (const { o, facts } of due) {
            if (sentSet.has(facts.orderId)) continue;
            if (quietNow && rule.quietBehavior === 'skip') {
                await pool().query('INSERT IGNORE INTO push_reminder_log (rule_id, order_id, user_id, status) VALUES (?, ?, ?, ?)', [rule.id, facts.orderId, o.user_id, 'skipped_quiet']);
                out.skipped += 1;
                continue;
            }
            const user = await getUser(Number(o.user_id));
            const r = await sendForOrder(rule, o, facts, user);
            await pool().query(
                'INSERT IGNORE INTO push_reminder_log (rule_id, order_id, user_id, status, notification_id) VALUES (?, ?, ?, ?, ?)',
                [rule.id, facts.orderId, o.user_id, r.ok ? (r.recipients ? 'sent' : 'skipped_prefs') : 'failed', r.ok && r.ids ? r.ids[0] : null],
            );
            if (r.ok && r.recipients) { sentHere += 1; out.sent += 1; } else out.skipped += 1;
        }
        await pool().query('UPDATE push_reminder_rules SET last_run_at = NOW(), sent_count = sent_count + ?, last_sent_at = IF(? > 0, NOW(), last_sent_at) WHERE id = ?', [sentHere, sentHere, rule.id]);
    }
    if (out.sent || out.skipped) console.log(`[notify] reminders: rules=${out.rules} sent=${out.sent} skipped=${out.skipped}`);
    return out;
}

/** Тест правила: отправить себе (userId) по его последнему заказу или по примерным данным. */
async function testRule(ruleOrId, userId) {
    const rule = typeof ruleOrId === 'object' ? ruleOrId : await getRule(ruleOrId);
    if (!rule) return { error: 'not_found' };
    let order = null;
    try {
        const [rows] = await pool().query('SELECT order_id, user_id, package, pay_status, order_state FROM orders WHERE user_id = ? ORDER BY order_id DESC LIMIT 1', [userId]);
        order = rows[0] || null;
    } catch (e) { order = null; }
    const facts = order ? orderFacts(parseJson(order.package), order) : {
        orderId: '48213', start: new Date(Date.now() + 86400000), end: new Date(Date.now() + 8 * 86400000), departure: new Date(Date.now() + 86400000),
        departureTime: '07:40', nights: 7, hotel: 'Rixos Premium', city: 'Хургада', country: 'Египет', airport: 'Шереметьево', created: new Date(), paid: true, state: '',
    };
    const [urows] = await pool().query('SELECT id, name, f_name FROM users WHERE id = ? LIMIT 1', [userId]);
    const r = await sendForOrder(rule, { user_id: userId }, facts, urows[0] || null, { source: `reminder_test:${rule.id}`, ruleId: null, respectQuietHours: false });
    return r.ok ? { ok: true, preview: { title: render(rule.title, facts, urows[0]), body: render(rule.body, facts, urows[0]) }, result: r } : r;
}

/** Предпросмотр текста (без отправки). */
function previewRule(v, sample) {
    const facts = sample || {
        orderId: '48213', start: new Date(Date.now() + 86400000), end: new Date(Date.now() + 8 * 86400000), departure: new Date(Date.now() + 86400000),
        departureTime: '07:40', nights: 7, hotel: 'Rixos Premium', city: 'Хургада', country: 'Египет', airport: 'Шереметьево', created: new Date(), paid: true, state: '',
    };
    return { title: render(v.title, facts, { f_name: 'Иван' }), body: render(v.body, facts, { f_name: 'Иван' }) };
}

module.exports = {
    EVENTS, UNITS, DIRECTIONS, QUIET, AUDIENCES,
    orderFacts, render, triggerTime, eventTime, parseDate, formatDate,
    validateRule, serializeRule, listRules, getRule, createRule, updateRule, setEnabled, deleteRule,
    runReminders, testRule, previewRule,
};
