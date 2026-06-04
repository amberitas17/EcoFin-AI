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
    resave: true,
    saveUninitialized: false,
    rolling: true,
    proxy: true,
    cookie: {
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
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


app.get('/auth/facebook', async (req, res) => {
    const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'facebook',
        options: {
            redirectTo: process.env.REDIRECT_URI // e.g. https://yourapp.com/auth/callback
        }
    });

    if (error) {
        console.error('OAuth error:', error.message);
        return res.redirect('/login.html?error=oauth');
    }

    return res.redirect(data.url);
});

app.get('/auth/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/login.html?error=missing_code');

    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
        console.error('Auth error:', error.message);
        return res.redirect('/login.html?error=auth_failed');
    }

    const user = data.user;

    const facebookId =
        user.identities?.[0]?.identity_data?.id || null;

    const userId = `fb_${facebookId || user.id}`;

    console.log('OAuth USER:', user);

    const { error: dbError } = await supabase
        .from('users')
        .upsert({
            id: userId,
            name: user.user_metadata?.full_name || user.user_metadata?.name,
            email: user.email,
            facebook_id: facebookId,
            psid: null,
            whatsapp: null,
            waba_id: null,
            fishing_hours: 0,
            achievements: 0,
            success_rate: 0,
            location: 'Philippines',
            total_catches: 0
        });

    if (dbError) {
        console.error('DATABASE ERROR:', dbError);
    } else {
        console.log('✅ User saved to DB');
    }

    req.session.userId = userId;
    req.session.loggedIn = true;

    await new Promise(resolve => req.session.save(resolve));

    res.redirect('/dashboard.html');
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
    console.log('SESSION:', req.session);

    if (!req.session?.loggedIn) {
        return res.status(401).json({ error: 'Not logged in' });
    }

    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', req.session.userId)
        .single();

    if (error || !data) {
        return res.status(404).json({ error: 'User not found' });
    }

    res.json(data);
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