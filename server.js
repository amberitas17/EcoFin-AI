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
    deleteUser,
    supabase
} = require('./src/services/supabase');
const { handleSystemMessage, sendMessengerMessage, sendWhatsAppMessage, sendWelcomeButtons, sendWhatsAppMenu } = require('./src/services/messengerService');
// const { createClient } = require('@supabase/supabase-js');

// const supabase = createClient(
//     process.env.SUPABASE_URL,
//     process.env.SUPABASE_SERVICE_KEY
// );

const app = express();

app.use(bodyParser.json());
app.use(express.static(__dirname));

// ─── Session Middleware ───────────────────────────────────────
app.use(session({
    secret: 'ecofin-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: true,        // ✅ REQUIRED on Render (HTTPS)
        httpOnly: true,
        sameSite: 'none'     // ✅ REQUIRED for OAuth
    }
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

// app.get('/auth/facebook', (req, res) => {
//     console.log('[EcoFin] APP_ID:', process.env.APP_ID);
//     console.log('[EcoFin] REDIRECT_URI:', process.env.REDIRECT_URI);

//     const params = new URLSearchParams({
//         client_id:     process.env.APP_ID,
//         redirect_uri:  process.env.REDIRECT_URI,
//         // scope:         'email,public_profile',
//         config_id:     '983035217405408',
//         response_type: 'code',
//         override_default_response_type: 'true'
//     });

//     res.redirect(`https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`);
// });
// app.get('/auth/facebook', (req, res) => {
//     console.log('[EcoFin] APP_ID:', process.env.APP_ID);
//     console.log('[EcoFin] REDIRECT_URI:', process.env.REDIRECT_URI);

//     const params = new URLSearchParams({
//         client_id: process.env.APP_ID,
//         redirect_uri: process.env.REDIRECT_URI,
//         scope: 'public_profile,email',
//         response_type: 'code'
//     });

//     const facebookUrl = `https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`;
//     console.log('[EcoFin] Facebook Login URL:', facebookUrl);

//     res.redirect(facebookUrl);
// });

// app.get('/auth/facebook', async (req, res) => {
//   try {
//     const { data, error } = await supabase.auth.signInWithOAuth({
//       provider: 'facebook',
//       options: {
//         redirectTo: 'https://ecofin-ai.onrender.com/auth/callback'
//       }
//     });

//     if (error) {
//       console.error('[EcoFin] Supabase OAuth error:', error.message);
//       return res.status(500).send(error.message);
//     }

//     return res.redirect(data.url);
//   } catch (err) {
//     console.error('[EcoFin] Facebook login route failed:', err);
//     return res.status(500).send('OAuth failed');
//   }
// });

app.get('/auth/facebook', (req, res) => {
  console.log('[EcoFin] APP_ID:', process.env.APP_ID);
  console.log('[EcoFin] REDIRECT_URI:', process.env.REDIRECT_URI);

  const params = new URLSearchParams({
    client_id: process.env.APP_ID,
    redirect_uri: process.env.REDIRECT_URI,
    scope: 'public_profile,email',
    response_type: 'code'
  });

  const facebookUrl = `https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`;
  console.log('[EcoFin] Facebook OAuth URL:', facebookUrl);

  res.redirect(facebookUrl);
});

app.get('/auth/facebook/callback', async (req, res) => {
    const code = req.query.code;

    console.log('[EcoFin] Callback REDIRECT_URI:', process.env.REDIRECT_URI);
    console.log('[EcoFin] Code received:', code ? 'YES' : 'NO');

    if (!code) {
        console.warn('[EcoFin] ⚠️ No code received — user may have cancelled login');
        return res.redirect('/login.html?error=cancelled');
    }

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
        const { id: facebookUserId, name, email, picture } = profileRes.data;

        console.log(`[EcoFin] ✅ Facebook login: ${name} (${facebookUserId})`);

        // ── Retrieve PSID using user's access token ───────────
        let psid = '';
        try {
            const psidRes = await axios.get(
                `https://graph.facebook.com/v19.0/${facebookUserId}`,
                { params: { fields: 'id, email, picture', access_token: accessToken } }
            );
            psid = psidRes.data?.id?.data?.[0]?.id || '';
            if (psid) {
                console.log(`[EcoFin] ✅ PSID retrieved: ${psid}`);
            } else {
                // Fallback: use facebook user ID as PSID
                psid = facebookUserId;
                console.log(`[EcoFin] ℹ️ Using facebookUserId as PSID: ${psid}`);
            }
        } catch (psidErr) {
            console.warn('[EcoFin] ⚠️ Could not retrieve PSID:', psidErr.response?.data || psidErr.message);
            // Fallback: use facebook user ID as PSID
            psid = facebookUserId;
            console.log(`[EcoFin] ℹ️ Using facebookUserId as PSID fallback: ${psid}`);
        }

        const existingUser = await getUserByFacebookId(facebookUserId);
        let userId;

        // If already logged in (email user connecting Messenger)
        if (req.session.loggedIn && req.session.userId) {
            userId = req.session.userId;
            await updateUser(userId, {
                facebook_id:         facebookUserId,
                psid:                psid || '',
                messenger_connected: !!psid,
                email:               email || '',
            });
            console.log(`[EcoFin] ✅ Messenger linked to existing user: ${userId}`);
        } else if (existingUser) {
            userId = existingUser.id;
            await updateUser(userId, {
                name,
                facebook_id:         facebookUserId,
                psid:                psid || existingUser.psid || '',
                messenger_connected: !!psid,
                email:               email || '',
            });
            console.log(`[EcoFin] ✅ Existing Facebook user updated: ${userId}`);
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
            console.log(`[EcoFin] ✅ New Facebook user created: ${userId}`);
        }

        req.session.userId   = userId;
        req.session.userName = name;
        req.session.loggedIn = true;

        // ── Send login notification to Messenger and/or WhatsApp ──
        const fbLoginMsg = `👋 Hi ${name}! You've just logged in to EcoFin AI.`;
        if (psid) {
            await sendMessengerMessage(psid, fbLoginMsg);
            await sendWelcomeButtons(psid);
        }

        const { data: fbUserData } = await supabase.from('users').select('*').eq('id', userId).single();
        if (fbUserData?.whatsapp && fbUserData?.whatsapp_connected) {
            await sendWhatsAppMessage(fbUserData.whatsapp, fbLoginMsg);
            await sendWhatsAppMenu(fbUserData.whatsapp);
        }

        // res.redirect('/dashboard.html');

        
        req.session.save(() => {
            console.log('[EcoFin] ✅ Session saved:', req.session);
            res.redirect('/dashboard.html');
        });


    } catch (err) {
        console.error('[EcoFin] ❌ Facebook OAuth failed:', err.response?.data || err.message);
        res.redirect('/login.html?error=failed');
        console.error('[EcoFin FULL ERROR]', err.response?.data);
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

// app.get('/auth/callback', (req, res) => {
//   res.redirect('/dashboard.html');
// });


// ─────────────────────────────────────────────────────────────
// B. Facebook OAuth — Step 2: Callback
// ─────────────────────────────────────────────────────────────

app.get('/auth/messenger/callback', async (req, res) => {
    const code = req.query.code;

    console.log('[EcoFin] Callback REDIRECT_URI:', process.env.REDIRECT_URI);
    console.log('[EcoFin] Code received:', code ? 'YES' : 'NO');

    if (!code) {
        console.warn('[EcoFin] ⚠️ No code received — user may have cancelled login');
        return res.redirect('/login.html?error=cancelled');
    }

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
            params: { access_token: accessToken, fields: 'id,name' }
        });
        const { id: facebookUserId, name } = profileRes.data;

        console.log(`[EcoFin] ✅ Facebook login: ${name} (${facebookUserId})`);

        // ── Retrieve PSID using user's access token ───────────
        let psid = '';
        try {
            const psidRes = await axios.get(
                `https://graph.facebook.com/v19.0/${facebookUserId}`,
                { params: { fields: 'ids_for_pages', access_token: accessToken } }
            );
            psid = psidRes.data?.ids_for_pages?.data?.[0]?.id || '';
            if (psid) {
                console.log(`[EcoFin] ✅ PSID retrieved: ${psid}`);
            } else {
                // Fallback: use facebook user ID as PSID
                psid = facebookUserId;
                console.log(`[EcoFin] ℹ️ Using facebookUserId as PSID: ${psid}`);
            }
        } catch (psidErr) {
            console.warn('[EcoFin] ⚠️ Could not retrieve PSID:', psidErr.response?.data || psidErr.message);
            // Fallback: use facebook user ID as PSID
            psid = facebookUserId;
            console.log(`[EcoFin] ℹ️ Using facebookUserId as PSID fallback: ${psid}`);
        }

        const existingUser = await getUserByFacebookId(facebookUserId);
        let userId;

        // If already logged in (email user connecting Messenger)
        if (req.session.loggedIn && req.session.userId) {
            userId = req.session.userId;
            await updateUser(userId, {
                facebook_id:         facebookUserId,
                psid:                psid || '',
                messenger_connected: !!psid,
            });
            console.log(`[EcoFin] ✅ Messenger linked to existing user: ${userId}`);
        } else if (existingUser) {
            userId = existingUser.id;
            await updateUser(userId, {
                name,
                facebook_id:         facebookUserId,
                psid:                psid || existingUser.psid || '',
                messenger_connected: !!psid,
            });
            console.log(`[EcoFin] ✅ Existing Facebook user updated: ${userId}`);
        } else {
            userId = `fb_${facebookUserId}`;
            await saveUser(userId, {
                name,
                email:               '',
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
            console.log(`[EcoFin] ✅ New Facebook user created: ${userId}`);
        }

        req.session.userId   = userId;
        req.session.userName = name;
        req.session.loggedIn = true;

        // ── Send login notification to Messenger and/or WhatsApp ──
        const fbLoginMsg = `👋 Hi ${name}! You've just logged in to EcoFin AI.`;
        if (psid) {
            await sendMessengerMessage(psid, fbLoginMsg);
            await sendWelcomeButtons(psid);
        }

        const { data: fbUserData } = await supabase.from('users').select('*').eq('id', userId).single();
        if (fbUserData?.whatsapp && fbUserData?.whatsapp_connected) {
            await sendWhatsAppMessage(fbUserData.whatsapp, fbLoginMsg);
            await sendWhatsAppMenu(fbUserData.whatsapp);
        }

        res.redirect('/dashboard.html');

    } catch (err) {
        console.error('[EcoFin] ❌ Facebook OAuth failed:', err.response?.data || err.message);
        res.redirect('/login.html?error=failed');
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
        // scope:         'public_profile',
        config_id:     '983035217405408',
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
    console.log('[EcoFin] SESSION CHECK:', req.session);
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
// 
// ─────────────────────────────────────────────────────────────
// app.get('/auth/facebook-signin', async (req, res) => {
//     try {
//         const redirectTo = `${req.protocol}://${req.get('host')}/dashboard.html`;

//         const { data, error } = await supabase.auth.signInWithOAuth({
//             provider: 'facebook',
//             options: {
//                 redirectTo
//             }
//         });

//         if (error) {
//             console.error('Facebook OAuth error:', error.message);
//             return res.redirect('/signup.html?error=facebook_oauth');
//         }

//         return res.redirect(data.url);
//     } catch (err) {
//         console.error('Facebook OAuth server error:', err.message);
//         return res.redirect('/signup.html?error=server');
//     }
// });

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