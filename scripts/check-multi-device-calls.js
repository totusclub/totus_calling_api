// Проверка: звонок приходит на ВСЕ устройства пользователя (телефон + сайт / панель).
//
// Запуск: node scripts/check-multi-device-calls.js   (без БД, сети и npm install)
//
// Загружается настоящий index.js; express, socket.io, apn, firebase-admin, db и т. п.
// подменены заглушками в памяти. Вызываются реальные обработчики /api/register-device,
// /api/calls, /answer, /candidate, /reject, /end и сокетные registerDevice / ice-candidate /
// disconnect.
//
// Поломка, которую это воспроизводит (02.10.2026, проверка владельцем после этапа 1):
// пользователь авторизован и в приложении, и на сайте → звонок не приходит на телефон.
//  - сайт регистрируется с voipToken "web-<uuid>" и затирает в users.voipToken токен телефона;
//  - loyaltyIdToDeviceId указывает на вкладку сайта → звонок уходит только в сокет сайта, без push;
//  - когда вкладки нет, "web-…" принимается за FCM-токен Android → 500.
'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      passed++;
      out(`  ok   ${name}`);
    } catch (e) {
      failed++;
      out(`  FAIL ${name}\n       ${e && e.message ? e.message : e}`);
    }
  });
}

// ------------------------------------------------------------------ in-memory world
const world = {
  users: [],
  emits: [], // {to, event, payload}
  apn: [], // {token, payload}
  fcm: [], // {token, data}
  fcmFail: new Set(), // tokens FCM rejects
  sockets: new Map(), // socket.id -> fake socket
};
function resetWorld() {
  world.users = [
    { id: 1, loyalty_id: '1111 2222 3333 4444', name: 'Клиент', voipToken: null, socketId: null, online: 0 },
    { id: 2, loyalty_id: '0978 6356 3712 8057', name: 'Поддержка', voipToken: null, socketId: null, online: 0 },
  ];
  world.emits = [];
  world.apn = [];
  world.fcm = [];
  world.fcmFail = new Set();
}
resetWorld();
const norm = (v) => String(v || '').replace(/\s+/g, '');
const findUser = (loyaltyId) => world.users.find((u) => norm(u.loyalty_id) === norm(loyaltyId)) || null;

// ------------------------------------------------------------------ mocks
function deepProxy() {
  const fn = function () { return proxy; };
  const proxy = new Proxy(fn, {
    get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : proxy),
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
}

const routes = [];
function compile(p) {
  const keys = [];
  const re = new RegExp('^' + String(p).replace(/:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }).replace(/\*/g, '.*') + '$');
  return { re, keys };
}
function makeApp() {
  const app = {};
  for (const m of ['get', 'post', 'put', 'patch', 'delete', 'options']) {
    app[m] = (p, ...handlers) => {
      if (m === 'get' && handlers.length === 0) return undefined; // app.get('setting')
      if (typeof p === 'string') routes.push({ method: m.toUpperCase(), path: p, ...compile(p), handlers: handlers.flat() });
      return app;
    };
  }
  app.use = () => app;
  app.set = () => app;
  app.listen = () => ({});
  app._router = { handle: (req, res) => dispatch(req.method, req.url, req.body, res) };
  return app;
}
function makeRes() {
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const res = {
    statusCode: 200,
    status(code) { res.statusCode = code; return res; },
    json(body) { resolve({ status: res.statusCode, body }); return res; },
    send(body) { resolve({ status: res.statusCode, body }); return res; },
    setHeader() {}, set() { return res; }, end() { resolve({ status: res.statusCode }); },
  };
  return { res, done };
}
function dispatch(method, url, body, res) {
  const route = routes.find((r) => r.method === method && r.re.test(url));
  if (!route) { res.status(404).json({ error: 'no route ' + method + ' ' + url }); return; }
  const m = route.re.exec(url);
  const params = {};
  route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
  const req = { method, url, path: url, params, body: body || {}, query: {}, headers: {}, get: () => undefined };
  let i = 0;
  const next = () => { const h = route.handlers[i++]; if (h) return h(req, res, next); };
  return next();
}
async function call(method, url, body) {
  const { res, done } = makeRes();
  await dispatch(method, url, body, res);
  return done;
}

class FakeIo {
  constructor() { this.sockets = { sockets: world.sockets }; this.handlers = {}; }
  use() {}
  on(ev, cb) { this.handlers[ev] = cb; }
  to(id) { return { emit: (event, payload) => world.emits.push({ to: id, event, payload }) }; }
  emit() {}
}
let ioInstance = null;
let socketSeq = 0;
function connectSocket() {
  const handlers = {};
  const socket = {
    id: 'sock-' + (++socketSeq), data: {}, handshake: { auth: {} },
    on(ev, cb) { (handlers[ev] = handlers[ev] || []).push(cb); },
    emit() {}, join() {}, leave() {}, to: () => ({ emit() {} }),
    async fire(ev, payload) { for (const cb of handlers[ev] || []) await cb(payload); },
  };
  world.sockets.set(socket.id, socket);
  ioInstance.handlers.connection(socket);
  return socket;
}
async function disconnectSocket(socket) {
  world.sockets.delete(socket.id);
  await socket.fire('disconnect');
}

const userDb = {
  async getUserDeviceInfoByLoyaltyId(l) { const u = findUser(l); return u ? { ...u } : null; },
  async getUserByLoyaltyId(l) { const u = findUser(l); return u ? { ...u } : null; },
  async getUserById(id) { const u = world.users.find((x) => x.id === id); return u ? { ...u } : null; },
  async getAllUsers() { return world.users.map((u) => ({ ...u })); },
  async updateUserDeviceInfo(id, voipToken, socketId) {
    const u = world.users.find((x) => x.id === id);
    if (voipToken !== undefined) u.voipToken = voipToken;
    if (socketId !== undefined) u.socketId = socketId;
    return { ...u };
  },
  async updateUserSocketId(id, socketId) {
    const u = world.users.find((x) => x.id === id);
    u.socketId = socketId; u.online = socketId ? 1 : 0;
    return { ...u };
  },
};

const MOCKS = {
  express: Object.assign(() => makeApp(), { json: () => (q, s, n) => n(), urlencoded: () => (q, s, n) => n(), static: () => (q, s, n) => n(), Router: () => makeApp() }),
  'body-parser': { json: () => (q, s, n) => n(), urlencoded: () => (q, s, n) => n() },
  cors: () => (q, s, n) => n(),
  uuid: { v4: () => 'uuid-' + Math.random().toString(16).slice(2) },
  http: { createServer: () => ({ listen() {} }) },
  'socket.io': { Server: class extends FakeIo { constructor() { super(); ioInstance = this; } } },
  apn: {
    Notification: class { constructor() { this.payload = {}; } },
    Provider: class {
      async send(note, token) { world.apn.push({ token, topic: note.topic, payload: note.payload }); return { sent: [{ device: token }], failed: [] }; }
    },
  },
  'firebase-admin': {
    initializeApp: () => ({}),
    credential: { cert: () => ({}) },
    messaging: () => ({
      async send(message) {
        if (world.fcmFail.has(message.token) || /^web-/.test(message.token)) {
          throw new Error('The registration token is not a valid FCM registration token');
        }
        world.fcm.push({ token: message.token, data: message.data });
        return 'fcm-msg-1';
      },
    }),
  },
  axios: deepProxy(),
  bcryptjs: deepProxy(),
};
const LOCAL_MOCKS = {
  [path.join(root, 'db')]: { userDb, contactDb: { addContact: async () => ({}) }, favoriteDb: deepProxy() },
  [path.join(root, 'ttsService')]: { synthesizeSpeech: async () => ({}), synthesizeSpeechToFile: async () => ({}) },
  [path.join(root, 'lib/auth')]: { authMode: () => 'log', signAgentToken: () => 't', signRefreshToken: () => 'r' },
  [path.join(root, 'lib/security')]: { corsOrigin: () => true, corsOptions: {}, loginLimiter: (q, s, n) => n(), allowedOrigins: () => [] },
  [path.join(root, 'middleware/auth')]: { httpGate: (q, s, n) => n(), socketGate: (s, n) => n && n(), socketLoyaltyId: () => null },
  [path.join(root, 'lib/env')]: { env: (n) => process.env[n], requireEnv: (n) => process.env[n], reportEnv: () => {} },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(MOCKS, request)) return MOCKS[request];
  if (request.startsWith('.') && parent && parent.filename) {
    const abs = path.resolve(path.dirname(parent.filename), request).replace(/\.js$/, '');
    if (LOCAL_MOCKS[abs]) return LOCAL_MOCKS[abs];
    if (abs.startsWith(path.join(root, 'tour-assistant'))) return deepProxy();
    if (request.endsWith('.json') && abs.includes('firebase')) return {};
  }
  try {
    return origLoad.apply(this, arguments);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && !request.startsWith('.')) return deepProxy();
    throw e;
  }
};

process.env.APN_KEY_PATH = '/tmp/none.p8';
process.env.APN_KEY_ID = 'K';
process.env.APN_TEAM_ID = 'T';
process.env.FIREBASE_CREDENTIALS_PATH = '/tmp/firebase-fake.json';
process.env.PORT = '0';

// Логи index.js глушим (CHECK_VERBOSE=1 — показать); результаты печатает out()
const out = console.log.bind(console);
if (!process.env.CHECK_VERBOSE) { console.log = () => {}; console.warn = () => {}; console.error = () => {}; }
require(path.join(root, 'index.js'));

// ------------------------------------------------------------------ helpers
const PHONE_IOS = 'a'.repeat(64);
const PHONE_ANDROID = 'fcmToken123:APA91bHPRgkF-android';
const CLIENT = '1111 2222 3333 4444';
const SUPPORT = '0978 6356 3712 8057';
const OFFER = { type: 'offer', sdp: 'v=0 offer' };
const ANSWER = { type: 'answer', sdp: 'v=0 answer' };
let callSeq = 0;
const newCallId = () => 'call-' + (++callSeq);
const emitsTo = (socket, event) => world.emits.filter((e) => e.to === socket.id && (!event || e.event === event));

async function registerPhone(loyaltyId, token, platform, withSocket) {
  const r = await call('POST', '/api/register-device', { deviceId: token, loyaltyId, voipToken: token, platform });
  assert.strictEqual(r.status, 200, 'phone register ' + JSON.stringify(r.body));
  if (!withSocket) return null;
  const s = connectSocket();
  await s.fire('registerDevice', { deviceId: token, loyaltyId });
  return s;
}
async function registerWeb(loyaltyId, deviceId) {
  const r = await call('POST', '/api/register-device', { deviceId, loyaltyId, voipToken: 'web-' + deviceId, platform: 'web' });
  assert.strictEqual(r.status, 200, 'web register ' + JSON.stringify(r.body));
  const s = connectSocket();
  await s.fire('registerDevice', { deviceId, loyaltyId });
  return s;
}
async function agentCaller() {
  const s = await registerWeb(SUPPORT, 'agent-tab-' + (++callSeq));
  return { socket: s, deviceId: 'agent-tab-' + callSeq };
}
async function startCall(callerDeviceId, toLoyaltyId) {
  const callId = newCallId();
  const r = await call('POST', '/api/calls', { callId, toLoyaltyId, fromDeviceId: callerDeviceId, fromLoyaltyId: SUPPORT, callerName: 'x', offer: OFFER });
  return { callId, r };
}
function freshRun(fn) {
  return async () => {
    // закрыть сокеты прошлого сценария (карты index.js живут между сценариями)
    for (const s of Array.from(world.sockets.values())) await disconnectSocket(s);
    resetWorld();
    // карты index.js живут между сценариями — у каждого сценария свои deviceId
    await fn();
  };
}

// ------------------------------------------------------------------ scenarios
out('multi-device calls (real index.js handlers, mocked IO)');

check('client in iOS app (killed) AND on the website → call rings on BOTH: VoIP push + website socket', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  const web = await registerWeb(CLIENT, 'client-web-1');
  assert.strictEqual(findUser(CLIENT).voipToken, PHONE_IOS, 'website must not overwrite the phone VoIP token in users.voipToken');
  const agent = await agentCaller();
  const { callId, r } = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(world.apn.map((p) => p.token), [PHONE_IOS], 'VoIP push to the phone');
  assert.strictEqual(emitsTo(web, 'offer').filter((e) => e.payload.callId === callId).length, 1, 'offer to the website');
}));

check('website opened AFTER the app and the app is killed: phone still gets the push (was: only the website rang)', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  await registerWeb(CLIENT, 'client-web-2');
  await registerWeb(CLIENT, 'client-web-3'); // second tab
  const agent = await agentCaller();
  const { r } = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(world.apn.length, 1);
}));

check('website tab closed, app killed → call goes to the phone push (was: "web-…" sent to FCM → 500)', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  const web = await registerWeb(CLIENT, 'client-web-4');
  await disconnectSocket(web);
  const agent = await agentCaller();
  const { r } = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(world.apn.map((p) => p.token), [PHONE_IOS]);
  assert.strictEqual(world.fcm.length, 0);
}));

check('Android app + website → FCM push to the phone AND offer to the website', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_ANDROID, 'android', false);
  const web = await registerWeb(CLIENT, 'client-web-5');
  const agent = await agentCaller();
  const { callId, r } = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(world.fcm.map((m) => m.token), [PHONE_ANDROID]);
  assert.strictEqual(emitsTo(web, 'offer').filter((e) => e.payload.callId === callId).length, 1);
}));

check('push fails but the website rang → caller is NOT told "failed" (200 + pushError)', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_ANDROID, 'android', false);
  world.fcmFail.add(PHONE_ANDROID);
  await registerWeb(CLIENT, 'client-web-6');
  const agent = await agentCaller();
  const { r } = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.pushError, 'pushError reported');
}));

check('phone answers first → website stops ringing (call-state ended), caller gets the answer', freshRun(async () => {
  const phoneSock = await registerPhone(CLIENT, PHONE_IOS, 'ios', true);
  const web = await registerWeb(CLIENT, 'client-web-7');
  const agent = await agentCaller();
  const { callId } = await startCall(agent.deviceId, CLIENT);
  const a = await call('POST', `/api/calls/${callId}/answer`, { answer: ANSWER, deviceId: PHONE_IOS });
  assert.strictEqual(a.status, 200);
  assert.ok(emitsTo(web, 'call-state').some((e) => e.payload.callId === callId && e.payload.state === 'ended' && e.payload.reason === 'answered_elsewhere'), 'website told to stop ringing');
  assert.ok(!emitsTo(phoneSock, 'call-state').some((e) => e.payload.callId === callId && e.payload.state === 'ended'), 'answering phone is NOT ended');
  assert.ok(emitsTo(agent.socket, 'answer').some((e) => e.payload.callId === callId), 'caller got the answer');
}));

check('website answers first → late answer from the phone gets 409, conversation is not hijacked', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  await registerWeb(CLIENT, 'client-web-8');
  const agent = await agentCaller();
  const { callId } = await startCall(agent.deviceId, CLIENT);
  const a = await call('POST', `/api/calls/${callId}/answer`, { answer: ANSWER, deviceId: 'client-web-8' });
  assert.strictEqual(a.status, 200);
  const late = await call('POST', `/api/calls/${callId}/answer`, { answer: ANSWER, deviceId: PHONE_IOS });
  assert.strictEqual(late.status, 409);
  const answersToCaller = emitsTo(agent.socket, 'answer').filter((e) => e.payload.callId === callId);
  assert.strictEqual(answersToCaller.length, 1, 'caller got exactly one answer');
}));

check('after the website answered, the phone hanging up its ringing CallKit does NOT end the conversation', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  await registerWeb(CLIENT, 'client-web-9');
  const agent = await agentCaller();
  const { callId } = await startCall(agent.deviceId, CLIENT);
  await call('POST', `/api/calls/${callId}/answer`, { answer: ANSWER, deviceId: 'client-web-9' });
  await call('POST', `/api/calls/${callId}/end`, { deviceId: PHONE_IOS });
  assert.ok(!emitsTo(agent.socket, 'call-state').some((e) => e.payload.callId === callId && e.payload.state === 'ended'), 'caller not ended');
}));

check('caller ICE candidates before the answer reach every ringing device and are replayed to the answering one', freshRun(async () => {
  const phoneSock = await registerPhone(CLIENT, PHONE_IOS, 'ios', true);
  const web = await registerWeb(CLIENT, 'client-web-10');
  const agent = await agentCaller();
  const { callId } = await startCall(agent.deviceId, CLIENT);
  await call('POST', `/api/calls/${callId}/candidate`, { from: 'caller', candidate: { candidate: 'c1' } });
  await agent.socket.fire('ice-candidate', { callId, candidate: { candidate: 'c2' }, fromDeviceId: agent.deviceId, toDeviceId: PHONE_IOS });
  for (const s of [web, phoneSock]) {
    const got = emitsTo(s, 'ice-candidate').filter((e) => e.payload.callId === callId).map((e) => e.payload.candidate.candidate);
    assert.ok(got.includes('c1') && got.includes('c2'), 'both candidates delivered to ' + s.id + ': ' + got);
  }
  world.emits = [];
  await call('POST', `/api/calls/${callId}/answer`, { answer: ANSWER, deviceId: 'client-web-10' });
  const replayed = emitsTo(web, 'ice-candidate').filter((e) => e.payload.callId === callId).map((e) => e.payload.candidate.candidate);
  assert.deepStrictEqual(replayed.sort(), ['c1', 'c2']);
  await call('POST', `/api/calls/${callId}/candidate`, { from: 'caller', candidate: { candidate: 'c3' } });
  assert.ok(!emitsTo(phoneSock, 'ice-candidate').some((e) => e.payload.candidate.candidate === 'c3'), 'after the answer only the answering device gets candidates');
}));

check('caller hangs up before the answer → every ringing device gets ended', freshRun(async () => {
  const phoneSock = await registerPhone(CLIENT, PHONE_IOS, 'ios', true);
  const web = await registerWeb(CLIENT, 'client-web-11');
  const agent = await agentCaller();
  const { callId } = await startCall(agent.deviceId, CLIENT);
  await call('POST', `/api/calls/${callId}/end`, { deviceId: agent.deviceId });
  for (const s of [web, phoneSock]) {
    assert.ok(emitsTo(s, 'call-state').some((e) => e.payload.callId === callId && e.payload.state === 'ended'), 'ended to ' + s.id);
  }
}));

check('declined on the website → caller told rejected, phone stops ringing', freshRun(async () => {
  const phoneSock = await registerPhone(CLIENT, PHONE_IOS, 'ios', true);
  await registerWeb(CLIENT, 'client-web-12');
  const agent = await agentCaller();
  const { callId } = await startCall(agent.deviceId, CLIENT);
  await call('POST', `/api/calls/${callId}/reject`, { deviceId: 'client-web-12' });
  assert.ok(emitsTo(agent.socket, 'call-state').some((e) => e.payload.callId === callId && e.payload.state === 'rejected'));
  assert.ok(emitsTo(phoneSock, 'call-state').some((e) => e.payload.callId === callId && e.payload.state === 'ended'));
}));

check('support account on the web panel AND the Support app (iOS): customer call rings on both', freshRun(async () => {
  await registerPhone(SUPPORT, 'b'.repeat(64), 'ios', false);
  const panel = await registerWeb(SUPPORT, 'panel-tab-1');
  const customer = await registerWeb(CLIENT, 'client-web-13');
  const callId = newCallId();
  const r = await call('POST', '/api/calls', { callId, toLoyaltyId: SUPPORT, fromDeviceId: 'client-web-13', fromLoyaltyId: CLIENT, offer: OFFER });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(world.apn.map((p) => p.token), ['b'.repeat(64)]);
  assert.ok(emitsTo(panel, 'offer').some((e) => e.payload.callId === callId));
  assert.ok(!emitsTo(customer, 'offer').some((e) => e.payload.callId === callId), 'caller does not ring itself');
}));

check('stale disconnect after reconnect does not make the website unreachable (S1)', freshRun(async () => {
  const oldSock = await registerWeb(CLIENT, 'client-web-14');
  const newSock = connectSocket();
  await newSock.fire('registerDevice', { deviceId: 'client-web-14', loyaltyId: CLIENT });
  await disconnectSocket(oldSock); // late disconnect of the old socket
  assert.strictEqual(findUser(CLIENT).online, 1, 'still online');
  const agent = await agentCaller();
  const { callId, r } = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(emitsTo(newSock, 'offer').some((e) => e.payload.callId === callId), 'offer reaches the new socket');
}));

check('phone socket after a server restart is a phone, not "web" → push still sent (S6)', freshRun(async () => {
  const token = 'c'.repeat(64);
  findUser(CLIENT).voipToken = token; // in DB from before the restart, no HTTP register yet
  const s = connectSocket();
  await s.fire('registerDevice', { deviceId: token, loyaltyId: CLIENT });
  const agent = await agentCaller();
  const { r } = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(world.apn.map((p) => p.token), [token]);
}));

check('already-overwritten users.voipToken "web-…" and no live website → honest 404, not FCM 500', freshRun(async () => {
  findUser(CLIENT).voipToken = 'web-old-uuid';
  const agent = await agentCaller();
  const { r } = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual(r.status, 404, JSON.stringify(r.body));
  assert.strictEqual(world.fcm.length, 0);
}));

check('regression: website-only user → socket offer, platform web', freshRun(async () => {
  const web = await registerWeb(CLIENT, 'client-web-15');
  const agent = await agentCaller();
  const { callId, r } = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.platform, 'web');
  assert.ok(emitsTo(web, 'offer').some((e) => e.payload.callId === callId));
  assert.strictEqual(world.apn.length + world.fcm.length, 0);
}));

check('regression: phone-only user → push only', freshRun(async () => {
  await registerPhone(CLIENT, 'd'.repeat(64), 'ios', false);
  const agent = await agentCaller();
  const { r } = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.apnResult && r.body.apnResult.sent === 1);
}));

(async () => {
  for (const run of pending) await run();
  out(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
