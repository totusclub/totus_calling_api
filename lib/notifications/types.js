'use strict';

/**
 * Реестр типов уведомлений хаба (план: claude/PUSH_NOTIFICATIONS_PLAN_RU.md §4,
 * дизайн: claude/NOTIFICATIONS_DESIGN_RU.md).
 *
 * category — ключ настройки пользователя (notification_settings.prefs) и фильтр-чип в центре уведомлений:
 *   orders     «Заказы и оплата»              — нельзя отключить
 *   documents  «Документы и статусы тура»     — нельзя отключить
 *   reminders  «Напоминания о поездке»        — по умолчанию вкл
 *   support    «Сообщения поддержки»          — по умолчанию вкл
 *   promo      «Акции и предложения»          — по умолчанию ВЫКЛ (opt-in), тихие часы
 *   system     «Важное»                       — нельзя отключить
 * androidChannel — id канала Android (создаёт приложение через notifee).
 * route — маршрут по умолчанию для тапа (клиенты читают data.route).
 */

const CATEGORIES = {
    orders: { title: 'Заказы и оплата', mandatory: true, default: true },
    documents: { title: 'Документы и статусы тура', mandatory: true, default: true },
    reminders: { title: 'Напоминания о поездке', mandatory: false, default: true },
    support: { title: 'Сообщения поддержки', mandatory: false, default: true },
    promo: { title: 'Акции и предложения', mandatory: false, default: false },
    system: { title: 'Важное', mandatory: true, default: true },
};

const TYPES = {
    order_created: { category: 'orders', androidChannel: 'orders', route: 'order', title: 'Заказ ожидает оплаты' },
    payment_success: { category: 'orders', androidChannel: 'orders', route: 'order', title: 'Оплата прошла' },
    payment_failed: { category: 'orders', androidChannel: 'orders', route: 'order', title: 'Оплата не прошла' },
    order_request_status: { category: 'orders', androidChannel: 'orders', route: 'order_request', title: 'Ответ по обращению' },
    order_confirmed: { category: 'documents', androidChannel: 'orders', route: 'order', title: 'Тур подтверждён' },
    order_status: { category: 'documents', androidChannel: 'orders', route: 'order', title: 'Статус заказа изменился' },
    order_cancelled: { category: 'documents', androidChannel: 'orders', route: 'order', title: 'Заказ отменён' },
    documents_ready: { category: 'documents', androidChannel: 'orders', route: 'documents', title: 'Документы готовы' },
    trip_reminder: { category: 'reminders', androidChannel: 'reminders', route: 'order', title: 'Напоминание о поездке' },
    support_message: { category: 'support', androidChannel: 'support_chat', route: 'support_chat', title: 'Поддержка Totus' },
    missed_call: { category: 'support', androidChannel: 'support_chat', route: 'account', title: 'Пропущенный звонок' },
    promo: { category: 'promo', androidChannel: 'promo', route: 'home', title: 'Totus Club' },
    system: { category: 'system', androidChannel: 'system', route: 'home', title: 'Totus Club' },
};

// Маршруты, которые понимают клиенты (deep link по data.route + data.orderId/chatId/url)
const ROUTES = ['home', 'order', 'orders', 'documents', 'order_request', 'support_chat', 'account', 'notifications', 'url', 'search'];

const PLATFORMS = ['ios', 'android', 'web', 'desktop'];
const CHANNELS = ['fcm', 'webpush'];

const TITLE_MAX = 160;
const BODY_MAX = 512;

function typeInfo(type) {
    return TYPES[type] || null;
}

function categoryOf(type) {
    const t = TYPES[type];
    return t ? t.category : 'system';
}

function defaultPrefs() {
    const out = {};
    for (const [k, v] of Object.entries(CATEGORIES)) out[k] = v.default;
    return out;
}

/** Нормализация prefs пользователя: обязательные категории всегда true, неизвестные ключи отбрасываются. */
function normalizePrefs(input) {
    const base = defaultPrefs();
    if (input && typeof input === 'object') {
        for (const k of Object.keys(CATEGORIES)) {
            if (typeof input[k] === 'boolean') base[k] = input[k];
        }
    }
    for (const [k, v] of Object.entries(CATEGORIES)) if (v.mandatory) base[k] = true;
    return base;
}

module.exports = { CATEGORIES, TYPES, ROUTES, PLATFORMS, CHANNELS, TITLE_MAX, BODY_MAX, typeInfo, categoryOf, defaultPrefs, normalizePrefs };
