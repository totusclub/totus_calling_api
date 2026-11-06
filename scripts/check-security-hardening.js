'use strict';
/**
 * Проверки SECURITY_AUDIT_2026-11 для calling_api_v2 (H2/H3/M5/H9/L1) без БД и сети:
 *   node scripts/check-security-hardening.js
 *  - middleware/auth.js: GET /api/users/by-id/:id — владелец (user) / любой (agent, staff);
 *  - lib/auth.js: токены только HS256;
 *  - lib/security.js paidLimiter: log пропускает с [RATE], enforce — 429, 0 — выключен;
 *  - index.js (функции извлекаются из исходника): restrictProfileForViewer, socketMayActAs, trust proxy = 1.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-1234567890';
process.env.JWT_REFRESH_SECRET = 'test-refresh-1234567890';

const root = path.join(__dirname, '..');
const authCore = require(path.join(root, 'lib/auth.js'));
const security = require(path.join(root, 'lib/security.js'));

let passed = 0;
function test(name, fn) {
    try { fn(); passed += 1; console.log(`ok   - ${name}`); }
    catch (e) { console.error(`FAIL - ${name}: ${e.message}`); process.exitCode = 1; }
}

// --- middleware/auth.js: POLICY (модуль тянет supportChat/notifications → подменяем их заглушками)
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (/lib\/(supportChat|notifications|iceServers)$/.test(request) || request === '../lib/supportChat' || request === '../lib/notifications' || request === '../lib/iceServers') {
        return {
            httpHandler: () => {}, attachSocket: () => {}, ensureReady: async () => {}, start: () => {},
            calls: { onCallCreated: () => {}, onCallAction: () => {} }, iceServersHandler: () => {},
        };
    }
    return origLoad.apply(this, arguments);
};
const { POLICY, findRule } = require(path.join(root, 'middleware/auth.js'));

test('POLICY: GET /api/users/by-id/:id — роли user, владелец по param 1', () => {
    const f = findRule({ method: 'GET', path: '/api/users/by-id/42' });
    assert.ok(f, 'правило найдено');
    assert.deepStrictEqual(f.rule.roles, ['user']);
    assert.deepStrictEqual(f.rule.ownerUser, { param: 1 });
    assert.strictEqual(f.match[1], '42');
});

// --- lib/auth.js: HS256
test('lib/auth: HS512-токен отклоняется, HS256 принимается', () => {
    const bad = jwt.sign({ id: 7, scope: 'user' }, process.env.JWT_SECRET, { algorithm: 'HS512' });
    assert.strictEqual(authCore.verifyAccessToken(bad), null);
    const ok = authCore.signUserToken({ id: 7, loyalty_id: '1111 2222', role: 'user' });
    assert.ok(authCore.verifyAccessToken(ok));
});

// --- index.js helpers, извлечённые из исходника
const src = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
function extract(name) {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `функция ${name} найдена в index.js`);
    let depth = 0; let i = src.indexOf('{', start);
    for (; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') { depth -= 1; if (depth === 0) break; }
    }
    return src.slice(start, i + 1);
}
const sandbox = {
    console: { warn: (...a) => sandbox.__warn.push(a.join(' ')), log: () => {} },
    __warn: [],
    authCore,
    devices: new Map(),
    socketDevices: new Map(),
};
vm.createContext(sandbox);
for (const name of ['normLoyaltyId', 'isPrivilegedAuth', 'restrictProfileForViewer', 'requestLoyaltyId', 'socketMayActAs']) {
    vm.runInContext(extract(name), sandbox);
}

test('index.js: trust proxy — число хопов, не true', () => {
    assert.ok(src.includes("app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));"));
    assert.ok(!src.includes("app.set('trust proxy', true)"));
});

test('index.js: лимитер платных вызовов подключён на /api/tts, /api/tour-assistant, /api/v2', () => {
    assert.ok(src.includes("app.use(['/api/tts', '/api/tour-assistant', '/api/v2'], paidLimiter());"));
});

const profile = { id: 5, loyaltyId: '1', name: 'A', email: 'a@x', phone: '7' };
test('restrictProfileForViewer: user видит чужой профиль без email/phone, свой — целиком', () => {
    delete process.env.AUTH_MODE;
    const other = sandbox.restrictProfileForViewer({ auth: { id: 9, role: 'user', payload: {} } }, { ...profile });
    assert.strictEqual(other.email, undefined); assert.strictEqual(other.phone, undefined); assert.strictEqual(other.name, 'A');
    const own = sandbox.restrictProfileForViewer({ auth: { id: 5, role: 'user', payload: {} } }, { ...profile });
    assert.strictEqual(own.email, 'a@x');
});
test('restrictProfileForViewer: agent/staff — полный; без токена в log — как раньше, в enforce — урезан', () => {
    assert.strictEqual(sandbox.restrictProfileForViewer({ auth: { id: 9, role: 'agent', payload: {} } }, { ...profile }).phone, '7');
    assert.strictEqual(sandbox.restrictProfileForViewer({ auth: { id: 9, role: 'staff', payload: {} } }, { ...profile }).phone, '7');
    delete process.env.AUTH_MODE;
    assert.strictEqual(sandbox.restrictProfileForViewer({ auth: null }, { ...profile }).phone, '7');
    process.env.AUTH_MODE = 'enforce';
    assert.strictEqual(sandbox.restrictProfileForViewer({ auth: null }, { ...profile }).phone, undefined);
    delete process.env.AUTH_MODE;
});

test('requestLoyaltyId: из токена user/agent, staff и без токена — null', () => {
    assert.strictEqual(sandbox.requestLoyaltyId({ auth: { role: 'user', payload: { loyalty_id: '12 34' } } }), '1234');
    assert.strictEqual(sandbox.requestLoyaltyId({ auth: { role: 'staff', payload: { loyalty_id: '12 34' } } }), null);
    assert.strictEqual(sandbox.requestLoyaltyId({ auth: null }), null);
});

test('socketMayActAs: своё устройство — да; чужое в enforce — нет, в log — да с предупреждением', () => {
    sandbox.socketDevices.set('s1', 'devA');
    sandbox.devices.set('devB', { loyaltyId: '9999' });
    const sock = { id: 's1', data: { auth: { id: 1, role: 'user', payload: { loyalty_id: '1111' } } } };
    assert.strictEqual(sandbox.socketMayActAs(sock, 'offer', 'devA'), true);
    assert.strictEqual(sandbox.socketMayActAs(sock, 'offer', undefined), true);
    process.env.AUTH_MODE = 'enforce';
    sandbox.__warn.length = 0;
    assert.strictEqual(sandbox.socketMayActAs(sock, 'offer', 'devB'), false);
    assert.ok(sandbox.__warn.some((w) => w.includes('fromDeviceId mismatch') && w.includes('ignored')));
    delete process.env.AUTH_MODE;
    sandbox.__warn.length = 0;
    assert.strictEqual(sandbox.socketMayActAs(sock, 'offer', 'devB'), true);
    assert.ok(sandbox.__warn.some((w) => w.includes('fromDeviceId mismatch')));
    // устройство того же loyalty_id, что и токен — можно
    sandbox.devices.set('devC', { loyaltyId: '11 11' });
    assert.strictEqual(sandbox.socketMayActAs(sock, 'answer', 'devC'), true);
    // старый клиент: ни registerDevice, ни токена — пропуск (log-режим)
    assert.strictEqual(sandbox.socketMayActAs({ id: 'sX', data: {} }, 'offer', 'devB'), true);
});

// --- paidLimiter
function makeReq(ip, p) { return { ip, method: 'POST', path: p, originalUrl: p, headers: {}, app: { get: () => 1 }, socket: { remoteAddress: ip }, connection: { remoteAddress: ip } }; }
function makeRes() {
    const res = { statusCode: 200, headers: {}, body: null };
    res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
    res.getHeader = (k) => res.headers[k.toLowerCase()];
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; }; res.send = res.json; res.end = () => res;
    return res;
}
function run(mw, req) {
    return new Promise((resolve) => {
        const res = makeRes(); let nexted = false;
        mw(req, res, () => { nexted = true; resolve({ res, nexted }); });
        setTimeout(() => resolve({ res, nexted }), 20);
    });
}
(async () => {
    const warnings = []; const origWarn = console.warn; console.warn = (...a) => warnings.push(a.join(' '));
    try {
        process.env.PAID_RATE_LIMIT = '2'; delete process.env.PAID_RATE_MODE;
        let mw = security.paidLimiter(); let r;
        for (let i = 0; i < 3; i += 1) r = await run(mw, makeReq('10.0.0.1', '/api/tts/synthesize'));
        assert.strictEqual(r.nexted, true); assert.ok(warnings.some((w) => w.includes('[RATE] paid mode=log exceeded')));
        passed += 1; console.log('ok   - paidLimiter log: пропускает, пишет [RATE]');
        process.env.PAID_RATE_MODE = 'enforce'; mw = security.paidLimiter();
        for (let i = 0; i < 3; i += 1) r = await run(mw, makeReq('10.0.0.2', '/api/tour-assistant'));
        assert.strictEqual(r.res.statusCode, 429); assert.deepStrictEqual(r.res.body, { error: 'too_many_requests' });
        passed += 1; console.log('ok   - paidLimiter enforce: 429');
        process.env.PAID_RATE_LIMIT = '0'; mw = security.paidLimiter();
        for (let i = 0; i < 5; i += 1) r = await run(mw, makeReq('10.0.0.3', '/api/tts/synthesize'));
        assert.strictEqual(r.nexted, true);
        passed += 1; console.log('ok   - PAID_RATE_LIMIT=0 выключает');
    } catch (e) { console.error(`FAIL - paidLimiter: ${e.message}`); process.exitCode = 1; }
    finally { console.warn = origWarn; }
    console.log(`\n${passed} проверок прошло${process.exitCode ? ', есть ошибки' : ''}`);
})();
