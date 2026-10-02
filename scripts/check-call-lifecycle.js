// Проверка: жизненный цикл звонка — состояние, таймаут, отмена, честный ответ при сбое push.
//
// Запуск: node scripts/check-call-lifecycle.js   (без БД, сети и npm install)
//
// Загружается настоящий index.js; express, socket.io, apn, firebase-admin, db и т. п.
// подменены заглушками в памяти. Вызываются реальные обработчики /api/register-device,
// /api/calls, /answer, /candidate, /reject, /end и сокетные registerDevice / ice-candidate /
// disconnect.
//
// Поломки (аудит calling flow S4, S5, P1-2), которые это воспроизводит:
//  - у звонка не было состояния: отбой звонящего не доходил до телефона, разбуженного push;
//    на закончившийся звонок можно было ответить; записи calls не удалялись;
//  - никто не ответил — звонок висел бесконечно (у исходящего из приложения своего таймаута нет);
//  - сбой APNs / FCM возвращался звонящему как 200 ok («гудки в никуда»), мёртвый токен не удалялся;
//  - полный SDP в push мог не влезть в лимит APNs 5 КБ / FCM 4 КБ.
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
  apnFail: new Map(), // token -> APNs reason
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
  world.apnFail = new Map();
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
      async send(note, token) {
        world.apn.push({ token, topic: note.topic, payload: note.payload, expiry: note.expiry, priority: note.priority });
        if (world.apnFail.has(token)) return { sent: [], failed: [{ device: token, status: '400', response: { reason: world.apnFail.get(token) } }] };
        return { sent: [{ device: token }], failed: [] };
      }
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
process.env.CALL_RING_TIMEOUT_MS = '1200'; // ускоренный таймаут звонка для проверки

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
out('call lifecycle (real index.js handlers, mocked IO)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CRLF = String.fromCharCode(13, 10); // без escape-последовательностей: коннектор GitHub их портит
const BIG_SDP = 'v=0' + CRLF + ('a=candidate:1 1 udp 2122260223 192.168.1.10 50000 typ host generation 0' + CRLF).repeat(80);

check('caller hangs up while the closed phone is waking up → woken phone is told "ended" on connect (CallKit stops ringing)', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  const agent = await agentCaller();
  const { callId } = await startCall(agent.deviceId, CLIENT);
  await call('POST', `/api/calls/${callId}/end`, { deviceId: agent.deviceId });
  const phoneSock = connectSocket(); // JS started by the VoIP push connects the socket
  await phoneSock.fire('registerDevice', { deviceId: PHONE_IOS, loyaltyId: CLIENT });
  assert.ok(emitsTo(phoneSock, 'call-state').some((e) => e.payload.callId === callId && e.payload.state === 'ended'), 'ended replayed');
}));

check('answered on the website while the phone app was closed → woken phone is told "ended" (answered_elsewhere)', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  await registerWeb(CLIENT, 'lc-web-1');
  const agent = await agentCaller();
  const { callId } = await startCall(agent.deviceId, CLIENT);
  await call('POST', `/api/calls/${callId}/answer`, { answer: ANSWER, deviceId: 'lc-web-1' });
  const phoneSock = connectSocket();
  await phoneSock.fire('registerDevice', { deviceId: PHONE_IOS, loyaltyId: CLIENT });
  const ev = emitsTo(phoneSock, 'call-state').find((e) => e.payload.callId === callId);
  assert.ok(ev && ev.payload.state === 'ended' && ev.payload.reason === 'answered_elsewhere', JSON.stringify(ev && ev.payload));
}));

check('phone connects while still ringing → nothing replayed (the call can still be answered)', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  const agent = await agentCaller();
  const { callId } = await startCall(agent.deviceId, CLIENT);
  const phoneSock = connectSocket();
  await phoneSock.fire('registerDevice', { deviceId: PHONE_IOS, loyaltyId: CLIENT });
  assert.ok(!emitsTo(phoneSock, 'call-state').some((e) => e.payload.callId === callId));
  const a = await call('POST', `/api/calls/${callId}/answer`, { answer: ANSWER, deviceId: PHONE_IOS });
  assert.strictEqual(a.status, 200);
}));

check('answer to a call the caller already cancelled → 410, caller is not told "answered"', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  const agent = await agentCaller();
  const { callId } = await startCall(agent.deviceId, CLIENT);
  await call('POST', `/api/calls/${callId}/end`, { deviceId: agent.deviceId });
  const a = await call('POST', `/api/calls/${callId}/answer`, { answer: ANSWER, deviceId: PHONE_IOS });
  assert.strictEqual(a.status, 410);
  assert.ok(!emitsTo(agent.socket, 'answer').some((e) => e.payload.callId === callId));
}));

check('nobody answers → after the ring timeout the call is missed: caller and ringing devices get "ended"', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  const web = await registerWeb(CLIENT, 'lc-web-2');
  const agent = await agentCaller();
  const { callId } = await startCall(agent.deviceId, CLIENT);
  await sleep(1500);
  assert.ok(emitsTo(agent.socket, 'call-state').some((e) => e.payload.callId === callId && e.payload.state === 'ended' && e.payload.reason === 'no_answer'), 'caller ended');
  assert.ok(emitsTo(web, 'call-state').some((e) => e.payload.callId === callId && e.payload.state === 'ended'), 'website stops ringing');
  const g = await call('GET', `/api/calls/${callId}`);
  assert.strictEqual(g.body.state, 'missed');
  const late = await call('POST', `/api/calls/${callId}/answer`, { answer: ANSWER, deviceId: PHONE_IOS });
  assert.strictEqual(late.status, 410);
}));

check('answered call is NOT ended by the ring timeout', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  const agent = await agentCaller();
  const { callId } = await startCall(agent.deviceId, CLIENT);
  await call('POST', `/api/calls/${callId}/answer`, { answer: ANSWER, deviceId: PHONE_IOS });
  await sleep(1500);
  assert.ok(!emitsTo(agent.socket, 'call-state').some((e) => e.payload.callId === callId && e.payload.state === 'ended'));
  assert.strictEqual((await call('GET', `/api/calls/${callId}`)).body.state, 'answered');
}));

check('APNs rejects the token and nothing else rings → 502 push_failed (not 200), dead token removed, caller told', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  world.apnFail.set(PHONE_IOS, 'BadDeviceToken');
  const agent = await agentCaller();
  const { callId, r } = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual(r.status, 502, JSON.stringify(r.body));
  assert.strictEqual(r.body.reason, 'BadDeviceToken');
  await sleep(10);
  assert.strictEqual(findUser(CLIENT).voipToken, null, 'dead token removed from users.voipToken');
  assert.ok(emitsTo(agent.socket, 'call-state').some((e) => e.payload.callId === callId && e.payload.state === 'ended' && e.payload.reason === 'unreachable'));
}));

check('APNs fails but the website rings → 200 with pushError, call keeps ringing', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  world.apnFail.set(PHONE_IOS, 'DeviceTokenNotForTopic');
  await registerWeb(CLIENT, 'lc-web-3');
  const agent = await agentCaller();
  const { callId, r } = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual(r.status, 200);
  assert.ok(/DeviceTokenNotForTopic/.test(r.body.pushError));
  assert.strictEqual(findUser(CLIENT).voipToken, PHONE_IOS, 'topic mismatch is not a dead token');
  assert.strictEqual((await call('GET', `/api/calls/${callId}`)).body.state, 'ringing');
}));

check('FCM says the token is invalid → 502 and the token is removed', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_ANDROID, 'android', false);
  world.fcmFail.add(PHONE_ANDROID);
  const agent = await agentCaller();
  const { r } = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual(r.status, 502, JSON.stringify(r.body));
  await sleep(10);
  assert.strictEqual(findUser(CLIENT).voipToken, null);
}));

check('large SDP: APNs payload without the offer (fits 5 KB), small SDP: offer still included', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  const agent = await agentCaller();
  const big = await call('POST', '/api/calls', { callId: newCallId(), toLoyaltyId: CLIENT, fromDeviceId: agent.deviceId, fromLoyaltyId: SUPPORT, offer: { type: 'offer', sdp: BIG_SDP } });
  assert.strictEqual(big.status, 200);
  const p1 = world.apn[world.apn.length - 1].payload;
  assert.ok(!p1.offer, 'offer dropped');
  assert.ok(Buffer.byteLength(JSON.stringify(p1)) < 4096);
  await startCall(agent.deviceId, CLIENT);
  const p2 = world.apn[world.apn.length - 1].payload;
  assert.ok(p2.offer && p2.offer.sdp, 'small offer kept');
  assert.ok(world.apn[world.apn.length - 1].expiry > Date.now() / 1000, 'expiry set');
  assert.strictEqual(world.apn[world.apn.length - 1].priority, 10);
}));

check('large SDP: FCM data without offerSdp (fits 4 KB)', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_ANDROID, 'android', false);
  const agent = await agentCaller();
  await call('POST', '/api/calls', { callId: newCallId(), toLoyaltyId: CLIENT, fromDeviceId: agent.deviceId, fromLoyaltyId: SUPPORT, offer: { type: 'offer', sdp: BIG_SDP } });
  const d = world.fcm[world.fcm.length - 1].data;
  assert.ok(!d.offerSdp);
  assert.strictEqual(d.type, 'incoming_call');
}));

check('GET /api/calls/:id reports state; rejected call cannot be answered', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  const agent = await agentCaller();
  const { callId } = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual((await call('GET', `/api/calls/${callId}`)).body.state, 'ringing');
  await call('POST', `/api/calls/${callId}/reject`, { deviceId: PHONE_IOS });
  assert.strictEqual((await call('GET', `/api/calls/${callId}`)).body.state, 'rejected');
  assert.strictEqual((await call('POST', `/api/calls/${callId}/answer`, { answer: ANSWER, deviceId: PHONE_IOS })).status, 410);
}));

check('device in an active call is not sent stale "ended" replays on reconnect', freshRun(async () => {
  const phoneSock = await registerPhone(CLIENT, PHONE_IOS, 'ios', true);
  const agent = await agentCaller();
  const first = await startCall(agent.deviceId, CLIENT);
  await call('POST', `/api/calls/${first.callId}/end`, { deviceId: agent.deviceId });
  const second = await startCall(agent.deviceId, CLIENT);
  await call('POST', `/api/calls/${second.callId}/answer`, { answer: ANSWER, deviceId: PHONE_IOS });
  world.emits = [];
  const again = connectSocket(); // reconnect during the conversation
  await again.fire('registerDevice', { deviceId: PHONE_IOS, loyaltyId: CLIENT });
  assert.strictEqual(emitsTo(again, 'call-state').length, 0);
  void phoneSock;
}));

(async () => {
  for (const run of pending) await run();
  out(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
