require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const session = require('express-session');
const cors = require('cors');
const cookieParser = require('cookie-parser');



const webhookRoute = require('./src/routes/webhook');
const {
    saveUser,
    getUserByFacebookId,
    getCatchesByUser,
    updateUser,
    saveCatch,
    countCatches,
    deleteCatches,
    deleteUser,
    supabase
} = require('./src/services/supabase');

const queryString = require('querystring'); // Add this line at the top

const app = express();

// ─── CORS Setup (Allow Credentials) ───────────────
app.use(cors({
    origin: process.env.APP_URL || 'https://ecofin-ai.onrender.com',
    credentials: true,
}));

app.use(bodyParser.json());
app.set('trust proxy', true); // Trust first proxy for secure cookies
app.use(cookieParser('ecofin-secret-key')); // Use the exact same secret here
app.use(session({
    name: 'ecofin.sid',
    secret: 'ecofin-secret-key',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: true,
    cookie: {
        secure: true,
        httpOnly: true,
        sameSite: 'none',
        maxAge: 24 * 60 * 60 * 1000 // 1 day expiration
    }
}));
app.use(express.static(__dirname));



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
app.get('/dashboard.html', (req, res) => {
    res.sendFile(__dirname + '/dashboard.html');
});


app.get('/auth/facebook', (req, res) => {
    // CRITICAL: Force the browser to completely ignore its cache for this request
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const stringifiedParams = queryString.stringify({
        client_id: process.env.APP_ID,
        redirect_uri: process.env.REDIRECT_URI,
        scope: ['public_profile', 'email'].join(','),
        response_type: 'code',
        auth_type: 'rerequest', // Forces a fresh authorization block
        display: 'popup'
    });

    const facebookLoginUrl = `https://www.facebook.com/v19.0/dialog/oauth?${stringifiedParams}`;
    res.redirect(facebookLoginUrl);
});
// 1. Put this memory cache near the top of your server file (outside the routes)
const processedCodes = new Map();

// Clean up memory leaks by wiping old codes after 10 seconds
setInterval(() => {
    const now = Date.now();
    for (const [code, timestamp] of processedCodes.entries()) {
        if (now - timestamp > 10000) processedCodes.delete(code);
    }
}, 10000);

// ... your other code ...

app.get('/auth/facebook/callback', async (req, res) => {
    console.log('================================');
    console.log('FACEBOOK CALLBACK HIT');
    console.log('TIME:', new Date().toISOString());
    console.log('CODE:', req.query.code);
    console.log('================================');

    const code = req.query.code;
    let facebookUserId = null;
    let name = null;

    if (!code) {
        console.warn('[EcoFin] ⚠️ No code received — user may have cancelled login');
        return res.redirect('/login.html?error=cancelled');
    }

        // 1. CRITICAL CONCURRENCY LOCK: Check and lock immediately!
    if (processedCodes.has(code)) {
        console.log(`[EcoFin] 🛡️ Duplicate callback blocked`);

        // ✅ wait for original request to finish writing session
        return setTimeout(() => {
            if (req.session && req.session.userId) {
                req.session.loggedIn = true;
            }

            req.session.save((err) => {
                if (err) console.error('[EcoFin] Session save error (race path):', err);

                res.setHeader('Cache-Control', 'no-store');
                return res.redirect('/dashboard.html');
            });
        }, 150);
    }


    // 2. Lock it right here BEFORE any asynchronous database or API calls can execute
    processedCodes.set(code, Date.now());

    if (req.session && (req.session.loggedIn || req.session.userId)) {
        console.log(`[EcoFin] 🚀 Session already exists for ${req.session.userId}. Bypassing exchange.`);
        return req.session.save(() => {
            res.redirect('/dashboard.html');
        });
    }

    console.log('[EcoFin] Callback REDIRECT_URI:', process.env.REDIRECT_URI);
    console.log('[EcoFin] Code received: YES');

    try {
        const tokenRes = await axios.get(
            'https://graph.facebook.com/v19.0/oauth/access_token',
            {
                params: {
                    client_id:     process.env.APP_ID,
                    client_secret: process.env.APP_SECRET,
                    redirect_uri:  process.env.REDIRECT_URI,
                    code,
                }
            }
        );
        const accessToken = tokenRes.data.access_token;

        const profileRes = await axios.get('https://graph.facebook.com/me', {
            params: { access_token: accessToken, fields: 'id,name,email,picture' }
        });
        
        facebookUserId = profileRes.data.id;
        name = profileRes.data.name;
        const email = profileRes.data.email;

        console.log(`[EcoFin] ✅ Facebook login: ${name} (${facebookUserId})`);

        let psid = '';
        try {
            const psidRes = await axios.get(
                `https://graph.facebook.com/v19.0/${facebookUserId}`,
                { params: { fields: 'id, email, picture', access_token: accessToken } }
            );
            psid = psidRes.data?.id?.data?.[0]?.id || '';
        } catch (psidErr) {
            psid = facebookUserId;
        }

        const existingUser = await getUserByFacebookId(facebookUserId);
        let userId;

        if (req.session.loggedIn && req.session.userId) {
            userId = req.session.userId;
            await updateUser(userId, {
                facebook_id:         facebookUserId,
                psid:                psid || '',
                messenger_connected: !!psid,
                email:               email || '',
            });
        } else if (existingUser) {
            userId = existingUser.id;
            await updateUser(userId, {
                name,
                facebook_id:         facebookUserId,
                psid:                psid || existingUser.psid || '',
                messenger_connected: !!psid,
                email:               email || '',
            });
        } else {
            userId = `fb_${facebookUserId}`;
            await saveUser(userId, {
                name,
                email:               email || '',
                facebook_id:         facebookUserId,
                psid:                psid || '',
                whatsapp:            '',
                location:            'Philippines',
                total_catches:       0,
                fishing_hours:       0,
                achievements:        0,
                success_rate:        0,
                member_since:        new Date().toLocaleDateString('en-US', {
                    month: 'long', year: 'numeric'
                }),
                messenger_connected: !!psid,
                whatsapp_connected:  false,
            });
        }

        // 3. Session attributes setup
        req.session.userId   = userId;
        req.session.userName = name;
        req.session.loggedIn = true;

        req.session.save((saveErr) => {
            if (saveErr) {
                console.error('[EcoFin] Session save error:', saveErr);
                return res.redirect('/login.html?error=session');
            }

            console.log('✅ SESSION AFTER SAVE:', req.session);

            // ✅ prevent caching issues
            res.setHeader('Cache-Control', 'no-store');
            return res.redirect('/dashboard.html');
        });

    } catch (err) {
        const errorData = err.response?.data?.error || {};
        
        // Secondary fallback checking
        if (errorData.code === 100 && errorData.error_subcode === 36009) {
            console.log('[EcoFin] ℹ️ Handled consumed token on fallback interceptor. Retaining session and redirecting.');
            
            if (facebookUserId) {
                req.session.userId = `fb_${facebookUserId}`;
                req.session.loggedIn = true;
            }

            return req.session.save(() => {
                res.redirect('/dashboard.html');
            });
        }

        console.error('[EcoFin] ❌ Facebook OAuth failed:', err.response?.data || err.message);
        res.redirect('/login.html?error=failed');
    }
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

    console.log(`[EcoFin] ✅ Session initialized for ${userId}`);

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

    // Wrap your JSON response so it waits for the session to save on Render
    req.session.save((err) => {
        if (err) {
            console.error('[EcoFin] ❌ Session save error:', err);
            return res.status(500).json({ error: 'Failed to save login session' });
        }
        console.log(`[EcoFin] ✅ Session successfully persisted for ${userId}`);
        res.json({ success: true });
    });

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
        const appUrl = process.env.APP_URL || 'https://ecofin-ai.onrender.com';

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
// E. Get Current Logged-In User
// ─────────────────────────────────────────────────────────────

app.get('/api/me', async (req, res) => {
    
    console.log('[EcoFin] SESSION CHECK:', req.session);
    console.log('[EcoFin] COOKIES:', req.headers.cookie); // ✅ ADD THIS

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
        console.log(`[EcoFin] Retrieved ${catches.length} catches for user ${req.session.userId}`);
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
// M. Delete Account
// ─────────────────────────────────────────────────────────────
app.delete('/api/delete-user', async (req, res) => {
    try {
        console.log('DELETE /api/delete-user hit');
        console.log('Session userId:', req.session.userId);

        const result = await deleteUser(req.session.userId);

        req.session.destroy(err => {
            if (err) {
                console.error('Session destroy failed:', err);
                return res.status(500).json({ error: 'Failed to clear session' });
            }

            res.clearCookie('connect.sid');
            return res.json({
                success: true,
                message: 'User account deleted successfully.',
                result
            });
        });
    } catch (err) {
        console.error('❌ DELETE USER ROUTE ERROR:', err);
        return res.status(500).json({
            error: err.message,
            stack: err.stack
        });
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