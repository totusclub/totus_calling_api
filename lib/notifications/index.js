'use strict';

/**
 * Хаб уведомлений calling_api_v2 — единая точка входа (план claude/PUSH_NOTIFICATIONS_PLAN_RU.md).
 *
 *   notify({ userId | userIds | loyaltyId, type, title?, body, data?, channels?, collapseKey?, respectQuietHours?, skipIfOnline? })
 *   attachSocket(socket)   — из socketGate: комната u:<userId>, события notify:*, отслеживание ответа на звонок
 *   httpHandler(req, res)  — из POLICY: /api/push*, /api/notifications*, /internal/*
 *   calls.onCallCreated / onCallAction — tap-функции POLICY для пропущенных звонков
 *   start()                — таймеры: отложенные пуши (тихие часы), запланированные рассылки, движок напоминаний
 *
 * Подключение только через middleware/auth.js — index.js не меняется.
 */

const service = require('./service');
const devices = require('./devices');
const campaigns = require('./campaigns');
const reminders = require('./reminders');
const calls = require('./calls');
const routes = require('./routes');
const fcm = require('./fcm');
const webpush = require('./webpush');
const types = require('./types');

const TICK_MS = 60 * 1000;
const REMINDER_EVERY_TICKS = 10; // движок напоминаний — раз в 10 минут
let timer = null;
let tick = 0;

function attachSocket(socket) {
    service.attachSocket(socket);
    calls.attachSocket(socket);
}

async function runTick() {
    tick += 1;
    if (!(await service.isReady())) return;
    try { await service.flushDeferred(); } catch (e) { console.warn('[notify] flushDeferred failed:', e.message); }
    try { await campaigns.runScheduled(); } catch (e) { console.warn('[notify] runScheduled failed:', e.message); }
    if (tick % REMINDER_EVERY_TICKS === 1) {
        try { await reminders.runReminders(); } catch (e) { console.warn('[notify] reminders failed:', e.message); }
    }
}

/** Запуск фоновых задач (вызывается из middleware/auth.js после старта). */
function start() {
    if (timer) return;
    setTimeout(() => { service.ensureReady().catch(() => {}); }, 3500).unref();
    timer = setInterval(() => { runTick().catch((e) => console.warn('[notify] tick failed:', e.message)); }, TICK_MS);
    if (timer.unref) timer.unref();
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = {
    notify: service.notify,
    attachSocket,
    httpHandler: routes.httpHandler,
    ensureReady: service.ensureReady,
    isReady: service.isReady,
    start,
    stop,
    runTick,
    calls,
    service,
    devices,
    campaigns,
    reminders,
    fcm,
    webpush,
    types,
};
