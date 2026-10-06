// Проверка: push сообщения поддержки доходит до закрытого телефона, даже если у пользователя
// открыт сайт или другой телефон (lib/notifications/presence.js + skipIfOnline в service.js).
// Без БД и сети: node scripts/check-push-presence.js
'use strict';
const assert = require('assert');
process.env.JWT_SECRET = 's1'; process.env.JWT_REFRESH_SECRET = 's2'; process.env.AUTH_MODE = 'log';
process.env.PUSH_QUIET_HOURS = '00:00-00:00';

// Фейковая БД (db.js тянет mysql2): service.js и devices.js получают один и тот же pool.
const fakeDb = { pool: { query: async (sql, args) => fakeDb.impl(sql, args) }, impl: async () => [[]] };
const dbPath = require.resolve('../db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const presence = require('../lib/notifications/presence');
const service = require('../lib/notifications/service');
const fcm = require('../lib/notifications/fcm');
const webpush = require('../lib/notifications/webpush');

let passed = 0;
let failed = 0;
async function check(name, fn) {
    try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e && e.message ? e.message : e}`); }
}

const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/537.36';
const ELECTRON = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 totus-desktop/1.0 Chrome/126 Electron/31.0 Safari/537.36';
const hs = {
    web: { auth: { token: 't' }, headers: { 'user-agent': BROWSER } },
    desktop: { auth: { token: 't' }, headers: { 'user-agent': ELECTRON } },
    oldAndroid: { auth: { token: 't' }, headers: { 'user-agent': 'okhttp/4.12.0' } },
    oldIos: { auth: { token: 't' }, headers: {} },
    voipAndroid: { auth: { token: 't', client: 'app' }, headers: { 'user-agent': 'okhttp/4.12.0' } },
    voipIos: { auth: { token: 't', client: 'app' }, headers: {} },
    fgIphone: { auth: { token: 't', client: 'app', presence: 'foreground', deviceId: 'ios-abc-1' }, headers: {} },
    fgAndroid: { auth: { token: 't', client: 'app', presence: 'foreground', deviceId: 'android-xyz-2' }, headers: {} },
    fgNoId: { auth: { token: 't', client: 'app', presence: 'foreground' }, headers: {} },
};
const DEV = {
    android: { id: 1, user_id: 7, platform: 'android', channel: 'fcm', token: 'a'.repeat(40), device_id: 'android-xyz-2' },
    iphone: { id: 2, user_id: 7, platform: 'ios', channel: 'fcm', token: 'i'.repeat(40), device_id: 'ios-abc-1' },
    site: { id: 3, user_id: 7, platform: 'web', channel: 'webpush', token: 'https://push.example/1', device_id: null },
};
const skipped = (handshakes) => {
    const p = presence.summarize(handshakes);
    return Object.keys(DEV).filter((k) => presence.shouldSkipDevice(DEV[k], p));
};

(async () => {
    console.log('Push presence (support messages)');

    await check('socket kinds: web / desktop / old app / call socket / foreground app', () => {
        assert.strictEqual(presence.classifySocket(hs.web).kind, 'web');
        assert.strictEqual(presence.classifySocket(hs.desktop).kind, 'web');
        assert.strictEqual(presence.classifySocket(hs.oldAndroid).kind, 'legacy-app');
        assert.strictEqual(presence.classifySocket(hs.oldIos).kind, 'legacy-app');
        assert.strictEqual(presence.classifySocket(hs.voipAndroid).kind, 'app-background');
        assert.deepStrictEqual(presence.classifySocket(hs.fgIphone), { kind: 'app-foreground', deviceId: 'ios-abc-1' });
        assert.strictEqual(presence.classifySocket(hs.fgNoId).kind, 'legacy-app', 'foreground without deviceId — as before');
        assert.strictEqual(presence.classifySocket({ auth: { client: 'app', presence: 'foreground', deviceId: 'bad id <x>' } }).kind, 'legacy-app');
        assert.strictEqual(presence.classifySocket(undefined).kind, 'legacy-app');
    });

    await check('owner scenario: site open, Android closed → Android and iPhone get FCM, no Web Push', () => {
        assert.deepStrictEqual(skipped([hs.web]), ['site']);
    });
    await check('owner scenario: iPhone open (chat socket + call socket), Android closed → push only to Android', () => {
        assert.deepStrictEqual(skipped([hs.fgIphone, hs.voipIos]), ['iphone', 'site']);
    });
    await check('call sockets of phones in background do not cancel pushes', () => {
        assert.deepStrictEqual(skipped([hs.voipAndroid, hs.voipIos]), []);
    });
    await check('Android open → no FCM to Android (banner comes from the socket, no duplicate)', () => {
        assert.deepStrictEqual(skipped([hs.fgAndroid, hs.voipAndroid]), ['android', 'site']);
    });
    await check('no sockets → push to every device (unchanged)', () => {
        assert.deepStrictEqual(skipped([]), []);
    });
    await check('old app version online → no push at all, exactly as before', () => {
        assert.deepStrictEqual(skipped([hs.oldAndroid]), ['android', 'iphone', 'site']);
        assert.deepStrictEqual(skipped([hs.web, hs.oldIos]), ['android', 'iphone', 'site']);
    });

    // --- notify() end-to-end with fake DB / socket.io / FCM -------------------
    let devicesRows = [];
    let socketsByRoom = {};
    const inserted = [];
    const pool = {
        async query(sql, args) {
            if (/^SELECT 1 FROM/.test(sql)) return [[]];
            if (/FROM notification_settings/.test(sql)) return [[]];
            if (/FROM push_devices WHERE enabled = 1/.test(sql)) {
                assert.ok(/device_id/.test(sql), 'device_id is selected');
                const ids = args[0];
                return [devicesRows.filter((d) => ids.includes(d.user_id))];
            }
            if (/^\s*INSERT INTO notifications/.test(sql)) {
                const values = args[0];
                inserted.push(...values.map((v) => v[0]));
                return [{ insertId: 100 + inserted.length }];
            }
            if (/SELECT COUNT/.test(sql)) return [[{ n: 1 }]];
            return [{ affectedRows: 0 }];
        },
    };
    fakeDb.impl = (sql, args) => pool.query(sql, args);
    const emitted = [];
    service.setIo({
        in: (room) => ({ fetchSockets: async () => (socketsByRoom[room] || []).map((h) => ({ handshake: h })) }),
        to: (room) => ({ emit: (ev) => emitted.push([room, ev]) }),
    });
    let fcmTokens = [];
    let webTokens = [];
    fcm.sendToDevices = async (devs) => { const t = devs.filter((d) => d.channel === 'fcm').map((d) => d.token); fcmTokens.push(...t); return { sent: t, dead: [], failed: [], errors: [] }; };
    webpush.sendToDevices = async (devs) => { const t = devs.filter((d) => d.channel === 'webpush').map((d) => d.token); webTokens.push(...t); return { sent: t, dead: [], failed: [], errors: [] }; };
    const reset = () => { fcmTokens = []; webTokens = []; inserted.length = 0; emitted.length = 0; };
    const support = { userId: 7, type: 'support_message', body: 'Ответ поддержки', data: { chatId: '5' }, collapseKey: 'support_chat_5', skipIfOnline: true };
    devicesRows = [DEV.android, DEV.iphone, DEV.site];

    await check('notify: site open + iPhone open → FCM to the closed Android only, record in the center', async () => {
        reset();
        socketsByRoom = { 'u:7': [hs.web, hs.fgIphone, hs.voipIos] };
        const r = await service.notify(support);
        assert.strictEqual(r.ok, true);
        assert.deepStrictEqual(fcmTokens, [DEV.android.token]);
        assert.deepStrictEqual(webTokens, []);
        assert.deepStrictEqual(inserted, [7]);
        assert.strictEqual(r.skippedOnline, 0);
    });
    await check('notify: everything closed → FCM to both phones + Web Push (unchanged)', async () => {
        reset();
        socketsByRoom = {};
        await service.notify(support);
        assert.deepStrictEqual(fcmTokens.sort(), [DEV.android.token, DEV.iphone.token].sort());
        assert.deepStrictEqual(webTokens, [DEV.site.token]);
    });
    await check('notify: the only phone is open → no push and no record (user sees the chat), as before', async () => {
        reset();
        devicesRows = [DEV.android];
        socketsByRoom = { 'u:7': [hs.fgAndroid, hs.voipAndroid] };
        const r = await service.notify(support);
        assert.strictEqual(r.recipients, 0);
        assert.strictEqual(r.skippedOnline, 1);
        assert.deepStrictEqual(fcmTokens, []);
        assert.deepStrictEqual(inserted, []);
        devicesRows = [DEV.android, DEV.iphone, DEV.site];
    });
    await check('notify: orders / admin pushes ignore sockets (no skipIfOnline) — unchanged', async () => {
        reset();
        socketsByRoom = { 'u:7': [hs.fgAndroid, hs.web, hs.oldIos] };
        await service.notify({ userId: 7, type: 'payment_success', body: 'Оплата прошла', data: { orderId: 1 } });
        assert.deepStrictEqual(fcmTokens.sort(), [DEV.android.token, DEV.iphone.token].sort());
        assert.deepStrictEqual(webTokens, [DEV.site.token]);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
