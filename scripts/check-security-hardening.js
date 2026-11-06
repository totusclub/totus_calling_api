'use strict';
/**
 * Проверки SECURITY_AUDIT_2026-11 для calling_api_v2 (H2/H3/M5/H9/L1) без БД и сети:
 *   node scripts/check-security-hardening.js
 * Все правки — в middleware/auth.js (index.js не менялся):
 *  - GET /api/users/by-id/:id — владелец (user) / любой (agent, staff); чужой профиль без email/phone;
 *  - POST /api/calls, /api/calls/by-loyalty — fromLoyaltyId из токена;
 *  - сокет: offer/answer/ice-candidate только от своего устройства; get-users-status — свои и контакты;
 *  - trust proxy = TRUST_PROXY_HOPS (1), лимит платных вызовов, synthesize-to-file без outputPath;
 *  - lib/auth.js: токены только HS256.
 */
const assert = require('assert');
const path = require('path');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-1234567890';
process.env.JWT_REFRESH_SECRET = 'test-refresh-1234567890';
process.env.PAID_RATE_LIMIT = '2';
delete process.env.PAID_RATE_MODE;

const root = path.join(__dirname, '..');

// Заглушки модулей с БД / внешними сервисами
const Module = require('module');
const origLoad = Module._load;
const fakeUsers = [
    { id: 1, loyalty_id: '1111', online: 1 }, { id: 2, loyalty_id: '2222', online: 0 }, { id: 3, loyalty_id: '3333', online: 1 },
];
Module._load = function (request, parent) {
    if (/(^|\/)lib\/(supportChat|notifications|iceServers)$/.test(request)) {
        return {
            httpHandler: () => {}, attachSocket: () => {}, ensureReady: async () => {}, start: () => {},
            calls: { onCallCreated: () => {}, onCallAction: () => {} }, iceServersHandler: () => {},
        };
    }
    if (request === '../db' && parent && /middleware/.test(parent.filename || '')) {
        return {
            userDb: { getAllUsers: async () => fakeUsers },
            contactDb: { getUserContacts: async (id) => (id === 1 ? [{ loyalty_id: '33 33' }] : []) },
        };
    }
    return origLoad.apply(this, arguments);
};

const authCore = require(path.join(root, 'lib/auth.js'));
const gate = require(path.join(root, 'middleware/auth.js'));

let passed = 0;
function test(name, fn) {
    try { fn(); passed += 1; console.log(`ok   - ${name}`); }
    catch (e) { console.error(`FAIL - ${name}: ${e.message}`); process.exitCode = 1; }
}
const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => warnings.push(a.join(' '));

function token(payload) { return authCore.signUserToken(payload); }
function makeReq({ method = 'GET', url, body, auth }) {
    const headers = auth ? { authorization: `Bearer ${token(auth)}` } : {};
    const app = { settings: {}, set(k, v) { this.settings[k] = v; }, get(k) { return this.settings[k]; } };
    return { method, path: url, originalUrl: url, url, body: body || {}, headers, ip: '10.0.0.1', app, socket: { remoteAddress: '10.0.0.1' }, connection: { remoteAddress: '10.0.0.1' } };
}
function makeRes() {
    const res = { statusCode: 200, body: null, headers: {} };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
    res.getHeader = (k) => res.headers[k.toLowerCase()];
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; }; res.send = res.json; res.end = () => res;
    return res;
}
function run(req) {
    return new Promise((resolve) => {
        const res = makeRes(); let nexted = false;
        gate.httpGate(req, res, () => { nexted = true; resolve({ req, res, nexted }); });
        setTimeout(() => resolve({ req, res, nexted }), 30);
    });
}

const user1 = { id: 1, loyalty_id: '1111', role: 'user' };
const agent = { id: 9, loyalty_id: '9999', role: 'agent' };

test('lib/auth: HS512-токен отклоняется, HS256 принимается', () => {
    const bad = jwt.sign({ id: 7, scope: 'user' }, process.env.JWT_SECRET, { algorithm: 'HS512' });
    assert.strictEqual(authCore.verifyAccessToken(bad), null);
    assert.ok(authCore.verifyAccessToken(token(user1)));
});

test('POLICY: GET /api/users/by-id/:id — владелец по param 1, stripContacts', () => {
    const f = gate.findRule({ method: 'GET', path: '/api/users/by-id/42' });
    assert.deepStrictEqual(f.rule.roles, ['user']);
    assert.deepStrictEqual(f.rule.ownerUser, { param: 1 });
    assert.strictEqual(f.rule.stripContacts, true);
});

test('stripContactsForViewer: user — чужой без email/phone, свой целиком; agent — полный; без токена: log как раньше, enforce урезан', () => {
    const body = { ok: true, user: { id: 5, name: 'A', email: 'a@x', phone: '7' } };
    delete process.env.AUTH_MODE;
    const other = gate.stripContactsForViewer({ auth: { id: 1, role: 'user' } }, body);
    assert.strictEqual(other.user.email, undefined); assert.strictEqual(other.user.phone, undefined); assert.strictEqual(other.user.name, 'A');
    assert.strictEqual(gate.stripContactsForViewer({ auth: { id: 5, role: 'user' } }, body).user.email, 'a@x');
    assert.strictEqual(gate.stripContactsForViewer({ auth: { id: 1, role: 'agent' } }, body).user.phone, '7');
    assert.strictEqual(gate.stripContactsForViewer({ auth: null }, body).user.phone, '7');
    process.env.AUTH_MODE = 'enforce';
    assert.strictEqual(gate.stripContactsForViewer({ auth: null }, body).user.phone, undefined);
    delete process.env.AUTH_MODE;
});

test('applyIdentity: fromLoyaltyId заменяется значением из токена; staff/без токена — не трогаем', () => {
    const req = { method: 'POST', path: '/api/calls', auth: { id: 1, role: 'user', payload: { loyalty_id: '1111' } }, body: { fromLoyaltyId: '2222' } };
    warnings.length = 0;
    gate.applyIdentity(req, 'fromLoyaltyId');
    assert.strictEqual(req.body.fromLoyaltyId, '1111');
    assert.ok(warnings.some((w) => w.includes('differs from token')));
    const staff = { method: 'POST', path: '/api/calls', auth: { id: 1, role: 'staff', payload: {} }, body: { fromLoyaltyId: '2222' } };
    gate.applyIdentity(staff, 'fromLoyaltyId'); assert.strictEqual(staff.body.fromLoyaltyId, '2222');
    const anon = { method: 'POST', path: '/api/calls', auth: null, body: { fromLoyaltyId: '2222' } };
    gate.applyIdentity(anon, 'fromLoyaltyId'); assert.strictEqual(anon.body.fromLoyaltyId, '2222');
});

test('socketMayActAs: своё устройство — да; чужое: enforce — нет, log — да с предупреждением; без registerDevice — да', () => {
    const sock = { id: 's1', data: { deviceId: 'devA', auth: { id: 1, role: 'user' } } };
    assert.strictEqual(gate.socketMayActAs(sock, 'offer', 'devA'), true);
    assert.strictEqual(gate.socketMayActAs(sock, 'offer', undefined), true);
    process.env.AUTH_MODE = 'enforce'; warnings.length = 0;
    assert.strictEqual(gate.socketMayActAs(sock, 'offer', 'devB'), false);
    assert.ok(warnings.some((w) => w.includes('fromDeviceId mismatch') && w.includes('ignored')));
    delete process.env.AUTH_MODE; warnings.length = 0;
    assert.strictEqual(gate.socketMayActAs(sock, 'answer', 'devB'), true);
    assert.ok(warnings.some((w) => w.includes('fromDeviceId mismatch')));
    assert.strictEqual(gate.socketMayActAs({ id: 'sX', data: {} }, 'offer', 'devB'), true);
});

(async () => {
    // httpGate end-to-end
    let r = await run(makeReq({ url: '/api/users/by-id/2', auth: user1 }));
    assert.strictEqual(r.nexted, true, 'log-режим: чужой by-id пропущен в index.js с логом');
    r.res.json({ ok: true, user: { id: 2, name: 'B', email: 'b@x', phone: '2' } });
    assert.strictEqual(r.res.body.user.email, undefined, 'ответ урезан');
    passed += 1; console.log('ok   - httpGate: чужой by-id (log) — ответ без email/phone');

    process.env.AUTH_MODE = 'enforce';
    r = await run(makeReq({ url: '/api/users/by-id/2', auth: user1 }));
    assert.strictEqual(r.res.statusCode, 403); assert.strictEqual(r.nexted, false);
    r = await run(makeReq({ url: '/api/users/by-id/1', auth: user1 }));
    assert.strictEqual(r.nexted, true);
    r = await run(makeReq({ url: '/api/users/by-id/2', auth: agent }));
    assert.strictEqual(r.nexted, true);
    r.res.json({ ok: true, user: { id: 2, email: 'b@x' } }); assert.strictEqual(r.res.body.user.email, 'b@x');
    delete process.env.AUTH_MODE;
    passed += 1; console.log('ok   - httpGate enforce: чужой by-id 403, свой и agent — проходят');

    r = await run(makeReq({ method: 'POST', url: '/api/calls', auth: user1, body: { fromLoyaltyId: '2222', callId: 'c' } }));
    assert.strictEqual(r.req.body.fromLoyaltyId, '1111');
    r = await run(makeReq({ method: 'POST', url: '/api/calls/by-loyalty', auth: user1, body: { fromLoyaltyId: '2222' } }));
    assert.strictEqual(r.req.body.fromLoyaltyId, '1111');
    passed += 1; console.log('ok   - httpGate: POST /api/calls(/by-loyalty) — fromLoyaltyId из токена');

    r = await run(makeReq({ method: 'POST', url: '/api/tts/synthesize-to-file', auth: user1, body: { text: 'a', outputPath: '/etc/x.mp3' } }));
    assert.strictEqual(r.req.body.outputPath, undefined);
    assert.strictEqual(r.req.app.get('trust proxy'), 1, 'trust proxy = 1 хоп');
    passed += 1; console.log('ok   - httpGate: outputPath убран; trust proxy = 1');

    warnings.length = 0;
    for (let i = 0; i < 3; i += 1) r = await run(makeReq({ method: 'POST', url: '/api/tour-assistant', auth: user1, body: { text: 'x' } }));
    assert.strictEqual(r.nexted, true); assert.ok(warnings.some((w) => w.includes('[RATE] paid mode=log exceeded')));
    passed += 1; console.log('ok   - httpGate: лимит платных вызовов в log-режиме пишет [RATE], пропускает');

    // get-users-status
    const emitted = [];
    const sockUser = { id: 's1', data: { auth: { id: 1, role: 'user' } }, emit: (ev, p) => emitted.push([ev, p]) };
    assert.strictEqual(await gate.handleUsersStatus(sockUser), true);
    assert.deepStrictEqual(emitted[0][1].users.map((u) => u.id), [1, 3], 'только сам и контакты');
    assert.strictEqual(await gate.handleUsersStatus({ id: 's2', data: { auth: { id: 9, role: 'agent' } }, emit: () => {} }), false);
    delete process.env.AUTH_MODE;
    assert.strictEqual(await gate.handleUsersStatus({ id: 's3', data: { auth: null }, emit: () => {} }), false);
    process.env.AUTH_MODE = 'enforce'; emitted.length = 0;
    assert.strictEqual(await gate.handleUsersStatus({ id: 's4', data: { auth: null }, emit: (ev, p) => emitted.push([ev, p]) }), true);
    assert.deepStrictEqual(emitted[0][1].users, []);
    delete process.env.AUTH_MODE;
    passed += 1; console.log('ok   - get-users-status: user — свои и контакты; agent/log без токена — как раньше; enforce без токена — пусто');

    console.warn = origWarn;
    console.log(`\n${passed} проверок прошло${process.exitCode ? ', есть ошибки' : ''}`);
})().catch((e) => { console.warn = origWarn; console.error('FAIL -', e.message); process.exitCode = 1; });
