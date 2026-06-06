require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const session = require('express-session');

const webhookRoute = require('./src/routes/webhook');
const {
    saveUser,
    getUserByFacebookId,
    getCatchesByUser,
    updateUser,
    saveCatch,
    countCatches,
    deleteCatches,
    supabase
} = require('./src/services/supabase');
const { handleSystemMessage, sendMessengerMessage, sendWhatsAppMessage, sendWelcomeButtons, sendWhatsAppMenu } = require('./src/services/messengerService');

const app = express();

app.use(bodyParser.json());
app.use(express.static(__dirname));

// ─── Session Middleware ───────────────────────────────────────
app.use(session({
    secret: 'ecofin-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use('/webhook', webhookRoute);

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/login.html');
});

// ─── Explicit static file routes ─────────────────────────────
app.get('/verify.html', (req, res) => {
    res.sendFile(__dirname + '/verify.html');
});
app.get('/signup.html', (req, res) => {
    res.sendFile(__dirname + '/signup.html');
});
app.get('/login.html', (req, res) => {
    res.sendFile(__dirname + '/login.html');
});


// ─────────────────────────────────────────────────────────────
// A. Facebook OAuth — Step 1: Redirect to Facebook Login
// ─────────────────────────────────────────────────────────────

app.get('/auth/facebook', (req, res) => {
    console.log('[EcoFin] APP_ID:', process.env.APP_ID);
    console.log('[EcoFin] REDIRECT_URI:', process.env.REDIRECT_URI);

    const params = new URLSearchParams({
        client_id:     process.env.APP_ID,
        redirect_uri:  process.env.REDIRECT_URI,
        scope:         'public_profile',
        response_type: 'code',
    });

    res.redirect(`https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`);
});


// ─────────────────────────────────────────────────────────────
// A2. Email / Password Login
// ─────────────────────────────────────────────────────────────

app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });

        if (error || !data.user) {
            console.warn(`[EcoFin] ⚠️ Login failed for ${email}:`, error?.message);
            if (error?.message?.toLowerCase().includes('email not confirmed')) {
                return res.status(401).json({ error: 'Please verify your email before logging in. Check your inbox.' });
            }
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        console.log(`[EcoFin] ✅ Email login: ${email}`);

        const { data: userData } = await supabase
            .from('users')
            .select('*')
            .eq('email', email)
            .single();

        let userId;

        if (userData) {
            userId = userData.id;
        } else {
            userId = `email_${data.user.id}`;
            const name = data.user.user_metadata?.name || email.split('@')[0];
            await saveUser(userId, {
                name,
                email,
                facebook_id:         null,
                psid:                null,
                whatsapp:            null,
                location:            'Philippines',
                total_catches:       0,
                fishing_hours:       0,
                achievements:        0,
                success_rate:        0,
                member_since:        new Date().toLocaleDateString('en-US', {
                    month: 'long', year: 'numeric'
                }),
                messenger_connected: false,
                whatsapp_connected:  false,
            });
        }

        req.session.userId   = userId;
        req.session.userName = userData?.name || data.user.user_metadata?.name || email.split('@')[0];
        req.session.loggedIn = true;

        console.log(`[EcoFin] ✅ Session created for ${userId}`);

        // ── Send login notification to Messenger and/or WhatsApp ──
        const loginUser = userData;
        if (loginUser) {
            const loginMsg = `👋 Hi ${loginUser.name}! You've just logged in to EcoFin AI.`;
            if (loginUser.psid && loginUser.messenger_connected) {
                await sendMessengerMessage(loginUser.psid, loginMsg);
                await sendWelcomeButtons(loginUser.psid);
            }
            if (loginUser.whatsapp && loginUser.whatsapp_connected) {
                await sendWhatsAppMessage(loginUser.whatsapp, loginMsg);
                await sendWhatsAppMenu(loginUser.whatsapp);
            }
        }

        res.json({ success: true });

    } catch (err) {
        console.error('[EcoFin] ❌ Email login error:', err.message);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});


// ─────────────────────────────────────────────────────────────
// A3. Sign Up — Create new account (with email verification)
// ─────────────────────────────────────────────────────────────

app.post('/auth/signup', async (req, res) => {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({ error: 'Name, email and password are required' });
    }
    if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    try {
        const appUrl = process.env.APP_URL || 'https://ecofin-ai-production-f13d.up.railway.app';

        const { data, error: authError } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: { name },
                emailRedirectTo: `${appUrl}/verify.html`,
            }
        });

        if (authError) {
            if (authError.message.toLowerCase().includes('already registered') ||
                authError.message.toLowerCase().includes('already exists')) {
                return res.status(400).json({ error: 'An account with this email already exists.' });
            }
            return res.status(400).json({ error: authError.message });
        }

        const userId = `user_${data.user.id.replace(/-/g, '').slice(0, 12)}`;

        await saveUser(userId, {
            name,
            email,
            facebook_id:         null,
            psid:                null,
            whatsapp:            null,
            waba_id:             null,
            location:            'Philippines',
            total_catches:       0,
            fishing_hours:       0,
            achievements:        0,
            success_rate:        0,
            member_since:        new Date().toLocaleDateString('en-US', {
                month: 'long', year: 'numeric'
            }),
            messenger_connected: false,
            whatsapp_connected:  false,
        });

        console.log(`[EcoFin] ✅ New signup (pending verification): ${email} (${name})`);
        res.json({ success: true, pending: true });

    } catch (err) {
        console.error('[EcoFin] ❌ Sign up error:', err.message);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});


// ─────────────────────────────────────────────────────────────
// A4. Email Verification
// ─────────────────────────────────────────────────────────────

app.get('/auth/verify', (req, res) => {
    res.sendFile(__dirname + '/verify.html');
});


// ─────────────────────────────────────────────────────────────
// B. Facebook OAuth — Step 2: Callback
// ─────────────────────────────────────────────────────────────

// Add a map outside the route to track codes currently being processed
// Keep track of used codes in-memory (or use a Redis store for production)
// Global memory pool to block duplicate codes
// Global memory map to track the status of code processing
// Key: auth_code, Value: 'processing' | 'done'
// Global memory map to track the status of code processing
// Keep track of recently used codes to prevent duplicates

let requestCounter = 0;

// Global cache that stores the ongoing login promise for each code
const activeAuthPromises = new Map();

app.get('/auth/messenger/callback', async (req, res) => {
    const code = req.query.code;
    requestCounter++;
    console.log(`[EcoFin] 🚨 Internal Request Hit Count: #${requestCounter} for code: ${req.query.code}`);

    if (!code) {
        console.warn('[EcoFin] ⚠️ No code received.');
        return res.redirect('/login.html?error=cancelled');
    }

    // ─── CRITICAL STEP: JOIN ONGOING PROMISE ────────────────────────────
    // If request #2 or #3 hits, they stop right here and wait for request #1 to finish.
    if (activeAuthPromises.has(code)) {
    console.log('[EcoFin] 🛑 Request duplicated. Waiting...');
    try {
        const sharedUserData = await activeAuthPromises.get(code);

        req.session.userId = sharedUserData.userId;
        req.session.userName = sharedUserData.name;
        req.session.loggedIn = true;

        return req.session.save(() => res.redirect('/dashboard.html'));
    } catch {
        return res.redirect('/login.html?error=failed');
    }
}

// ✅ STEP 1: CREATE MANUAL PROMISE CONTROL (LOCK IMMEDIATELY)
let resolvePromise, rejectPromise;

const lockPromise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
});

// ✅ STORE LOCK IMMEDIATELY — NO GAP
activeAuthPromises.set(code, lockPromise);

try {
    // ✅ NOW run your main logic safely
    const tokenRes = await axios.get(
        'https://graph.facebook.com/v19.0/oauth/access_token',
        {
            params: {
                client_id: process.env.APP_ID,
                client_secret: process.env.APP_SECRET,
                redirect_uri: process.env.REDIRECT_URI,
                code,
            }
        }
    );

    const accessToken = tokenRes.data.access_token;

    const profileRes = await axios.get(
        'https://graph.facebook.com/me',
        {
            params: {
                access_token: accessToken,
                fields: 'id,name,email'
            }
        }
    );

    const { id: facebookUserId, name, email } = profileRes.data;

    if (!facebookUserId || !name) {
        throw new Error('Invalid FB data');
    }

    console.log(`[EcoFin] 🚀 Main process verified: ${name}`);

    // ✅ DB logic (unchanged)
    let userId;
    const existingUser = await getUserByFacebookId(facebookUserId);

    if (req.session.loggedIn && req.session.userId) {
        userId = req.session.userId;
        await updateUser(userId, { facebook_id: facebookUserId });
    } else if (existingUser) {
        userId = existingUser.id;
        await updateUser(userId, { name, facebook_id: facebookUserId });
    } else {
        userId = `fb_${facebookUserId}`;
        await saveUser(userId, {
            name,
            email: email || '',
            facebook_id: facebookUserId,
            location: 'Philippines',
            total_catches: 0,
            fishing_hours: 0,
            achievements: 0,
            success_rate: 0,
            member_since: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
        });
    }

    const result = { userId, name };

    // ✅ RESOLVE ALL WAITING REQUESTS
    resolvePromise(result);

    // ✅ SET SESSION for request #1
    req.session.userId = userId;
    req.session.userName = name;
    req.session.loggedIn = true;

    console.log(`[EcoFin] ✅ Primary login done: ${name}`);

    return req.session.save(() => res.redirect('/dashboard.html'));

} catch (err) {
    rejectPromise(err);
    console.error('[EcoFin] ❌ OAuth Error:', err.message);
    return res.redirect('/login.html?error=failed');

} finally {
    activeAuthPromises.delete(code);
}
});








// ─────────────────────────────────────────────────────────────
// C. Connect Messenger (after already logged in)
// ─────────────────────────────────────────────────────────────

app.get('/auth/messenger', (req, res) => {
    if (!req.session.loggedIn) return res.redirect('/login.html?error=not_logged_in');

    console.log('[EcoFin] Connect Messenger REDIRECT_URI:', process.env.REDIRECT_URI);

    const params = new URLSearchParams({
        client_id:     process.env.APP_ID,
        redirect_uri:  process.env.REDIRECT_URI,
        scope:         'public_profile',
        response_type: 'code',
        state:         req.session.userId,
    });

    res.redirect(`https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`);
});


// ─────────────────────────────────────────────────────────────
// D. WhatsApp Callback
// ─────────────────────────────────────────────────────────────

app.post('/auth/whatsapp/callback', async (req, res) => {
    const { phone, wabaId, userId, name } = req.body;
    if (!phone) return res.status(400).json({ error: 'No phone number received' });

    try {
        const targetId = userId || req.session.userId;

        if (targetId) {
            await updateUser(targetId, {
                whatsapp:           phone,
                waba_id:            wabaId || '',
                whatsapp_connected: true,
            });
            console.log(`[EcoFin] ✅ WhatsApp linked to ${targetId}: ${phone}`);
        } else {
            await saveUser(`wa_${phone}`, {
                name:                name || 'EcoFin User',
                whatsapp:            phone,
                waba_id:             wabaId || '',
                whatsapp_connected:  true,
                messenger_connected: false,
                total_catches:       0,
                location:            'Philippines',
                member_since:        new Date().toLocaleDateString('en-US', {
                    month: 'long', year: 'numeric'
                }),
            });
            console.log(`[EcoFin] ✅ New WhatsApp user created: ${phone}`);
        }

        res.json({ success: true, phone });
    } catch (err) {
        console.error('[EcoFin] ❌ WhatsApp auth failed:', err.message);
        res.status(500).json({ error: 'Failed to save WhatsApp data' });
    }
});


// ─────────────────────────────────────────────────────────────
// E. Get Current Logged-In User
// ─────────────────────────────────────────────────────────────

app.get('/api/me', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in' });

    try {
        const { data, error } = await supabase
            .from('users')
            .select('*')
            .eq('id', req.session.userId)
            .single();

        if (error || !data) return res.status(404).json({ error: 'User not found' });
        res.json({ id: req.session.userId, ...data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────────
// F. Get Profile Data (by userId)
// ─────────────────────────────────────────────────────────────

app.get('/api/profile/:userId', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('users')
            .select('*')
            .eq('id', req.params.userId)
            .single();

        if (error || !data) return res.status(404).json({ error: 'User not found' });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────────
// G. Get Catches for Logged-In User
// ─────────────────────────────────────────────────────────────

app.get('/api/my-catches', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in' });

    try {
        const catches = await getCatchesByUser(req.session.userId);
        res.json(catches);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────────
// H. Get Catches by userId (generic)
// ─────────────────────────────────────────────────────────────

app.get('/api/catches/:userId', async (req, res) => {
    try {
        const catches = await getCatchesByUser(req.params.userId);
        res.json(catches);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────────
// I. Submit New Catch
// ─────────────────────────────────────────────────────────────

app.post('/api/log-catch', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in' });

    try {
        const catchData = {
            fish:     req.body.fish,
            weight:   req.body.weight,
            size:     req.body.size,
            location: req.body.location,
            source:   req.body.source,
            depth:    req.body.depth,
            date:     new Date().toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric'
            }),
        };

        const catchId = `catch_${Date.now()}`;
        await saveCatch(req.session.userId, catchId, catchData);

        const realCount = await countCatches(req.session.userId);
        await updateUser(req.session.userId, { total_catches: realCount });

        const { data: user } = await supabase
            .from('users')
            .select('*')
            .eq('id', req.session.userId)
            .single();

        if (user.psid)     await handleSystemMessage(user.psid,     'catch', catchData, user);
        if (user.whatsapp) await handleSystemMessage(user.whatsapp, 'catch', catchData, user);

        console.log(`[EcoFin] ✅ Catch logged for ${user.name} (total: ${realCount})`);
        res.json({ success: true, message: 'Catch logged and alerts sent!' });

    } catch (err) {
        console.error('[EcoFin] ❌ Log catch failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────────
// J. Clear All Catches for Logged-In User
// ─────────────────────────────────────────────────────────────

app.delete('/api/clear-catches', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in' });

    try {
        await deleteCatches(req.session.userId);
        await updateUser(req.session.userId, { total_catches: 0 });

        console.log(`[EcoFin] 🗑️ Catches cleared for ${req.session.userId}`);
        res.json({ success: true, message: 'Catch history cleared.' });
    } catch (err) {
        console.error('[EcoFin] ❌ Clear catches failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────────
// L. Update Profile (name + email)
// ─────────────────────────────────────────────────────────────

app.post('/api/update-profile', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in' });

    try {
        const { name, email } = req.body;
        if (!name) return res.status(400).json({ error: 'Name is required' });

        await updateUser(req.session.userId, { name, email: email || '' });
        req.session.userName = name;

        console.log(`[EcoFin] ✅ Profile updated for ${req.session.userId}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[EcoFin] ❌ Profile update failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});


// ─────────────────────────────────────────────────────────────
// K. Logout
// ─────────────────────────────────────────────────────────────

app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login.html');
});


// ─────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`[EcoFin] Server running → http://localhost:${PORT}`);
    console.log(`[EcoFin] REDIRECT_URI on startup: ${process.env.REDIRECT_URI}`);
    console.log(`[EcoFin] APP_ID on startup: ${process.env.APP_ID}`);
});