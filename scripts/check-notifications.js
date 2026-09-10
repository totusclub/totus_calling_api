// Проверка хаба уведомлений без БД и сети: node scripts/check-notifications.js
// Валидация, настройки, тихие часы, шаблоны напоминаний, сегменты, политика доступа, трекер пропущенных звонков.
'use strict';
const assert = require('assert');
process.env.JWT_SECRET = 's1'; process.env.JWT_REFRESH_SECRET = 's2'; process.env.AUTH_MODE = 'log';
process.env.PUSH_QUIET_HOURS = '21:00-09:00';
process.env.INTERNAL_API_KEY = 'k-test-1234567890';

const hub = require('../lib/notifications');
const { service, devices, campaigns, reminders, calls, types, fcm, webpush } = hub;
const routes = require('../lib/notifications/routes');
const { findRule } = require('../middleware/auth');

// --- типы и настройки -------------------------------------------------------
assert.strictEqual(types.categoryOf('payment_success'), 'orders');
assert.strictEqual(types.categoryOf('support_message'), 'support');
assert.strictEqual(types.categoryOf('nope'), 'system');
const prefs = types.normalizePrefs({ orders: false, promo: true, reminders: false, junk: true });
assert.strictEqual(prefs.orders, true, 'orders обязательны');
assert.strictEqual(prefs.promo, true);
assert.strictEqual(prefs.reminders, false);
assert.strictEqual(prefs.junk, undefined);
assert.strictEqual(types.defaultPrefs().promo, false, 'promo — opt-in');

// --- validateNotify / sanitizeData -----------------------------------------
assert.deepStrictEqual(service.validateNotify({ type: 'x', userId: 1, body: 'b' }), { error: 'type_invalid' });
assert.deepStrictEqual(service.validateNotify({ type: 'promo', body: 'b' }), { error: 'user_required' });
assert.deepStrictEqual(service.validateNotify({ type: 'promo', userId: 1 }), { error: 'body_required' });
const v = service.validateNotify({ type: 'payment_success', userId: '7', body: '  Оплата   прошла ', data: { orderId: 48213, route: 'documents', url: 'javascript:alert(1)', 'bad key': 1, nested: { a: 1 } } });
assert.strictEqual(v.userIds[0], 7);
assert.strictEqual(v.title, 'Оплата прошла');
assert.strictEqual(v.body, 'Оплата прошла');
assert.strictEqual(v.data.type, 'payment_success');
assert.strictEqual(v.data.route, 'documents');
assert.strictEqual(v.data.orderId, '48213');
assert.strictEqual(v.data.url, undefined, 'url только http(s)');
assert.strictEqual(v.data['bad key'], undefined);
assert.strictEqual(v.data.nested, undefined);
assert.strictEqual(v.respectQuietHours, false, 'транзакционные — без тихих часов');
assert.strictEqual(service.validateNotify({ type: 'promo', userIds: [1, 1, 2], body: 'b' }).userIds.length, 2);
assert.strictEqual(service.validateNotify({ type: 'promo', userIds: [1], body: 'b' }).respectQuietHours, true, 'promo — тихие часы по умолчанию');
assert.strictEqual(service.validateNotify({ type: 'promo', loyaltyId: '1234 5678', body: 'b' }).loyaltyId, '12345678');
assert.strictEqual(service.sanitizeData({ route: 'weird' }, 'order_created').route, 'order');
assert.strictEqual(service._internal.cleanText('x'.repeat(600), 512).length, 512);

// --- тихие часы (МСК = UTC+3) ------------------------------------------------
assert.strictEqual(service.isQuietNow(new Date('2026-09-08T20:00:00Z')), true, '23:00 МСК — тихо');
assert.strictEqual(service.isQuietNow(new Date('2026-09-08T09:00:00Z')), false, '12:00 МСК — можно');
assert.strictEqual(service.isQuietNow(new Date('2026-09-08T05:59:00Z')), true, '08:59 МСК — тихо');
assert.strictEqual(service.isQuietNow(new Date('2026-09-08T06:00:00Z')), false, '09:00 МСК — можно');
assert.strictEqual(service.nextAllowedTime(new Date('2026-09-08T20:00:00Z')).toISOString(), '2026-09-09T06:00:00.000Z');
assert.strictEqual(service.nextAllowedTime(new Date('2026-09-08T10:00:00Z')).toISOString(), '2026-09-08T10:00:00.000Z');
assert.strictEqual(service._internal.serializeSettings(null).categories.length, 6);
assert.strictEqual(service._internal.serializeSettings({ prefs: '{"email":false,"promo":true}' }).email, false);

// --- устройства --------------------------------------------------------------
assert.deepStrictEqual(devices.validateDevice({ platform: 'tv', token: 'x' }), { error: 'platform_invalid' });
assert.deepStrictEqual(devices.validateDevice({ platform: 'ios', token: 'short' }), { error: 'token_invalid' });
const dv = devices.validateDevice({ platform: 'android', token: 'dGVzdA:APA91b' + 'x'.repeat(120), deviceId: 'dev-1', appVersion: '2.3.0' });
assert.strictEqual(dv.device.channel, 'fcm');
assert.strictEqual(dv.device.deviceId, 'dev-1');
assert.deepStrictEqual(devices.validateDevice({ platform: 'web', subscription: { endpoint: 'http://x' } }), { error: 'subscription_invalid' });
const wv = devices.validateDevice({ platform: 'web', subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } } });
assert.strictEqual(wv.device.channel, 'webpush');
assert.strictEqual(wv.device.token, 'https://fcm.googleapis.com/fcm/send/abc');
assert.strictEqual(devices.serializeDevice({ id: 1, platform: 'ios', channel: 'fcm', token: 'abcdefgh12345678', enabled: 1 }).tokenTail, '…12345678');

// --- FCM / Web Push payload ----------------------------------------------------
const msg = { title: 'T', body: 'B', data: { type: 'promo', route: 'home', n: 5 }, category: 'promo', androidChannel: 'promo', collapseKey: 'campaign_1', badge: 3 };
const fm = fcm.buildMessage(msg);
assert.strictEqual(fm.data.n, '5', 'data только строки');
assert.strictEqual(fm.android.notification.channelId, 'promo');
assert.strictEqual(fm.apns.payload.aps.badge, 3);
assert.strictEqual(fm.apns.headers['apns-collapse-id'], 'campaign_1');
assert.strictEqual(fcm.buildMessage({ ...msg, silent: true }).notification, undefined);
assert.strictEqual(fcm.isEnabled(), false, 'без Firebase — off');
assert.strictEqual(webpush.isEnabled(), false, 'без VAPID — off');
const wp = JSON.parse(webpush.buildPayload(msg));
assert.strictEqual(wp.tag, 'campaign_1');
assert.strictEqual(wp.data.route, 'home');

// --- сегменты и рассылки ----------------------------------------------------
assert.deepStrictEqual(campaigns.normalizeSegment({ platforms: ['ios', 'tv', 'ios'], hasOrders: true, departureFrom: '2026-10-01' }).segment, { platforms: ['ios'], hasOrders: true, departureFrom: '2026-10-01' });
assert.deepStrictEqual(campaigns.normalizeSegment({ departureTo: '01.10.2026' }), { error: 'segment_departure_invalid' });
const sq = campaigns.segmentQuery({ platforms: ['web'], hasOrders: true, departureFrom: '2026-10-01', userIds: [1, 2] }, 'promo');
assert.ok(sq.sql.includes('push_devices') && sq.sql.includes('orders') && sq.sql.includes("'$.promo'"));
assert.deepStrictEqual(sq.args, [[1, 2], ['web'], '2026-10-01']);
assert.deepStrictEqual(campaigns.validateCampaign({ body: 'x' }), { error: 'title_required' });
const cv = campaigns.validateCampaign({ title: 'Горящие туры', body: 'Турция от 45 000 ₽', type: 'promo', data: { route: 'search', url: 'https://totus.club/hot' }, scheduledAt: '2026-09-10T07:00:00Z' });
assert.strictEqual(cv.data.url, 'https://totus.club/hot');
assert.strictEqual(cv.respectQuietHours, true);
assert.strictEqual(cv.scheduledAt.toISOString(), '2026-09-10T07:00:00.000Z');
assert.strictEqual(campaigns.validateCampaign({ title: 't', body: 'b', type: 'hack' }).type, 'promo');

// --- напоминания -------------------------------------------------------------
const facts = reminders.orderFacts({ start_date: '2026-09-20', nights: 7, hotel: { name: 'Rixos', city: 'Хургада' }, flights: { to: { departure_time: '07:40', departure_airport: 'Шереметьево' } } }, { order_id: '48213', pay_status: 'RECONCILED' });
assert.strictEqual(facts.departureTime, '07:40');
assert.strictEqual(facts.departure.toISOString(), '2026-09-20T04:40:00.000Z', 'вылет 07:40 МСК');
assert.strictEqual(facts.end.toISOString(), '2026-09-26T21:00:00.000Z', 'окончание = start + nights (полночь МСК)');
assert.strictEqual(facts.paid, true);
assert.strictEqual(reminders.render('Вылет {дата_вылета} в {время_вылета}, {аэропорт} → {город}. Заказ №{номер}, {имя}!', facts, { f_name: 'Иван' }), 'Вылет 20 сентября в 07:40, Шереметьево → Хургада. Заказ №48213, Иван!');
assert.strictEqual(reminders.render('Привет, {имя}! {неизвестно}', facts, null), 'Привет! {неизвестно}');
const rule3d = { event: 'departure', offsetValue: 3, offsetUnit: 'days', offsetDirection: 'before', sendTime: '10:00' };
assert.strictEqual(reminders.triggerTime(rule3d, facts).toISOString(), '2026-09-17T07:00:00.000Z', 'за 3 дня в 10:00 МСК');
const rule24h = { event: 'departure', offsetValue: 24, offsetUnit: 'hours', offsetDirection: 'before' };
assert.strictEqual(reminders.triggerTime(rule24h, facts).toISOString(), '2026-09-19T04:40:00.000Z');
const ruleAfter = { event: 'trip_end', offsetValue: 1, offsetUnit: 'days', offsetDirection: 'after', sendTime: '12:00' };
assert.strictEqual(reminders.triggerTime(ruleAfter, facts).toISOString(), '2026-09-28T09:00:00.000Z', 'окончание 27.09 + 1 день в 12:00 МСК');
assert.strictEqual(reminders.triggerTime({ event: 'order_created', offsetValue: 1, offsetUnit: 'hours', offsetDirection: 'after' }, facts), null, 'нет created_at — нет события');
assert.deepStrictEqual(reminders.validateRule({ name: 'x', event: 'departure', offsetValue: -1 }), { error: 'offset_invalid' });
assert.deepStrictEqual(reminders.validateRule({ name: 'x', event: 'departure', offsetValue: 1, sendTime: '25:00', title: 't', body: 'b' }), { error: 'send_time_invalid' });
const rv = reminders.validateRule({ name: 'За сутки', event: 'departure', offsetValue: 24, offsetUnit: 'hours', title: 'Вылет завтра', body: 'В {время_вылета}', channels: { email: true }, quietBehavior: 'skip' });
assert.strictEqual(rv.type, 'trip_reminder');
assert.deepStrictEqual(rv.channels, { push: true, inapp: true, email: true });
assert.strictEqual(rv.audience, 'paid');
assert.strictEqual(reminders.previewRule(rv).body.startsWith('В 07:40'), true);
assert.strictEqual(reminders.parseDate('20.09.2026').toISOString(), '2026-09-19T21:00:00.000Z');

// --- внутренний ключ ------------------------------------------------------
assert.strictEqual(routes.internalKeyOk({ headers: { 'x-internal-key': 'k-test-1234567890' } }), true);
assert.strictEqual(routes.internalKeyOk({ headers: { 'x-internal-key': 'k-test-123456789X' } }), false);
assert.strictEqual(routes.internalKeyOk({ headers: {} }), false);
assert.strictEqual(routes._STAFF_RE.test('/campaigns/5/send'), true);
assert.strictEqual(routes._STAFF_RE.test('/devices'), false);

// --- политика доступа (middleware/auth.js) -----------------------------------
const rule = (m, p) => findRule({ method: m, path: p });
assert.strictEqual(rule('POST', '/api/push/devices').rule.handler, hub.httpHandler);
assert.strictEqual(rule('GET', '/api/notifications').rule.handler, hub.httpHandler);
assert.strictEqual(rule('POST', '/internal/notify').rule.handler, hub.httpHandler);
assert.strictEqual(rule('GET', '/api/push/vapid-public-key').rule.public, true);
assert.strictEqual(rule('POST', '/api/calls').rule.tap, calls.onCallCreated);
assert.strictEqual(rule('POST', '/api/calls/abc/answer').rule.tap, calls.onCallAction);
assert.strictEqual(rule('POST', '/api/calls/abc/candidate').rule.tap, undefined);
assert.strictEqual(rule('GET', '/api/support/chat').rule.handler !== hub.httpHandler, true);

// --- пропущенные звонки --------------------------------------------------------
calls.onCallCreated({ auth: { role: 'user', id: 1 }, body: { callId: 'c1', toLoyaltyId: '1111 2222' } });
assert.strictEqual(calls._pending.has('c1'), false, 'звонок пользователя не отслеживаем');
calls.onCallCreated({ auth: { role: 'agent', id: 9 }, body: { callId: 'c2', toLoyaltyId: '1111 2222', callerName: 'Поддержка' } });
assert.strictEqual(calls._pending.get('c2').toLoyaltyId, '11112222');
calls.onCallAction({}, ['/api/calls/c2/answer', 'c2', 'answer']);
assert.strictEqual(calls._pending.has('c2'), false, 'ответ снимает таймер');
calls.onCallCreated({ auth: { role: 'staff', id: 2 }, body: { callId: 'c3', toLoyaltyId: '3333' } });
calls._cancel('c3');
assert.strictEqual(calls._pending.size, 0);

hub.stop();
console.log('✅ notifications check passed');
