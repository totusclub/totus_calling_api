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
const http = require('http');
const {Server} = require('socket.io');
const {userDb} = require('./db');
const {synthesizeSpeech, synthesizeSpeechToFile} = require('./ttsService');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  },
});

// Trust proxy (important if behind reverse proxy/load balancer)
app.set('trust proxy', true);

// Handle OPTIONS requests FIRST - before any other middleware
// This prevents redirects from breaking CORS preflight
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.header('Access-Control-Max-Age', '86400'); // 24 hours
  return res.sendStatus(200);
});

// CORS configuration - allow all origins for development and production
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: false,
  preflightContinue: false,
  optionsSuccessStatus: 200,
}));

// Additional CORS headers middleware as backup
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  // Don't redirect OPTIONS requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(bodyParser.json());
// Simple request logger so you can see every hit
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// In-memory stores (for active calls and WebRTC signaling)
const devices = new Map(); // deviceId -> { userId, loyaltyId, platform, voipToken, socketId }
const calls = new Map();   // callId  -> { fromUserId, fromLoyaltyId, fromDeviceId, toDeviceId, toLoyaltyId, offer, answer }
const callCandidates = new Map(); // callId -> { caller: [], callee: [] }
const deviceSockets = new Map(); // deviceId -> socket.id
const socketDevices = new Map(); // socket.id -> deviceId
const loyaltyIdToDeviceId = new Map(); // loyaltyId -> deviceId (for quick lookups)

// ======================
// APNs (VoIP) Provider
// ======================

// You provided this snippet:
//
// const providerOpts = {
//   token: {
//     // key: './p8/AuthKey_FV2BW9CFNB.p8', // keep your file if needed sendbox
//     key: './p8/AuthKey_2X2QV7S43J.p8', // keep your file if needed sendbox
//     keyId: '2X2QV7S43J',
//     teamId: 'C6258722D6'
//   },
//   production: false
// };
//
// We adapt it to use an absolute path so it works regardless of where you start Node.

const providerOpts = {
  token: {
    key: path.join(__dirname, 'p8', 'AuthKey_2X2QV7S43J.p8'),
    keyId: '2X2QV7S43J',
    teamId: 'C6258722D6',
  },
  production: false, // false = sandbox / development
};

const apnProvider = new apn.Provider(providerOpts);

// This must match the VoIP topic configured for your app in Apple Developer portal.
// Often: "<bundle-id>.voip" or just your bundle id if configured that way.
const APN_VOIP_TOPIC = process.env.APN_VOIP_TOPIC || 'app.totus.club.voip';

// ======================
// Authentication (Login)
// ======================

// Web app login - only agents can login
// POST /api/web/login
// body: { email: string, password: string }
app.post('/api/web/login', async (req, res) => {
  const {email, password} = req.body || {};
  console.log('web-login', email);
  
  if (!email || !password) {
    return res.status(400).json({error: 'email and password are required'});
  }

  try {
    // Get user by email and password
    const user = await userDb.getUserByEmailAndPassword(email, password);
    
    if (!user) {
      return res.status(401).json({error: 'Invalid email or password'});
    }

    // Check if user has role 'agent'
    if (user.role !== 'agent') {
      return res.status(403).json({error: 'Access denied. Only agents can login to web app.'});
    }

    // Return user data (without password)
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
  const {deviceId, loyaltyId, userId, voipToken, platform} = req.body || {};
  console.log('register-device', deviceId, loyaltyId, userId, voipToken, platform);
  
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

    // Update user's voipToken and socketId in database
    const socketId = deviceSockets.get(deviceId) || null;
    await userDb.updateUserDeviceInfo(user.id, voipToken, socketId);

    // Also store in memory for quick access
    devices.set(deviceId, {
      userId: user.id,
      loyaltyId: user.loyalty_id,
      voipToken,
      platform: platform || 'ios',
      socketId,
    });

    loyaltyIdToDeviceId.set(user.loyalty_id, deviceId);

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
      },
    });
  } catch (error) {
    console.error('[get-user-by-id] error:', error);
    res.status(500).json({error: 'Failed to get user: ' + error.message});
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

// From caller app: start a call and send VoIP push to callee.
// Matches the fetch in startOutgoingVoiceCall:
// POST /api/calls
// body: { callId, toDeviceId (or toLoyaltyId), callerName, offer: { type, sdp }, fromDeviceId?, fromLoyaltyId? }
app.post('/api/calls', async (req, res) => {
  const {callId, toDeviceId, toLoyaltyId, callerName, offer, fromDeviceId, fromLoyaltyId} = req.body || {};
  console.log('callerName', callId, toDeviceId, toLoyaltyId, callerName, offer);
  
  // Support calling by loyalty_id or deviceId
  let targetDeviceId = toDeviceId;
  let targetLoyaltyId = toLoyaltyId;
  
  // If toLoyaltyId provided, find the deviceId
  if (!targetDeviceId && targetLoyaltyId) {
    targetDeviceId = loyaltyIdToDeviceId.get(targetLoyaltyId) || null;
    if (!targetDeviceId) {
      // Try to find in database
      try {
        const user = await userDb.getUserDeviceInfoByLoyaltyId(targetLoyaltyId);
        if (user && user.voipToken) {
          // User exists but might not be in memory, we'll use voipToken directly
          targetLoyaltyId = user.loyalty_id;
        } else {
          return res.status(404).json({error: 'Target user not found or not online'});
        }
      } catch (error) {
        console.error('[call] error finding user:', error);
        return res.status(500).json({error: 'Failed to find target user'});
      }
    }
  }
  
  if (!callId || (!targetDeviceId && !targetLoyaltyId) || !offer || !offer.sdp) {
    return res.status(400).json({error: 'callId, toDeviceId (or toLoyaltyId), and offer.sdp are required'});
  }

  // Get callee info from memory or database
  let callee = targetDeviceId ? devices.get(targetDeviceId) : null;
  
  // If not in memory, get from database
  if (!callee && targetLoyaltyId) {
    try {
      const user = await userDb.getUserDeviceInfoByLoyaltyId(targetLoyaltyId);
      if (!user) {
        return res.status(404).json({error: 'Target user not found'});
      }
      
      // Determine platform: web if has socketId, iOS if has voipToken
      // Allow calling offline users if they have voipToken (VoIP push works even when offline)
      const isWeb = !!user.socketId;
      const isPhone = !!user.voipToken;
      
      if (!isWeb && !isPhone) {
        return res.status(404).json({error: 'Target user not registered for calls (no socketId or voipToken)'});
      }
      
      callee = {
        userId: user.id,
        loyaltyId: user.loyalty_id,
        voipToken: user.voipToken || null,
        platform: isWeb ? 'web' : 'ios',
        socketId: user.socketId || null,
      };
      targetDeviceId = isWeb ? user.socketId : (user.voipToken || targetDeviceId);
    } catch (error) {
      console.error('[call] error getting user:', error);
      return res.status(500).json({error: 'Failed to get target user'});
    }
  }
  
  if (!callee) {
    return res.status(404).json({error: 'Target device not registered'});
  }

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
  if (callerLoyaltyId) {
    try {
      const callerUser = await userDb.getUserByLoyaltyId(callerLoyaltyId);
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

  calls.set(callId, {
    fromUserId: callee.userId,
    fromLoyaltyId: callerLoyaltyId || null,
    fromDeviceId: fromDeviceId || null,
    toDeviceId: targetDeviceId,
    toLoyaltyId: callee.loyaltyId || targetLoyaltyId || null,
    callerName: finalCallerName,
    offer,
    answer: null,
  });

  console.log('[create-call] callId=', callId, '=> deviceId=', targetDeviceId, 'platform=', callee.platform);

  // Determine if callee is web or phone
  // Allow calling offline users if they have voipToken (VoIP push works even when offline)
  const calleeSocketId = callee.socketId || deviceSockets.get(targetDeviceId);
  const isCalleeWeb = callee.platform === 'web' || !!calleeSocketId;
  const isCalleePhone = (callee.platform === 'ios' && !!callee.voipToken) || (!!callee.voipToken && !callee.socketId);

  // For web clients: send offer via socket
  if (isCalleeWeb && calleeSocketId) {
    console.log('[call] Sending offer to web client via socket:', calleeSocketId);
    io.to(calleeSocketId).emit('offer', {
      callId,
      offer: {
        type: offer.type,
        sdp: offer.sdp,
      },
      fromDeviceId: fromDeviceId || null,
      fromLoyaltyId: callerLoyaltyId || null,
      callerName: finalCallerName,
    });
    
    // Also notify about incoming call state
    io.to(calleeSocketId).emit('call-state', {
      callId,
      state: 'ringing',
      direction: 'incoming',
      fromDeviceId: fromDeviceId || null,
      fromLoyaltyId: callerLoyaltyId || null,
      callerName: finalCallerName,
    });
  }

  // For phone clients: send VoIP push notification
  if (isCalleePhone) {
    try {
      const note = new apn.Notification();

      // VoIP push headers
      note.pushType = 'voip';
      note.topic = APN_VOIP_TOPIC;

      // Payload received by AppDelegate / RNVoipPushNotificationManager
      // Note: AppDelegate expects these keys: callId, handle, callerName, uuid (optional)
      note.payload = {
        callId,
        uuid: callId, // Some libraries expect uuid field
        handle: targetDeviceId,
        callerName: finalCallerName,
        caller_name: finalCallerName, // Alternative key name
        from: targetDeviceId, // Alternative key name
        offer: {
          type: offer.type,
          sdp: offer.sdp,
        },
      };

      console.log('[apn] VoIP push payload:', {
        callId,
        handle: targetDeviceId,
        callerName: finalCallerName,
        topic: APN_VOIP_TOPIC,
        voipTokenLength: callee.voipToken ? callee.voipToken.length : 0,
      });

      const result = await apnProvider.send(note, callee.voipToken);
      console.log(
        '[apn] sent=', result.sent.length,
        'failed=', result.failed.length,
      );

      // Log failed notifications with details
      if (result.failed.length > 0) {
        result.failed.forEach((failure) => {
          console.error('[apn] failed notification:', {
            device: failure.device,
            status: failure.status,
            response: failure.response,
          });
        });
      }

      // Log successful notifications
      if (result.sent.length > 0) {
        result.sent.forEach((success) => {
          console.log('[apn] sent successfully to device:', success);
        });
      }

      res.json({ok: true, callId, apnResult: {sent: result.sent.length, failed: result.failed.length}});
    } catch (err) {
      console.error('[apn] send error', err);
      console.error('[apn] error details:', {
        message: err.message,
        stack: err.stack,
        callId,
        targetDeviceId,
        voipToken: callee.voipToken ? `${callee.voipToken.substring(0, 20)}...` : 'null',
      });
      res.status(500).json({error: 'APNs send failed: ' + err.message});
    }
  } else if (isCalleeWeb) {
    // Web client - already sent via socket above
    res.json({ok: true, callId, platform: 'web'});
  } else {
    // TODO: Android – send FCM data message here
    console.log('[create-call] Android push not implemented, deviceId=', targetDeviceId);
    res.json({ok: true, callId, note: 'Android push not implemented yet'});
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

  call.answer = answer;
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

  res.json({ok: true});
});

// Caller (or callee) polls call state to retrieve offer/answer.
// GET /api/calls/:callId
app.get('/api/calls/:callId', (req, res) => {
  const {callId} = req.params;
  const call = calls.get(callId);
  console.log('call', callId, call);

  if (!call) {
    return res.status(404).json({error: 'Unknown callId'});
  }

  res.json({
    callId,
    fromDeviceId: call.fromDeviceId || null,
    toDeviceId: call.toDeviceId || null,
    fromLoyaltyId: call.fromLoyaltyId || null,
    toLoyaltyId: call.toLoyaltyId || null,
    callerName: call.callerName || null,
    offer: call.offer,
    answer: call.answer,
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
  console.log('candidate', callId, from, candidate);
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
    const toDeviceId = from === 'caller' ? call.toDeviceId : call.fromDeviceId;
    
    if (toDeviceId) {
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

  // Figure out the peer device (the other side of the call)
  const {fromDeviceId, toDeviceId} = call;
  let peerDeviceId = null;
  if (deviceId && fromDeviceId && deviceId === fromDeviceId) {
    peerDeviceId = toDeviceId;
  } else if (deviceId && toDeviceId && deviceId === toDeviceId) {
    peerDeviceId = fromDeviceId;
  }

  if (peerDeviceId) {
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

io.on('connection', socket => {
  console.log('Socket connected', socket.id);

  socket.on('registerDevice', async ({deviceId, loyaltyId, userId}) => {
    if (!deviceId) {
      return;
    }
    
    // Use loyaltyId if provided, otherwise try userId for backward compatibility
    const targetLoyaltyId = loyaltyId || userId;
    
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
            devices.set(deviceId, {
              userId: user.id,
              loyaltyId: user.loyalty_id,
              voipToken: user.voipToken || null,
              platform: 'web',
              socketId: socket.id,
            });
          }
          loyaltyIdToDeviceId.set(user.loyalty_id, deviceId);
          
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
      io.to(toSocketId).emit('offer', {callId, offer, fromDeviceId});
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
    
    if (deviceId) {
      // Update database to remove socketId and set online = 0
      const device = devices.get(deviceId);
      if (device && device.loyaltyId) {
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
      if (device && device.loyaltyId) {
        loyaltyIdToDeviceId.delete(device.loyaltyId);
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
const DEEPSEEK_API_KEY = '';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// System prompt for tour agent assistant
const DEEPSEEK_SYSTEM_PROMPT = `Ты профессиональный туристический агент-помощник. Твоя задача - помочь пользователям найти идеальные туры и путешествия.

Твои возможности:
- Задавай уточняющие вопросы о предпочтениях пользователя (бюджет, даты, тип отдыха, количество человек)
- Рекомендуй конкретные направления и туры
- Предоставляй информацию о ценах, длительности, особенностях туров
- Отвечай на русском языке дружелюбно и профессионально
- Если пользователь спрашивает о турах, предоставь конкретные рекомендации в формате:
  "1. [Название тура] - [Направление] - [Цена] рублей - [Длительность] дней - [Описание]"

Пример ответа с турами:
"Отлично, я нашел несколько вариантов для вас:
Отдых в Дубае - Дубай, ОАЭ - 85000 рублей - 7 дней - Роскошный отдых с посещением небоскребов и пляжей.
Пляжный отдых в Турции - Анталия, Турция - 45000 рублей - 5 дней - Все включено, идеально для семейного отдыха.
Экскурсионный тур по Египту - Каир, Египет - 55000 рублей - 6 дней - Погружение в историю древних цивилизаций."

Если туры не найдены или запрос неясен, отвечай вежливо и предлагай уточнить запрос.`;

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
        model: 'deepseek-chat',
        messages: messages,
        temperature: 0.7,
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

// ======================
// Server start
// ======================

const PORT = process.env.PORT || 4444;
app.get('/api/health', (req, res) => {
  res.json({ok: true});
});

server.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
  console.log('APN provider using key:', providerOpts.token.key);
});


