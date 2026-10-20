// Push сотрудникам поддержки (lib/staffPush.js) без БД и сети: node scripts/check-staff-push.js
// БД и APNs подменяются заглушками. Сценарий владельца 20.10.2026: iPhone с Totus Support заблокирован —
// о сообщении пользователя нет уведомления (сервер пушей сотрудникам не слал).
'use strict';
const assert = require('assert');

process.env.APN_KEY_PATH = '/tmp/AuthKey_TEST.p8';
process.env.APN_KEY_ID = 'KEYID';
process.env.APN_TEAM_ID = 'TEAMID';

const staffPush = require('../lib/staffPush');
const { normalizeToken, normalizeEnvironment, normalizeBundle, isForeground, presence, _setDeps } = staffPush._internal;

// ---- заглушка MySQL ---------------------------------------------------------
function makePool() {
    const rows = [];
    let nextId = 1;
    const queries = [];
    return {
        rows, queries,
        async query(sql, params = []) {
            queries.push(sql);
            const s = sql.replace(/\s+/g, ' ').trim();
            if (s.startsWith('CREATE TABLE')) return [{}];
            if (s.startsWith('INSERT INTO support_staff_push_devices')) {
                const [user_id, role, token, bundle_id, environment, platform] = params;
                const ex = rows.find((r) => r.token === token);
                if (ex) Object.assign(ex, { user_id, role, bundle_id, environment, platform });
                else rows.push({ id: nextId++, user_id, role, token, bundle_id, environment, platform });
                return [{ affectedRows: 1 }];
            }
            if (s.startsWith('DELETE FROM support_staff_push_devices WHERE token = ? AND user_id = ?')) {
                const i = rows.findIndex((r) => r.token === params[0] && r.user_id === params[1]);
                if (i >= 0) rows.splice(i, 1);
                return [{}];
            }
            if (s.startsWith('DELETE FROM support_staff_push_devices WHERE token = ?')) {
                const i = rows.findIndex((r) => r.token === params[0]);
                if (i >= 0) rows.splice(i, 1);
                return [{}];
            }
            if (s.startsWith('UPDATE support_staff_push_devices SET environment')) {
                const r = rows.find((x) => x.token === params[1]);
                if (r) r.environment = params[0];
                return [{}];
            }
            if (s.startsWith('SELECT * FROM support_staff_push_devices WHERE user_id = ?')) return [rows.filter((r) => r.user_id === params[0])];
            if (s.startsWith('SELECT * FROM support_staff_push_devices')) return [rows.slice()];
            if (s.startsWith('SELECT SUM(staff_unread)')) return [[{ total: 3 }]];
            throw new Error('unexpected SQL: ' + s);
        },
    };
}

// ---- заглушка apn -----------------------------------------------------------
function makeApn(behaviour) {
    const sent = [];
    class Notification { constructor() { this.payload = {}; } }
    class Provider {
        constructor(opts) { this.production = opts.production; }
        async send(note, token) {
            const env = this.production ? 'production' : 'sandbox';
            sent.push({ env, token, topic: note.topic, pushType: note.pushType, alert: note.alert, payload: note.payload, badge: note.badge, threadId: note.threadId });
            const r = behaviour(token, env, note);
            if (r === 'ok') return { sent: [{ device: token }], failed: [] };
            return { sent: [], failed: [{ device: token, status: r === 'Unregistered' ? '410' : '400', response: { reason: r } }] };
        }
    }
    return { apn: { Notification, Provider }, sent };
}

const T1 = 'a'.repeat(64);
const T2 = 'b'.repeat(64);
const T3 = 'c'.repeat(64);
const agent1 = { id: 11, role: 'agent' };
const agent2 = { id: 12, role: 'agent' };
const chatRow = (extra = {}) => ({ id: 42, user_id: 7, assigned_role: null, assigned_id: null, ...extra });
const message = { id: 900, body: '  Здравствуйте,\n не пришёл ваучер  ' };

let passed = 0;
async function check(name, fn) {
    await fn();
    passed += 1;
    console.log('  ok  ', name);
}

(async () => {
    await check('токен APNs: hex 64+, пробелы и <> убираются, мусор отклоняется', () => {
        assert.strictEqual(normalizeToken(`<${'AB'.repeat(32)}>`), 'ab'.repeat(32));
        assert.strictEqual(normalizeToken('dGVzdA:APA91b'), null);
        assert.strictEqual(normalizeToken(''), null);
        assert.strictEqual(normalizeEnvironment('development'), 'sandbox');
        assert.strictEqual(normalizeEnvironment('production'), 'production');
        assert.strictEqual(normalizeEnvironment(undefined), 'production');
        assert.strictEqual(normalizeBundle('club.totus.support'), 'club.totus.support');
        assert.strictEqual(normalizeBundle('evil bundle;'), 'club.totus.support');
    });

    await check('регистрация: устройство сохраняется, повтор не дублирует, токен переезжает к новому сотруднику', async () => {
        const pool = makePool();
        _setDeps({ pool, apn: makeApn(() => 'ok').apn });
        assert.deepStrictEqual((await staffPush.registerDevice(agent1, { token: T1, environment: 'production', bundleId: 'club.totus.support' })).ok, true);
        await staffPush.registerDevice(agent1, { token: T1, environment: 'production' });
        assert.strictEqual(pool.rows.length, 1);
        await staffPush.registerDevice(agent2, { token: T1, environment: 'sandbox' });
        assert.strictEqual(pool.rows.length, 1);
        assert.strictEqual(pool.rows[0].user_id, 12);
        assert.strictEqual(pool.rows[0].environment, 'sandbox');
        assert.strictEqual((await staffPush.registerDevice(agent1, { token: 'xyz' })).error, 'invalid_token');
    });

    await check('выход: снимается только это устройство этого сотрудника', async () => {
        const pool = makePool();
        _setDeps({ pool, apn: makeApn(() => 'ok').apn });
        await staffPush.registerDevice(agent1, { token: T1 });
        await staffPush.registerDevice(agent1, { token: T2 });
        await staffPush.unregisterDevice(agent1, { token: T1 });
        assert.deepStrictEqual(pool.rows.map((r) => r.token), [T2]);
        await staffPush.unregisterDevice(agent2, { token: T2 }); // чужой токен — не трогаем
        assert.deepStrictEqual(pool.rows.map((r) => r.token), [T2]);
    });

    await check('сообщение пользователя → alert-пуш с topic club.totus.support (не .voip), имя, текст, бейдж, chatId', async () => {
        const pool = makePool();
        const fake = makeApn(() => 'ok');
        _setDeps({ pool, apn: fake.apn });
        await staffPush.registerDevice(agent1, { token: T1, environment: 'production', bundleId: 'club.totus.support' });
        const r = await staffPush.notifyStaff({ chatRow: chatRow(), message, userName: 'Иван Петров' });
        assert.strictEqual(r.sent, 1);
        const p = fake.sent[0];
        assert.strictEqual(p.topic, 'club.totus.support');
        assert.strictEqual(p.pushType, 'alert');
        assert.strictEqual(p.env, 'production');
        assert.deepStrictEqual(p.alert, { title: 'Иван Петров', body: 'Здравствуйте, не пришёл ваучер' });
        assert.strictEqual(p.payload.chatId, '42');
        assert.strictEqual(p.payload.type, 'support_message_staff');
        assert.strictEqual(p.badge, 3);
        assert.strictEqual(p.threadId, 'support-chat-42');
    });

    await check('приложение на экране → пуш этому устройству не уходит; свёрнуто / сокет закрыт → уходит', async () => {
        const pool = makePool();
        const fake = makeApn(() => 'ok');
        _setDeps({ pool, apn: fake.apn });
        presence.clear();
        await staffPush.registerDevice(agent1, { token: T1 });
        await staffPush.registerDevice(agent2, { token: T2 });
        staffPush.setPresence('s1', agent1, { state: 'foreground', pushToken: T1 });
        staffPush.setPresence('s2', agent2, { state: 'background', pushToken: T2 });
        assert.strictEqual(isForeground(T1), true);
        let r = await staffPush.notifyStaff({ chatRow: chatRow(), message, userName: 'Иван' });
        assert.deepStrictEqual([r.sent, r.skipped], [1, 1]);
        assert.deepStrictEqual(fake.sent.map((x) => x.token), [T2]);
        staffPush.clearPresence('s1'); // экран заблокирован — iOS закрыла сокет
        r = await staffPush.notifyStaff({ chatRow: chatRow(), message, userName: 'Иван' });
        assert.strictEqual(r.sent, 2);
    });

    await check('диалог закреплён за агентом → пуш только ему; у него нет устройства → всем', async () => {
        const pool = makePool();
        const fake = makeApn(() => 'ok');
        _setDeps({ pool, apn: fake.apn });
        presence.clear();
        await staffPush.registerDevice(agent1, { token: T1 });
        await staffPush.registerDevice(agent2, { token: T2 });
        let r = await staffPush.notifyStaff({ chatRow: chatRow({ assigned_role: 'agent', assigned_id: 12 }), message, userName: 'Иван' });
        assert.strictEqual(r.total, 1);
        assert.deepStrictEqual(fake.sent.map((x) => x.token), [T2]);
        r = await staffPush.notifyStaff({ chatRow: chatRow({ assigned_role: 'agent', assigned_id: 99 }), message, userName: 'Иван' });
        assert.strictEqual(r.total, 2);
    });

    await check('токен сборки из Xcode (sandbox) записан как production → BadDeviceToken → повтор в sandbox, окружение исправлено', async () => {
        const pool = makePool();
        const fake = makeApn((token, env) => (env === 'sandbox' ? 'ok' : 'BadDeviceToken'));
        _setDeps({ pool, apn: fake.apn });
        presence.clear();
        await staffPush.registerDevice(agent1, { token: T3, environment: 'production' });
        const r = await staffPush.notifyStaff({ chatRow: chatRow(), message, userName: 'Иван' });
        assert.strictEqual(r.sent, 1);
        assert.deepStrictEqual(fake.sent.map((x) => x.env), ['production', 'sandbox']);
        assert.strictEqual(pool.rows[0].environment, 'sandbox');
    });

    await check('приложение удалено (Unregistered / 410) → токен удаляется; другая ошибка → токен остаётся', async () => {
        const pool = makePool();
        _setDeps({ pool, apn: makeApn((token) => (token === T1 ? 'Unregistered' : 'TooManyRequests')).apn });
        presence.clear();
        await staffPush.registerDevice(agent1, { token: T1 });
        await staffPush.registerDevice(agent2, { token: T2 });
        const r = await staffPush.notifyStaff({ chatRow: chatRow(), message, userName: 'Иван' });
        assert.strictEqual(r.failed, 2);
        assert.deepStrictEqual(pool.rows.map((x) => x.token), [T2]);
    });

    await check('APNs не настроен → ничего не шлём и не падаем', async () => {
        const saved = process.env.APN_KEY_PATH;
        delete process.env.APN_KEY_PATH;
        _setDeps({ pool: makePool(), apn: makeApn(() => 'ok').apn });
        const r = await staffPush.notifyStaff({ chatRow: chatRow(), message, userName: 'Иван' });
        assert.strictEqual(r.reason, 'apns_not_configured');
        process.env.APN_KEY_PATH = saved;
    });

    console.log(`\nALL STAFF PUSH CHECKS PASSED (${passed})`);
})().catch((e) => {
    console.error('FAIL:', e && e.message ? e.message : e);
    process.exit(1);
});
