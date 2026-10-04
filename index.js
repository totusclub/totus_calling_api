// backend/index.js
//
// Simple backend for:
// - registering devices with VoIP push tokens
// - starting calls and sending iOS VoIP pushes via APNs
// - acting as a very basic WebRTC signaling server (offer/answer/candidates)
//
// Run:
//   cd backend
//   npm install
//   npm start

const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const {v4: uuidv4} = require('uuid');
const apn = require('apn');
const admin = require('firebase-admin');
const http = require('http');
const {Server} = require('socket.io');
const {userDb, contactDb, favoriteDb, callDeviceDb: callDeviceDbFromDb} = require('./db');
// Телефоны пользователя для звонков (db.js); без таблицы — прежняя схема с users.voipToken
const callDeviceDb = callDeviceDbFromDb || {
  available: false,
  ensureTable: async () => false,
  upsert: async () => false,
  releaseFromOtherUsers: async () => false,
  listByUser: async () => [],
  remove: async () => false,
  removeAllForUser: async () => false,
};
callDeviceDb.ensureTable().catch(() => {});
const {synthesizeSpeech, synthesizeSpeechToFile} = require('./ttsService');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const authCore = require('./lib/auth');
const { corsOrigin, corsOptions, loginLimiter, allowedOrigins } = require('./lib/security');
const { httpGate, socketGate, socketLoyaltyId } = require('./middleware/auth');
// Секреты только из .env (Б.1, SECURITY_AUDIT_SECRETS_RU.md) — без fallback-литералов и файлов в репо.
const { env, requireEnv, reportEnv } = require('./lib/env');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: corsOrigin, // whitelist из lib/security.js (в AUTH_MODE=log — пропуск с логом)
  },
});

// Trust proxy (important if behind reverse proxy/load balancer)
app.set('trust proxy', true);

// CORS: whitelist origin'ов (CORS_ORIGINS / lib/security.js). Preflight обрабатывается
// пакетом cors первым, до любых редиректов. В AUTH_MODE=log неизвестный origin
// пропускается с записью [CORS] в лог, в enforce — блокируется.
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

app.use(bodyParser.json());
// Simple request logger so you can see every hit
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// JWT-гейт по политике путей (middleware/auth.js). AUTH_MODE=log — только лог, enforce — 401/403.
app.use(httpGate);

// In-memory stores (for active calls and WebRTC signaling)
const devices = new Map(); // deviceId -> { userId, loyaltyId, platform, voipToken, socketId }
const calls = new Map();   // callId  -> { fromUserId, fromLoyaltyId, fromDeviceId, toDeviceId, toLoyaltyId, offer, answer }
const callCandidates = new Map(); // callId -> { caller: [], callee: [] }
const deviceSockets = new Map(); // deviceId -> socket.id
const socketDevices = new Map(); // socket.id -> deviceId
const loyaltyIdToDeviceId = new Map(); // loyaltyId -> deviceId (for quick lookups)

// ----------------------------------------------------------------------------
// Несколько устройств одного пользователя (телефон + вкладки сайта / панели).
// loyaltyIdToDeviceId хранит только ПОСЛЕДНЕЕ зарегистрированное устройство: раньше
// открытая вкладка сайта «забирала» звонок у телефона, а её фиктивный voipToken "web-…"
// затирал в users.voipToken настоящий токен телефона (аудит calling flow, S2/S3/S6).
// Теперь звонок идёт на все устройства: телефон — push по токену из БД, остальные —
// по живым сокетам; отвечает первое, остальным приходит call-state 'ended'.
// ----------------------------------------------------------------------------
const loyaltyDevices = new Map(); // normalized loyaltyId -> Set<deviceId>
const MAX_LOGGED_CALLER_CANDIDATES = 200;

function normLoyaltyId(value) {
  return String(value || '').replace(/\s+/g, '');
}

function addLoyaltyDevice(loyaltyId, deviceId) {
  const key = normLoyaltyId(loyaltyId);
  if (!key || !deviceId) return;
  if (!loyaltyDevices.has(key)) loyaltyDevices.set(key, new Set());
  loyaltyDevices.get(key).add(deviceId);
}

function removeLoyaltyDevice(loyaltyId, deviceId) {
  const key = normLoyaltyId(loyaltyId);
  const set = loyaltyDevices.get(key);
  if (!set) return;
  set.delete(deviceId);
  if (!set.size) loyaltyDevices.delete(key);
}

/** Сокет действительно подключён (а не устаревшая запись в картах / БД). */
function isLiveSocket(socketId) {
  return Boolean(socketId) && Boolean(io.sockets.sockets.get(socketId));
}

/** Настоящий VoIP (APNs) / FCM токен телефона, а не фиктивный "web-<uuid>" веб-клиента. */
function isPhoneVoipToken(token) {
  const t = String(token || '').trim();
  return Boolean(t) && !/^web-/i.test(t);
}

function isWebRegistration(platform, voipToken) {
  return platform === 'web' || !isPhoneVoipToken(voipToken);
}

/**
 * Куда звонить пользователю: телефон (push по токену из БД) + все живые сокеты его устройств.
 * excludeDeviceId — устройство звонящего (не звоним сами себе).
 */
function resolveCallTargets(user, {toDeviceId = null, excludeDeviceId = null} = {}) {
  const loyalty = normLoyaltyId(user.loyalty_id);
  const sockets = [];
  const seen = new Set();
  const consider = (deviceId) => {
    if (!deviceId || seen.has(deviceId) || deviceId === excludeDeviceId) return;
    seen.add(deviceId);
    const socketId = deviceSockets.get(deviceId);
    if (!isLiveSocket(socketId)) return;
    const device = devices.get(deviceId);
    if (device && device.loyaltyId && normLoyaltyId(device.loyaltyId) !== loyalty) return; // чужое устройство
    sockets.push({deviceId, socketId});
  };
  for (const deviceId of loyaltyDevices.get(loyalty) || []) consider(deviceId);
  consider(loyaltyIdToDeviceId.get(user.loyalty_id));
  consider(toDeviceId);
  if (isLiveSocket(user.socketId)) consider(socketDevices.get(user.socketId));

  let phone = null;
  if (isPhoneVoipToken(user.voipToken)) {
    const mem = devices.get(user.voipToken);
    const platform = mem && (mem.platform === 'ios' || mem.platform === 'android')
      ? mem.platform
      : detectPhonePlatformFromToken(user.voipToken);
    phone = {token: user.voipToken, platform};
  }
  return {phone, sockets};
}

/** call-state 'ended' остальным устройствам адресата (ответили / отклонили на другом). */
function notifyOtherCalleeDevices(call, callId, exceptDeviceId, reason) {
  const ids = Array.isArray(call.calleeDeviceIds) ? call.calleeDeviceIds : [];
  for (const deviceId of ids) {
    if (!deviceId || deviceId === exceptDeviceId) continue;
    const socketId = deviceSockets.get(deviceId);
    if (!isLiveSocket(socketId)) continue;
    io.to(socketId).emit('call-state', {callId, state: 'ended', reason, by: exceptDeviceId || null});
    console.log('[call] other callee device notified:', deviceId, 'reason=', reason);
  }
}

/** Кандидаты звонящего, пришедшие до ответа, — заново ответившему устройству. */
function replayCallerCandidates(call, callId, deviceId) {
  const socketId = deviceSockets.get(deviceId);
  const list = Array.isArray(call.callerCandidates) ? call.callerCandidates : [];
  if (!list.length || !isLiveSocket(socketId)) return;
  for (const candidate of list) {
    io.to(socketId).emit('ice-candidate', {callId, candidate, fromDeviceId: call.fromDeviceId || null});
  }
  console.log('[answer] replayed', list.length, 'caller candidate(s) to', deviceId);
}

function logCallerCandidate(call, candidate) {
  if (!Array.isArray(call.callerCandidates)) call.callerCandidates = [];
  if (call.callerCandidates.length < MAX_LOGGED_CALLER_CANDIDATES) call.callerCandidates.push(candidate);
}

/** До ответа кандидаты звонящего идут на ВСЕ устройства адресата (ответить может любое). */
function calleeTargetsForCallerCandidate(call) {
  if (!call.answeredBy && Array.isArray(call.calleeDeviceIds) && call.calleeDeviceIds.length) {
    return call.calleeDeviceIds;
  }
  return call.toDeviceId ? [call.toDeviceId] : [];
}

// ----------------------------------------------------------------------------
// Состояние звонка, таймаут, очистка, «мёртвые» push-токены (аудит S4, S5, P1-2).
// Раньше у звонка не было состояния: записи в calls не удалялись, телефон продолжал звонить
// после отбоя / ответа на другом устройстве, на звонок можно было ответить спустя минуты,
// а сбой APNs/FCM возвращался звонящему как 200 ok («гудки в никуда»).
// ----------------------------------------------------------------------------
const CALL_RING_TIMEOUT_MS = Math.max(1000, Number(process.env.CALL_RING_TIMEOUT_MS) || 60000);
const CALL_RETENTION_MS = 10 * 60 * 1000; // закончившийся звонок держим 10 мин (поздние запросы)
const CALL_MAX_AGE_MS = 6 * 60 * 60 * 1000; // любой звонок удаляется через 6 ч
// Кому сообщить «звонок закончился» после пробуждения — считается от КОНЦА звонка (или ответа на
// другом устройстве), а не от его начала: раньше после разговора дольше 3 мин повтора уже не было.
const ENDED_REPLAY_WINDOW_MS = 10 * 60 * 1000;
// Закончившийся звонок после очистки из calls остаётся «надгробием»: GET /api/calls/:id отвечает его
// состоянием, а не 404 — приложение снимает зависший «Входящий» даже спустя часы.
const CALL_TOMBSTONE_MS = 24 * 60 * 60 * 1000;
const CALL_TOMBSTONE_MAX = 5000;
const CANCEL_PUSH_TTL_SEC = 60;
const callTombstones = new Map(); // callId -> {state, endReason, endedAt, answeredBy, toLoyaltyId, fromLoyaltyId, callerName}
const FINAL_CALL_STATES = new Set(['ended', 'rejected', 'missed']);
const APNS_PAYLOAD_SOFT_LIMIT = 3800; // лимит VoIP-push 5120 байт, запас на aps и заголовки
const FCM_DATA_SOFT_LIMIT = 3500; // лимит FCM data 4096 байт

function isCallFinal(call) {
  return Boolean(call) && FINAL_CALL_STATES.has(call.state);
}

function finishCall(callId, call, state, reason) {
  if (!call || isCallFinal(call)) return false;
  call.state = state;
  call.endReason = reason || state;
  call.endedAt = Date.now();
  if (call.ringTimer) {
    clearTimeout(call.ringTimer);
    call.ringTimer = null;
  }
  console.log('[call-state]', callId, '->', state, 'reason=', call.endReason);
  return true;
}

function emitToDevice(deviceId, event, payload) {
  const socketId = deviceId ? deviceSockets.get(deviceId) : null;
  if (!isLiveSocket(socketId)) return false;
  io.to(socketId).emit(event, payload);
  return true;
}

/** Никто не ответил за CALL_RING_TIMEOUT_MS: пропущенный, всем сообщить. */
function onRingTimeout(callId) {
  const call = calls.get(callId);
  if (!call || call.state !== 'ringing') return;
  finishCall(callId, call, 'missed', 'no_answer');
  emitToDevice(call.fromDeviceId, 'call-state', {callId, state: 'ended', reason: 'no_answer', direction: 'outgoing'});
  notifyOtherCalleeDevices(call, callId, null, 'missed');
  sendCallEndedPushes(callId, call, {reason: 'missed'});
}

function scheduleRingTimeout(callId, call) {
  if (!call) return;
  call.ringTimer = setTimeout(() => onRingTimeout(callId), CALL_RING_TIMEOUT_MS);
  if (call.ringTimer && call.ringTimer.unref) call.ringTimer.unref();
}

/**
 * Устройство подключило сокет — часто это телефон, разбуженный VoIP-push. Если звонок, ради
 * которого его разбудили, уже закончился или принят на другом устройстве, сообщаем 'ended',
 * чтобы CallKit / системный экран перестал звонить (отдельного «отменяющего» push у iOS нет).
 */
function replayFinishedCallsTo(deviceId, socketId) {
  if (!deviceId || !socketId) return;
  const now = Date.now();
  // Устройство в разговоре — не трогаем (клиенты не везде сверяют callId у 'ended')
  for (const c of calls.values()) {
    if (c.state === 'answered' && (c.answeredBy === deviceId || c.fromDeviceId === deviceId)) return;
  }
  for (const [callId, c] of calls) {
    if (!Array.isArray(c.calleeDeviceIds) || !c.calleeDeviceIds.includes(deviceId)) continue;
    const answeredElsewhere = c.state === 'answered' && c.answeredBy && c.answeredBy !== deviceId;
    const finishedAt = c.endedAt || (answeredElsewhere ? c.answeredAt : 0) || c.createdAt || 0;
    if (now - finishedAt > ENDED_REPLAY_WINDOW_MS) continue;
    if (!isCallFinal(c) && !answeredElsewhere) continue;
    io.to(socketId).emit('call-state', {
      callId,
      state: 'ended',
      reason: answeredElsewhere ? 'answered_elsewhere' : (c.endReason || c.state),
    });
    console.log('[call] replayed ended to woken device', deviceId, 'call', callId);
  }
}

function sweepCalls() {
  const now = Date.now();
  for (const [callId, c] of calls) {
    const endedLongAgo = isCallFinal(c) && now - (c.endedAt || 0) > CALL_RETENTION_MS;
    const tooOld = now - (c.createdAt || now) > CALL_MAX_AGE_MS;
    if (endedLongAgo || tooOld) {
      if (c.ringTimer) clearTimeout(c.ringTimer);
      rememberTombstone(callId, c);
      calls.delete(callId);
      callCandidates.delete(callId);
    }
  }
  for (const [callId, t] of callTombstones) {
    if (now - (t.endedAt || 0) > CALL_TOMBSTONE_MS) callTombstones.delete(callId);
  }
}

function rememberTombstone(callId, c) {
  if (!callId || !c) return;
  if (callTombstones.size >= CALL_TOMBSTONE_MAX) {
    callTombstones.delete(callTombstones.keys().next().value);
  }
  callTombstones.set(callId, {
    state: isCallFinal(c) ? c.state : 'ended',
    endReason: c.endReason || (isCallFinal(c) ? c.state : 'expired'),
    endedAt: c.endedAt || Date.now(),
    answeredBy: c.answeredBy || null,
    fromLoyaltyId: c.fromLoyaltyId || null,
    toLoyaltyId: c.toLoyaltyId || null,
    callerName: c.callerName || null,
  });
}
const callSweepTimer = setInterval(sweepCalls, 60 * 1000);
if (callSweepTimer.unref) callSweepTimer.unref();

const APNS_DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered']);

function isDeadFcmTokenError(err) {
  const code = String((err && (err.code || (err.errorInfo && err.errorInfo.code))) || '');
  const msg = String((err && err.message) || '');
  return code === 'messaging/registration-token-not-registered'
    || code === 'messaging/invalid-registration-token'
    || /not a valid FCM registration token|Requested entity was not found/i.test(msg);
}

/** APNs/FCM сказали, что токена больше нет: убрать его из users.voipToken (если он там). */
async function forgetDeadPushToken(userId, token, reason) {
  try {
    await callDeviceDb.remove(token);
    const user = await userDb.getUserById(userId);
    if (user && user.voipToken === token) {
      await userDb.updateUserDeviceInfo(userId, null, undefined);
    }
    const device = devices.get(token);
    if (device && device.platform !== 'web') device.voipToken = null;
    console.warn('[push] dead token removed for user', userId, 'reason=', reason);
  } catch (e) {
    console.error('[push] failed to remove dead token:', e.message);
  }
}

/** VoIP-push: SDP в payload только если влезает в лимит, иначе клиент берёт offer через GET. */
function fitApnsPayload(payload) {
  const size = Buffer.byteLength(JSON.stringify({aps: {}, ...payload}), 'utf8');
  if (size <= APNS_PAYLOAD_SOFT_LIMIT || !payload.offer) return {payload, size, offerDropped: false};
  const rest = {...payload};
  delete rest.offer;
  return {payload: rest, size: Buffer.byteLength(JSON.stringify({aps: {}, ...rest}), 'utf8'), offerDropped: true};
}

function fitFcmData(data) {
  const sizeOf = (d) => Object.entries(d).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(String(v)), 0);
  const size = sizeOf(data);
  if (size <= FCM_DATA_SOFT_LIMIT || !data.offerSdp) return {data, size, offerDropped: false};
  const rest = {...data};
  delete rest.offerSdp;
  delete rest.offerType;
  return {data: rest, size: sizeOf(rest), offerDropped: true};
}

// ======================
// APNs (VoIP) Provider
// ======================

// APNs-ключ (.p8) лежит ВНЕ репозитория; путь и идентификаторы — из .env:
//   APN_KEY_PATH=/home/secrets/calling/AuthKey_XXXXXXXXXX.p8
//   APN_KEY_ID=XXXXXXXXXX  APN_TEAM_ID=YYYYYYYYYY  APN_PRODUCTION=1
// Без них VoIP-пуши на iOS не отправляются (лог [apn] disabled), сервис при этом работает.
const providerOpts = env('APN_KEY_PATH') && env('APN_KEY_ID') && env('APN_TEAM_ID')
  ? {
      token: {
        key: path.resolve(env('APN_KEY_PATH')),
        keyId: env('APN_KEY_ID'),
        teamId: env('APN_TEAM_ID'),
      },
      production: env('APN_PRODUCTION') !== '0', // 0 = sandbox / development
    }
  : null;

let apnProvider = null;
if (providerOpts) {
  try {
    apnProvider = new apn.Provider(providerOpts);
  } catch (e) {
    console.error('[apn] provider init failed:', e.message);
  }
} else {
  console.warn('[apn] disabled — set APN_KEY_PATH, APN_KEY_ID, APN_TEAM_ID in .env');
}

// This must match the VoIP topic configured for your app in Apple Developer portal.
// Often: "<bundle-id>.voip" or just your bundle id if configured that way.
const APN_VOIP_TOPIC = process.env.APN_VOIP_TOPIC || 'app.totus.club.voip';

// Ключ Firebase Admin SDK (FCM) — файл вне репозитория: FIREBASE_CREDENTIALS_PATH=/home/secrets/calling/firebase-adminsdk.json
let firebaseApp = null;
const firebaseCredPath = env('FIREBASE_CREDENTIALS_PATH');
if (firebaseCredPath) {
  try {
    const firebaseServiceAccount = require(path.resolve(firebaseCredPath));
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(firebaseServiceAccount),
    });
    console.log('[fcm] Firebase Admin initialized');
  } catch (e) {
    console.error('[fcm] Firebase Admin init failed:', e.message);
  }
} else {
  console.warn('[fcm] disabled — set FIREBASE_CREDENTIALS_PATH in .env');
}

function toFcmDataValue(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value);
}

function detectPhonePlatformFromToken(token) {
  const raw = String(token || '').trim();
  if (!raw) {
    return null;
  }

  // APNs VoIP tokens are hex strings (typically 64+ chars, no ':').
  const isLikelyApnsToken = /^[a-fA-F0-9]{40,}$/.test(raw) && !raw.includes(':');
  if (isLikelyApnsToken) {
    return 'ios';
  }

  // FCM tokens typically contain ':' and mixed URL-safe chars.
  return 'android';
}

// ======================
// Authentication (Login)
// ======================

// Web app login - only agents can login
// POST /api/web/login
// body: { email: string, password: string }
// Пароли агентов — bcrypt; старые plaintext-пароли перехэшируются при первом успешном входе.
// Ответ: { ok, user } (как раньше) + accessToken / refreshToken (agent-JWT, тот же JWT_SECRET, что у totus_API).
function looksLikeBcrypt(value) {
  return typeof value === 'string' && /^\$2[aby]\$\d{2}\$/.test(value);
}

app.post('/api/web/login', loginLimiter, async (req, res) => {
  const {email, password} = req.body || {};
  console.log('web-login', email);
  
  if (!email || !password) {
    return res.status(400).json({error: 'email and password are required'});
  }

  try {
    const user = await userDb.getUserByEmail(String(email).trim().toLowerCase());
    const invalid = () => res.status(401).json({error: 'Invalid email or password'});

    if (!user || !user.password) {
      return invalid();
    }

    let ok = false;
    if (looksLikeBcrypt(user.password)) {
      ok = await bcrypt.compare(String(password), user.password);
    } else if (user.password === String(password)) {
      ok = true;
      try {
        await userDb.updateUserPassword(user.id, await bcrypt.hash(String(password), 10));
      } catch (rehashErr) {
        console.warn('[web-login] password rehash failed:', rehashErr.message);
      }
    }
    if (!ok) {
      return invalid();
    }

    // access: 0/NULL — Доступ, 1 — Заблок.
    if (Number(user.access) === 1) {
      return res.status(403).json({error: 'Access denied'});
    }

    // Check if user has role 'agent'
    if (user.role !== 'agent') {
      return res.status(403).json({error: 'Access denied. Only agents can login to web app.'});
    }

    const tokens = process.env.JWT_SECRET && process.env.JWT_REFRESH_SECRET
      ? {
          accessToken: authCore.signAgentToken(user),
          refreshToken: authCore.signRefreshToken(user.id, 'agent'),
        }
      : {};
    if (!tokens.accessToken) {
      console.warn('[web-login] JWT_SECRET / JWT_REFRESH_SECRET not set — login without tokens');
    }

    // Return user data (without password)
    res.json({
      ok: true,
      ...tokens,
      user: {
        id: user.id,
        loyaltyId: user.loyalty_id,
        name: user.name,
        fName: user.f_name,
        lName: user.l_name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('[web-login] error:', error);
    res.status(500).json({error: 'Login failed: ' + error.message});
  }
});

// ======================
// Device Registration
// ======================

// Called from the app when a VoIP token is received.
// POST /api/register-device
// body: { deviceId: string, loyaltyId: string (or userId for backward compatibility), voipToken: string, platform: 'ios' | 'android' | 'web' }
app.post('/api/register-device', async (req, res) => {
  const {deviceId, loyaltyId, userId, voipToken, platform, callEndedPush} = req.body || {};
  // Приложение понимает «отменяющий» push (type=call_ended): только таким телефонам он и уходит
  const supportsCancel = callEndedPush === true || callEndedPush === 'true' || callEndedPush === 1;
  console.log('register-device', deviceId, loyaltyId, userId, voipToken, platform, 'callEndedPush=', supportsCancel);
  
  // Use loyaltyId if provided, otherwise try userId for backward compatibility
  const targetLoyaltyId = loyaltyId || userId;
  
  if (!deviceId || !targetLoyaltyId || !voipToken) {
    return res.status(400).json({error: 'deviceId, loyaltyId (or userId), and voipToken are required'});
  }

  try {
    // Find user by loyalty_id in database
    const user = await userDb.getUserDeviceInfoByLoyaltyId(targetLoyaltyId);
    if (!user) {
      return res.status(404).json({error: 'User not found with loyalty_id: ' + targetLoyaltyId});
    }

    const socketId = deviceSockets.get(deviceId) || null;
    const webDevice = isWebRegistration(platform, voipToken);
    if (webDevice) {
      // Вкладка сайта / панели: фиктивный voipToken "web-…" в users.voipToken НЕ пишем —
      // иначе он затирает токен телефона того же пользователя и телефон перестаёт
      // получать звонки (аудит S2). Веб достижим только по сокету.
      console.log('[register-device] web device: users.voipToken is kept (phone token not overwritten)');
    } else {
      // socketId пишем, только если сокет есть: null затирал бы сокет другого устройства
      await userDb.updateUserDeviceInfo(user.id, voipToken, socketId || undefined);
      // Каждый телефон — своя строка: push звонка уходит на все телефоны пользователя
      await callDeviceDb.upsert(user.id, voipToken, platform === 'android' ? 'android' : 'ios', supportsCancel);
      // Смена аккаунта на телефоне: прежний пользователь больше не звонит на этот телефон
      if (callDeviceDb.releaseFromOtherUsers) await callDeviceDb.releaseFromOtherUsers(voipToken, user.id);
    }

    // Also store in memory for quick access
    devices.set(deviceId, {
      userId: user.id,
      loyaltyId: user.loyalty_id,
      voipToken,
      platform: webDevice ? 'web' : (platform || 'ios'),
      socketId,
      supportsCancel: !webDevice && supportsCancel,
    });

    loyaltyIdToDeviceId.set(user.loyalty_id, deviceId);
    addLoyaltyDevice(user.loyalty_id, deviceId);

    // If a socket is already connected for this device, log that we see it
    if (socketId) {
      console.log(
        '[register-device] deviceId already has socket connection',
        socketId,
      );
    }

    console.log('[register-device] deviceId=', deviceId, 'loyaltyId=', user.loyalty_id, 'userId=', user.id, 'platform=', platform);
    res.json({ok: true, userId: user.id, loyaltyId: user.loyalty_id});
  } catch (error) {
    console.error('[register-device] error:', error);
    res.status(500).json({error: 'Failed to register device: ' + error.message});
  }
});

// Unregister device on logout - clears voipToken/socketId so the device
// no longer receives calls for that user. Required for account switching.
// POST /api/unregister-device
// body: { loyaltyId: string } - the user who is logging out
app.post('/api/unregister-device', async (req, res) => {
  const {loyaltyId, deviceId: logoutDeviceId} = req.body || {};
  console.log('[unregister-device] loyaltyId=', loyaltyId, 'deviceId=', logoutDeviceId ? 'yes' : 'no');

  if (!loyaltyId) {
    return res.status(400).json({error: 'loyaltyId is required'});
  }

  try {
    const user = await userDb.getUserDeviceInfoByLoyaltyId(loyaltyId);
    if (!user) {
      return res.status(404).json({error: 'User not found with loyalty_id: ' + loyaltyId});
    }

    if (logoutDeviceId) {
      // Новое приложение называет свой телефон: убираем только его, остальные телефоны продолжают звонить
      await callDeviceDb.remove(logoutDeviceId);
      if (user.voipToken === logoutDeviceId) {
        await userDb.updateUserDeviceInfo(user.id, null, null);
        await userDb.updateUserSocketId(user.id, null);
      }
    } else {
      // Старый клиент (без deviceId): как раньше — пользователь больше не получает звонки на телефоны
      await callDeviceDb.removeAllForUser(user.id);
      // Clear voipToken and socketId in DB - stops backend from sending VoIP pushes to this device for this user
      await userDb.updateUserDeviceInfo(user.id, null, null);
      await userDb.updateUserSocketId(user.id, null);
    }

    // Remove from in-memory maps so device no longer receives calls for this user
    const deviceIdToRemove = logoutDeviceId || loyaltyIdToDeviceId.get(loyaltyId);
    if (deviceIdToRemove) {
      const sockId = deviceSockets.get(deviceIdToRemove);
      if (sockId) {
        socketDevices.delete(sockId);
      }
      deviceSockets.delete(deviceIdToRemove);
      const device = devices.get(deviceIdToRemove);
      if (device && device.loyaltyId === loyaltyId) {
        devices.delete(deviceIdToRemove);
      }
      if (loyaltyIdToDeviceId.get(loyaltyId) === deviceIdToRemove) {
        loyaltyIdToDeviceId.delete(loyaltyId);
      }
      removeLoyaltyDevice(loyaltyId, deviceIdToRemove);
    }

    // Broadcast user offline
    io.emit('user-status', {loyaltyId, online: false});
    console.log('[unregister-device] Cleared device for user', loyaltyId);
    res.json({ok: true});
  } catch (error) {
    console.error('[unregister-device] error:', error);
    res.status(500).json({error: 'Failed to unregister device: ' + error.message});
  }
});

// ======================
// User Management
// ======================

// Get all users (for listing in app)
// GET /api/users
app.get('/api/users', async (req, res) => {
  try {
    const users = await userDb.getAllUsers();
    res.json({
      ok: true,
      users: users.map((user) => ({
        id: user.id,
        loyaltyId: user.loyalty_id,
        name: user.name,
        fName: user.f_name,
        lName: user.l_name,
        email: user.email,
        phone: user.phone,
        online: user.online === 1,
        hasVoipToken: !!user.voipToken,
        hasSocket: !!user.socketId,
        access: user.access != null ? user.access : 0,
      })),
    });
  } catch (error) {
    console.error('[get-users] error:', error);
    res.status(500).json({error: 'Failed to get users: ' + error.message});
  }
});

// Get user by loyalty_id
// GET /api/users/:loyaltyId
app.get('/api/users/:loyaltyId', async (req, res) => {
  try {
    const {loyaltyId} = req.params;
    const user = await userDb.getUserDeviceInfoByLoyaltyId(loyaltyId);
    if (!user) {
      return res.status(404).json({error: 'User not found'});
    }
    res.json({
      ok: true,
      user: {
        id: user.id,
        loyaltyId: user.loyalty_id,
        name: user.name,
        fName: user.f_name,
        lName: user.l_name,
        email: user.email,
        phone: user.phone,
        online: user.online === 1,
        hasVoipToken: !!user.voipToken,
        hasSocket: !!user.socketId,
      },
    });
  } catch (error) {
    console.error('[get-user] error:', error);
    res.status(500).json({error: 'Failed to get user: ' + error.message});
  }
});

// Get user by ID (for logged-in user)
// GET /api/users/by-id/:userId
app.get('/api/users/by-id/:userId', async (req, res) => {
  try {
    const {userId} = req.params;
    const user = await userDb.getUserById(parseInt(userId, 10));
    if (!user) {
      return res.status(404).json({error: 'User not found'});
    }
    res.json({
      ok: true,
      user: {
        id: user.id,
        loyaltyId: user.loyalty_id,
        name: user.name,
        fName: user.f_name,
        lName: user.l_name,
        email: user.email,
        phone: user.phone,
        online: user.online === 1,
        hasVoipToken: !!user.voipToken,
        hasSocket: !!user.socketId,
        access: (user.access ?? 1) === 1,
      },
    });
  } catch (error) {
    console.error('[get-user-by-id] error:', error);
    res.status(500).json({error: 'Failed to get user: ' + error.message});
  }
});

// Update user access (1 or 0)
// PATCH /api/users/:userId/access
// body: { access: boolean | 0 | 1 }
app.patch('/api/users/:userId/access', async (req, res) => {
  const {userId} = req.params;
  const {access} = req.body || {};
  const accessVal = access === true || access === 1;
  try {
    const user = await userDb.updateUserAccess(parseInt(userId, 10), accessVal);
    if (!user) {
      return res.status(404).json({error: 'User not found'});
    }
    res.json({
      ok: true,
      user: {
        id: user.id,
        access: user.access === 1,
      },
    });
  } catch (error) {
    console.error('[update-user-access] error:', error);
    res.status(500).json({error: 'Failed to update user access: ' + error.message});
  }
});

// ======================
// Contacts Management
// ======================

// Add a contact (user adds another user to their contacts)
// POST /api/contacts
// body: { userId: number, contactLoyaltyId: string }
app.post('/api/contacts', async (req, res) => {
  const {userId, contactLoyaltyId} = req.body || {};
  console.log('add-contact', userId, contactLoyaltyId);
  
  if (!userId || !contactLoyaltyId) {
    return res.status(400).json({error: 'userId and contactLoyaltyId are required'});
  }

  try {
    // Verify user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({error: 'User not found'});
    }

    // Verify contact user exists
    const contactUser = await userDb.getUserByLoyaltyId(contactLoyaltyId);
    if (!contactUser) {
      return res.status(404).json({error: 'Contact user not found with loyalty_id: ' + contactLoyaltyId});
    }

    // Prevent adding self as contact
    if (user.loyalty_id === contactLoyaltyId) {
      return res.status(400).json({error: 'Cannot add yourself as a contact'});
    }

    // Add contact
    const result = await contactDb.addContact(userId, contactLoyaltyId);
    
    res.json({
      ok: true,
      contact: {
        id: result.id,
        userId: userId,
        contactLoyaltyId: contactLoyaltyId,
        alreadyExists: result.alreadyExists || false,
      },
    });
  } catch (error) {
    console.error('[add-contact] error:', error);
    res.status(500).json({error: 'Failed to add contact: ' + error.message});
  }
});

// Get user's contacts
// GET /api/contacts/:userId
app.get('/api/contacts/:userId', async (req, res) => {
  try {
    const {userId} = req.params;
    console.log('[get-contacts] Fetching contacts for userId:', userId);
    const contacts = await contactDb.getUserContacts(parseInt(userId, 10));
    console.log('[get-contacts] Found contacts:', contacts.length);
    
    res.json({
      ok: true,
      contacts: contacts.map((contact) => ({
        id: contact.id,
        contactId: contact.contact_id,
        loyaltyId: contact.loyalty_id,
        name: contact.name,
        fName: contact.f_name,
        lName: contact.l_name,
        email: contact.email,
        phone: contact.phone,
        online: contact.online === 1,
        hasVoipToken: !!contact.voipToken,
        hasSocket: !!contact.socketId,
        createdAt: contact.created_at,
      })),
    });
  } catch (error) {
    console.error('[get-contacts] error:', error);
    // If table doesn't exist or other DB error, return empty array instead of error
    if (error.message && (error.message.includes('doesn\'t exist') || error.message.includes('Unknown table'))) {
      console.log('[get-contacts] Contacts table does not exist, returning empty array');
      return res.json({
        ok: true,
        contacts: [],
      });
    }
    res.status(500).json({error: 'Failed to get contacts: ' + error.message});
  }
});

// Check if contact already exists
// GET /api/contacts/check/:userId/:contactLoyaltyId
app.get('/api/contacts/check/:userId/:contactLoyaltyId', async (req, res) => {
  try {
    const {userId, contactLoyaltyId} = req.params;
    // Normalize loyalty ID by removing spaces
    const normalizedContactLoyaltyId = contactLoyaltyId.replace(/\s+/g, '');
    const exists = await contactDb.contactExists(parseInt(userId, 10), normalizedContactLoyaltyId);
    
    res.json({
      ok: true,
      exists: exists,
    });
  } catch (error) {
    console.error('[check-contact] error:', error);
    res.status(500).json({error: 'Failed to check contact: ' + error.message});
  }
});

// Search user by loyalty ID (for adding contacts)
// GET /api/users/search/:loyaltyId
// Supports loyalty IDs with or without spaces (e.g., "9897 3971 0801 6689" or "9897397108016689")
app.get('/api/users/search/:loyaltyId', async (req, res) => {
  try {
    let {loyaltyId} = req.params;
    // Remove all spaces from loyalty ID to normalize it
    loyaltyId = loyaltyId.replace(/\s+/g, '');
    console.log('[search-user] Searching for loyaltyId:', loyaltyId);
    
    const user = await userDb.getUserDeviceInfoByLoyaltyId(loyaltyId);
    if (!user) {
      return res.status(404).json({error: 'User not found'});
    }
    res.json({
      ok: true,
      user: {
        id: user.id,
        loyaltyId: user.loyalty_id,
        name: user.name,
        fName: user.f_name,
        lName: user.l_name,
        email: user.email,
        phone: user.phone,
        online: user.online === 1,
        hasVoipToken: !!user.voipToken,
        hasSocket: !!user.socketId,
      },
    });
  } catch (error) {
    console.error('[search-user] error:', error);
    res.status(500).json({error: 'Failed to search user: ' + error.message});
  }
});

// ======================
// Favorites Management
// ======================

// Add a hotel to favorites
// POST /api/favorites
// body: { userId: number, hotelId: number, hotelData: object }
app.post('/api/favorites', async (req, res) => {
  const {userId, hotelId, hotelData} = req.body || {};
  console.log('add-favorite', userId, hotelId);
  
  if (!userId || !hotelId || !hotelData) {
    return res.status(400).json({error: 'userId, hotelId, and hotelData are required'});
  }

  try {
    // Verify user exists
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({error: 'User not found'});
    }

    // Add favorite
    const result = await favoriteDb.addFavorite(userId, hotelId, hotelData);
    
    res.json({
      ok: true,
      favorite: {
        id: result.id,
        userId: userId,
        hotelId: hotelId,
        alreadyExists: result.alreadyExists || false,
      },
    });
  } catch (error) {
    console.error('[add-favorite] error:', error);
    res.status(500).json({error: 'Failed to add favorite: ' + error.message});
  }
});

// Remove a hotel from favorites
// DELETE /api/favorites
// body: { userId: number, hotelId: number }
app.delete('/api/favorites', async (req, res) => {
  const {userId, hotelId} = req.body || {};
  console.log('remove-favorite', userId, hotelId);
  
  if (!userId || !hotelId) {
    return res.status(400).json({error: 'userId and hotelId are required'});
  }

  try {
    const result = await favoriteDb.removeFavorite(userId, hotelId);
    
    res.json({
      ok: true,
      deleted: result.deleted,
    });
  } catch (error) {
    console.error('[remove-favorite] error:', error);
    res.status(500).json({error: 'Failed to remove favorite: ' + error.message});
  }
});

// Get user's favorites
// GET /api/favorites/:userId
app.get('/api/favorites/:userId', async (req, res) => {
  try {
    const {userId} = req.params;
    console.log('[get-favorites] Fetching favorites for userId:', userId);
    const favorites = await favoriteDb.getUserFavorites(parseInt(userId, 10));
    console.log('[get-favorites] Found favorites:', favorites.length);
    
    res.json({
      ok: true,
      favorites: favorites,
    });
  } catch (error) {
    console.error('[get-favorites] error:', error);
    // If table doesn't exist, return empty array
    if (error.message && (error.message.includes('doesn\'t exist') || error.message.includes('Unknown table'))) {
      console.log('[get-favorites] Favorites table does not exist, returning empty array');
      return res.json({
        ok: true,
        favorites: [],
      });
    }
    res.status(500).json({error: 'Failed to get favorites: ' + error.message});
  }
});

// Check if hotel is favorited
// GET /api/favorites/:userId/:hotelId
app.get('/api/favorites/:userId/:hotelId', async (req, res) => {
  try {
    const {userId, hotelId} = req.params;
    const isFavorite = await favoriteDb.isFavorite(parseInt(userId, 10), parseInt(hotelId, 10));
    
    res.json({
      ok: true,
      isFavorite: isFavorite,
    });
  } catch (error) {
    console.error('[check-favorite] error:', error);
    res.status(500).json({error: 'Failed to check favorite: ' + error.message});
  }
});

// ======================
// Call Creation (Outgoing)
// ======================

// Helper endpoint: Call by loyalty_id (easier to use)
// POST /api/calls/by-loyalty
// body: { callId, toLoyaltyId, callerName, offer: { type, sdp }, fromLoyaltyId? }
app.post('/api/calls/by-loyalty', async (req, res) => {
  const {callId, toLoyaltyId, callerName, offer, fromLoyaltyId, fromDeviceId} = req.body || {};
  
  if (!callId || !toLoyaltyId || !offer || !offer.sdp) {
    return res.status(400).json({error: 'callId, toLoyaltyId, and offer.sdp are required'});
  }

  // Find target deviceId from loyalty_id
  let targetDeviceId = loyaltyIdToDeviceId.get(toLoyaltyId);
  
  // Call the main /api/calls endpoint logic
  req.body.toDeviceId = targetDeviceId;
  req.body.toLoyaltyId = toLoyaltyId;
  req.body.fromLoyaltyId = fromLoyaltyId;
  
  // Forward to main /api/calls handler
  return app._router.handle({...req, url: '/api/calls', method: 'POST'}, res);
});

// ----------------------------------------------------------------------------
// Push звонка — на КАЖДЫЙ телефон пользователя; «отменяющий» push, когда звонок закончился
// (05.10.2026, сценарий владельца: Android + iOS + сайт, ответ и отбой на сайте → второй звонок
// не приходил на телефоны, а при открытии приложения показывался завершённый звонок).
// Раньше: один токен на пользователя (users.voipToken, его перезаписывал последний открытый
// телефон), а об окончании звонка узнавали только живые сокеты — телефон в фоне / выгруженный
// продолжал «звонить» и отбрасывал следующий звонок как «занято».
// ----------------------------------------------------------------------------

/** Все телефоны пользователя: таблица call_devices + users.voipToken (старые клиенты). */
async function resolvePhoneTargets(user, excludeDeviceId = null) {
  const phones = [];
  const seen = new Set();
  const add = (token, platform, supportsCancel) => {
    if (!isPhoneVoipToken(token) || seen.has(token) || token === excludeDeviceId) return;
    seen.add(token);
    const mem = devices.get(token);
    const memPlatform = mem && (mem.platform === 'ios' || mem.platform === 'android') ? mem.platform : null;
    const pf = platform === 'ios' || platform === 'android'
      ? platform
      : (memPlatform || detectPhonePlatformFromToken(token));
    phones.push({token, platform: pf, supportsCancel: Boolean(supportsCancel || (mem && mem.supportsCancel))});
  };
  let rows = [];
  try {
    rows = await callDeviceDb.listByUser(user.id);
  } catch (e) {
    rows = [];
  }
  for (const d of rows) add(d.token, d.platform, d.supportsCancel);
  add(user.voipToken, null, false);
  return phones;
}

/** Push входящего звонка на один телефон. Возвращает {ok, platform, token, reason?, ...}. */
async function sendIncomingCallPush(phone, ctx) {
  const {callId, targetDeviceId, finalCallerName, callerLoyaltyId, calleeLoyaltyId, offer, fromDeviceId, userId} = ctx;
  const base = {platform: phone.platform, token: phone.token};
  if (phone.platform === 'ios') {
    if (!apnProvider) {
      console.warn('[apn] push skipped: provider not configured (APN_KEY_PATH/APN_KEY_ID/APN_TEAM_ID)');
      return {...base, ok: false, reason: 'apn_not_configured', soft: true};
    }
    try {
      const note = new apn.Notification();
      note.pushType = 'voip';
      note.topic = APN_VOIP_TOPIC;
      // Звонок не должен «догнать» телефон после таймаута; VoIP — немедленная доставка
      note.expiry = Math.floor(Date.now() / 1000) + Math.ceil(CALL_RING_TIMEOUT_MS / 1000);
      note.priority = 10;
      // AppDelegate ждёт callId, handle, callerName, uuid; toLoyaltyId — сверка после смены аккаунта
      const fittedApns = fitApnsPayload({
        callId,
        uuid: callId,
        handle: targetDeviceId,
        callerName: finalCallerName,
        caller_name: finalCallerName,
        from: targetDeviceId,
        toLoyaltyId: calleeLoyaltyId || null,
        offer: {type: offer.type, sdp: offer.sdp},
      });
      note.payload = fittedApns.payload;
      console.log('[apn] VoIP push payload:', {
        bytes: fittedApns.size,
        offerInPayload: !fittedApns.offerDropped,
        callId,
        topic: APN_VOIP_TOPIC,
        voipTokenLength: phone.token.length,
      });
      const result = await apnProvider.send(note, phone.token);
      console.log('[apn] sent=', result.sent.length, 'failed=', result.failed.length, 'call', callId);
      const apnResult = {sent: result.sent.length, failed: result.failed.length};
      if (result.sent.length === 0 && result.failed.length > 0) {
        const failure = result.failed[0] || {};
        console.error('[apn] failed notification:', {status: failure.status, response: failure.response});
        const reason = (failure.response && failure.response.reason) || (failure.error && failure.error.message) || String(failure.status || 'unknown');
        if (APNS_DEAD_TOKEN_REASONS.has(reason) || String(failure.status) === '410') {
          forgetDeadPushToken(userId, phone.token, reason);
        }
        return {...base, ok: false, reason, label: 'APNs', apnResult};
      }
      return {...base, ok: true, apnResult};
    } catch (err) {
      console.error('[apn] send error', err && err.message, {callId});
      return {...base, ok: false, reason: 'APNs send failed: ' + (err && err.message), label: 'APNs'};
    }
  }
  if (phone.platform === 'android') {
    try {
      if (!firebaseApp) {
        throw new Error('Firebase Admin is not initialized');
      }
      const fittedFcm = fitFcmData({
        type: 'incoming_call',
        callId: toFcmDataValue(callId),
        uuid: toFcmDataValue(callId),
        handle: toFcmDataValue(fromDeviceId || targetDeviceId || 'caller'),
        callerName: toFcmDataValue(finalCallerName || 'Incoming call'),
        caller_name: toFcmDataValue(finalCallerName || 'Incoming call'),
        fromDevice: toFcmDataValue(fromDeviceId || 'caller'),
        fromDeviceId: toFcmDataValue(fromDeviceId || ''),
        fromLoyaltyId: toFcmDataValue(callerLoyaltyId || ''),
        toLoyaltyId: toFcmDataValue(calleeLoyaltyId || ''),
        offerType: toFcmDataValue(offer?.type || 'offer'),
        offerSdp: toFcmDataValue(offer?.sdp || ''),
      });
      const messageId = await admin.messaging().send({
        token: phone.token,
        data: fittedFcm.data,
        android: {priority: 'high', ttl: 30000, directBootOk: true},
      });
      console.log('[fcm] incoming call push sent:', {callId, messageId, bytes: fittedFcm.size, offerInPayload: !fittedFcm.offerDropped});
      return {...base, ok: true, fcmMessageId: messageId};
    } catch (err) {
      console.error('[fcm] send error', err && err.message, {callId});
      if (isDeadFcmTokenError(err)) {
        forgetDeadPushToken(userId, phone.token, (err && err.code) || 'invalid_token');
      }
      return {...base, ok: false, reason: 'FCM send failed: ' + (err && err.message), label: 'FCM'};
    }
  }
  return {...base, ok: false, reason: 'unknown_platform'};
}

/** «Звонок закончился» одному телефону: Android — FCM data, iOS — VoIP push с ТЕМ ЖЕ uuid. */
async function sendCallEndedPush(phone, callId, call, reason) {
  if (phone.platform === 'ios') {
    if (!apnProvider) return false;
    const note = new apn.Notification();
    note.pushType = 'voip';
    note.topic = APN_VOIP_TOPIC;
    note.expiry = Math.floor(Date.now() / 1000) + CANCEL_PUSH_TTL_SEC;
    note.priority = 10;
    // iOS требует отчёт в CallKit на каждый VoIP-push: AppDelegate завершает вызов с этим uuid
    // (или сообщает и сразу завершает, если вызова уже нет).
    note.payload = {
      type: 'call_ended',
      callId,
      uuid: callId,
      reason,
      callerName: call.callerName || null,
      toLoyaltyId: call.toLoyaltyId || null,
    };
    const result = await apnProvider.send(note, phone.token);
    console.log('[apn] call_ended push', callId, 'reason=', reason, 'sent=', result.sent.length, 'failed=', result.failed.length);
    return result.sent.length > 0;
  }
  if (phone.platform === 'android') {
    if (!firebaseApp) return false;
    const messageId = await admin.messaging().send({
      token: phone.token,
      data: {
        type: 'call_ended',
        callId: toFcmDataValue(callId),
        uuid: toFcmDataValue(callId),
        reason: toFcmDataValue(reason),
        toLoyaltyId: toFcmDataValue(call.toLoyaltyId || ''),
      },
      android: {priority: 'high', ttl: CANCEL_PUSH_TTL_SEC * 1000},
    });
    console.log('[fcm] call_ended push', callId, 'reason=', reason, 'messageId=', messageId);
    return true;
  }
  return false;
}

/**
 * Звонок закончился (ответ на другом устройстве, отбой, сброс, пропущенный): каждому телефону,
 * которому ушёл push этого звонка, — «отменяющий» push. Даже если сокет кажется живым (уснувший
 * телефон до ~45 с числится подключённым). Только приложениям, которые его понимают (supportsCancel).
 */
function sendCallEndedPushes(callId, call, {exceptDeviceIds = [], reason = 'ended'} = {}) {
  if (!call) return;
  const phones = Array.isArray(call.pushedPhones) ? call.pushedPhones : [];
  if (!call.cancelPushedTo) call.cancelPushedTo = new Set();
  for (const phone of phones) {
    if (!phone || !phone.supportsCancel) continue;
    if (exceptDeviceIds.includes(phone.token) || call.cancelPushedTo.has(phone.token)) continue;
    call.cancelPushedTo.add(phone.token);
    sendCallEndedPush(phone, callId, call, reason).catch((e) => {
      console.error('[push] call_ended push failed', callId, phone.platform, e && e.message);
    });
  }
}

// From caller app: start a call and send VoIP push to callee.
// Matches the fetch in startOutgoingVoiceCall:
// POST /api/calls
// body: { callId, toDeviceId (or toLoyaltyId), callerName, offer: { type, sdp }, fromDeviceId?, fromLoyaltyId? }
app.post('/api/calls', async (req, res) => {
  const {callId, toDeviceId, toLoyaltyId, callerName, offer, fromDeviceId, fromLoyaltyId} = req.body || {};
  console.log('[create-call] request', callId, 'to', toLoyaltyId || toDeviceId, 'offer sdp bytes=', offer && offer.sdp ? offer.sdp.length : 0);
  
  // Адресат — пользователь целиком: телефон (push по токену из БД) + все живые сокеты
  // его устройств (сайт, панель, приложение на экране). Раньше звонок шёл на одно
  // «последнее» устройство, и открытая вкладка сайта забирала звонок у телефона (аудит S2/S3).
  let targetLoyaltyId = toLoyaltyId || null;
  if (!targetLoyaltyId && toDeviceId && devices.has(toDeviceId)) {
    targetLoyaltyId = devices.get(toDeviceId).loyaltyId || null;
  }

  if (!callId || (!toDeviceId && !targetLoyaltyId) || !offer || !offer.sdp) {
    return res.status(400).json({error: 'callId, toDeviceId (or toLoyaltyId), and offer.sdp are required'});
  }
  if (!targetLoyaltyId) {
    return res.status(404).json({error: 'Target device not registered'});
  }

  let calleeUser = null;
  try {
    calleeUser = await userDb.getUserDeviceInfoByLoyaltyId(targetLoyaltyId);
  } catch (error) {
    console.error('[call] error getting user:', error);
    return res.status(500).json({error: 'Failed to get target user'});
  }
  if (!calleeUser) {
    return res.status(404).json({error: 'Target user not found'});
  }

  const route = resolveCallTargets(calleeUser, {toDeviceId: toDeviceId || null, excludeDeviceId: fromDeviceId || null});
  const phones = await resolvePhoneTargets(calleeUser, fromDeviceId || null);
  if (!phones.length && !route.sockets.length) {
    return res.status(404).json({error: 'Target user not registered for calls (no socketId or voipToken)'});
  }

  const callee = {
    userId: calleeUser.id,
    loyaltyId: calleeUser.loyalty_id,
    voipToken: phones.length ? phones[0].token : null,
    platform: phones.length ? phones[0].platform : 'web',
  };
  targetLoyaltyId = calleeUser.loyalty_id;
  // Основное устройство (для старых клиентов, читающих toDeviceId): телефон, иначе первый сокет.
  // После ответа становится ответившим устройством (см. /answer).
  let targetDeviceId = phones.length ? phones[0].token : route.sockets[0].deviceId;
  const calleeDeviceIds = Array.from(new Set([
    ...route.sockets.map((t) => t.deviceId),
    ...phones.map((p) => p.token),
  ]));

  // Get caller info if we have fromLoyaltyId or fromDeviceId
  let callerLoyaltyId = fromLoyaltyId;
  if (!callerLoyaltyId && fromDeviceId) {
    const callerDevice = devices.get(fromDeviceId);
    if (callerDevice) {
      callerLoyaltyId = callerDevice.loyaltyId;
    }
  }

  // ALWAYS get caller name from database if we have fromLoyaltyId
  // The callerName from frontend might be the target's name (for outgoing calls),
  // so we should always fetch the actual caller's name from the database
  let finalCallerName = 'Incoming call';
  let callerUser = null;
  if (callerLoyaltyId) {
    try {
      callerUser = await userDb.getUserByLoyaltyId(callerLoyaltyId);
      if (callerUser) {
        // Format caller name from database
        if (callerUser.name) {
          finalCallerName = callerUser.name;
        } else if (callerUser.f_name || callerUser.l_name) {
          finalCallerName = [callerUser.f_name, callerUser.l_name].filter(Boolean).join(' ');
        } else if (callerUser.email) {
          finalCallerName = callerUser.email;
        } else if (callerUser.phone) {
          finalCallerName = callerUser.phone;
        } else {
          finalCallerName = `User ${callerUser.loyalty_id}`;
        }
      } else {
        // Fallback to provided callerName if user not found in database
        finalCallerName = callerName || 'Incoming call';
      }
    } catch (error) {
      console.error('[call] error getting caller name from database:', error);
      // Fallback to provided callerName or default
      finalCallerName = callerName || 'Incoming call';
    }
  } else {
    // No callerLoyaltyId, use provided callerName
    finalCallerName = callerName || 'Incoming call';
  }

  // Auto-save contact: When caller calls someone, save the callee to caller's contacts
  // When callee receives a call, save the caller to callee's contacts
  if (callerLoyaltyId && targetLoyaltyId && callerUser && callerUser.id) {
    try {
      // Save callee to caller's contacts (outgoing call)
      await contactDb.addContact(callerUser.id, targetLoyaltyId).catch(err => {
        console.log('[call] auto-save contact (caller->callee) skipped:', err.message);
      });
      
      // Save caller to callee's contacts (incoming call)
      if (callee.userId) {
        await contactDb.addContact(callee.userId, callerLoyaltyId).catch(err => {
          console.log('[call] auto-save contact (callee->caller) skipped:', err.message);
        });
      }
    } catch (error) {
      // Don't fail the call if contact saving fails
      console.error('[call] error auto-saving contacts:', error);
    }
  }

  calls.set(callId, {
    fromUserId: callee.userId,
    fromLoyaltyId: callerLoyaltyId || null,
    fromDeviceId: fromDeviceId || null,
    toDeviceId: targetDeviceId,
    toLoyaltyId: callee.loyaltyId || targetLoyaltyId || null,
    callerName: finalCallerName,
    offer,
    answer: null,
    calleeDeviceIds,
    answeredBy: null,
    callerCandidates: [],
    state: 'ringing',
    createdAt: Date.now(),
  });
  scheduleRingTimeout(callId, calls.get(callId));

  console.log('[create-call] callId=', callId, '=> deviceId=', targetDeviceId, 'platform=', callee.platform,
    'phones=', phones.map((p) => p.platform).join(',') || 'none', 'sockets=', route.sockets.length);

  // 1) Все живые сокеты адресата: offer + ringing (сайт, панель, приложение на экране)
  for (const target of route.sockets) {
    io.to(target.socketId).emit('offer', {
      callId,
      offer: {
        type: offer.type,
        sdp: offer.sdp,
      },
      fromDeviceId: fromDeviceId || null,
      fromLoyaltyId: callerLoyaltyId || null,
      toLoyaltyId: callee.loyaltyId || null,
      callerName: finalCallerName,
    });

    // Also notify about incoming call state
    io.to(target.socketId).emit('call-state', {
      callId,
      state: 'ringing',
      direction: 'incoming',
      fromDeviceId: fromDeviceId || null,
      fromLoyaltyId: callerLoyaltyId || null,
      callerName: finalCallerName,
    });
  }
  if (route.sockets.length) {
    console.log('[call] offer sent via socket to', route.sockets.length, 'device(s):', route.sockets.map((t) => t.deviceId).join(', '));
  }

  // 2) Телефоны: push на КАЖДЫЙ телефон пользователя, даже если открыт сайт / панель
  const deliveredViaSocket = route.sockets.length > 0;
  const pushResults = await Promise.all(phones.map((phone) => sendIncomingCallPush(phone, {
    callId,
    targetDeviceId,
    finalCallerName,
    callerLoyaltyId,
    calleeLoyaltyId: callee.loyaltyId || targetLoyaltyId || null,
    offer,
    fromDeviceId,
    userId: callee.userId,
  })));
  const createdCall = calls.get(callId);
  if (createdCall) {
    // Кому потом слать «отменяющий» push
    createdCall.pushedPhones = phones.filter((p, i) => pushResults[i] && pushResults[i].ok);
  }
  const pushOk = pushResults.filter((r) => r.ok);
  const firstOk = pushOk[0] || null;
  const pushSummary = pushResults.map((r) => ({platform: r.platform, ok: r.ok, reason: r.reason || null}));
  const firstApn = pushResults.find((r) => r.apnResult);
  const firstFcm = pushResults.find((r) => r.fcmMessageId);
  if (pushOk.length || deliveredViaSocket) {
    res.json({
      ok: true,
      callId,
      platform: firstOk ? firstOk.platform : 'web',
      push: pushSummary,
      apnResult: firstApn ? firstApn.apnResult : undefined,
      fcmMessageId: firstFcm ? firstFcm.fcmMessageId : undefined,
      pushError: pushResults.some((r) => !r.ok)
        ? pushResults.filter((r) => !r.ok).map((r) => (r.label && !String(r.reason).startsWith(r.label) ? r.label + ': ' : '') + r.reason).join('; ')
        : undefined,
    });
  } else if (pushResults.length && pushResults.every((r) => r.soft)) {
    // APNs не настроен на сервере (как раньше: звонок не обрывается, пишем предупреждение)
    res.json({ok: true, callId, apnResult: null, warning: 'apn_not_configured', push: pushSummary});
  } else {
    // Честный ответ вместо 200 ok: звонящий не слушает «гудки в никуда»
    const reason = pushResults.length === 1 ? pushResults[0].reason : (pushResults.map((r) => r.reason).join('; ') || 'push_failed');
    finishCall(callId, calls.get(callId), 'ended', 'push_failed');
    emitToDevice(fromDeviceId, 'call-state', {callId, state: 'ended', reason: 'unreachable', direction: 'outgoing'});
    res.status(502).json({error: 'push_failed', reason, callId, push: pushSummary});
  }

  // Also notify caller (if we know its device and socket)
  if (fromDeviceId && deviceSockets.has(fromDeviceId)) {
    io.to(deviceSockets.get(fromDeviceId)).emit('call-state', {
      callId,
      state: 'dialing',
      direction: 'outgoing',
      toDeviceId: targetDeviceId,
      toLoyaltyId: callee.loyaltyId || targetLoyaltyId || null,
      callerName: callerName || 'Incoming call',
    });
  }
});

// ======================
// Answer from Callee
// ======================

// Callee posts WebRTC answer after answering the call in CallKeep.
// POST /api/calls/:callId/answer
// body: { answer: { type, sdp }, deviceId: string }
app.post('/api/calls/:callId/answer', (req, res) => {
  const {callId} = req.params;
  const {answer, deviceId} = req.body || {};
  console.log('[answer] Received answer request:', {
    callId,
    deviceId,
    hasAnswer: !!answer,
    hasSdp: !!(answer && answer.sdp),
    sdpLength: answer?.sdp?.length || 0,
  });
  
  if (!answer || !answer.sdp) {
    console.error('[answer] ❌ Missing answer or SDP');
    return res.status(400).json({error: 'answer.sdp is required'});
  }

  const call = calls.get(callId);
  if (!call) {
    console.error('[answer] ❌ Call not found:', callId);
    console.error('[answer] Available calls:', Array.from(calls.keys()));
    return res.status(404).json({error: 'Unknown callId'});
  }

  // Звонок уже закончился (отбой, отклонён, никто не ответил) — ответ не принимаем
  if (isCallFinal(call)) {
    console.warn('[answer] call is already finished:', {callId, state: call.state, deviceId});
    return res.status(410).json({error: 'call_ended', state: call.state});
  }

  // Звонок звонит на нескольких устройствах: принимается первый ответ, второе устройство
  // получает 409 и завершает у себя звонок (иначе оно перехватило бы разговор).
  if (call.answeredBy && deviceId && call.answeredBy !== deviceId) {
    console.warn('[answer] call already answered on another device:', {callId, answeredBy: call.answeredBy, deviceId});
    return res.status(409).json({error: 'answered_elsewhere'});
  }

  call.answer = answer;
  const firstAnswer = Boolean(deviceId) && !call.answeredBy;
  if (firstAnswer) {
    call.answeredBy = deviceId;
    call.toDeviceId = deviceId; // дальше кандидаты и /end идут на ответившее устройство
  }
  if (call.state === 'ringing') {
    call.state = 'answered';
    call.answeredAt = Date.now();
    if (call.ringTimer) {
      clearTimeout(call.ringTimer);
      call.ringTimer = null;
    }
  }
  calls.set(callId, call);

  console.log('[answer] ✅ Answer stored for call:', callId, 'from deviceId:', deviceId);
  console.log('[answer] Call info:', {
    fromDeviceId: call.fromDeviceId,
    toDeviceId: call.toDeviceId,
    fromLoyaltyId: call.fromLoyaltyId,
    toLoyaltyId: call.toLoyaltyId,
  });

  // Notify both sides via socket that call is now "answered"
  const calleeDeviceId = deviceId;
  const callerDeviceId = call.fromDeviceId;
  
  // Forward answer to caller (web or phone)
  if (callerDeviceId) {
    const callerSocketId = deviceSockets.get(callerDeviceId);
    console.log('[answer] Looking up caller socket:', {
      callerDeviceId,
      hasSocketId: !!callerSocketId,
      socketId: callerSocketId,
      availableSockets: Array.from(deviceSockets.keys()).slice(0, 5), // Log first 5 for debugging
    });
    
    if (callerSocketId) {
      // Caller is connected via socket - send answer immediately
      console.log('[answer] 📤 Sending answer to caller via socket:', {
        socketId: callerSocketId,
        callId,
        answerType: answer.type,
        sdpLength: answer.sdp?.length || 0,
      });
      
      io.to(callerSocketId).emit('call-state', {
        callId,
        state: 'answered',
        direction: 'outgoing',
        peerDeviceId: calleeDeviceId,
      });
      
      io.to(callerSocketId).emit('answer', {
        callId,
        answer,
        fromDeviceId: calleeDeviceId,
      });
      
      console.log('[answer] ✅ Answer forwarded to caller via socket:', callerDeviceId);
    } else {
      // Caller might be phone that's offline - answer is stored in call object for HTTP polling
      console.log('[answer] ⚠️ Caller not connected via socket, answer stored for HTTP polling:', callerDeviceId);
      console.log('[answer] Available device sockets:', Array.from(deviceSockets.entries()).slice(0, 10));
    }
  } else {
    console.warn('[answer] ⚠️ No callerDeviceId in call object:', {
      callId,
      call: call,
    });
  }
  
  // Notify callee (if connected via socket)
  if (calleeDeviceId && deviceSockets.has(calleeDeviceId)) {
    io.to(deviceSockets.get(calleeDeviceId)).emit('call-state', {
      callId,
      state: 'answered',
      direction: 'incoming',
      peerDeviceId: callerDeviceId,
    });
    console.log('[answer] Notified callee via socket:', calleeDeviceId);
  }

  if (firstAnswer) {
    // Остальные устройства адресата перестают звонить; ответившему — кандидаты звонящего,
    // пришедшие до ответа (они могли уйти на другое устройство).
    notifyOtherCalleeDevices(call, callId, deviceId, 'answered_elsewhere');
    sendCallEndedPushes(callId, call, {exceptDeviceIds: [deviceId], reason: 'answered_elsewhere'});
    replayCallerCandidates(call, callId, deviceId);
  }

  res.json({ok: true});
});

// Caller (or callee) polls call state to retrieve offer/answer.
// GET /api/calls/:callId
app.get('/api/calls/:callId', (req, res) => {
  const {callId} = req.params;
  const call = calls.get(callId);
  console.log('[get-call]', callId, call ? `state=${call.state || 'n/a'} hasAnswer=${Boolean(call.answer)}` : 'unknown');

  if (!call) {
    // Звонок уже убран из памяти: отдаём его итоговое состояние, чтобы клиент снял зависший экран
    const t = callTombstones.get(callId);
    if (t) {
      return res.json({
        callId,
        fromLoyaltyId: t.fromLoyaltyId,
        toLoyaltyId: t.toLoyaltyId,
        callerName: t.callerName,
        offer: null,
        answer: null,
        state: t.state,
        endReason: t.endReason,
        answeredBy: t.answeredBy,
      });
    }
    return res.status(404).json({error: 'Unknown callId'});
  }

  res.json({
    callId,
    answeredBy: call.answeredBy || null,
    fromDeviceId: call.fromDeviceId || null,
    toDeviceId: call.toDeviceId || null,
    fromLoyaltyId: call.fromLoyaltyId || null,
    toLoyaltyId: call.toLoyaltyId || null,
    callerName: call.callerName || null,
    offer: call.offer,
    answer: call.answer,
    state: call.state || null,
    endReason: call.endReason || null,
  });
});

// ======================
// ICE Candidates
// ======================

// Both peers can POST ICE candidates here.
// POST /api/calls/:callId/candidate
// body: { from: 'caller' | 'callee', candidate: any }
app.post('/api/calls/:callId/candidate', (req, res) => {
  const {callId} = req.params;
  const {from, candidate} = req.body || {};
  console.log('[candidate] received', callId, 'from=', from);
  if (!from || !candidate) {
    return res.status(400).json({error: 'from and candidate are required'});
  }

  const existing = callCandidates.get(callId) || {caller: [], callee: []};
  if (!existing[from]) {
    existing[from] = [];
  }
  existing[from].push(candidate);
  callCandidates.set(callId, existing);

  console.log('[candidate] callId=', callId, 'from=', from);
  
  // Also forward ICE candidate via socket for real-time delivery (faster than polling)
  const call = calls.get(callId);
  if (call) {
    const fromDeviceId = from === 'caller' ? call.fromDeviceId : call.toDeviceId;
    if (from === 'caller') logCallerCandidate(call, candidate);
    // До ответа кандидаты звонящего — на все устройства адресата, после — ответившему
    const targets = from === 'caller'
      ? calleeTargetsForCallerCandidate(call)
      : (call.fromDeviceId ? [call.fromDeviceId] : []);

    for (const toDeviceId of targets) {
      const toSocketId = deviceSockets.get(toDeviceId);
      if (toSocketId) {
        // Peer is connected via socket - forward immediately
        io.to(toSocketId).emit('ice-candidate', {
          callId,
          candidate,
          fromDeviceId,
        });
        console.log('[candidate] Forwarded via socket to', toDeviceId, 'socket:', toSocketId);
      } else {
        // Peer might be phone that's offline - candidate is stored for HTTP polling
        console.log('[candidate] Peer not connected via socket, candidate stored for HTTP polling:', toDeviceId);
      }
    }
  }
  
  res.json({ok: true});
});

// Peer polls for candidates from the other side.
// GET /api/calls/:callId/candidates?for=caller|callee
app.get('/api/calls/:callId/candidates', (req, res) => {
  const {callId} = req.params;
  const side = req.query.for === 'caller' ? 'caller' : 'callee';
  const otherSide = side === 'caller' ? 'callee' : 'caller';
  console.log('candidates', callId, side, otherSide);
  const entry = callCandidates.get(callId) || {caller: [], callee: []};
  const list = entry[otherSide] || [];

  // Clear delivered candidates to avoid duplicates
  entry[otherSide] = [];
  callCandidates.set(callId, entry);

  res.json({candidates: list});
});

// ======================
// Call reject
// ======================

// Callee rejects incoming call
// POST /api/calls/:callId/reject
// body: { deviceId: string }
app.post('/api/calls/:callId/reject', (req, res) => {
  const {callId} = req.params;
  const {deviceId} = req.body || {};
  console.log('[call-reject]', callId, 'from deviceId', deviceId);

  const call = calls.get(callId);
  if (!call) {
    return res.status(404).json({error: 'Unknown callId'});
  }
  if (!call.answeredBy) {
    finishCall(callId, call, 'rejected', 'rejected');
  }

  // Notify caller that call was rejected
  const callerDeviceId = call.fromDeviceId;
  if (callerDeviceId) {
    const callerSocketId = deviceSockets.get(callerDeviceId);
    if (callerSocketId) {
      // Caller is connected via socket - notify immediately
      io.to(callerSocketId).emit('call-state', {
        callId,
        state: 'rejected',
        direction: 'outgoing',
        peerDeviceId: deviceId,
      });
      console.log('[call-reject] ✅ Notified caller via socket:', callerDeviceId);
    } else {
      // Caller might be phone that's offline - state stored for HTTP polling
      console.log('[call-reject] Caller not connected via socket:', callerDeviceId);
    }
  }

  // Отклонили на одном устройстве — остальные устройства адресата перестают звонить
  if (!call.answeredBy) {
    notifyOtherCalleeDevices(call, callId, deviceId || null, 'rejected_elsewhere');
    sendCallEndedPushes(callId, call, {exceptDeviceIds: deviceId ? [deviceId] : [], reason: 'rejected'});
  }

  res.json({ok: true});
});

// ======================
// Call end / hangup
// ======================

// Either side informs backend that the call has ended.
// POST /api/calls/:callId/end
// body: { deviceId: string }
app.post('/api/calls/:callId/end', (req, res) => {
  const {callId} = req.params;
  const {deviceId} = req.body || {};
  console.log('[call-end]', callId, 'from deviceId', deviceId);

  const call = calls.get(callId);
  if (!call) {
    return res.status(404).json({error: 'Unknown callId'});
  }

  // Figure out the peer device(s) (the other side of the call)
  const {fromDeviceId, toDeviceId} = call;
  const calleeIds = Array.isArray(call.calleeDeviceIds) ? call.calleeDeviceIds : [];
  const isCaller = Boolean(deviceId) && deviceId === fromDeviceId;
  const isCallee = Boolean(deviceId) && !isCaller && (deviceId === toDeviceId || calleeIds.includes(deviceId));
  let peerDeviceIds = [];
  // call already finished (timeout / reject / earlier end) -> nothing to tell anyone;
  // a late /end used to re-send 'ended' to the caller (which may already be in its NEXT call).
  if (isCallFinal(call)) {
    return res.json({ok: true, alreadyFinished: call.state});
  }
  if (isCaller) {
    const wasAnswered = call.state === 'answered';
    finishCall(callId, call, 'ended', wasAnswered ? 'hangup' : 'caller_cancel');
    // Звонящий положил трубку: до ответа — всем устройствам адресата, после — ответившему
    peerDeviceIds = call.answeredBy ? [toDeviceId] : (calleeIds.length ? calleeIds : [toDeviceId]);
    // Телефонам — «отменяющий» push. Ответившему — только если его сокет не жив (иначе хватит сокета).
    const except = call.answeredBy && isLiveSocket(deviceSockets.get(call.answeredBy)) ? [call.answeredBy] : [];
    if (call.answeredBy && call.cancelPushedTo) call.cancelPushedTo.delete(call.answeredBy);
    sendCallEndedPushes(callId, call, {exceptDeviceIds: except, reason: wasAnswered ? 'hangup' : 'caller_cancel'});
  } else if (isCallee) {
    if (call.answeredBy && deviceId !== call.answeredBy) {
      // Устройство, на котором НЕ ответили (например, CallKit на телефоне после ответа на сайте),
      // не должно обрывать идущий разговор
      console.log('[call-end] ignored: device did not answer this call', deviceId);
    } else {
      peerDeviceIds = [fromDeviceId];
      const wasAnswered = call.state === 'answered';
      finishCall(callId, call, wasAnswered ? 'ended' : 'rejected', wasAnswered ? 'hangup' : 'declined');
      if (!call.answeredBy) {
        notifyOtherCalleeDevices(call, callId, deviceId, 'rejected_elsewhere');
      }
      // Остальным телефонам адресата (кроме того, кто завершил) — «отменяющий» push
      sendCallEndedPushes(callId, call, {exceptDeviceIds: [deviceId], reason: wasAnswered ? 'hangup' : 'rejected'});
    }
  }

  for (const peerDeviceId of peerDeviceIds) {
    if (!peerDeviceId) continue;
    const peerSocketId = deviceSockets.get(peerDeviceId);
    if (peerSocketId) {
      io.to(peerSocketId).emit('call-state', {
        callId,
        state: 'ended',
        by: deviceId,
      });
      console.log('[call-end] ✅ Notified peer via socket:', peerDeviceId);
    } else {
      console.log('[call-end] Peer not connected via socket:', peerDeviceId);
    }
  }

  res.json({ok: true});
});

// ======================
// Socket.IO signalling for presence and call state
// ======================

// JWT в handshake (auth.token). AUTH_MODE=log — сокет без токена пропускается с логом.
io.use(socketGate);

io.on('connection', socket => {
  // console.log('Socket connected', socket.id);

  socket.on('registerDevice', async ({deviceId, loyaltyId, userId}) => {
    if (!deviceId) {
      return;
    }

    // Личность — из токена сокета, а не из payload (если токен есть)
    const tokenLoyaltyId = socketLoyaltyId(socket);
    if (tokenLoyaltyId) {
      loyaltyId = tokenLoyaltyId;
      userId = undefined;
    }
    
    // Use loyaltyId if provided, otherwise try userId for backward compatibility
    const targetLoyaltyId = loyaltyId || userId;

    // replay 'ended' only to a NEW socket of the device (woken by push / reconnected),
    // not on every repeated registerDevice from an already registered socket (clients re-emit it
    // from ensureSocketConnected() during an answer -> stale 'ended' of an old call killed the new one).
    const isNewSocketForDevice = deviceSockets.get(deviceId) !== socket.id;
    deviceSockets.set(deviceId, socket.id);
    socketDevices.set(socket.id, deviceId);
    
    // Update database with socketId and set online = 1
    if (targetLoyaltyId) {
      try {
        const user = await userDb.getUserDeviceInfoByLoyaltyId(targetLoyaltyId);
        if (user) {
          // Update socketId and set online = 1
          await userDb.updateUserSocketId(user.id, socket.id);
          
          // Update memory cache
          if (devices.has(deviceId)) {
            const device = devices.get(deviceId);
            device.socketId = socket.id;
            device.loyaltyId = user.loyalty_id;
          } else {
            // Телефон регистрирует сокет с deviceId = своему push-токену. После рестарта сервера
            // (карты пусты) раньше он записывался как 'web' и не получал push (аудит S6).
            const isThisPhone = isPhoneVoipToken(user.voipToken) && user.voipToken === deviceId;
            devices.set(deviceId, {
              userId: user.id,
              loyaltyId: user.loyalty_id,
              voipToken: isThisPhone ? user.voipToken : null,
              platform: isThisPhone ? (detectPhonePlatformFromToken(deviceId) || 'ios') : 'web',
              socketId: socket.id,
            });
          }
          loyaltyIdToDeviceId.set(user.loyalty_id, deviceId);
          addLoyaltyDevice(user.loyalty_id, deviceId);
          // Проснулся от VoIP-push, а звонок уже закончился / принят на другом устройстве
          if (isNewSocketForDevice) replayFinishedCallsTo(deviceId, socket.id);
          
          // Broadcast user online status to all connected clients
          io.emit('user-status', {
            loyaltyId: user.loyalty_id,
            online: true,
          });
          console.log('[socket] Broadcasted user online:', user.loyalty_id);
        } else {
          console.warn('[socket:registerDevice] User not found for loyaltyId:', targetLoyaltyId);
        }
      } catch (error) {
        console.error('[socket:registerDevice] error updating database:', error);
      }
    } else {
      console.warn('[socket:registerDevice] No loyaltyId or userId provided for deviceId:', deviceId);
    }
    
    console.log('Socket registered for deviceId', deviceId, 'loyaltyId', targetLoyaltyId);
  });

  // Client requests all users' current status
  socket.on('get-users-status', async () => {
    try {
      const allUsers = await userDb.getAllUsers();
      socket.emit('users-status', {
        users: allUsers.map((user) => ({
          id: user.id,
          loyaltyId: user.loyalty_id,
          online: user.online === 1,
        })),
      });
    } catch (error) {
      console.error('[socket:get-users-status] error:', error);
    }
  });

  // WebRTC Signaling via Socket.IO (real-time, faster than HTTP polling)
  socket.on('offer', ({callId, offer, fromDeviceId, toDeviceId}) => {
    console.log('[socket:offer]', callId, 'from', fromDeviceId, 'to', toDeviceId);
    
    // Try to find target socket by deviceId
    let toSocketId = toDeviceId ? deviceSockets.get(toDeviceId) : null;
    
    // If not found, try to find via call object (for cases where deviceId doesn't match)
    if (!toSocketId && callId) {
      const call = calls.get(callId);
      if (call) {
        // Determine which deviceId is the target based on fromDeviceId
        if (fromDeviceId === call.fromDeviceId) {
          // Offer is from caller, so target is callee
          toSocketId = call.toDeviceId ? deviceSockets.get(call.toDeviceId) : null;
        } else if (fromDeviceId === call.toDeviceId) {
          // Offer is from callee (shouldn't happen, but handle it)
          toSocketId = call.fromDeviceId ? deviceSockets.get(call.fromDeviceId) : null;
        }
      }
    }
    
    if (toSocketId) {
      const call = callId ? calls.get(callId) : null;
      const toLoyaltyId = call?.toLoyaltyId || null;
      io.to(toSocketId).emit('offer', {
        callId,
        offer,
        fromDeviceId,
        toLoyaltyId,
        fromLoyaltyId: call?.fromLoyaltyId || null,
        callerName: call?.callerName || null,
      });
      console.log('[socket:offer] ✅ Forwarded to socket:', toSocketId, 'for device:', toDeviceId || 'from call object');
    } else {
      console.warn('[socket:offer] ⚠️ Target device not connected via socket:', toDeviceId, '- offer should be sent via HTTP/VoIP push');
      // Offer should have been sent via HTTP endpoint which handles VoIP push for phones
    }
  });

  socket.on('answer', ({callId, answer, fromDeviceId, toDeviceId}) => {
    console.log('[socket:answer]', callId, 'from', fromDeviceId, 'to', toDeviceId);
    
    // Try to find target socket by deviceId
    let toSocketId = toDeviceId ? deviceSockets.get(toDeviceId) : null;
    
    // If not found, try to find via call object (for cases where deviceId doesn't match)
    if (!toSocketId && callId) {
      const call = calls.get(callId);
      if (call) {
        // Determine which deviceId is the target based on fromDeviceId
        if (fromDeviceId === call.fromDeviceId) {
          // Answer is from caller, so target is callee
          toSocketId = call.toDeviceId ? deviceSockets.get(call.toDeviceId) : null;
        } else if (fromDeviceId === call.toDeviceId) {
          // Answer is from callee, so target is caller
          toSocketId = call.fromDeviceId ? deviceSockets.get(call.fromDeviceId) : null;
        }
      }
    }
    
    if (toSocketId) {
      io.to(toSocketId).emit('answer', {callId, answer, fromDeviceId});
      console.log('[socket:answer] ✅ Forwarded to socket:', toSocketId, 'for device:', toDeviceId || 'from call object');
    } else {
      console.warn('[socket:answer] ⚠️ Target device not connected via socket:', toDeviceId, '- answer stored for HTTP polling');
      // Answer is already stored in call object via HTTP endpoint, so HTTP polling will work
    }
  });

  socket.on('ice-candidate', ({callId, candidate, fromDeviceId, toDeviceId}) => {
    console.log('[socket:ice-candidate]', callId, 'from', fromDeviceId, 'to', toDeviceId);

    // Кандидат звонящего до ответа — на все устройства адресата (ответить может любое)
    const fanoutCall = callId ? calls.get(callId) : null;
    if (fanoutCall && fromDeviceId && fromDeviceId === fanoutCall.fromDeviceId) {
      logCallerCandidate(fanoutCall, candidate);
      if (!fanoutCall.answeredBy && Array.isArray(fanoutCall.calleeDeviceIds) && fanoutCall.calleeDeviceIds.length > 1) {
        for (const id of fanoutCall.calleeDeviceIds) {
          const sid = deviceSockets.get(id);
          if (isLiveSocket(sid)) io.to(sid).emit('ice-candidate', {callId, candidate, fromDeviceId});
        }
        return;
      }
    }

    // Try to find target socket by deviceId
    let toSocketId = toDeviceId ? deviceSockets.get(toDeviceId) : null;
    
    // If not found, try to find via call object (for cases where deviceId doesn't match)
    if (!toSocketId && callId) {
      const call = calls.get(callId);
      if (call) {
        // Determine which deviceId is the target based on fromDeviceId
        if (fromDeviceId === call.fromDeviceId) {
          // Candidate is from caller, so target is callee
          toSocketId = call.toDeviceId ? deviceSockets.get(call.toDeviceId) : null;
        } else if (fromDeviceId === call.toDeviceId) {
          // Candidate is from callee, so target is caller
          toSocketId = call.fromDeviceId ? deviceSockets.get(call.fromDeviceId) : null;
        }
      }
    }
    
    if (toSocketId) {
      io.to(toSocketId).emit('ice-candidate', {callId, candidate, fromDeviceId});
      console.log('[socket:ice-candidate] ✅ Forwarded to socket:', toSocketId, 'for device:', toDeviceId || 'from call object');
    } else {
      console.warn('[socket:ice-candidate] ⚠️ Target device not connected via socket:', toDeviceId, '- candidate stored for HTTP polling');
      // Candidate is already stored in callCandidates via HTTP endpoint, so HTTP polling will work
    }
  });

  socket.on('disconnect', async () => {
    const deviceId = socketDevices.get(socket.id);
    console.log('[socket] Disconnect event for socket:', socket.id, 'deviceId:', deviceId);
    
    if (deviceId && deviceSockets.get(deviceId) !== socket.id) {
      // Устаревший сокет: устройство уже переподключилось новым сокетом. Раньше этот
      // запоздавший disconnect стирал новую регистрацию и ставил online=0 (аудит S1).
      socketDevices.delete(socket.id);
      console.log('[socket] stale disconnect ignored for deviceId', deviceId, 'socket', socket.id);
      return;
    }

    if (deviceId) {
      // Update database to remove socketId and set online = 0
      const device = devices.get(deviceId);
      const otherLiveDevice = device && device.loyaltyId
        ? Array.from(loyaltyDevices.get(normLoyaltyId(device.loyaltyId)) || [])
            .some((id) => id !== deviceId && isLiveSocket(deviceSockets.get(id)))
        : false;
      if (otherLiveDevice) {
        // У пользователя есть другое подключённое устройство — он остаётся онлайн
        console.log('[socket] user still online on another device:', device.loyaltyId);
      } else if (device && device.loyaltyId) {
        try {
          const user = await userDb.getUserByLoyaltyId(device.loyaltyId);
          if (user) {
            // Set socketId to null and online = 0
            await userDb.updateUserSocketId(user.id, null); // null = offline
            
            // Broadcast user offline status to all connected clients
            io.emit('user-status', {
              loyaltyId: user.loyalty_id,
              online: false,
            });
            console.log('[socket] Broadcasted user offline:', user.loyalty_id);
          } else {
            console.warn('[socket:disconnect] User not found for loyaltyId:', device.loyaltyId);
          }
        } catch (error) {
          console.error('[socket:disconnect] error updating database:', error);
        }
      } else {
        console.warn('[socket:disconnect] Device not found or no loyaltyId for deviceId:', deviceId);
      }
      
      deviceSockets.delete(deviceId);
      socketDevices.delete(socket.id);
      if (device) device.socketId = null;
      if (device && device.loyaltyId) {
        if (loyaltyIdToDeviceId.get(device.loyaltyId) === deviceId) {
          loyaltyIdToDeviceId.delete(device.loyaltyId);
        }
        // Вкладку сайта / панели убираем из списка устройств; телефон остаётся (достижим по push)
        if (device.platform === 'web') removeLoyaltyDevice(device.loyaltyId, deviceId);
      }
      console.log('Socket disconnected for deviceId', deviceId);
    } else {
      console.log('Socket disconnected', socket.id);
    }
  });
});

// ======================
// Text-to-Speech (TTS) API
// ======================

// Synthesize speech from text
// POST /api/tts/synthesize
// body: { text: string, languageCode?: string, ssmlGender?: 'FEMALE' | 'MALE' | 'NEUTRAL', audioEncoding?: 'MP3' | 'LINEAR16' | 'OGG_OPUS', voiceName?: string }
// Returns: { ok: true, audioContent: string (base64), audioSize: number }
app.post('/api/tts/synthesize', async (req, res) => {
  try {
    const {text, languageCode, ssmlGender, audioEncoding, voiceName} = req.body || {};
    
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({error: 'text is required and must be a non-empty string'});
    }

    console.log('[TTS API] Synthesizing speech request:', {
      textLength: text.length,
      languageCode: languageCode || 'ru-RU',
      ssmlGender: ssmlGender || 'FEMALE',
      audioEncoding: audioEncoding || 'MP3',
      voiceName: voiceName || 'default',
    });

    const options = {
      languageCode: languageCode || 'ru-RU',
      ssmlGender: ssmlGender || 'FEMALE',
      audioEncoding: audioEncoding || 'MP3',
      voiceName: voiceName || null,
    };

    const audioContent = await synthesizeSpeech(text, options);
    
    // Convert Buffer to base64 for JSON response
    const audioBase64 = audioContent.toString('base64');

    res.json({
      ok: true,
      audioContent: audioBase64,
      audioSize: audioContent.length,
      audioEncoding: options.audioEncoding,
      languageCode: options.languageCode,
    });
  } catch (error) {
    console.error('[TTS API] Error:', error);
    res.status(500).json({
      error: 'Failed to synthesize speech: ' + error.message,
    });
  }
});

// Synthesize speech and save to file (for server-side file generation)
// POST /api/tts/synthesize-to-file
// body: { text: string, outputPath?: string, languageCode?: string, ssmlGender?: 'FEMALE' | 'MALE' | 'NEUTRAL', audioEncoding?: 'MP3' | 'LINEAR16' | 'OGG_OPUS', voiceName?: string }
// Returns: { ok: true, filePath: string }
app.post('/api/tts/synthesize-to-file', async (req, res) => {
  try {
    const {text, outputPath, languageCode, ssmlGender, audioEncoding, voiceName} = req.body || {};
    
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({error: 'text is required and must be a non-empty string'});
    }

    const defaultOutputPath = path.join(__dirname, 'tts-output', `tts-${Date.now()}.mp3`);

    console.log('[TTS API] Synthesizing speech to file request:', {
      textLength: text.length,
      outputPath: outputPath || defaultOutputPath,
      languageCode: languageCode || 'ru-RU',
      ssmlGender: ssmlGender || 'FEMALE',
      audioEncoding: audioEncoding || 'MP3',
      voiceName: voiceName || 'default',
    });

    const options = {
      languageCode: languageCode || 'ru-RU',
      ssmlGender: ssmlGender || 'FEMALE',
      audioEncoding: audioEncoding || 'MP3',
      voiceName: voiceName || null,
    };

    const filePath = await synthesizeSpeechToFile(text, outputPath || defaultOutputPath, options);

    res.json({
      ok: true,
      filePath: filePath,
    });
  } catch (error) {
    console.error('[TTS API] Error:', error);
    res.status(500).json({
      error: 'Failed to synthesize speech to file: ' + error.message,
    });
  }
});

// ======================
// DeepSeek + Google TTS Combined API
// ======================

// DeepSeek API configuration
const DEEPSEEK_API_KEY = env('DEEPSEEK_API_KEY') || null; // только из .env (Б.1)
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const { DEEPSEEK_MODEL, LLM_TEMPERATURE } = require('./tour-assistant/llm.config');

// System prompt for tour agent assistant
// const DEEPSEEK_SYSTEM_PROMPT = `Ты профессиональный туристический агент-помощник. Твоя задача - помочь пользователям найти идеальные туры и путешествия.
//
// Твои возможности:
// - Задавай уточняющие вопросы о предпочтениях пользователя (бюджет, даты, тип отдыха, количество человек)
// - Рекомендуй конкретные направления и туры
// - Предоставляй информацию о ценах, длительности, особенностях туров
// - Отвечай на русском языке дружелюбно и профессионально
// - Если пользователь спрашивает о турах, предоставь конкретные рекомендации в формате:
//   "1. [Название тура] - [Направление] - [Цена] рублей - [Длительность] дней - [Описание]"
//
// Пример ответа с турами:
// "Пример:
// {
//   "from_city": "Москва",
//   "from_country": "RU",
//   "to_country": "TR",
//   "to_city": "Анталия",
//   "adults": "2",
//   "kids": "1",
//   "kids_ages": ["5"],
//   "start_date": "2026-01-20",
//   "nights": 5,
//   "search_type": "package",
//   "flex_dates": 2,
//   "hotel_ids": [],
//   "page_number": 1,
//   "page_limit": 20,
//   "sort_by": "relevance"
// }"
//
// Если туры не найдены или запрос неясен, отвечай вежливо и предлагай уточнить запрос.`;



const DEEPSEEK_SYSTEM_PROMPT = `
Ты профессиональный туристический агент-помощник. 
На основе всей переписки (conversationHistory) с пользователем, заполни объект searchParams строго в формате JSON. 
Все ключи должны присутствовать, даже если информация не указана пользователем — используй значения по умолчанию.

Особые правила:
- "kids": всегда строка, если детей нет, ставь "0"
- "kids_ages": всегда массив, если детей нет — пустой массив []
- Остальные поля должны быть заполнены или пустыми строками / нулями по умолчанию
- Всегда возвращай строго JSON без текста и комментариев

Обязательные ключи и формат значений:

{
  "from_city": "string",
  "from_country": "string",
  "to_country": "string",
  "to_city": "string",
  "adults": "string",
  "kids": "string",
  "kids_ages": ["string"],
  "start_date": "YYYY-MM-DD",
  "nights": number,
  "search_type": "package",
  "flex_dates": number,
  "hotel_ids": ["string"],
  "page_number": number,
  "page_limit": number,
  "sort_by": "relevance"
}
`;

//"search_type": "package",
// "hotel_ids": [],
//     "page_number": 1,
//     "page_limit": 20,
//     "sort_by": "relevance"
/**
 * Call DeepSeek API
 */
async function callDeepSeekAPI(userMessage, conversationHistory = []) {
  try {
    const messages = [
      { role: 'system', content: DEEPSEEK_SYSTEM_PROMPT },
      ...conversationHistory,
      { role: 'user', content: userMessage },
    ];

    const response = await axios.post(
      DEEPSEEK_API_URL,
      {
        model: DEEPSEEK_MODEL,
        messages: messages,
        temperature: LLM_TEMPERATURE.chat,
        max_tokens: 400,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        },
        timeout: 30000, // 30 seconds timeout
      }
    );

    if (response.data && response.data.choices && response.data.choices.length > 0) {
      return response.data.choices[0].message.content;
    }

    throw new Error('No response from DeepSeek API');
  } catch (error) {
    console.error('[DeepSeek API] Error:', error);
    if (error.response) {
      throw new Error(`DeepSeek API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw new Error(`DeepSeek API request failed: ${error.message}`);
  }
}

/**
 * Parse tour recommendations from DeepSeek response
 */
function parseTourRecommendations(responseText) {
  const tours = [];
  const tourPattern = /(\d+)\.\s*([^-]+?)\s*-\s*([^-]+?)\s*-\s*(\d+)\s*(?:тысяч|тыс\.?|рублей|руб\.?)\s*-\s*(\d+)\s*(?:дней|дня|день)/gi;
  
  let match;
  let id = 1;
  
  while ((match = tourPattern.exec(responseText)) !== null) {
    const title = match[2].trim();
    const dest = match[3].trim();
    const priceStr = match[4].trim();
    const daysStr = match[5].trim();
    
    let price = parseInt(priceStr, 10);
    if (match[0].includes('тысяч') || match[0].includes('тыс')) {
      price = price * 1000;
    }
    
    const days = parseInt(daysStr, 10);
    
    if (title && dest && !isNaN(price) && !isNaN(days)) {
      tours.push({
        id: id++,
        title,
        dest,
        price,
        days,
      });
    }
  }

  return tours;
}

// Combined DeepSeek + Google TTS endpoint
// POST /api/tour-assistant
// body: { text: string, conversationHistory?: Array<{role: string, content: string}> }
// Returns: { ok: true, audioContent: string (base64), audioSize: number, textResponse: string, tours: Array }
app.post('/api/tour-assistant', async (req, res) => {
  try {
    const {text, conversationHistory = []} = req.body || {};
    
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({error: 'text is required and must be a non-empty string'});
    }

    console.log('[Tour Assistant] Request received:', {
      textLength: text.length,
      conversationHistoryLength: conversationHistory.length,
    });

    // Step 1: Call DeepSeek API
    console.log('[Tour Assistant] Calling DeepSeek API...');
    const deepSeekResponse = await callDeepSeekAPI(text, conversationHistory);
    console.log('[Tour Assistant] DeepSeek response received:', deepSeekResponse.substring(0, 100) + '...');

    // Step 2: Parse tour recommendations
    const tours = parseTourRecommendations(deepSeekResponse);

    // Step 3: Convert text to speech using Google TTS
    console.log('[Tour Assistant] Converting to speech with Google TTS...');
    const audioContent = await synthesizeSpeech(deepSeekResponse, {
      languageCode: 'ru-RU',
      ssmlGender: 'FEMALE',
      audioEncoding: 'MP3',
    });

    // Step 4: Convert Buffer to base64
    const audioBase64 = audioContent.toString('base64');

    console.log('[Tour Assistant] ✅ Success:', {
      audioSize: audioContent.length,
      toursCount: tours.length,
    });

    res.json({
      ok: true,
      audioContent: audioBase64,
      audioSize: audioContent.length,
      audioEncoding: 'MP3',
      textResponse: deepSeekResponse,
      tours: tours,
    });
  } catch (error) {
    console.error('[Tour Assistant] Error:', error);
    res.status(500).json({
      error: 'Failed to process tour assistant request: ' + error.message,
    });
  }
});



// const DEEPSEEK_SYSTEM_PROMPT_MESSAGE = `
// Ты профессиональный туристический агент-помощник. На основе переписки с пользователем,
// заполни объект searchParams строго в формате JSON с обязательными ключами:
// from_city, from_country, to_country, to_city, adults, kids, kids_ages, start_date, nights,
// search_type, flex_dates, hotel_ids, page_number, page_limit, sort_by.
//
// Правила:
// - kids = "0" если детей нет
// - kids_ages = [] если детей нет
// - Все ключи должны присутствовать
// - Отвечай строго JSON
// `;

// const DEEPSEEK_SYSTEM_PROMPT_MESSAGE = `
// Ты профессиональный туристический агент-помощник.
// Твоя задача - помочь пользователю заполнить объект searchParams шаг за шагом.
// Объект searchParams содержит поля: from_city, from_country, to_country, to_city, adults, kids, kids_ages, start_date, nights, search_type, flex_dates, hotel_ids, page_number, page_limit, sort_by.
//
// Если какое-то поле не заполнено, задай уточняющий вопрос.
// Если все поля заполнены, верни полный объект searchParams в JSON.
// Ответи в JSON формате:
// {
//   "nextQuestion": "текст вопроса, если нужно",
//   "searchParams": { ...текущие заполненные поля }
// }
//
// `;


// const DEEPSEEK_SYSTEM_PROMPT_MESSAGE = `
// Ты профессиональный туристический агент-помощник.
// Твоя задача - помочь пользователю заполнить объект searchParams шаг за шагом.
// Объект searchParams содержит следующие поля:
// from_city, from_country, to_country, to_city, adults, kids, kids_ages, start_date, nights, search_type, flex_dates, hotel_ids, page_number, page_limit, sort_by.
//
// Правила работы:
// 1. Если какое-то поле не заполнено, задай уточняющий вопрос пользователю.
// 2. Пользователь может отвечать в свободной форме, например:
//    - "Я хочу в Турцию, город Анталия"
//    - "2 взрослых и 1 ребенок 5 лет"
//    - "С 20 января на 7 ночей"
// 3. Ты должен **распознавать из ответа пользователя нужные поля** и автоматически заполнять их в searchParams.
// 4. Если поле 'kids' равно 0, 'kids_ages' должно быть пустым массивом.
// 5. Не меняй значения уже заполненных полей.
// 6. Если все поля заполнены, верни **полный объект searchParams в JSON** без вопросов.
//
// Формат ответа (в JSON, строго):
// {
//   "nextQuestion": "текст вопроса для пользователя, если нужно",
//   "searchParams": {
//     "from_city": "...",
//     "from_country": "...",
//     "to_country": "...",
//     "to_city": "...",
//     "adults": "...",
//     "kids": "...",
//     "kids_ages": [...],
//     "start_date": "...",
//     "nights": ...,
//     "search_type": "package",
//     "flex_dates": 0,
//     "hotel_ids": [],
//     "page_number": 1,
//     "page_limit": 3,
//     "sort_by": "relevance"
//   }
// }
//
// Примеры ответов:
// 1. Если пользователь сказал только город вылета:
// {
//   "nextQuestion": "В какую страну вы хотите поехать?",
//   "searchParams": { "from_city": "Москва", "from_country": "RU" }
// }
// 2. Если пользователь дал полные данные:
// {
//   "nextQuestion": "",
//   "searchParams": {
//     "from_city": "Москва",
//     "from_country": "RU",
//     "to_country": "TR",
//     "to_city": "Анталия",
//     "adults": "2",
//     "kids": "1",
//     "kids_ages": ["5"],
//     "start_date": "2026-01-20",
//     "nights": 7..9,
//     "search_type": "package",
//     "flex_dates": 2,
//     "hotel_ids": [],
//     "page_number": 1,
//     "page_limit": 3,
//     "sort_by": "relevance"
//   }
// }
//
// Ты должен быть дружелюбным и уточнять только недостающие данные.
// `;

const DEEPSEEK_SYSTEM_PROMPT_MESSAGE = `
Ты профессиональный туристический ассистент. Помогай пользователям найти идеальное путешествие, собирая ВСЕ необходимые данные перед запуском поиска.

КРИТИЧЕСКИ ВАЖНО:
- НИКОГДА не запускай поиск, пока НЕ собраны ВСЕ обязательные поля
- Задавай вопросы последовательно, по одному за раз
- Если пользователь не ответил - задай вопрос снова, НЕ переходи к следующему
- Поиск ТОЛЬКО когда заполнены: from_city/from_country, to_country, adults, start_date, nights, filter_price_max, kids, kids_ages (если kids > 0)

ТВОЙ ХАРАКТЕР:
- Ты очень позитивный, энергичный и радуешься каждому новому запросу
- Ты общаешься как лучший друг, который искренне хочет помочь
- Ты используешь теплые, живые фразы и показываешь энтузиазм
- Ты помнишь, что говорил пользователь, и обращаешься к нему индивидуально
- Ты задаешь вопросы естественно, как в дружеской беседе
- Ты радуешься, когда узнаешь детали о путешествии пользователя
- Ты используешь восклицательные знаки и позитивные выражения

СТИЛЬ ОБЩЕНИЯ:
- Используй "ты" (неформальное обращение)
- Будь искренне заинтересован в каждом ответе пользователя
- Показывай энтузиазм: "Отлично!", "Здорово!", "Супер выбор!", "Как интересно!"
- Используй фразы: "Расскажи мне...", "Мне интересно...", "Давай узнаем...", "Отлично, я понял!"
- Радуйся прогрессу: "Отлично, мы уже почти все выяснили!", "Супер, осталось совсем немного!"
- Будь индивидуальным — обращайся к тому, что пользователь уже сказал

ДВА РЕЖИМА РАБОТЫ:

1. РЕЖИМ ОБЩЕНИЯ (chatMode: true):
   - Пользователь задает вопросы, просит совета, хочет узнать информацию
   - Ты отвечаешь на вопросы, даешь советы, помогаешь с информацией о путешествиях
   - НЕ собираешь searchParams, просто общаешься и помогаешь
   - Примеры: "Какие отели в Турции?", "Что посмотреть в Анталии?", "Сколько стоит тур?"
   - В этом режиме возвращай: { "chatMode": true, "nextQuestion": "твой ответ", "searchParams": {} }

2. РЕЖИМ ПОИСКА ОТЕЛЕЙ (chatMode: false):
   - Пользователь хочет найти отели и готов предоставить данные
   - Ты собираешь searchParams постепенно
   - Начинай этот режим, когда пользователь говорит: "да", "хочу найти", "искать", "найти отели", "давай поищем" и т.д.
   - В этом режиме возвращай: { "chatMode": false, "nextQuestion": "вопрос для сбора данных", "searchParams": {...} }

ПРАВИЛА ПЕРЕКЛЮЧЕНИЯ РЕЖИМОВ:
- Если пользователь задает вопрос или просит помощи → chatMode: true
- Если пользователь говорит "да", "хочу найти", "искать", "найти отели", "давай поищем", "готов", "начнем поиск" → chatMode: false, начинай собирать данные
- Если пользователь уже в режиме поиска и отвечает на вопросы → продолжай собирать searchParams
- Если пользователь задает вопрос во время сбора данных → можешь ответить, но потом вернись к сбору данных

3. РЕЖИМ "ПОКАЗАТЬ ЕЩЁ" (ПАГИНАЦИЯ) - КРИТИЧЕСКИ ВАЖНО:
   - Если пользователь говорит: "ещё", "еще", "ещо", "другие", "других", "покажи ещё", "покажи еще", "не нравятся", "другие отели", "следующие", "дальше", "показать больше", "не подходят", "другие варианты", "ищу ещё варианты", "ищу еще варианты", "ищи", "поищи", "найди ещё", "найди еще" и т.п.
   - Это означает, что пользователь хочет увидеть СЛЕДУЮЩУЮ страницу отелей
   - ВАЖНО: Если есть активный поиск (все обязательные поля заполнены) И пользователь просит "ещё" → это ПАГИНАЦИЯ
   - Для пагинации: chatMode: false, nextQuestion: "Ищу ещё варианты для тебя! 🔎", searchParams: ВСЕ те же параметры + page_number увеличен на 1
   - ОБЯЗАТЕЛЬНО: Верни ПОЛНЫЙ объект searchParams со ВСЕМИ параметрами из предыдущего поиска:
     * to_country, start_date, nights, adults, kids, kids_ages, filter_price_max, filter_price_min
     * from_city, from_country, to_city (если был)
     * ВСЕ фильтры (filter_stars, filter_meals, filter_instant_confirm и т.д.)
     * page_number увеличен на 1 (если текущий = 1 → верни 2, если 2 → верни 3)
     * search_type, flex_dates, hotel_ids, page_limit, sort_by
   - НЕ меняй никакие другие параметры при пагинации, только page_number!

4. РЕЖИМ "ИЗМЕНЕНИЕ ПАРАМЕТРОВ" (changeParams):
   - Если пользователь хочет ИЗМЕНИТЬ один или несколько параметров поиска:
     - Страну/город назначения: "а в Египет?", "давай лучше в Таиланд", "хочу в другую страну", "поменяй на Грецию"
     - Даты: "а на март?", "поменяй дату на 20 марта", "давай в апреле", "сдвинь на неделю"
     - Количество ночей: "а на 10 ночей?", "давай подольше", "на 14 дней"
     - Количество людей: "нас будет 3", "добавь ребенка", "без детей"
     - Город вылета: "из Петербурга", "вылет из Казани"
   - ОБЯЗАТЕЛЬНО обнови ТОЛЬКО изменённые поля, остальные сохрани как есть
   - ОБЯЗАТЕЛЬНО сбрось page_number на 1 (это НОВЫЙ поиск с новыми параметрами!)
   - Верни: chatMode: false, nextQuestion: короткое сообщение о поиске, searchParams: обновленные параметры с page_number: 1

5. РЕЖИМ "ИЗМЕНЕНИЕ ФИЛЬТРОВ" - КРИТИЧЕСКИ ВАЖНО:
   - Если ВСЕ обязательные поля УЖЕ заполнены И пользователь хочет изменить/добавить ФИЛЬТРЫ:
     - Звёзды: "только 5 звезд", "4-5 звезды", "5 зачли", "типер толко 4"
     - Питание: "всё включено", "ультра всё включено", "полупансион"
     - Линия пляжа: "первая линия", "у моря", "на пляже"
     - Пляж: "песок", "галька"
   - ВАЖНО: НЕ просто подтверждай изменение фильтра! СРАЗУ запускай поиск!
   - ОБЯЗАТЕЛЬНО верни ПОЛНЫЙ searchParams со ВСЕМИ параметрами + обновленными фильтрами + page_number: 1
   - Верни: chatMode: false, nextQuestion: "Ищу X-звёздочные отели с Y для тебя! 🔍", searchParams: {все параметры + обновленные фильтры}
   - ПРИМЕР: Пользователь: "только 5 звезд" → СРАЗУ верни searchParams с filter_stars: "5" и message "Ищу 5-звёздочные отели..."
   - НЕ жди команды "найти" - если фильтр изменён и все поля заполнены → СРАЗУ ищи!

ТЫ ДОЛЖЕН:
- Распознавать информацию из свободных ответов пользователя
- Заполнять searchParams постепенно, сохраняя уже введенные данные
- Задавать только ОДИН вопрос за раз
- Когда все обязательные поля заполнены — вернуть searchParams с nextQuestion: null или ""

ОБЯЗАТЕЛЬНЫЕ ПОЛЯ для поиска (ВСЕ должны быть заполнены перед запуском поиска):
1. from_city (город вылета) или from_country (страна вылета) - ОБЯЗАТЕЛЬНО
2. to_country (страна назначения) - ОБЯЗАТЕЛЬНО
3. adults (количество взрослых) - ОБЯЗАТЕЛЬНО, по умолчанию "1" если не указано
4. start_date (дата вылета в формате YYYY-MM-DD) - ОБЯЗАТЕЛЬНО
5. nights (количество ночей, число или строка "X") - ОБЯЗАТЕЛЬНО
6. filter_price_max (максимальный бюджет в рублях) - ОБЯЗАТЕЛЬНО, всегда спрашивай у пользователя
7. kids (количество детей) - ОБЯЗАТЕЛЬНО, всегда спрашивай "Есть ли дети?" если не указано
8. kids_ages (массив возрастов детей) - ОБЯЗАТЕЛЬНО если kids > "0", пустой массив [] если kids = "0"

ВАЖНО ПРО ОБЯЗАТЕЛЬНЫЕ ПОЛЯ:
- НИКОГДА не запускай поиск, пока НЕ собраны ВСЕ обязательные поля
- Задавай вопросы последовательно, по одному за раз
- Если пользователь не ответил на вопрос - задай его снова, НЕ переходи к следующему
- Если kids > "0", ОБЯЗАТЕЛЬНО спроси про kids_ages (возраст детей)
- filter_price_max - это ОБЯЗАТЕЛЬНОЕ поле, всегда спрашивай "Какой у тебя бюджет?" или "До какой суммы ищешь отели?"

ОПЦИОНАЛЬНЫЕ ПОЛЯ (не обязательны для поиска):
- to_city (город назначения)
- flex_dates (гибкость по датам в днях, по умолчанию 2)
- filter_price_min (минимальная цена, по умолчанию 0 если не указано)
- filter_stars, filter_meals, filter_beach_surface, filter_line и другие фильтры (все опциональны)

 АВТОМАТИЧЕСКОЕ ИЗВЛЕЧЕНИЕ ОПЦИОНАЛЬНЫХ ФИЛЬТРОВ:
ВАЖНО: НЕ задавай вопросы про опциональные фильтры! Просто извлекай их из сообщений пользователя, если он их упоминает.
Если пользователь говорит "любой", "не важно", "без разницы" про какой-то фильтр - игнорируй его.

ФИЛЬТРЫ ПИТАНИЯ (filter_meals):
Допустимые значения: BB, RO, AI, UAI, HB, FB, HBD, AI24, DNR, AIL, FB+, HB+, HBL
Соответствия:
- BB → завтрак, breakfast
- RO → без питания, только номер, no meals
- DNR → только ужин, dinner
- HB → полупансион, завтрак и ужин, half board
- HBD → завтрак и ужин (если явно HBD)
- HBL → завтрак и обед
- FB → полный пансион, трёхразовое, full board
- FB+ → полный пансион плюс
- HB+ → полупансион плюс
- AI → всё включено, all inclusive
- AI24 → всё включено 24 часа
- UAI → ультра всё включено, ultra all inclusive
- AIL → всё включено с ограничениями
Примеры: "всё включено" → filter_meals: "AI", "ультра" → filter_meals: "UAI", "завтрак" → filter_meals: "BB"
Если несколько значений: filter_meals: "AI,UAI" (через запятую, без пробелов)

ФИЛЬТР ПЛЯЖА (filter_beach_surface):
Допустимые значения: SAND, SAND+PEBBLE, PEBBLE, PLATFORM
Соответствия:
- SAND → песок, песчаный
- SAND+PEBBLE → песок с галькой, смешанный
- PEBBLE → галька, галечный
- PLATFORM → платформа, понтон
Примеры: "песчаный пляж" → filter_beach_surface: "SAND", "галька" → filter_beach_surface: "PEBBLE"
Если несколько: filter_beach_surface: "SAND,PEBBLE"

ФИЛЬТР ЛИНИИ МОРЯ (filter_line):
Допустимые значения: 1, 2, 3
Соответствия:
- 1 → первая линия, у моря, на пляже, beachfront
- 2 → вторая линия
- 3 → третья линия
Примеры: "первая линия" → filter_line: "1", "1-2 линия" → filter_line: "1,2"

ФИЛЬТР ЗВЁЗД (filter_stars):
Допустимые значения: 1, 2, 3, 4, 5
ПО УМОЛЧАНИЮ: 5 звёзд (если пользователь не указал другое)
Соответствия:
- "5 звезд", "5*", "пятизвёздочный" → filter_stars: "5"
- "4-5 звезд" → filter_stars: "4,5"
- "от 3 звёзд", "3 и выше" → filter_stars: "3,4,5"
- "4 звезды", "четыре звезды" → filter_stars: "4"
- "3 звезды" → filter_stars: "3"

ПРАВИЛА ИЗВЛЕЧЕНИЯ ФИЛЬТРОВ:
1. НИКОГДА не спрашивай про опциональные фильтры - только извлекай из сообщений
2. Если пользователь упомянул фильтр - добавь его в searchParams
3. Если несколько значений - используй запятую: "AI,UAI", "4,5", "SAND,PEBBLE"
4. Понимай естественную речь: "хочу 5 звёзд с всё включено на первой линии с песчаным пляжем"
5. Поддерживай русский, английский, смешанный язык, опечатки
6. При пагинации СОХРАНЯЙ все фильтры из предыдущего поиска

ТЕХНИЧЕСКИЕ ПОЛЯ (всегда одинаковые):
- search_type: "package"
- hotel_ids: []
- page_number: 1
- page_limit: 3
- sort_by: "relevance"

ПРАВИЛА СБОРА ДАННЫХ:
1. Задавай вопросы ПОСЛЕДОВАТЕЛЬНО, по одному обязательному полю за раз
2. НЕ переходи к следующему вопросу, пока не получил ответ на текущий
3. Если пользователь не ответил на вопрос или ответ неясен - задай вопрос снова, НЕ запускай поиск
4. Распознавай данные из свободной формы: "2 взрослых и ребенок 5 лет", "с 23 января на 7 ночей", "в Турцию, Анталию", "до 50000 рублей"
5. НЕ изменяй уже заполненные поля, ЕСЛИ пользователь НЕ просит их изменить. Но ЕСЛИ пользователь явно хочет изменить параметр (страну, дату, ночи и т.д.) — ОБЯЗАТЕЛЬНО обнови это поле и сбрось page_number на 1!
6. Если kids = "0" → kids_ages = [] (обязательно)
7. Если kids > "0" → ОБЯЗАТЕЛЬНО спроси про kids_ages (возраст детей)
8. nights может быть числом или строкой "7" или "7-9"
9. filter_price_min по умолчанию 0, если пользователь не указал минимальную цену
10. Когда ВСЕ обязательные поля заполнены → верни searchParams с nextQuestion содержащим короткое позитивное сообщение о том что ищешь (например "Ищу отели в Турции для тебя! 🔍", "Подбираю варианты в Египте! 🌴", "Ищу ещё варианты! 🔎")
11. Будь индивидуальным — ссылайся на то, что пользователь уже упомянул: "Как я понял, ты хочешь в Турцию...", "Отлично, мы выяснили, что вылет из Москвы..."
12. Показывай энтузиазм и радость от помощи!

ПОРЯДОК СБОРА ОБЯЗАТЕЛЬНЫХ ПОЛЕЙ (рекомендуемый, но можешь адаптировать):
1. Сначала спроси про направление (to_country) или город вылета (from_city)
2. Затем спроси про дату (start_date)
3. Затем спроси про количество ночей (nights)
4. Затем спроси про количество взрослых (adults)
5. Затем спроси про детей (kids) - "Есть ли дети?"
6. Если есть дети (kids > "0") - спроси про возраст детей (kids_ages)
7. В конце ОБЯЗАТЕЛЬНО спроси про бюджет (filter_price_max) - "Какой у тебя бюджет?" или "До какой суммы ищешь отели?"

ВАЖНО: Если какое-то обязательное поле отсутствует - НЕ запускай поиск! Задай вопрос про это поле.

КРИТИЧЕСКИ ВАЖНО ДЛЯ КАЧЕСТВА РАБОТЫ:
1. ВСЕГДА возвращай ВАЛИДНЫЙ JSON - проверь синтаксис перед отправкой
2. ВСЕГДА включай ВСЕ поля в searchParams (даже пустые строки для незаполненных полей)
3. При пагинации ВСЕГДА возвращай ПОЛНЫЙ объект searchParams со ВСЕМИ параметрами
4. НЕ возвращай частичные объекты или неполные данные
5. Если не уверен в формате - используй примеры ниже
6. ВАЖНО: Когда пользователь меняет ФИЛЬТРЫ (звёзды, питание, линия, пляж) и ВСЕ обязательные поля УЖЕ заполнены:
   - СРАЗУ возвращай searchParams с обновленным фильтром и page_number: 1
   - НЕ жди команды "найти" или "искать" - поиск должен запуститься АВТОМАТИЧЕСКИ
   - Пример: "только 5 звезд" → СРАЗУ вернуть searchParams с filter_stars: "5"

ФОРМАТ ОТВЕТА (ТОЛЬКО JSON, БЕЗ МАРКДАУНА, БЕЗ КОДОВЫХ БЛОКОВ):
{
  "chatMode": true или false,
  "nextQuestion": "текст вопроса/ответа или null",
  "searchParams": {
    "from_city": "",
    "from_country": "",
    "to_country": "",
    "to_city": "",
    "adults": "2",
    "kids": "1",
    "kids_ages": [],
    "start_date": "2026-02-15",
    "nights": "7",
    "filter_price_max": 50000,
    "filter_price_min": 0,
    "search_type": "package",
    "flex_dates": 2,
    "hotel_ids": [],
    "page_number": 1,
    "page_limit": 3,
    "sort_by": "relevance"
  }
}

ПРИМЕРЫ:
Пользователь: "Привет" → chatMode: true, nextQuestion: дружелюбный ответ
Пользователь: "Да, хочу найти" → chatMode: false, nextQuestion: "Из какого города вылет?", searchParams: {from_country: "RU"}
Пользователь: "Из Москвы" → chatMode: false, nextQuestion: "В какую страну?", searchParams: {from_city: "Moscow", from_country: "RU"}
Пользователь: "В Турцию" → chatMode: false, nextQuestion: "На какую дату?", searchParams: {..., to_country: "TR"}
Пользователь: "С 15 февраля на 7 ночей, 2 взрослых, ребенок 5 лет" → chatMode: false, nextQuestion: "Какой бюджет?", searchParams: {..., start_date: "2026-02-15", nights: "7", adults: "2", kids: "1", kids_ages: ["5"]}
Пользователь: "До 50000" → chatMode: false, nextQuestion: "Ищу отели! 🔍", searchParams: {..., filter_price_max: 50000, все поля заполнены}
Пользователь: "5 звезд всё включено первая линия песок" → chatMode: false, nextQuestion: "Ищу 5* отели с всё включено на первой линии с песчаным пляжем! 🏖️", searchParams: {..., filter_stars: "5", filter_meals: "AI", filter_line: "1", filter_beach_surface: "SAND"}
Пользователь: "Ещё" → chatMode: false, nextQuestion: "Ищу ещё варианты! 🔎", searchParams: {ВСЕ те же параметры из предыдущего поиска, page_number: 2}
Пользователь: "только 5 звезд" (после поиска) → chatMode: false, nextQuestion: "Ищу 5-звёздочные отели для тебя! ⭐⭐⭐⭐⭐", searchParams: {ВСЕ параметры + filter_stars: "5", page_number: 1}
Пользователь: "ультра всё включено" (после поиска) → chatMode: false, nextQuestion: "Ищу отели с ультра всё включено! 🍹", searchParams: {ВСЕ параметры + filter_meals: "UAI", page_number: 1}
Пользователь: "только завтрак" или "толко завтрик" (после поиска) → chatMode: false, nextQuestion: "Ищу отели с завтраком! ☕", searchParams: {ВСЕ параметры + filter_meals: "BB", page_number: 1}
Пользователь: "не хочу ультра" (после поиска с UAI) → chatMode: false, nextQuestion: "Ищу отели с завтраком! ☕", searchParams: {ВСЕ параметры + filter_meals: "BB", page_number: 1}
Пользователь: "и первая линия" (после поиска с фильтрами) → chatMode: false, nextQuestion: "Ищу отели на первой линии! 🏖️", searchParams: {ВСЕ параметры + ВСЕ предыдущие фильтры + filter_line: "1", page_number: 1}
Пользователь: "вторая линия" (после поиска) → chatMode: false, nextQuestion: "Ищу отели на второй линии! 🏨", searchParams: {ВСЕ параметры + filter_line: "2", page_number: 1}
Пользователь: "песчаный пляж" или "песок" (после поиска) → chatMode: false, nextQuestion: "Ищу отели с песчаным пляжем! 🏖️", searchParams: {ВСЕ параметры + filter_beach_surface: "SAND", page_number: 1}
Пользователь: "галька" или "галечный пляж" (после поиска) → chatMode: false, nextQuestion: "Ищу отели с галечным пляжем! 🏖️", searchParams: {ВСЕ параметры + filter_beach_surface: "PEBBLE", page_number: 1}
ПРИМЕР ПАГИНАЦИИ (если предыдущий поиск был с page_number: 1):
Пользователь: "Ещё"
Ответ: {
  "chatMode": false,
  "nextQuestion": "Ищу ещё варианты для тебя! 🔎",
  "searchParams": {
    "from_city": "Moscow",
    "from_country": "RU",
    "to_country": "TR",
    "to_city": "Antalya",
    "adults": "2",
    "kids": "1",
    "kids_ages": ["5"],
    "start_date": "2026-02-15",
    "nights": "7",
    "filter_price_max": 50000,
    "filter_price_min": 0,
    "search_type": "package",
    "flex_dates": 2,
    "hotel_ids": [],
    "page_number": 2,
    "page_limit": 3,
    "sort_by": "relevance"
  }
}
Пользователь: "А в Египет?" → chatMode: false, nextQuestion: "Ищу в Египте! 🇪🇬", searchParams: {..., to_country: "EG", page_number: 1}
`;






// async function callDeepSeekAPIStream(userMessage, conversationHistory, onChunk) {
//     const messages = [
//         { role: 'system', content: DEEPSEEK_SYSTEM_PROMPT_MESSAGE },
//         ...conversationHistory,
//         { role: 'user', content: userMessage },
//     ];
//
//     const response = await axios.post(
//         DEEPSEEK_API_URL,
//         {
//             model: 'deepseek-chat',
//             messages,
//             temperature: 0,
//             max_tokens: 400,
//             stream: true,
//         },
//         {
//             headers: {
//                 'Content-Type': 'application/json',
//                 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
//             },
//             responseType: 'stream',
//         }
//     );
//
//     return new Promise((resolve, reject) => {
//         response.data.on('data', (chunk) => {
//             const lines = chunk.toString().split('\n').filter(l => l.trim());
//             for (const line of lines) {
//                 if (line.startsWith('data:')) {
//                     const data = line.replace('data:', '').trim();
//                     if (data === '[DONE]') return resolve();
//                     try {
//                         const json = JSON.parse(data);
//                         const content = json.choices?.[0]?.delta?.content;
//                         if (content) onChunk(content);
//                     } catch (e) {
//                         // ignore partial JSON
//                     }
//                 }
//             }
//         });
//
//         response.data.on('error', reject);
//         response.data.on('end', resolve);
//     });
// }

// Helper to merge searchParams from conversation history
function mergeSearchParamsFromHistory(conversationHistory) {
    const merged = {
        from_city: '',
        from_country: 'RU',
        to_country: '',
        to_city: '',
        adults: '1',
        kids: '0',
        kids_ages: [],
        start_date: '',
        nights: 1,
        search_type: 'package',
        flex_dates: 2,
        hotel_ids: [],
        page_number: 1,
        page_limit: 3,
        sort_by: 'relevance',
    };

    // Extract searchParams from previous messages
    for (const msg of conversationHistory) {
        if (msg.searchParams && typeof msg.searchParams === 'object') {
            Object.assign(merged, msg.searchParams);
        }
    }

    return merged;
}

async function callDeepSeek(userMessage, conversationHistory, currentSearchParams = {}) {
    // [PAGINATION_DEBUG] Entry
    console.log('[PAGINATION_DEBUG] -------- callDeepSeek ENTRY --------');
    console.log('[PAGINATION_DEBUG] currentSearchParams.page_number:', currentSearchParams.page_number);
    console.log('[PAGINATION_DEBUG] userMessage:', (userMessage || '').substring(0, 60));

    // AI will determine pagination based on context and user message
    // We only check if there's an active search to provide context to AI
    const hasActiveSearch = currentSearchParams && currentSearchParams.to_country && currentSearchParams.start_date;
    console.log('[PAGINATION_DEBUG] hasActiveSearch:', hasActiveSearch, 'to_country:', currentSearchParams.to_country, 'start_date:', currentSearchParams.start_date);
    
    // Build messages array with proper role structure
    const messages = [
        { role: 'system', content: DEEPSEEK_SYSTEM_PROMPT_MESSAGE },
    ];

    // Add conversation history with proper role structure
    for (const msg of conversationHistory) {
        if (msg.role === 'user' || msg.role === 'assistant') {
            messages.push({
                role: msg.role,
                content: msg.content || msg.text || '',
            });
        }
    }

    // Include current search params context so the AI knows the current page_number
    // This is critical for pagination: AI needs to know current state to make correct decisions
    if (currentSearchParams && currentSearchParams.page_number && currentSearchParams.to_country) {
        const currentPageNumber = currentSearchParams.page_number || 1;
        const nextPageNumber = currentPageNumber + 1;
        
        messages.push({
            role: 'system',
            content: `🔍 КОНТЕКСТ АКТИВНОГО ПОИСКА:
Текущие параметры поиска: ${JSON.stringify(currentSearchParams)}
Текущий page_number = ${currentPageNumber}
Следующий page_number должен быть = ${nextPageNumber}

ТВОЯ ЗАДАЧА - ОПРЕДЕЛИТЬ ПАГИНАЦИЮ:
1. Если пользователь просит "ещё", "другие", "покажи ещё", "следующие", "дальше", "ищи", "ещо", "еще" и т.п.
   И при этом НЕ меняет основные параметры (страну, дату, ночи, людей, бюджет) → это ПАГИНАЦИЯ
   
2. При пагинации:
   - Верни ПОЛНЫЙ объект searchParams со ВСЕМИ теми же параметрами из текущего поиска
   - Установи page_number = ${nextPageNumber} (ОБЯЗАТЕЛЬНО ${nextPageNumber}, не ${currentPageNumber}!)
   - Включи ВСЕ параметры: to_country, start_date, nights, adults, kids, kids_ages, filter_price_max, filter_price_min, from_city, from_country, to_city, все фильтры
   - nextQuestion: "Ищу ещё варианты для тебя! 🔎"
   - НЕ меняй никакие другие параметры при пагинации, только page_number!

3. Если пользователь ИЗМЕНЯЕТ параметры (страну, дату, ночи, людей, бюджет) → это НОВЫЙ поиск с page_number = 1

КРИТИЧЕСКИ ВАЖНО: 
- Если это пагинация - верни page_number = ${nextPageNumber} (текущий ${currentPageNumber} + 1)
- Если новый поиск - верни page_number = 1
- При пагинации ВСЕГДА возвращай ПОЛНЫЙ объект searchParams со ВСЕМИ параметрами из текущего поиска`,
        });
    }

    // Add current user message
    messages.push({ role: 'user', content: userMessage });

    try {
        const response = await axios.post(
            DEEPSEEK_API_URL,
            {
                model: DEEPSEEK_MODEL,
                messages,
                temperature: LLM_TEMPERATURE.chat,
                max_tokens: 600,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
                },
                timeout: 30000,
            }
        );

        // DeepSeek can return plain text or JSON
        const aiText = response.data?.choices?.[0]?.message?.content;
        if (!aiText) {
            return { 
                chatMode: true,
                nextQuestion: 'Извините, не удалось получить ответ. Попробуйте еще раз.', 
                searchParams: {} 
            };
        }

        // Try parsing JSON if AI returned object
        let parsed = {};
        try {
            // Clean the response - remove markdown code blocks if present
            let cleanText = aiText.trim();
            if (cleanText.startsWith('```json')) {
                cleanText = cleanText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            } else if (cleanText.startsWith('```')) {
                cleanText = cleanText.replace(/```\n?/g, '').trim();
            }
            // Try to extract JSON from mixed content (text + JSON)
            if (!cleanText.startsWith('{')) {
                const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    cleanText = jsonMatch[0];
                }
            }
            parsed = JSON.parse(cleanText);
        } catch (e) {
            // If it's not JSON, treat as chat response
            // But first clean any JSON-like content from the text
            console.log('[DeepSeek] Response is not JSON, treating as chat:', aiText.substring(0, 100));
            let cleanResponse = aiText.trim();
            // Remove any JSON blocks that might be in the response
            cleanResponse = cleanResponse.replace(/```json[\s\S]*?```/g, '').trim();
            cleanResponse = cleanResponse.replace(/\{[\s\S]*"chatMode"[\s\S]*\}/g, '').trim();
            cleanResponse = cleanResponse.replace(/\{[\s\S]*"searchParams"[\s\S]*\}/g, '').trim();
            if (!cleanResponse) {
                cleanResponse = 'Чем могу помочь?';
            }
            return { 
                chatMode: true,
                nextQuestion: cleanResponse, 
                searchParams: currentSearchParams 
            };
        }

        // Extract chatMode (default to false if not specified, but check if it's a chat response)
        const chatMode = parsed.chatMode !== undefined ? parsed.chatMode : false;

        // Validate nextQuestion is not raw JSON
        let nextQuestion = parsed.nextQuestion || '';
        if (typeof nextQuestion === 'object') {
            nextQuestion = '';
        }
        // If nextQuestion looks like JSON, clean it
        if (nextQuestion && (nextQuestion.includes('"chatMode"') || nextQuestion.includes('"searchParams"'))) {
            nextQuestion = nextQuestion.replace(/\{[\s\S]*"chatMode"[\s\S]*\}/g, '').trim();
            nextQuestion = nextQuestion.replace(/\{[\s\S]*"searchParams"[\s\S]*\}/g, '').trim();
            if (!nextQuestion) {
                nextQuestion = chatMode ? 'Чем ещё могу помочь?' : '';
            }
        }

        // --- BACKEND-SIDE PAGINATION SAFETY ---
        // User wants "more" results → if есть активный поиск, но AI не увеличил page_number,
        // форсим корректный page_number здесь, чтобы логика пагинации работала на 100%.
        if (!chatMode && hasActiveSearch) {
            const normalizedUserText = (userMessage || '').toLowerCase();
            const userWantsMore =
                normalizedUserText.includes('ещё') ||
                normalizedUserText.includes('еще') ||
                normalizedUserText.includes('ещо') ||
                normalizedUserText.includes('другие') ||
                normalizedUserText.includes('следующие') ||
                normalizedUserText.includes('дальше') ||
                normalizedUserText.includes('покажи ещё') ||
                normalizedUserText.includes('покажи еще') ||
                normalizedUserText.includes('найди ещё') ||
                normalizedUserText.includes('найди еще') ||
                normalizedUserText.includes('ищи') ||
                normalizedUserText.includes('поищи') ||
                normalizedUserText.includes('найти друга варианты') ||
                normalizedUserText.includes('найти другие варианты');

            if (userWantsMore) {
                const currentPageNumber = currentSearchParams.page_number || 1;
                console.log('[PAGINATION_DEBUG] userWantsMore=true, currentPageNumber:', currentPageNumber);
                if (!parsed.searchParams || typeof parsed.searchParams !== 'object') {
                    parsed.searchParams = {};
                }
                
                // КРИТИЧЕСКИ ВАЖНО: При пагинации копируем ВСЕ параметры из currentSearchParams в parsed.searchParams
                // Это гарантирует, что AI получит полный контекст и вернет правильный JSON
                Object.keys(currentSearchParams).forEach(key => {
                    if (key !== 'page_number' && parsed.searchParams[key] === undefined) {
                        parsed.searchParams[key] = currentSearchParams[key];
                    }
                });
                
                // Если AI не задал page_number или вернул <= текущей страницы – поднимаем страницу на +1
                const aiPageNumber = parsed.searchParams.page_number || 1;
                // CRITICAL: Always increment page_number for pagination requests
                // Use the maximum of (currentPageNumber + 1) and aiPageNumber to ensure we always advance
                const forcedPageNumber = Math.max(currentPageNumber + 1, aiPageNumber);
                parsed.searchParams.page_number = forcedPageNumber;
                
                console.log('[PAGINATION_DEBUG] BACKEND FORCED PAGINATION: currentPageNumber:', currentPageNumber, '→ forcedPageNumber:', forcedPageNumber, 'AI had returned:', aiPageNumber);
                
                if (aiPageNumber <= currentPageNumber) {
                    console.log('[Backend] ✅ FORCED pagination - user wants more, currentPage:', currentPageNumber, '→ forced page_number:', forcedPageNumber, 'AI returned:', aiPageNumber);
                } else if (aiPageNumber === forcedPageNumber) {
                    console.log('[Backend] ✅ Pagination confirmed - currentPage:', currentPageNumber, '→ page_number:', forcedPageNumber, 'AI returned:', aiPageNumber);
                } else {
                    console.log('[Backend] ✅ Pagination adjusted - currentPage:', currentPageNumber, '→ page_number:', forcedPageNumber, 'AI returned:', aiPageNumber);
                }
                console.log('[Backend] Copied all params from currentSearchParams to parsed.searchParams for pagination');
            } else {
                console.log('[PAGINATION_DEBUG] userWantsMore=false (no pagination keywords in message)');
            }
        } else {
            console.log('[PAGINATION_DEBUG] Skipped pagination safety: chatMode=', chatMode, 'hasActiveSearch=', hasActiveSearch);
        }

        // Merge with current searchParams (only if not in chat mode)
        // For pagination: preserve ALL existing params and only update page_number
        // For new search: merge AI's params with current params
        const mergedParams = chatMode ? {} : { ...currentSearchParams };
        
        if (!chatMode && parsed.searchParams && typeof parsed.searchParams === 'object') {
            // AI-BASED PAGINATION: Trust AI's decision completely
            // If AI returns page_number > 1 AND core params match → it's pagination
            const aiPageNumber = parsed.searchParams.page_number || 1;
            const currentPageNumber = currentSearchParams.page_number || 1;
            
            // Check if core params match (for pagination detection)
            // If parsed.searchParams doesn't have these fields, they should match (we copied them above)
            const paramsMatch = currentSearchParams.to_country && 
                               (parsed.searchParams.to_country === currentSearchParams.to_country || !parsed.searchParams.to_country || parsed.searchParams.to_country === '') &&
                               (parsed.searchParams.start_date === currentSearchParams.start_date || !parsed.searchParams.start_date || parsed.searchParams.start_date === '');
            
            // CRITICAL: Check if user wants pagination (keywords were detected above)
            // This is the PRIMARY way to detect pagination - more reliable than AI's page_number
            const userWantsMore = (userMessage || '').toLowerCase().includes('другие') ||
                                 (userMessage || '').toLowerCase().includes('ещё') ||
                                 (userMessage || '').toLowerCase().includes('еще') ||
                                 (userMessage || '').toLowerCase().includes('ещо') ||
                                 (userMessage || '').toLowerCase().includes('ищи') ||
                                 (userMessage || '').toLowerCase().includes('поищи') ||
                                 (userMessage || '').toLowerCase().includes('найди') ||
                                 (userMessage || '').toLowerCase().includes('предлагай') ||
                                 (userMessage || '').toLowerCase().includes('следующие') ||
                                 (userMessage || '').toLowerCase().includes('дальше');
            
            // Pagination if:
            // 1. We have active search AND
            // 2. Core params match (or user wants more) AND
            // 3. (AI says page_number > 1 OR backend forced increment OR user wants more)
            const isPagination = hasActiveSearch && 
                                paramsMatch && 
                                (aiPageNumber > 1 || aiPageNumber > currentPageNumber || userWantsMore);
            
            console.log('[Backend] Pagination check:', {
                hasActiveSearch,
                aiPageNumber,
                currentPageNumber,
                paramsMatch,
                isPagination,
                userWantsMore,
                to_country_current: currentSearchParams.to_country,
                to_country_parsed: parsed.searchParams.to_country,
                start_date_current: currentSearchParams.start_date,
                start_date_parsed: parsed.searchParams.start_date,
                to_country_match: parsed.searchParams.to_country === currentSearchParams.to_country || !parsed.searchParams.to_country || parsed.searchParams.to_country === '',
                start_date_match: parsed.searchParams.start_date === currentSearchParams.start_date || !parsed.searchParams.start_date || parsed.searchParams.start_date === '',
            });
            console.log('[PAGINATION_DEBUG] isPagination=', isPagination, '→ mergedParams.page_number will be:', isPagination ? parsed.searchParams.page_number : '(from merge)');
            
            if (isPagination) {
                // For pagination: preserve ALL current params, use AI's page_number
                console.log('[Backend] ✅ PAGINATION CONFIRMED - page_number:', aiPageNumber, 'preserving all params');
                
                // CRITICAL: Start with ALL currentSearchParams, then override only page_number and page_limit
                // IMPORTANT: mergedParams already has currentSearchParams from line 2237, but we need to ensure ALL fields are preserved
                Object.assign(mergedParams, currentSearchParams);
                // CRITICAL: Use the forced page_number from parsed.searchParams (which was already incremented above)
                mergedParams.page_number = parsed.searchParams.page_number; // This is the forced/incremented value
                mergedParams.page_limit = 3; // ALWAYS force page_limit to 3 for pagination
                
                console.log('[Backend] Merged params for pagination:', {
                    page_number: mergedParams.page_number,
                    to_country: mergedParams.to_country,
                    start_date: mergedParams.start_date,
                    nights: mergedParams.nights,
                    adults: mergedParams.adults,
                    filter_price_max: mergedParams.filter_price_max,
                });
                
                // Merge any new filter params that AI might have returned (but don't override existing ones)
                const filterFields = ['filter_price_min', 'filter_price_max', 'filter_stars', 'filter_meals', 
                    'filter_instant_confirm', 'filter_regions', 'filter_line', 'filter_operators', 'filter_hotel_type', 'filter_beach_surface'];
                for (const field of filterFields) {
                    if (parsed.searchParams[field] !== undefined && parsed.searchParams[field] !== null && parsed.searchParams[field] !== '') {
                        mergedParams[field] = parsed.searchParams[field];
                    }
                }
            } else {
                // For new search or field updates: merge AI's params
                Object.assign(mergedParams, parsed.searchParams);
            }
        } else if (!chatMode && (nextQuestion === null || nextQuestion === '' || !nextQuestion)) {
            // If no nextQuestion and not chat mode, merge root-level search fields only
            const searchFields = ['from_city', 'from_country', 'to_country', 'to_city', 'adults', 'kids', 'kids_ages', 'start_date', 'nights', 'search_type', 'flex_dates', 'hotel_ids', 'page_number', 'page_limit', 'sort_by'];
            for (const field of searchFields) {
                if (parsed[field] !== undefined) {
                    mergedParams[field] = parsed[field];
                }
            }
        }

        // Ensure required fields have defaults (only if not in chat mode)
        // For pagination: preserve existing values, don't override
        if (!chatMode) {
            const isPagination = mergedParams.page_number > 1 && currentSearchParams.to_country;
            
            if (!mergedParams.from_country) mergedParams.from_country = currentSearchParams.from_country || 'RU';
            if (!mergedParams.adults) mergedParams.adults = isPagination ? (currentSearchParams.adults || '1') : '1';
            if (!mergedParams.kids) mergedParams.kids = isPagination ? (currentSearchParams.kids || '0') : '0';
            if (!mergedParams.kids_ages) mergedParams.kids_ages = isPagination ? (currentSearchParams.kids_ages || []) : [];
            if (!mergedParams.search_type) mergedParams.search_type = 'package';
            if (!mergedParams.flex_dates) mergedParams.flex_dates = isPagination ? (currentSearchParams.flex_dates || 2) : 2;
            if (!mergedParams.hotel_ids) mergedParams.hotel_ids = [];
            if (!mergedParams.page_number) mergedParams.page_number = 1;
            // ALWAYS force page_limit to 3 - CRITICAL for consistent pagination
            mergedParams.page_limit = 3;
            if (!mergedParams.sort_by) mergedParams.sort_by = 'relevance';
            
            // For pagination: preserve all filter params from current search
            if (isPagination) {
                console.log('[Backend] Preserving all params for pagination...');
                const filterFields = ['filter_price_min', 'filter_price_max', 'filter_stars', 'filter_meals', 
                    'filter_instant_confirm', 'filter_regions', 'filter_line', 'filter_operators', 'filter_hotel_type', 'filter_beach_surface'];
                for (const field of filterFields) {
                    if (currentSearchParams[field] !== undefined && mergedParams[field] === undefined) {
                        mergedParams[field] = currentSearchParams[field];
                    }
                }
                // Preserve core search params - CRITICAL for pagination
                if (!mergedParams.to_country && currentSearchParams.to_country) {
                    mergedParams.to_country = currentSearchParams.to_country;
                    console.log('[Backend] Preserved to_country:', currentSearchParams.to_country);
                }
                if (!mergedParams.start_date && currentSearchParams.start_date) {
                    mergedParams.start_date = currentSearchParams.start_date;
                    console.log('[Backend] Preserved start_date:', currentSearchParams.start_date);
                }
                if (!mergedParams.nights && currentSearchParams.nights) {
                    mergedParams.nights = currentSearchParams.nights;
                    console.log('[Backend] Preserved nights:', currentSearchParams.nights);
                }
                if (!mergedParams.adults && currentSearchParams.adults) {
                    mergedParams.adults = currentSearchParams.adults;
                    console.log('[Backend] Preserved adults:', currentSearchParams.adults);
                }
                if (!mergedParams.kids && currentSearchParams.kids !== undefined) {
                    mergedParams.kids = currentSearchParams.kids;
                    console.log('[Backend] Preserved kids:', currentSearchParams.kids);
                }
                if (!mergedParams.kids_ages && currentSearchParams.kids_ages) {
                    mergedParams.kids_ages = currentSearchParams.kids_ages;
                    console.log('[Backend] Preserved kids_ages:', currentSearchParams.kids_ages);
                }
                if (!mergedParams.filter_price_max && currentSearchParams.filter_price_max) {
                    mergedParams.filter_price_max = currentSearchParams.filter_price_max;
                    console.log('[Backend] Preserved filter_price_max:', currentSearchParams.filter_price_max);
                }
                if (!mergedParams.from_city && currentSearchParams.from_city) {
                    mergedParams.from_city = currentSearchParams.from_city;
                    console.log('[Backend] Preserved from_city:', currentSearchParams.from_city);
                }
                if (!mergedParams.from_country && currentSearchParams.from_country) {
                    mergedParams.from_country = currentSearchParams.from_country;
                    console.log('[Backend] Preserved from_country:', currentSearchParams.from_country);
                }
            }
        }

        // Final logging before return
        const finalPageNumber = mergedParams.page_number || 1;
        console.log('[Backend] ✅ Final response:', {
            chatMode,
            nextQuestion: nextQuestion ? nextQuestion.substring(0, 50) : '',
            page_number: finalPageNumber,
            to_country: mergedParams.to_country,
            start_date: mergedParams.start_date,
            nights: mergedParams.nights,
            adults: mergedParams.adults,
            filter_price_max: mergedParams.filter_price_max,
            hasActiveSearch,
            paramsCount: Object.keys(mergedParams).length,
        });

        return { 
            chatMode: chatMode,
            nextQuestion: nextQuestion, 
            searchParams: chatMode ? {} : mergedParams 
        };

    } catch (error) {
        console.error('Error calling DeepSeek:', error);
        return { 
            chatMode: true,
            nextQuestion: 'Извините, произошла ошибка при обработке запроса. Попробуйте еще раз.', 
            searchParams: {} 
        };
    }
}


// Streaming endpoint for step-by-step conversation
app.post('/api/tour-assistant/stream', async (req, res) => {
    try {
        const { text, conversationHistory = [], currentSearchParams = {} } = req.body;

        // Log full request payload
        console.log('\n========== 📥 TOUR-ASSISTANT REQUEST ==========');
        console.log('📝 User message:', text);
        console.log('📊 Current search params:', JSON.stringify(currentSearchParams, null, 2));
        console.log('💬 Conversation history length:', conversationHistory.length);
        if (conversationHistory.length > 0) {
            console.log('💬 Last 3 messages:');
            conversationHistory.slice(-3).forEach((msg, i) => {
                const content = msg.content?.substring(0, 100) + (msg.content?.length > 100 ? '...' : '');
                console.log(`   [${msg.role}]: ${content}`);
            });
        }
        console.log('================================================\n');

        if (!text) {
            return res.status(400).json({ error: 'text required' });
        }

        // [PAGINATION_DEBUG] Incoming request
        console.log('[PAGINATION_DEBUG] ========== STREAM REQUEST ==========');
        console.log('[PAGINATION_DEBUG] user text:', text.substring(0, 80));
        console.log('[PAGINATION_DEBUG] currentSearchParams.page_number:', currentSearchParams.page_number);
        console.log('[PAGINATION_DEBUG] currentSearchParams keys:', Object.keys(currentSearchParams).join(', '));
        console.log('[PAGINATION_DEBUG] currentSearchParams (full):', JSON.stringify({
            page_number: currentSearchParams.page_number,
            to_country: currentSearchParams.to_country,
            start_date: currentSearchParams.start_date,
            adults: currentSearchParams.adults,
            nights: currentSearchParams.nights,
            filter_stars: currentSearchParams.filter_stars,
            filter_meals: currentSearchParams.filter_meals,
            filter_line: currentSearchParams.filter_line,
            filter_beach_surface: currentSearchParams.filter_beach_surface,
            filter_price_max: currentSearchParams.filter_price_max,
        }));

        // Merge searchParams from conversation history
        const mergedParams = mergeSearchParamsFromHistory(conversationHistory);
        Object.assign(mergedParams, currentSearchParams);

        console.log('[PAGINATION_DEBUG] mergedParams BEFORE callDeepSeek.page_number:', mergedParams.page_number);

        // Call DeepSeek API safely
        const aiResponse = await callDeepSeek(text, conversationHistory, mergedParams);

        if (!aiResponse) {
            return res.status(500).json({ error: 'AI response is empty' });
        }

        console.log('[PAGINATION_DEBUG] ========== STREAM RESPONSE ==========');
        console.log('[PAGINATION_DEBUG] chatMode:', aiResponse.chatMode);
        console.log('[PAGINATION_DEBUG] searchParams.page_number returned:', aiResponse.searchParams && aiResponse.searchParams.page_number);
        console.log('[PAGINATION_DEBUG] searchParams keys returned:', aiResponse.searchParams ? Object.keys(aiResponse.searchParams).join(', ') : 'none');

        // AUTO-SEARCH FIX: If AI says "Ищу" but didn't return searchParams, use mergedParams
        const searchKeywords = ['ищу', 'подбираю', 'поиск', 'ищем', 'ищю', 'найд'];
        const nextQuestionLower = (aiResponse.nextQuestion || '').toLowerCase();
        const aiSaysSearching = searchKeywords.some(kw => nextQuestionLower.includes(kw));
        
        // Check if user message contains filter keywords (stars, meals, beach, line)
        const textLower = text.toLowerCase();
        
        // CHECK IF USER IS SATISFIED/DONE - should NOT trigger search
        const userIsSatisfied = textLower.match(/спасибо|благодар|отлично|супер|класс|нашёл|нашел|нашла|выбрал|выбрала|понрав|нравится|хорош|подход|устраива|беру|бронир|заказ|оформ|thank|thanks|perfect|great|found|like|good/);
        const userSaysGoodbye = textLower.match(/пока|до свидан|прощай|bye|goodbye|see you/);
        const userAskingQuestion = textLower.match(/^(что|как|какой|какая|какие|где|когда|почему|зачем|сколько|можно|есть|а |расскажи|покажи|опиши)\s/);
        
        // If user is satisfied or saying goodbye, skip auto-search entirely
        if (userIsSatisfied || userSaysGoodbye) {
            console.log('✅ USER IS SATISFIED/DONE - skipping auto-search');
            console.log('   userIsSatisfied:', !!userIsSatisfied);
            console.log('   userSaysGoodbye:', !!userSaysGoodbye);
        }
        const userAddingFilter = textLower.match(/звезд|зв[её]зд|звод|ультра|у[ль]тра|включ|вклуч|песок|песч|песоч|галька|галеч|галка|платформ|понтон|перв.*лин|втор.*лин|трет.*лин|первая|вторая|третья|линия|у\s*моря|beachfront|завтр|зафтр|полупансион|пансион/);
        
        // Check if user is changing required parameters (date, nights, adults, budget)
        const userChangingParams = textLower.match(/(\d+)\s*(ноч|ночей|дней|день|марта|февраля|января|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|взросл|человек|чел|руб|рубл|\d{5,})/);
        
        // Extract parameter changes from user message
        let paramChanges = {};
        if (userChangingParams) {
            // Nights detection
            const nightsMatch = textLower.match(/(\d+)\s*(ноч|ночей|дней)/);
            if (nightsMatch) {
                paramChanges.nights = nightsMatch[1];
                console.log('🔄 PARAM CHANGE: nights =', paramChanges.nights);
            }
            
            // Adults detection
            const adultsMatch = textLower.match(/(\d+)\s*(взросл|человек|чел)/);
            if (adultsMatch) {
                paramChanges.adults = adultsMatch[1];
                console.log('🔄 PARAM CHANGE: adults =', paramChanges.adults);
            }
            
            // Budget detection
            const budgetMatch = textLower.match(/(\d{5,})\s*(руб|рубл)?/);
            if (budgetMatch) {
                paramChanges.filter_price_max = budgetMatch[1];
                console.log('🔄 PARAM CHANGE: filter_price_max =', paramChanges.filter_price_max);
            }
            
            // Date detection (simple pattern for now)
            const dateMatch = textLower.match(/(\d{1,2})\s*(марта|февраля|января|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/);
            if (dateMatch) {
                const day = dateMatch[1].padStart(2, '0');
                const monthMap = {
                    'января': '01', 'февраля': '02', 'марта': '03', 'апреля': '04',
                    'мая': '05', 'июня': '06', 'июля': '07', 'августа': '08',
                    'сентября': '09', 'октября': '10', 'ноября': '11', 'декабря': '12'
                };
                const month = monthMap[dateMatch[2]];
                const year = new Date().getFullYear();
                const currentMonth = new Date().getMonth() + 1;
                const targetMonth = parseInt(month);
                const targetYear = targetMonth < currentMonth ? year + 1 : year;
                paramChanges.start_date = `${targetYear}-${month}-${day}`;
                console.log('🔄 PARAM CHANGE: start_date =', paramChanges.start_date);
            }
        }
        
        // Use both mergedParams and currentSearchParams to check for required fields
        const combinedParams = { ...mergedParams, ...currentSearchParams };
        
        // Check if we have core required fields (price is optional, can default to high value)
        const hasCoreFields = combinedParams.to_country && 
                              combinedParams.start_date && 
                              combinedParams.nights && 
                              combinedParams.adults;
        
        // Also check if previous search was done (hotels in conversation means we had a successful search)
        const hadPreviousSearch = conversationHistory.some(msg => 
            msg.hotels && Array.isArray(msg.hotels) && msg.hotels.length > 0
        );
        
        // Check if we had a previous successful search based on currentSearchParams having complete data
        const hadSearchFromParams = currentSearchParams.to_country && 
                                    currentSearchParams.start_date && 
                                    currentSearchParams.nights;
        
        // Check if AI returned incomplete/empty searchParams
        const aiSearchParams = aiResponse.searchParams || {};
        const aiParamsKeys = Object.keys(aiSearchParams).filter(k => aiSearchParams[k] !== '' && aiSearchParams[k] !== undefined && aiSearchParams[k] !== null);
        const aiHasIncompleteParams = aiParamsKeys.length < 5 || !aiSearchParams.to_country || !aiSearchParams.start_date;
        
        console.log('🔍 AUTO-SEARCH CHECK:', {
            aiSaysSearching,
            userAddingFilter: !!userAddingFilter,
            userChangingParams: !!userChangingParams,
            paramChanges: Object.keys(paramChanges).length > 0 ? paramChanges : 'none',
            hasCoreFields,
            hadPreviousSearch,
            hadSearchFromParams,
            aiHasIncompleteParams,
            aiParamsKeysCount: aiParamsKeys.length,
            combinedParamsKeys: Object.keys(combinedParams).filter(k => combinedParams[k]).length,
            to_country: combinedParams.to_country,
            start_date: combinedParams.start_date,
            nights: combinedParams.nights,
            adults: combinedParams.adults,
            filter_price_max: combinedParams.filter_price_max,
            aiChatMode: aiResponse.chatMode,
            aiNextQuestion: (aiResponse.nextQuestion || '').substring(0, 80),
            aiSearchParamsKeys: Object.keys(aiSearchParams).join(','),
        });
        
        let finalSearchParams = aiResponse.searchParams;
        let finalChatMode = aiResponse.chatMode;
        
        // If AI says "Ищу..." but didn't return proper searchParams, use combinedParams
        // Trigger if: 
        //   (AI says searching OR user adding filter OR user changing params) 
        //   AND (we have core fields OR had previous search OR had search from params) 
        //   AND AI returned incomplete params
        //   AND user is NOT satisfied/done with the search
        const canAutoSearch = hasCoreFields || hadPreviousSearch || hadSearchFromParams;
        const userMakingChanges = userAddingFilter || userChangingParams;
        const userNotDone = !userIsSatisfied && !userSaysGoodbye;
        const shouldAutoSearch = (aiSaysSearching || userMakingChanges) && canAutoSearch && aiHasIncompleteParams && userNotDone;
        
        // NEW FIX: If AI says "Ищу..." but returned chatMode: true, override to false
        // This handles the case where AI returns complete searchParams but still says chatMode: true
        // But NOT if user is satisfied/done
        const shouldForceChatModeFalse = (aiSaysSearching || userMakingChanges) && canAutoSearch && aiResponse.chatMode === true && userNotDone;
        
        console.log('🔍 shouldAutoSearch:', shouldAutoSearch, '(aiSaysSearching:', aiSaysSearching, ', userMakingChanges:', !!userMakingChanges, ', canAutoSearch:', canAutoSearch, ', aiHasIncompleteParams:', aiHasIncompleteParams, ', userNotDone:', userNotDone, ')');
        console.log('🔍 shouldForceChatModeFalse:', shouldForceChatModeFalse);
        
        if (shouldAutoSearch) {
            console.log('🔧 AUTO-SEARCH FIX: AI said "Ищу" but returned incomplete params. Using combinedParams.');
            console.log('🔧 Trigger reason: aiSaysSearching=' + aiSaysSearching + ', hasCoreFields=' + hasCoreFields + ', hadPreviousSearch=' + hadPreviousSearch);
            
            // Start with combinedParams (has all required fields from history)
            finalSearchParams = { ...combinedParams };
            
            // Copy any filters from AI response (in case AI extracted them from user message)
            const filterKeys = ['filter_stars', 'filter_meals', 'filter_line', 'filter_beach_surface', 
                               'filter_price_min', 'filter_price_max', 'filter_instant_confirm'];
            filterKeys.forEach(key => {
                if (aiSearchParams[key] !== undefined && aiSearchParams[key] !== '') {
                    finalSearchParams[key] = aiSearchParams[key];
                }
            });
            
            // Apply user's parameter changes (nights, adults, budget, date)
            if (Object.keys(paramChanges).length > 0) {
                Object.assign(finalSearchParams, paramChanges);
                console.log('🔧 AUTO-SEARCH FIX: Applied param changes:', paramChanges);
            }
            
            // Extract filters from user message (backup if AI didn't extract them)
            const userTextLower = text.toLowerCase();
            
            // Stars detection - more patterns, handle typos like "зводни" instead of "звезды"
            if (!finalSearchParams.filter_stars) {
                if (userTextLower.match(/толко\s*5|только\s*5|5\s*зв|5\s*звод|пять\s*зв/)) {
                    finalSearchParams.filter_stars = '5';
                } else if (userTextLower.match(/толко\s*4|только\s*4|4\s*зв|4\s*звод|четыре\s*зв/)) {
                    finalSearchParams.filter_stars = '4';
                } else if (userTextLower.match(/4-5|4\s*и\s*5/)) {
                    finalSearchParams.filter_stars = '4,5';
                } else if (userTextLower.match(/толко\s*3|только\s*3|3\s*зв|3\s*звод|три\s*зв/)) {
                    finalSearchParams.filter_stars = '3';
                }
            }
            
            // Also extract stars from AI's nextQuestion
            if (!finalSearchParams.filter_stars) {
                const nextQLower = (aiResponse.nextQuestion || '').toLowerCase();
                if (nextQLower.match(/5.*звёзд|5.*звезд|5-звёзд/)) {
                    finalSearchParams.filter_stars = '5';
                } else if (nextQLower.match(/4.*звёзд|4.*звезд|4-звёзд/)) {
                    finalSearchParams.filter_stars = '4';
                } else if (nextQLower.match(/3.*звёзд|3.*звезд|3-звёзд/)) {
                    finalSearchParams.filter_stars = '3';
                }
            }
            
            // Meals detection - ALWAYS check user message for meal changes (not just when empty)
            // Priority: check if user wants to CHANGE meals first
            const userWantsBreakfast = userTextLower.match(/толко\s*завтр|только\s*завтр|завтрак|завтрик|зафтр/);
            const userWantsHalfBoard = userTextLower.match(/полупансион|завтрак.*ужин|ужин.*завтрак/);
            const userWantsFullBoard = userTextLower.match(/полный\s*пансион|трёхразов|трехразов/);
            const userWantsAI = userTextLower.match(/(все|всё).*(включ|вклуч)/) && !userTextLower.match(/у[ль]?тра/);
            const userWantsUAI = userTextLower.match(/у[ль]?тра.*(включ|вклуч)/);
            const userDoesntWantUAI = userTextLower.match(/не\s*хочу.*(у[ль]?тра|все.*включ|всё.*включ)/);
            
            // Apply meal changes based on user request
            if (userWantsBreakfast || userDoesntWantUAI) {
                finalSearchParams.filter_meals = 'BB';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_meals = BB (breakfast only)');
            } else if (userWantsHalfBoard) {
                finalSearchParams.filter_meals = 'HB';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_meals = HB (half board)');
            } else if (userWantsFullBoard) {
                finalSearchParams.filter_meals = 'FB';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_meals = FB (full board)');
            } else if (userWantsUAI) {
                finalSearchParams.filter_meals = 'UAI';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_meals = UAI (ultra all inclusive)');
            } else if (userWantsAI) {
                finalSearchParams.filter_meals = 'AI';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_meals = AI (all inclusive)');
            }
            
            // Also check AI's nextQuestion for meal type (only if user didn't specify)
            if (!userWantsBreakfast && !userWantsHalfBoard && !userWantsFullBoard && !userWantsAI && !userWantsUAI && !userDoesntWantUAI) {
                const nextQLower = (aiResponse.nextQuestion || '').toLowerCase();
                if (nextQLower.match(/завтрак|breakfast/i) && !nextQLower.match(/включ/)) {
                    finalSearchParams.filter_meals = 'BB';
                } else if (nextQLower.match(/ультра.*(включ|вклуч)|ultra.*all.*incl/i)) {
                    finalSearchParams.filter_meals = 'UAI';
                } else if (nextQLower.match(/(все|всё).*(включ|вклуч)|all.*incl/i)) {
                    finalSearchParams.filter_meals = 'AI';
                }
            }
            
            // Line detection - ALWAYS check for line changes (not just when empty)
            const userWantsFirstLine = userTextLower.match(/перв.*лин|1.*лин|первая\s*лин|первой\s*лин|на\s*первой|у\s*моря|beachfront/);
            const userWantsSecondLine = userTextLower.match(/втор.*лин|2.*лин|вторая\s*лин|второй\s*лин|на\s*второй/);
            const userWantsThirdLine = userTextLower.match(/трет.*лин|3.*лин|третья\s*лин|третьей\s*лин|на\s*третьей/);
            
            if (userWantsFirstLine) {
                finalSearchParams.filter_line = '1';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_line = 1 (first line)');
            } else if (userWantsSecondLine) {
                finalSearchParams.filter_line = '2';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_line = 2 (second line)');
            } else if (userWantsThirdLine) {
                finalSearchParams.filter_line = '3';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_line = 3 (third line)');
            }
            
            // Beach surface detection - ALWAYS check for beach changes (not just when empty)
            const userWantsSand = userTextLower.match(/песок|песч|писок|пляж.*песок|песоч/);
            const userWantsPebble = userTextLower.match(/галька|галеч|галка/);
            const userWantsMixed = userTextLower.match(/смешан|песок.*галь|галь.*песок/);
            const userWantsPlatform = userTextLower.match(/платформ|понтон/);
            
            if (userWantsSand && !userWantsPebble) {
                finalSearchParams.filter_beach_surface = 'SAND';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_beach_surface = SAND');
            } else if (userWantsPebble && !userWantsSand) {
                finalSearchParams.filter_beach_surface = 'PEBBLE';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_beach_surface = PEBBLE');
            } else if (userWantsMixed || (userWantsSand && userWantsPebble)) {
                finalSearchParams.filter_beach_surface = 'SAND+PEBBLE';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_beach_surface = SAND+PEBBLE');
            } else if (userWantsPlatform) {
                finalSearchParams.filter_beach_surface = 'PLATFORM';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_beach_surface = PLATFORM');
            }
            
            // Ensure filter_price_max has a value (required for search)
            if (!finalSearchParams.filter_price_max) {
                // Try to extract from conversation history
                const pricePattern = /(\d{5,})/;
                for (const msg of conversationHistory) {
                    if (msg.role === 'user' && msg.content) {
                        const match = msg.content.match(pricePattern);
                        if (match) {
                            finalSearchParams.filter_price_max = match[1];
                            console.log('🔧 AUTO-SEARCH FIX: Extracted filter_price_max from history:', match[1]);
                            break;
                        }
                    }
                }
                // If still no price, use a high default
                if (!finalSearchParams.filter_price_max) {
                    finalSearchParams.filter_price_max = '500000';
                    console.log('🔧 AUTO-SEARCH FIX: Using default filter_price_max: 500000');
                }
            }
            
            // Ensure kids fields are set (required by frontend)
            if (finalSearchParams.kids === undefined || finalSearchParams.kids === null || finalSearchParams.kids === '') {
                finalSearchParams.kids = '0';
            }
            if (!finalSearchParams.kids_ages || !Array.isArray(finalSearchParams.kids_ages)) {
                finalSearchParams.kids_ages = [];
            }
            
            // Ensure from_city/from_country is set (required by frontend)
            if (!finalSearchParams.from_city && !finalSearchParams.from_country) {
                finalSearchParams.from_country = 'RU';
                finalSearchParams.from_city = 'Moscow';
            } else if (!finalSearchParams.from_city && finalSearchParams.from_country === 'RU') {
                finalSearchParams.from_city = 'Moscow';
            }
            
            // Ensure adults is set
            if (!finalSearchParams.adults) {
                finalSearchParams.adults = '2';
            }
            
            // DEFAULT: Set filter_stars to 5 if not specified
            if (!finalSearchParams.filter_stars) {
                finalSearchParams.filter_stars = '5';
                console.log('🔧 AUTO-SEARCH FIX: Using default filter_stars: 5');
            }
            
            // Reset page_number for new filter search
            finalSearchParams.page_number = 1;
            finalChatMode = false;
            
            console.log('🔧 AUTO-SEARCH FIX: Final searchParams:', JSON.stringify(finalSearchParams, null, 2));
        } else if (shouldForceChatModeFalse) {
            // AI returned complete params but chatMode: true - force chatMode to false
            console.log('🔧 FORCE CHAT MODE FIX: AI said "Ищу" with complete params but chatMode=true. Forcing chatMode=false.');
            finalChatMode = false;
            
            // Apply user's parameter changes (nights, adults, budget, date)
            if (Object.keys(paramChanges).length > 0) {
                Object.assign(finalSearchParams, paramChanges);
                console.log('🔧 FORCE CHAT MODE FIX: Applied param changes:', paramChanges);
            }
            
            // Also extract filter from user message and apply to finalSearchParams
            const userTextLower = text.toLowerCase();
            
            // Meals detection - check if user wants to CHANGE meals
            const userWantsBreakfast = userTextLower.match(/толко\s*завтр|только\s*завтр|завтрак|завтрик|зафтр/);
            const userWantsHalfBoard = userTextLower.match(/полупансион|завтрак.*ужин|ужин.*завтрак/);
            const userWantsFullBoard = userTextLower.match(/полный\s*пансион|трёхразов|трехразов/);
            const userWantsAI = userTextLower.match(/(все|всё).*(включ|вклуч)/) && !userTextLower.match(/у[ль]?тра/);
            const userWantsUAI = userTextLower.match(/у[ль]?тра.*(включ|вклуч)/);
            const userDoesntWantUAI = userTextLower.match(/не\s*хочу.*(у[ль]?тра|все.*включ|всё.*включ)/);
            
            // Apply meal changes based on user request
            if (userWantsBreakfast || userDoesntWantUAI) {
                finalSearchParams.filter_meals = 'BB';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_meals = BB (breakfast only)');
            } else if (userWantsHalfBoard) {
                finalSearchParams.filter_meals = 'HB';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_meals = HB (half board)');
            } else if (userWantsFullBoard) {
                finalSearchParams.filter_meals = 'FB';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_meals = FB (full board)');
            } else if (userWantsUAI) {
                finalSearchParams.filter_meals = 'UAI';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_meals = UAI (ultra all inclusive)');
            } else if (userWantsAI) {
                finalSearchParams.filter_meals = 'AI';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_meals = AI (all inclusive)');
            }
            
            // Check for stars
            if (userTextLower.match(/толко\s*5|только\s*5|5\s*зв|5\s*звод|пять\s*зв/)) {
                finalSearchParams.filter_stars = '5';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_stars = 5');
            } else if (userTextLower.match(/толко\s*4|только\s*4|4\s*зв|4\s*звод|четыре\s*зв/)) {
                finalSearchParams.filter_stars = '4';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_stars = 4');
            } else if (userTextLower.match(/толко\s*3|только\s*3|3\s*зв|3\s*звод|три\s*зв/)) {
                finalSearchParams.filter_stars = '3';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_stars = 3');
            }
            
            // Check for line filter
            const userWantsFirstLine = userTextLower.match(/перв.*лин|1.*лин|первая\s*лин|первой\s*лин|на\s*первой|у\s*моря|beachfront/);
            const userWantsSecondLine = userTextLower.match(/втор.*лин|2.*лин|вторая\s*лин|второй\s*лин|на\s*второй/);
            const userWantsThirdLine = userTextLower.match(/трет.*лин|3.*лин|третья\s*лин|третьей\s*лин|на\s*третьей/);
            
            if (userWantsFirstLine) {
                finalSearchParams.filter_line = '1';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_line = 1 (first line)');
            } else if (userWantsSecondLine) {
                finalSearchParams.filter_line = '2';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_line = 2 (second line)');
            } else if (userWantsThirdLine) {
                finalSearchParams.filter_line = '3';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_line = 3 (third line)');
            }
            
            // Check for beach surface filter
            const userWantsSand = userTextLower.match(/песок|песч|писок|пляж.*песок|песоч/);
            const userWantsPebble = userTextLower.match(/галька|галеч|галка/);
            const userWantsMixed = userTextLower.match(/смешан|песок.*галь|галь.*песок/);
            const userWantsPlatform = userTextLower.match(/платформ|понтон/);
            
            if (userWantsSand && !userWantsPebble) {
                finalSearchParams.filter_beach_surface = 'SAND';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_beach_surface = SAND');
            } else if (userWantsPebble && !userWantsSand) {
                finalSearchParams.filter_beach_surface = 'PEBBLE';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_beach_surface = PEBBLE');
            } else if (userWantsMixed || (userWantsSand && userWantsPebble)) {
                finalSearchParams.filter_beach_surface = 'SAND+PEBBLE';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_beach_surface = SAND+PEBBLE');
            } else if (userWantsPlatform) {
                finalSearchParams.filter_beach_surface = 'PLATFORM';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_beach_surface = PLATFORM');
            }
            
            // Reset page_number for new filter search
            finalSearchParams.page_number = 1;
            
            console.log('🔧 FORCE CHAT MODE FIX: Final searchParams:', JSON.stringify(finalSearchParams, null, 2));
        } else if (aiSaysSearching || userMakingChanges) {
            console.log('⚠️ AUTO-SEARCH NOT TRIGGERED: AI says "Ищу" or user making changes, but conditions not met');
            console.log('   - aiSaysSearching:', aiSaysSearching);
            console.log('   - userAddingFilter:', !!userAddingFilter);
            console.log('   - userChangingParams:', !!userChangingParams);
            console.log('   - paramChanges:', paramChanges);
            console.log('   - hasCoreFields:', hasCoreFields);
            console.log('   - hadPreviousSearch:', hadPreviousSearch);
            console.log('   - hadSearchFromParams:', hadSearchFromParams);
            console.log('   - canAutoSearch:', canAutoSearch);
            console.log('   - aiHasIncompleteParams:', aiHasIncompleteParams);
            console.log('   - combinedParams:', JSON.stringify(combinedParams, null, 2));
        }

        // GLOBAL DEFAULT: Set filter_stars to 5 if not specified and we're about to search
        // This applies to ALL search cases (not just AUTO-SEARCH FIX)
        if (finalChatMode === false && finalSearchParams && !finalSearchParams.filter_stars) {
            finalSearchParams.filter_stars = '5';
            console.log('🔧 GLOBAL DEFAULT: Set filter_stars = 5');
        }

        // Log full response
        console.log('\n========== 📤 TOUR-ASSISTANT RESPONSE ==========');
        console.log('🔄 chatMode:', finalChatMode);
        console.log('💬 nextQuestion:', aiResponse.nextQuestion?.substring(0, 150) + (aiResponse.nextQuestion?.length > 150 ? '...' : ''));
        console.log('📊 searchParams:', JSON.stringify(finalSearchParams, null, 2));
        console.log('================================================\n');

        // Return AI response with chatMode and merged searchParams
        res.json({
            chatMode: finalChatMode !== undefined ? finalChatMode : false,
            nextQuestion: aiResponse.nextQuestion,
            searchParams: finalSearchParams,
        });

    } catch (error) {
        console.error('Error in /stream:', error);
        // Never send raw error details to the client
        res.status(500).json({ error: 'Ой, что-то пошло не так. Попробуйте ещё раз!' });
    }
});

// Note: Final search is now handled directly in the frontend using runFullSearchFlow
// This endpoint is no longer needed

// Tour Assistant V2 (isolated — does not change legacy /api/tour-assistant routes)
const { mountTourAssistantV2Routes } = require('./tour-assistant/v2/routes');
mountTourAssistantV2Routes(app);

// ======================
// Server start
// ======================

const PORT = process.env.PORT || 4444;
app.get('/api/health', (req, res) => {
  res.json({ok: true});
});

server.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
  reportEnv();
  console.log('APN provider:', apnProvider ? `key ${providerOpts.token.key} (production=${providerOpts.production})` : 'disabled');
  console.log(`[AUTH] mode=${authCore.authMode()} (AUTH_MODE=log|enforce), JWT_SECRET loaded: ${Boolean(process.env.JWT_SECRET)}, JWT_REFRESH_SECRET loaded: ${Boolean(process.env.JWT_REFRESH_SECRET)}`);
  console.log(`[CORS] origins: ${allowedOrigins().join(', ')}`);
});


