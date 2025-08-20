const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutter
    max: 100 // max 100 requests per windowMs
});

// Middleware
app.use(limiter);
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// Security headers
app.use((req, res, next) => {
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'DENY');
    res.header('X-XSS-Protection', '1; mode=block');
    next();
});

// Logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path} - ${req.ip}`);
    next();
});

// Data storage (i produksjon: bruk database)
let users = {}; // phoneNumber -> userInfo
let devices = {}; // phoneNumber -> deviceInfo
let calls = {}; // callId -> callInfo
let events = {}; // phoneNumber -> [events]
let verificationCodes = {}; // phoneNumber -> { code, expires }

// Simple UUID generator
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Generate verification code
function generateVerificationCode() {
    return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit code
}

console.log('🚀 EveryApp Production Server Starting...');

// MARK: - SMS Verification (Mock implementation)
async function sendSMS(phoneNumber, message) {
    // I produksjon: integrer med Twilio, AWS SNS, eller lignende
    console.log(`📱 SMS til ${phoneNumber}: ${message}`);
    
    // Mock: return success
    return { success: true, messageId: generateUUID() };
}

// MARK: - User Registration & Verification
app.post('/request-verification', async (req, res) => {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber || !/^\+?[1-9]\d{1,14}$/.test(phoneNumber)) {
        return res.status(400).json({
            success: false,
            message: 'Ugyldig telefonnummer format'
        });
    }
    
    // Generate verification code
    const code = generateVerificationCode();
    const expires = Date.now() + (5 * 60 * 1000); // 5 minutter
    
    verificationCodes[phoneNumber] = { code, expires };
    
    // Send SMS (mock)
    const smsResult = await sendSMS(phoneNumber, `Din EveryApp verifikasjonskode er: ${code}`);
    
    if (smsResult.success) {
        console.log(`✅ Verifikasjonskode sendt til ${phoneNumber}: ${code}`);
        res.json({
            success: true,
            message: 'Verifikasjonskode sendt',
            // I produksjon: ikke returner koden!
            debug_code: process.env.NODE_ENV === 'development' ? code : undefined
        });
    } else {
        res.status(500).json({
            success: false,
            message: 'Kunne ikke sende SMS'
        });
    }
});

app.post('/verify-code', (req, res) => {
    const { phoneNumber, code, deviceToken, userName } = req.body;
    
    if (!phoneNumber || !code) {
        return res.status(400).json({
            success: false,
            message: 'Telefonnummer og kode er påkrevd'
        });
    }
    
    const verification = verificationCodes[phoneNumber];
    
    if (!verification) {
        return res.status(404).json({
            success: false,
            message: 'Ingen verifikasjon funnet for dette nummeret'
        });
    }
    
    if (Date.now() > verification.expires) {
        delete verificationCodes[phoneNumber];
        return res.status(410).json({
            success: false,
            message: 'Verifikasjonskoden er utløpt'
        });
    }
    
    if (verification.code !== code) {
        return res.status(401).json({
            success: false,
            message: 'Ugyldig verifikasjonskode'
        });
    }
    
    // Code is valid - create/update user
    const userId = generateUUID();
    const deviceId = generateUUID();
    
    users[phoneNumber] = {
        userId: userId,
        phoneNumber: phoneNumber,
        userName: userName || phoneNumber,
        createdAt: new Date(),
        isVerified: true
    };
    
    devices[phoneNumber] = {
        deviceId: deviceId,
        deviceToken: deviceToken || null,
        phoneNumber: phoneNumber,
        registeredAt: new Date()
    };
    
    // Clean up verification code
    delete verificationCodes[phoneNumber];
    
    console.log(`✅ Bruker verifisert og registrert: ${phoneNumber} -> ${userId}`);
    
    res.json({
        success: true,
        message: 'Bruker verifisert og registrert',
        user: {
            userId: userId,
            phoneNumber: phoneNumber,
            userName: users[phoneNumber].userName
        },
        deviceId: deviceId
    });
});

// MARK: - Device Registration (for existing users)
app.post('/register-device', (req, res) => {
    const { phoneNumber, deviceToken } = req.body;
    
    if (!phoneNumber) {
        return res.status(400).json({
            success: false,
            message: 'Telefonnummer er påkrevd'
        });
    }
    
    // Check if user exists
    if (!users[phoneNumber] || !users[phoneNumber].isVerified) {
        return res.status(404).json({
            success: false,
            message: 'Bruker ikke funnet eller ikke verifisert'
        });
    }
    
    // Update device info
    const deviceId = devices[phoneNumber]?.deviceId || generateUUID();
    
    devices[phoneNumber] = {
        deviceId: deviceId,
        deviceToken: deviceToken || devices[phoneNumber]?.deviceToken,
        phoneNumber: phoneNumber,
        registeredAt: new Date()
    };
    
    console.log(`📱 Enhet oppdatert for ${phoneNumber}: ${deviceId}`);
    
    if (deviceToken) {
        console.log(`🔑 VoIP Token: ${deviceToken.substring(0, 20)}...`);
    }
    
    res.json({
        success: true,
        message: 'Enhet registrert',
        deviceId: deviceId
    });
});

// MARK: - Calls (oppdatert med bruker-validering)
app.post('/call', (req, res) => {
    const { from, to } = req.body;
    
    if (!from || !to) {
        return res.status(400).json({
            success: false,
            message: 'from og to er påkrevd'
        });
    }
    
    // Validate caller
    if (!users[from] || !users[from].isVerified) {
        return res.status(401).json({
            success: false,
            message: 'Ringer ikke verifisert'
        });
    }
    
    // Check if receiver exists (auto-create for testing)
    if (!users[to]) {
        console.log(`⚠️ Mottaker ${to} ikke registrert, oppretter for testing...`);
        
        const receiverId = generateUUID();
        const deviceId = generateUUID();
        
        users[to] = {
            userId: receiverId,
            phoneNumber: to,
            userName: to,
            createdAt: new Date(),
            isVerified: true // Auto-verify for testing
        };
        
        devices[to] = {
            deviceId: deviceId,
            deviceToken: 'auto-created-for-testing',
            phoneNumber: to,
            registeredAt: new Date()
        };
    }
    
    console.log(`📞 WebRTC ANROP: ${from} (${users[from].userName}) ringer ${to} (${users[to].userName})`);
    
    // Create call
    const callId = Date.now().toString();
    calls[callId] = {
        callId: callId,
        from: from,
        to: to,
        fromName: users[from].userName,
        toName: users[to].userName,
        startTime: new Date(),
        status: 'ringing'
    };
    
    // Send incoming call event
    if (!events[to]) events[to] = [];
    events[to].push({
        type: 'incoming_call',
        from: from,
        fromName: users[from].userName,
        callId: callId,
        timestamp: Date.now()
    });
    
    console.log(`✅ Anrop opprettet: ${callId}`);
    
    if (devices[to]?.deviceToken) {
        console.log(`🔔 VoIP push ville blitt sendt til ${devices[to].deviceToken.substring(0, 20)}...`);
    }
    
    res.json({
        success: true,
        message: 'Anrop initiert',
        callId: callId,
        toName: users[to].userName
    });
});

// MARK: - WebRTC Signaling (unchanged)
app.post('/offer', (req, res) => {
    const { callId, offer } = req.body;
    
    if (!callId || !offer || !calls[callId]) {
        return res.status(400).json({
            success: false,
            message: 'Ugyldig callId eller offer'
        });
    }
    
    const call = calls[callId];
    call.offer = offer;
    
    if (!events[call.to]) events[call.to] = [];
    events[call.to].push({
        type: 'webrtc_offer',
        callId: callId,
        offer: offer,
        timestamp: Date.now()
    });
    
    console.log(`📥 WebRTC Offer mottatt for call: ${callId}`);
    res.json({ success: true });
});

app.post('/answer', (req, res) => {
    const { callId, answer } = req.body;
    
    if (!callId || !answer || !calls[callId]) {
        return res.status(400).json({
            success: false,
            message: 'Ugyldig callId eller answer'
        });
    }
    
    const call = calls[callId];
    
    if (!events[call.from]) events[call.from] = [];
    events[call.from].push({
        type: 'webrtc_answer',
        callId: callId,
        answer: answer,
        timestamp: Date.now()
    });
    
    console.log(`📥 WebRTC Answer mottatt for call: ${callId}`);
    res.json({ success: true });
});

app.post('/ice-candidate', (req, res) => {
    const { callId, candidate, sdpMLineIndex, sdpMid } = req.body;
    
    if (!callId || !candidate || !calls[callId]) {
        return res.status(400).json({
            success: false,
            message: 'Ugyldig callId eller candidate'
        });
    }
    
    const call = calls[callId];
    const phones = [call.from, call.to];
    
    phones.forEach(phone => {
        if (!events[phone]) events[phone] = [];
        events[phone].push({
            type: 'ice_candidate',
            callId: callId,
            candidate: candidate,
            sdpMLineIndex: sdpMLineIndex,
            sdpMid: sdpMid,
            timestamp: Date.now()
        });
    });
    
    res.json({ success: true });
});

// MARK: - Events (unchanged)
app.get('/events/:phoneNumber', (req, res) => {
    const phoneNumber = req.params.phoneNumber;
    const userEvents = events[phoneNumber] || [];
    events[phoneNumber] = [];
    
    res.json({
        success: true,
        events: userEvents
    });
});

// MARK: - Info endpoints
app.get('/users', (req, res) => {
    const userList = Object.values(users).map(user => ({
        phoneNumber: user.phoneNumber,
        userName: user.userName,
        isVerified: user.isVerified,
        createdAt: user.createdAt
    }));
    
    res.json({
        success: true,
        count: userList.length,
        users: userList
    });
});

app.get('/health', (req, res) => {
    res.json({
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        name: 'EveryApp WebRTC Signaling Server',
        version: '1.0.0',
        status: 'running',
        endpoints: {
            auth: {
                requestVerification: 'POST /request-verification',
                verifyCode: 'POST /verify-code',
                registerDevice: 'POST /register-device'
            },
            calls: {
                initiateCall: 'POST /call',
                webrtcOffer: 'POST /offer',
                webrtcAnswer: 'POST /answer',
                iceCandidate: 'POST /ice-candidate'
            },
            polling: {
                events: 'GET /events/:phoneNumber'
            },
            info: {
                users: 'GET /users',
                health: 'GET /health'
            }
        }
    });
});

// Error handling
app.use((err, req, res, next) => {
    console.error(`❌ Server error: ${err.message}`);
    res.status(500).json({
        success: false,
        message: 'Intern server feil'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint ikke funnet'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🌟 EveryApp Server kjører på port ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📝 Registrer bruker: POST /request-verification`);
    console.log(`✅ Verifiser kode: POST /verify-code`);
    console.log(`📊 Server info: GET /`);
});