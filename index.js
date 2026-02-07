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
  production: true, // false = sandbox / development
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
  // console.log('Socket connected', socket.id);

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
Ты счастливый и дружелюбный туристический помощник! Твоя миссия — помочь каждому пользователю найти идеальное путешествие его мечты! 

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

3. РЕЖИМ "ПОКАЗАТЬ ЕЩЁ" (showMore):
   - Если пользователь говорит: "ещё", "другие", "покажи ещё", "не нравятся", "другие отели", "следующие", "дальше", "показать больше", "не подходят", "другие варианты" и т.п.
   - Это означает, что пользователь хочет увидеть СЛЕДУЮЩУЮ страницу отелей
   - В этом случае: chatMode: false, nextQuestion: null или "", searchParams: те же параметры но page_number увеличен на 1
   - Если текущий page_number = 1, верни page_number = 2, если 2 → верни 3 и т.д.
   - ВАЖНО: Сохрани ВСЕ остальные searchParams как есть, НЕ обнуляй их!

4. РЕЖИМ "ИЗМЕНЕНИЕ ПАРАМЕТРОВ" (changeParams):
   - Если пользователь хочет ИЗМЕНИТЬ один или несколько параметров поиска:
     - Страну/город назначения: "а в Египет?", "давай лучше в Таиланд", "хочу в другую страну", "поменяй на Грецию"
     - Даты: "а на март?", "поменяй дату на 20 марта", "давай в апреле", "сдвинь на неделю"
     - Количество ночей: "а на 10 ночей?", "давай подольше", "на 14 дней"
     - Количество людей: "нас будет 3", "добавь ребенка", "без детей"
     - Город вылета: "из Петербурга", "вылет из Казани"
   - ОБЯЗАТЕЛЬНО обнови ТОЛЬКО изменённые поля, остальные сохрани как есть
   - ОБЯЗАТЕЛЬНО сбрось page_number на 1 (это НОВЫЙ поиск с новыми параметрами!)
   - Верни: chatMode: false, nextQuestion: null или "", searchParams: обновленные параметры с page_number: 1
   - Примеры фраз пользователя: "а если в Египет?", "поменяй страну на Грецию", "а на другие даты?", "давай на март", "а если на 10 ночей?"

ТЫ ДОЛЖЕН:
- Распознавать информацию из свободных ответов пользователя
- Заполнять searchParams постепенно, сохраняя уже введенные данные
- Задавать только ОДИН вопрос за раз
- Когда все обязательные поля заполнены — вернуть searchParams с nextQuestion: null или ""

ОБЯЗАТЕЛЬНЫЕ ПОЛЯ для поиска:
- from_city (город вылета) или from_country (страна вылета, по умолчанию "RU")
- to_country (страна назначения) - ОБЯЗАТЕЛЬНО
- adults (количество взрослых, по умолчанию "1")
- start_date (дата вылета в формате YYYY-MM-DD)
- nights (количество ночей, число или строка "X" или "X-Y")

ОПЦИОНАЛЬНЫЕ ПОЛЯ:
- to_city (город назначения)
- kids (количество детей, по умолчанию "0")
- kids_ages (массив возрастов детей, пустой если kids = "0")
- flex_dates (гибкость по датам в днях, по умолчанию 2)

ТЕХНИЧЕСКИЕ ПОЛЯ (всегда одинаковые):
- search_type: "package"
- hotel_ids: []
- page_number: 1
- page_limit: 3
- sort_by: "relevance"

ПРАВИЛА:
1. Если поле не заполнено — задай ОДИН дружелюбный и позитивный вопрос на русском языке
2. Распознавай данные из свободной формы: "2 взрослых и ребенок 5 лет", "с 23 января на 7 ночей", "в Турцию, Анталию"
3. НЕ изменяй уже заполненные поля, ЕСЛИ пользователь НЕ просит их изменить. Но ЕСЛИ пользователь явно хочет изменить параметр (страну, дату, ночи и т.д.) — ОБЯЗАТЕЛЬНО обнови это поле и сбрось page_number на 1!
4. Если kids = "0" → kids_ages = []
5. nights может быть числом или строкой "7" или "7-9"
6. Когда ВСЕ обязательные поля заполнены → верни searchParams с nextQuestion: null или ""
7. Будь индивидуальным — ссылайся на то, что пользователь уже упомянул: "Как я понял, ты хочешь в Турцию...", "Отлично, мы выяснили, что вылет из Москвы..."
8. Показывай энтузиазм и радость от помощи!

ФОРМАТ ОТВЕТА (ТОЛЬКО JSON, БЕЗ МАРКДАУНА):
{
  "chatMode": true или false,
  "nextQuestion": "текст вопроса/ответа или null",
  "searchParams": {
    "from_city": "Moscow",
    "from_country": "RU",
    "to_country": "TR",
    "adults": "2",
    "kids": "1",
    "kids_ages": ["5"],
    "start_date": "2026-02-15",
    "nights": "7",
    "search_type": "package",
    "flex_dates": 2,
    "hotel_ids": [],
    "page_number": 1,
    "page_limit": 3,
    "sort_by": "relevance"
  }
}

ПРИМЕРЫ (обрати внимание на позитивный и индивидуальный тон):

Пользователь: "Привет"
Ответ: {
  "chatMode": true,
  "nextQuestion": "Привет! Как здорово, что ты решил отправиться в путешествие! 😊 Чем могу помочь? Могу рассказать о направлениях, помочь выбрать отель или найти подходящий тур. Что тебя интересует?",
  "searchParams": {}
}

Пользователь: "Какие отели есть в Турции?"
Ответ: {
  "chatMode": true,
  "nextQuestion": "В Турции просто огромный выбор отелей! 🌴 Есть и роскошные 5-звездочные отели с собственными пляжами, и уютные семейные отели. Особенно популярны отели в Анталии, Кемере, Алании. Хочешь, помогу найти конкретные варианты? Просто скажи 'да' или 'хочу найти', и я помогу подобрать идеальный отель! 😊",
  "searchParams": {}
}

Пользователь: "Да, хочу найти"
Ответ: {
  "chatMode": false,
  "nextQuestion": "Отлично! Давай найдем идеальный отель для тебя! 🎉 Из какого города планируешь вылет?",
  "searchParams": {
    "from_country": "RU"
  }
}

Пользователь: "Привет, хочу найти отель"
Ответ: {
  "chatMode": false,
  "nextQuestion": "Привет! Как здорово, что ты решил найти отель! 😊 Давай начнем! Из какого города планируешь вылет?",
  "searchParams": {
    "from_country": "RU"
  }
}

Пользователь: "Из Москвы"
Ответ: {
  "chatMode": false,
  "nextQuestion": "Отлично, Москва! Отличный старт! 🎉 А куда мечтаешь поехать? В какую страну?",
  "searchParams": {
    "from_city": "Moscow",
    "from_country": "RU"
  }
}

Пользователь: "В Турцию, Анталию"
Ответ: {
  "chatMode": false,
  "nextQuestion": "О, Турция и Анталия — это просто потрясающе! 🌴 Там такой красивый пляж и море! А на сколько человек планируешь поездку?",
  "searchParams": {
    "from_city": "Moscow",
    "from_country": "RU",
    "to_country": "TR",
    "to_city": "Antalya"
  }
}

Пользователь: "2 взрослых и ребенок 5 лет"
Ответ: {
  "chatMode": false,
  "nextQuestion": "Супер! Семейное путешествие — это всегда здорово! 👨‍👩‍👦 А на какие даты планируешь поездку? Когда хочешь отправиться и на сколько ночей?",
  "searchParams": {
    "from_city": "Moscow",
    "from_country": "RU",
    "to_country": "TR",
    "to_city": "Antalya",
    "adults": "2",
    "kids": "1",
    "kids_ages": ["5"]
  }
}

Пользователь: "С 15 февраля на 7 ночей"
Ответ: {
  "chatMode": false,
  "nextQuestion": null,
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
    "search_type": "package",
    "flex_dates": 2,
    "hotel_ids": [],
    "page_number": 1,
    "page_limit": 3,
    "sort_by": "relevance"
  }
}

ПОКАЗАТЬ ЕЩЁ ПРИМЕРЫ:

Пользователь: "Ещё" / "Другие" / "Покажи ещё" / "Не нравятся" / "Другие варианты"
(Если searchParams уже заполнены и page_number = 1)
Ответ: {
  "chatMode": false,
  "nextQuestion": null,
  "searchParams": {
    "from_city": "Moscow",
    "from_country": "RU",
    "to_country": "TR",
    "to_city": "Antalya",
    "adults": "2",
    "kids": "0",
    "kids_ages": [],
    "start_date": "2026-02-15",
    "nights": "7",
    "search_type": "package",
    "flex_dates": 2,
    "hotel_ids": [],
    "page_number": 2,
    "page_limit": 3,
    "sort_by": "relevance"
  }
}

ИЗМЕНЕНИЕ ПАРАМЕТРОВ ПРИМЕРЫ:

Пользователь: "А давай лучше в Египет" / "Поменяй на Египет" / "А если в Египет?"
(Если до этого искали в Турции — пользователь хочет ИЗМЕНИТЬ страну)
Ответ: {
  "chatMode": false,
  "nextQuestion": null,
  "searchParams": {
    "from_city": "Moscow",
    "from_country": "RU",
    "to_country": "EG",
    "adults": "2",
    "kids": "0",
    "kids_ages": [],
    "start_date": "2026-02-15",
    "nights": "7",
    "search_type": "package",
    "flex_dates": 2,
    "hotel_ids": [],
    "page_number": 1,
    "page_limit": 3,
    "sort_by": "relevance"
  }
}
ОБРАТИ ВНИМАНИЕ: to_country изменён на "EG", to_city убран (т.к. Antalya не в Египте), page_number СБРОШЕН на 1!

Пользователь: "А на март?" / "Поменяй дату на 15 марта" / "Давай в марте"
(Если до этого искали на февраль — пользователь хочет ИЗМЕНИТЬ дату)
Ответ: {
  "chatMode": false,
  "nextQuestion": null,
  "searchParams": {
    "from_city": "Moscow",
    "from_country": "RU",
    "to_country": "TR",
    "to_city": "Antalya",
    "adults": "2",
    "kids": "0",
    "kids_ages": [],
    "start_date": "2026-03-15",
    "nights": "7",
    "search_type": "package",
    "flex_dates": 2,
    "hotel_ids": [],
    "page_number": 1,
    "page_limit": 3,
    "sort_by": "relevance"
  }
}
ОБРАТИ ВНИМАНИЕ: start_date изменён на "2026-03-15", page_number СБРОШЕН на 1!

Пользователь: "А на 10 ночей?" / "Давай подольше, на 14 ночей"
(Если до этого было 7 ночей — пользователь хочет ИЗМЕНИТЬ количество ночей)
Ответ: {
  "chatMode": false,
  "nextQuestion": null,
  "searchParams": {
    "from_city": "Moscow",
    "from_country": "RU",
    "to_country": "TR",
    "to_city": "Antalya",
    "adults": "2",
    "kids": "0",
    "kids_ages": [],
    "start_date": "2026-02-15",
    "nights": "10",
    "search_type": "package",
    "flex_dates": 2,
    "hotel_ids": [],
    "page_number": 1,
    "page_limit": 3,
    "sort_by": "relevance"
  }
}
ОБРАТИ ВНИМАНИЕ: nights изменён на "10", page_number СБРОШЕН на 1!

Пользователь: "А в Египет на март на 10 дней?"
(Пользователь хочет ИЗМЕНИТЬ НЕСКОЛЬКО параметров одновременно)
Ответ: {
  "chatMode": false,
  "nextQuestion": null,
  "searchParams": {
    "from_city": "Moscow",
    "from_country": "RU",
    "to_country": "EG",
    "adults": "2",
    "kids": "0",
    "kids_ages": [],
    "start_date": "2026-03-01",
    "nights": "10",
    "search_type": "package",
    "flex_dates": 2,
    "hotel_ids": [],
    "page_number": 1,
    "page_limit": 3,
    "sort_by": "relevance"
  }
}
ОБРАТИ ВНИМАНИЕ: to_country, to_city, start_date, nights изменены, page_number СБРОШЕН на 1!

ВАЖНО: 
- Всегда возвращай ТОЛЬКО валидный JSON, без дополнительного текста, без markdown блоков кода
- ВСЕГДА указывай поле "chatMode": true или false
- В nextQuestion можешь использовать эмодзи для выражения эмоций (😊, 🎉, 🌴, ✈️, ✈️, 👨‍👩‍👦 и т.д.)
- Будь искренне счастлив помогать каждому пользователю!
- Помни: ты можешь и отвечать на вопросы, и помогать найти отели — все зависит от того, что хочет пользователь!
- Если пользователь задает вопрос → chatMode: true, отвечай и помогай
- Если пользователь хочет найти отели (говорит "да", "хочу найти", "искать") → chatMode: false, собирай данные
- Если пользователь хочет увидеть ДРУГИЕ отели (говорит "ещё", "другие", "не нравятся", "следующие", "дальше") → chatMode: false, nextQuestion: null, page_number + 1
- Если пользователь хочет ИЗМЕНИТЬ параметры (страну, дату, ночи, кол-во людей и т.д.) → chatMode: false, nextQuestion: null, обнови ИЗМЕНЁННЫЕ поля, page_number = 1 (НОВЫЙ поиск!)

КЛЮЧЕВОЕ РАЗЛИЧИЕ "ещё" vs "изменение":
- "Покажи ещё" / "Другие варианты" → page_number + 1, параметры НЕ меняются (та же страна, дата, ночи)
- "А в Египет?" / "Поменяй на март" / "На 10 ночей" → page_number = 1, ОБНОВИ изменённый параметр (НОВЫЙ поиск!)
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
    // This is critical for pagination: without it, the AI can't increment page_number properly
    if (currentSearchParams && currentSearchParams.page_number && currentSearchParams.to_country) {
        messages.push({
            role: 'system',
            content: `КОНТЕКСТ ТЕКУЩЕГО ПОИСКА: Текущие параметры поиска пользователя: ${JSON.stringify(currentSearchParams)}. Текущий page_number = ${currentSearchParams.page_number}. Если пользователь хочет увидеть ДРУГИЕ отели, увеличь page_number на 1 (следующий page_number = ${currentSearchParams.page_number + 1}). Все остальные searchParams оставь без изменений!`,
        });
    }

    // Add current user message
    messages.push({ role: 'user', content: userMessage });

    try {
        const response = await axios.post(
            DEEPSEEK_API_URL,
            {
                model: 'deepseek-chat',
                messages,
                temperature: 0.7,
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

        // Merge with current searchParams (only if not in chat mode)
        const mergedParams = chatMode ? {} : { ...currentSearchParams };
        
        if (!chatMode && parsed.searchParams && typeof parsed.searchParams === 'object') {
            Object.assign(mergedParams, parsed.searchParams);
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
        if (!chatMode) {
            if (!mergedParams.from_country) mergedParams.from_country = 'RU';
            if (!mergedParams.adults) mergedParams.adults = '1';
            if (!mergedParams.kids) mergedParams.kids = '0';
            if (!mergedParams.kids_ages) mergedParams.kids_ages = [];
            if (!mergedParams.search_type) mergedParams.search_type = 'package';
            if (!mergedParams.flex_dates) mergedParams.flex_dates = 2;
            if (!mergedParams.hotel_ids) mergedParams.hotel_ids = [];
            if (!mergedParams.page_number) mergedParams.page_number = 1;
            if (!mergedParams.page_limit) mergedParams.page_limit = 3;
            if (!mergedParams.sort_by) mergedParams.sort_by = 'relevance';
        }

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

        if (!text) {
            return res.status(400).json({ error: 'text required' });
        }

        // Merge searchParams from conversation history
        const mergedParams = mergeSearchParamsFromHistory(conversationHistory);
        Object.assign(mergedParams, currentSearchParams);

        // Call DeepSeek API safely
        const aiResponse = await callDeepSeek(text, conversationHistory, mergedParams);

        if (!aiResponse) {
            return res.status(500).json({ error: 'AI response is empty' });
        }

        // Return AI response with chatMode and merged searchParams
        res.json({
            chatMode: aiResponse.chatMode !== undefined ? aiResponse.chatMode : false,
            nextQuestion: aiResponse.nextQuestion,
            searchParams: aiResponse.searchParams,
        });

    } catch (error) {
        console.error('Error in /stream:', error);
        // Never send raw error details to the client
        res.status(500).json({ error: 'Ой, что-то пошло не так. Попробуйте ещё раз!' });
    }
});

// Note: Final search is now handled directly in the frontend using runFullSearchFlow
// This endpoint is no longer needed

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


