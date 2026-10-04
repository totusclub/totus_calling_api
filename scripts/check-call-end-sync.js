// Проверка: завершённый звонок не «оживает», следующий звонок приходит на ВСЕ телефоны.
//
// Запуск: node scripts/check-call-end-sync.js   (без БД, сети и npm install)
//
// Сценарий владельца 05.10.2026: аккаунт открыт на Android, iOS и сайте → звонок → ответ и
// отбой на сайте → второй звонок не пришёл ни на Android, ни на iOS → при открытии приложений
// показывался «Входящий» уже завершённого звонка. Причины на сервере:
//  - push звонка уходил одному телефону (users.voipToken перезаписывал последний открытый);
//  - телефону, получившему push, никто не сообщал, что звонок закончился (только живым сокетам),
//    повтор 'ended' — 3 мин от НАЧАЛА звонка, через 10 мин звонок забывался (GET → 404).
// Загружается настоящий index.js (заглушки как в check-call-lifecycle.js).
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
  callDevices: new Map(),
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
  world.callDevices = new Map();
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

// call_devices (db.js) в памяти: token -> {userId, platform, supportsCancel, updatedAt}
const callDeviceDb = {
  available: true,
  async ensureTable() { return true; },
  async upsert(userId, token, platform, supportsCancel) {
    world.callDevices.set(token, { userId, platform, supportsCancel: Boolean(supportsCancel), updatedAt: Date.now() });
    return true;
  },
  async listByUser(userId) {
    return Array.from(world.callDevices.entries())
      .filter(([, d]) => d.userId === userId)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .map(([token, d]) => ({ token, platform: d.platform, supportsCancel: d.supportsCancel }));
  },
  async releaseFromOtherUsers(token, userId) {
    for (const u of world.users) if (u.voipToken === token && u.id !== userId) u.voipToken = null;
    return true;
  },
  async remove(token) { world.callDevices.delete(token); return true; },
  async removeAllForUser(userId) {
    for (const [t, d] of Array.from(world.callDevices.entries())) if (d.userId === userId) world.callDevices.delete(t);
    return true;
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
  [path.join(root, 'db')]: { userDb, callDeviceDb, contactDb: { addContact: async () => ({}) }, favoriteDb: deepProxy() },
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
// Управляемые часы (разговор дольше 3 мин, очистка звонков) и ручной запуск sweepCalls
let clockOffset = 0;
const realNow = Date.now;
Date.now = () => realNow() + clockOffset;
const advance = (ms) => { clockOffset += ms; };
let sweepCalls = null;
const realSetInterval = global.setInterval;
global.setInterval = (fn, ms, ...a) => {
  if (ms === 60 * 1000 && !sweepCalls) sweepCalls = fn;
  return realSetInterval(fn, ms, ...a);
};
require(path.join(root, 'index.js'));
global.setInterval = realSetInterval;

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

async function registerPhone(loyaltyId, token, platform, withSocket, callEndedPush = true) {
  const body = { deviceId: token, loyaltyId, voipToken: token, platform };
  if (callEndedPush) body.callEndedPush = true;
  const r = await call('POST', '/api/register-device', body);
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
out('call end sync: Web + Android + iOS (real index.js handlers, mocked IO)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PHONE_IOS_2 = 'b'.repeat(64);
const cancelApn = (token, callId) => world.apn.filter((p) => p.token === token && p.payload.type === 'call_ended' && (!callId || p.payload.callId === callId));
const incomingApn = (token, callId) => world.apn.filter((p) => p.token === token && p.payload.type !== 'call_ended' && (!callId || p.payload.callId === callId));
const cancelFcm = (token, callId) => world.fcm.filter((p) => p.token === token && p.data.type === 'call_ended' && (!callId || p.data.callId === callId));
const incomingFcm = (token, callId) => world.fcm.filter((p) => p.token === token && p.data.type === 'incoming_call' && (!callId || p.data.callId === callId));

check('OWNER SCENARIO: answer + hang up on the website → both phones told the call ended; call 2 rings on BOTH phones', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  await registerPhone(CLIENT, PHONE_ANDROID, 'android', false); // Android opened last
  await registerWeb(CLIENT, 'es-web-1');
  const agent = await agentCaller();
  const c1 = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual(c1.r.status, 200, JSON.stringify(c1.r.body));
  assert.strictEqual(incomingApn(PHONE_IOS, c1.callId).length, 1, 'iOS rings for call 1');
  assert.strictEqual(incomingFcm(PHONE_ANDROID, c1.callId).length, 1, 'Android rings for call 1');
  await call('POST', `/api/calls/${c1.callId}/answer`, { answer: ANSWER, deviceId: 'es-web-1' });
  await sleep(10);
  const ia = cancelApn(PHONE_IOS, c1.callId);
  assert.strictEqual(ia.length, 1, 'iOS gets call_ended VoIP push');
  assert.strictEqual(ia[0].payload.uuid, c1.callId, 'same UUID as the CallKit call');
  assert.strictEqual(ia[0].payload.reason, 'answered_elsewhere');
  assert.strictEqual(ia[0].priority, 10);
  assert.ok(ia[0].expiry > Date.now() / 1000 && ia[0].expiry <= Date.now() / 1000 + 61, 'short expiry');
  assert.strictEqual(cancelFcm(PHONE_ANDROID, c1.callId).length, 1, 'Android gets call_ended FCM');
  assert.strictEqual(cancelFcm(PHONE_ANDROID, c1.callId)[0].data.reason, 'answered_elsewhere');
  advance(4 * 60 * 1000); // 4-minute conversation
  const end = await call('POST', `/api/calls/${c1.callId}/end`, { deviceId: 'es-web-1' });
  assert.strictEqual(end.status, 200);
  await sleep(10);
  assert.ok(emitsTo(agent.socket, 'call-state').some((e) => e.payload.callId === c1.callId && e.payload.state === 'ended'), 'caller told');
  assert.strictEqual(cancelApn(PHONE_IOS, c1.callId).length, 1, 'no duplicate cancel');
  assert.strictEqual(cancelFcm(PHONE_ANDROID, c1.callId).length, 1, 'no duplicate cancel');
  const c2 = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual(c2.r.status, 200);
  assert.strictEqual(incomingApn(PHONE_IOS, c2.callId).length, 1, 'iOS rings for call 2');
  assert.strictEqual(incomingFcm(PHONE_ANDROID, c2.callId).length, 1, 'Android rings for call 2');
  assert.strictEqual((await call('GET', `/api/calls/${c1.callId}`)).body.state, 'ended');
}));

check('two phones: the one opened earlier still gets the call (no more single users.voipToken)', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_ANDROID, 'android', false);
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false); // iOS opened last
  const agent = await agentCaller();
  const c = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual(c.r.status, 200);
  assert.strictEqual(incomingFcm(PHONE_ANDROID, c.callId).length, 1, 'Android rings');
  assert.strictEqual(incomingApn(PHONE_IOS, c.callId).length, 1, 'iOS rings');
  assert.deepStrictEqual(c.r.body.push.map((p) => p.ok), [true, true]);
}));

check('old app (no callEndedPush in register) gets the call but never a cancel push (it would ring)', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false, false);
  await registerPhone(CLIENT, PHONE_ANDROID, 'android', false, false);
  await registerWeb(CLIENT, 'es-web-2');
  const agent = await agentCaller();
  const c = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual(incomingApn(PHONE_IOS, c.callId).length, 1);
  assert.strictEqual(incomingFcm(PHONE_ANDROID, c.callId).length, 1);
  await call('POST', `/api/calls/${c.callId}/answer`, { answer: ANSWER, deviceId: 'es-web-2' });
  await call('POST', `/api/calls/${c.callId}/end`, { deviceId: 'es-web-2' });
  await sleep(10);
  assert.strictEqual(cancelApn(PHONE_IOS).length + cancelFcm(PHONE_ANDROID).length, 0);
}));

check('caller cancels before anyone answers → cancel push to every phone (caller_cancel)', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  await registerPhone(CLIENT, PHONE_ANDROID, 'android', false);
  const agent = await agentCaller();
  const c = await startCall(agent.deviceId, CLIENT);
  await call('POST', `/api/calls/${c.callId}/end`, { deviceId: agent.deviceId });
  await sleep(10);
  assert.strictEqual(cancelApn(PHONE_IOS, c.callId)[0].payload.reason, 'caller_cancel');
  assert.strictEqual(cancelFcm(PHONE_ANDROID, c.callId)[0].data.reason, 'caller_cancel');
}));

check('nobody answers (ring timeout) → cancel push to every phone (missed)', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  await registerPhone(CLIENT, PHONE_ANDROID, 'android', false);
  const agent = await agentCaller();
  const c = await startCall(agent.deviceId, CLIENT);
  await sleep(1500);
  assert.strictEqual(cancelApn(PHONE_IOS, c.callId)[0].payload.reason, 'missed');
  assert.strictEqual(cancelFcm(PHONE_ANDROID, c.callId)[0].data.reason, 'missed');
}));

check('declined on Android → iOS told (rejected), Android itself not', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  await registerPhone(CLIENT, PHONE_ANDROID, 'android', false);
  const agent = await agentCaller();
  const c = await startCall(agent.deviceId, CLIENT);
  await call('POST', `/api/calls/${c.callId}/reject`, { deviceId: PHONE_ANDROID });
  await sleep(10);
  assert.strictEqual(cancelApn(PHONE_IOS, c.callId)[0].payload.reason, 'rejected');
  assert.strictEqual(cancelFcm(PHONE_ANDROID, c.callId).length, 0);
}));

check('answered on iOS → Android told (answered_elsewhere); caller hangs up while iOS socket is gone → iOS told (hangup)', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  await registerPhone(CLIENT, PHONE_ANDROID, 'android', false);
  const agent = await agentCaller();
  const c = await startCall(agent.deviceId, CLIENT);
  await call('POST', `/api/calls/${c.callId}/answer`, { answer: ANSWER, deviceId: PHONE_IOS });
  await sleep(10);
  assert.strictEqual(cancelFcm(PHONE_ANDROID, c.callId)[0].data.reason, 'answered_elsewhere');
  assert.strictEqual(cancelApn(PHONE_IOS, c.callId).length, 0, 'answering phone not cancelled');
  await call('POST', `/api/calls/${c.callId}/end`, { deviceId: agent.deviceId });
  await sleep(10);
  assert.strictEqual(cancelApn(PHONE_IOS, c.callId).length, 1);
  assert.strictEqual(cancelApn(PHONE_IOS, c.callId)[0].payload.reason, 'hangup');
  assert.strictEqual(cancelFcm(PHONE_ANDROID, c.callId).length, 1, 'Android not told twice');
}));

check('answered on iOS with a live socket, caller hangs up → socket "ended" is enough, no cancel push to iOS', freshRun(async () => {
  const sock = await registerPhone(CLIENT, PHONE_IOS, 'ios', true);
  const agent = await agentCaller();
  const c = await startCall(agent.deviceId, CLIENT);
  await call('POST', `/api/calls/${c.callId}/answer`, { answer: ANSWER, deviceId: PHONE_IOS });
  await call('POST', `/api/calls/${c.callId}/end`, { deviceId: agent.deviceId });
  await sleep(10);
  assert.ok(emitsTo(sock, 'call-state').some((e) => e.payload.callId === c.callId && e.payload.state === 'ended'));
  assert.strictEqual(cancelApn(PHONE_IOS, c.callId).length, 0);
}));

check('conversation longer than 3 min, then the phone app is opened → "ended" still replayed (window counts from the end)', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS_2, 'ios', false);
  await registerWeb(CLIENT, 'es-web-3');
  const agent = await agentCaller();
  const c = await startCall(agent.deviceId, CLIENT);
  await call('POST', `/api/calls/${c.callId}/answer`, { answer: ANSWER, deviceId: 'es-web-3' });
  advance(5 * 60 * 1000);
  await call('POST', `/api/calls/${c.callId}/end`, { deviceId: 'es-web-3' });
  advance(2 * 60 * 1000);
  const phoneSock = connectSocket();
  await phoneSock.fire('registerDevice', { deviceId: PHONE_IOS_2, loyaltyId: CLIENT });
  assert.ok(emitsTo(phoneSock, 'call-state').some((e) => e.payload.callId === c.callId && e.payload.state === 'ended'), 'ended replayed');
}));

check('hours later the call is gone from memory → GET /api/calls/:id answers its final state, not 404', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  await registerWeb(CLIENT, 'es-web-4');
  const agent = await agentCaller();
  const c = await startCall(agent.deviceId, CLIENT);
  await call('POST', `/api/calls/${c.callId}/answer`, { answer: ANSWER, deviceId: 'es-web-4' });
  await call('POST', `/api/calls/${c.callId}/end`, { deviceId: 'es-web-4' });
  advance(30 * 60 * 1000);
  assert.ok(sweepCalls, 'sweep captured');
  sweepCalls();
  const g = await call('GET', `/api/calls/${c.callId}`);
  assert.strictEqual(g.status, 200, JSON.stringify(g.body));
  assert.strictEqual(g.body.state, 'ended');
  assert.strictEqual(g.body.endReason, 'hangup');
  assert.strictEqual(g.body.answeredBy, 'es-web-4');
  assert.strictEqual(g.body.offer, null);
  const late = await call('POST', `/api/calls/${c.callId}/answer`, { answer: ANSWER, deviceId: PHONE_IOS });
  assert.notStrictEqual(late.status, 200, 'late answer refused');
}));

check('logout on one phone (new app sends deviceId) → the other phone keeps ringing', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  await registerPhone(CLIENT, PHONE_ANDROID, 'android', false);
  const out1 = await call('POST', '/api/unregister-device', { loyaltyId: CLIENT, deviceId: PHONE_ANDROID });
  assert.strictEqual(out1.status, 200);
  const agent = await agentCaller();
  const c = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual(incomingApn(PHONE_IOS, c.callId).length, 1, 'iOS still rings');
  assert.strictEqual(incomingFcm(PHONE_ANDROID, c.callId).length, 0, 'logged-out Android does not');
}));

check('logout from an old app (no deviceId) → no phone rings any more (previous behaviour kept)', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  await registerPhone(CLIENT, PHONE_ANDROID, 'android', false);
  await call('POST', '/api/unregister-device', { loyaltyId: CLIENT });
  await registerWeb(CLIENT, 'es-web-5');
  const agent = await agentCaller();
  const c = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual(incomingApn(PHONE_IOS, c.callId).length + incomingFcm(PHONE_ANDROID, c.callId).length, 0);
}));

check('dead token on one phone → removed, the other phone still rings, caller gets 200', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_IOS, 'ios', false);
  await registerPhone(CLIENT, PHONE_ANDROID, 'android', false);
  world.fcmFail.add(PHONE_ANDROID);
  const agent = await agentCaller();
  const c = await startCall(agent.deviceId, CLIENT);
  assert.strictEqual(c.r.status, 200, JSON.stringify(c.r.body));
  assert.ok(/FCM/.test(c.r.body.pushError));
  await sleep(10);
  assert.ok(!world.callDevices.has(PHONE_ANDROID), 'dead token removed');
  assert.strictEqual(incomingApn(PHONE_IOS, c.callId).length, 1);
}));

check('account switch: a phone registered by another user stops ringing for the previous one', freshRun(async () => {
  await registerPhone(CLIENT, PHONE_ANDROID, 'android', false);
  await registerPhone(SUPPORT, PHONE_ANDROID, 'android', false);
  await registerWeb(CLIENT, 'es-web-6');
  const agentTab = await registerWeb(SUPPORT, 'es-agent-x');
  const c = await startCall('es-agent-x', CLIENT);
  assert.strictEqual(incomingFcm(PHONE_ANDROID, c.callId).length, 0);
  void agentTab;
}));

(async () => {
  for (const run of pending) await run();
  out(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
