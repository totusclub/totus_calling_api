// Проверка Support Chat без БД и сети: node scripts/check-support-chat.js
// Роуты/сокет с БД здесь не трогаются — только валидация, сериализация, политика доступа и rate-limit.
'use strict';
const assert = require('assert');
process.env.JWT_SECRET = 's1'; process.env.JWT_REFRESH_SECRET = 's2'; process.env.AUTH_MODE = 'log';
const chat = require('../lib/supportChat');
const { findRule } = require('../middleware/auth');
const { validateBody, sanitizeMeta, looksLikeFcmToken, preview, serializeChat, serializeMessage, displayName, checkRate } = chat._internal;

// validateBody
assert.deepStrictEqual(validateBody(''), { error: 'body_required' });
assert.deepStrictEqual(validateBody('   '), { error: 'body_required' });
assert.deepStrictEqual(validateBody('x'.repeat(4001)), { error: 'message_too_long' });
assert.strictEqual(validateBody('  Привет\r\n мир ').text, 'Привет\n мир');

// meta
assert.strictEqual(sanitizeMeta(null), null);
assert.strictEqual(sanitizeMeta({ foo: 'bar' }), null);
assert.deepStrictEqual(sanitizeMeta({ orderId: 48213, foo: 1 }), { orderId: '48213' });
assert.deepStrictEqual(sanitizeMeta({ topic: 'payment', orderId: 'x'.repeat(65) }), { topic: 'payment' });

// push token detection
assert.strictEqual(looksLikeFcmToken('web'), false);
assert.strictEqual(looksLikeFcmToken('a'.repeat(64)), false, 'APNs VoIP hex token is not FCM');
assert.strictEqual(looksLikeFcmToken('dGVzdA:APA91b' + 'x'.repeat(120)), true);
assert.strictEqual(looksLikeFcmToken(null), false);

// preview / names
assert.strictEqual(preview('  a \n b  '), 'a b');
assert.strictEqual(preview('x'.repeat(300)).length, 253);
assert.strictEqual(displayName({ f_name: 'Иван', l_name: 'Иванов' }, '-'), 'Иван Иванов');
assert.strictEqual(displayName({ name: 'Анна', lastname: 'П.' }, '-'), 'Анна П.');
assert.strictEqual(displayName({ email: 'a@b' }, '-'), 'a@b');
assert.strictEqual(displayName(null, 'X'), 'X');

// serialization
const now = new Date('2026-09-07T10:00:00Z');
const c = serializeChat({ id: '5', user_id: 7, status: 'open', assigned_id: null, assigned_role: null, assigned_name: null, subject: null, order_id: null, last_message_id: 9, last_message_at: now, last_message_preview: 'hi', user_unread: 0, staff_unread: 2, created_at: now, updated_at: now, u_id: 7, u_name: null, u_f_name: 'Иван', u_l_name: 'Иванов', u_email: 'i@i.ru', u_phone: '+7', u_loyalty_id: '1234 5678', u_online: 1 });
assert.strictEqual(c.id, 5); assert.strictEqual(c.staffUnread, 2); assert.strictEqual(c.user.name, 'Иван Иванов'); assert.strictEqual(c.user.online, true); assert.strictEqual(c.lastMessageAt, now.toISOString());
const m = serializeMessage({ id: 9, chat_id: 5, sender_role: 'user', sender_id: 7, sender_name: 'Иван', body: 'hi', meta: '{"orderId":"1"}', client_msg_id: 'c1', read_at: null, created_at: now });
assert.deepStrictEqual(m.meta, { orderId: '1' }); assert.strictEqual(m.readAt, null); assert.strictEqual(m.chatId, 5);

// rate limit
process.env.SUPPORT_CHAT_RATE_LIMIT = '3';
assert(checkRate(1) && checkRate(1) && checkRate(1), 'first 3 pass');
assert.strictEqual(checkRate(1), false, '4th is limited');
assert.strictEqual(checkRate(2), true, 'other user unaffected');

// policy routing: /api/support/* handled by supportChat, roles as planned
let r = findRule({ method: 'GET', path: '/api/support/chat' });
assert(r && r.rule.handler === chat.httpHandler && r.rule.roles.join() === 'user', 'user side rule');
r = findRule({ method: 'POST', path: '/api/support/chat/messages' });
assert(r && r.rule.roles.join() === 'user');
r = findRule({ method: 'GET', path: '/api/support/chats' });
assert(r && r.rule.handler === chat.httpHandler && r.rule.roles.join() === 'agent,staff', 'support side rule');
r = findRule({ method: 'GET', path: '/api/support/summary' });
assert(r && r.rule.roles.join() === 'agent,staff');
r = findRule({ method: 'POST', path: '/api/calls' });
assert(r && !r.rule.handler, 'calls untouched');

console.log('ALL SUPPORT CHAT CHECKS PASSED');
