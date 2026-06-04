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

// // ─── Session Middleware ───────────────────────────────────────
// app.use(session({
//     secret: 'ecofin-secret-key',
//     resave: false,
//     saveUninitialized: false,
//     cookie: { maxAge: 24 * 60 * 60 * 1000 }
// }));

app.set('trust proxy', 1);

app.use(session({
    secret: process.env.SESSION_SECRET || 'ecofin-secret-key',
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
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

app.get('/auth/facebook', (req, res) => {
    console.log('[EcoFin] APP_ID:', process.env.APP_ID);
    console.log('[EcoFin] REDIRECT_URI:', process.env.REDIRECT_URI);

    const params = new URLSearchParams({
        client_id:     process.env.APP_ID,
        redirect_uri:  process.env.REDIRECT_URI,
        scope:         'public_profile,email',
        response_type: 'code',
    });

    res.redirect(`https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`);
});

app.get('/auth/callback', async (req, res) => {
    // 1. Correctly extract the string code
    const code = req.query.code;

    console.log('[EcoFin] Callback REDIRECT_URI:', process.env.REDIRECT_URI);
    console.log('[EcoFin] Code received:', code ? 'YES' : 'NO');

    // if (!code) {
    //     return res.redirect('/login.html?error=no_code');
    // }

    try {
        const tokenRes = await axios.get('https://graph.facebook.com/v19.0/oauth/access_token', {
            params: {
                client_id:     process.env.APP_ID,
                client_secret: process.env.APP_SECRET,
                redirect_uri:  process.env.REDIRECT_URI,
                code,
            }
        });
    
        const accessToken = tokenRes.data.access_token;
        const userRes = await axios.get('https://graph.facebook.com/me', {
            params: {
                fields: 'id,name,email',
                access_token: accessToken,
            }
        });
        const fbUser = userRes.data;

        console.log(`[EcoFin] ✅ Facebook OAuth successful for ${fbUser.name} (${fbUser.id})`);
        
        // 2. Fix variable scope and pass correct FB ID variable
        let user;
        const existingUser = await getUserByFacebookId(fbUser.id); 
        
        if (!existingUser) {
            const userId = `fb_${fbUser.id}`;
            try {
                console.log(`[EcoFin] 🔄 Attempting to create user profile for Facebook user: ${userId}`);
                await saveUser(userId, {
                    name: fbUser.name,
                    email: fbUser.email || '',
                    facebook_id: fbUser.id,
                    location: 'Philippines',
                    total_catches: 0,
                    fishing_hours: 0,
                    achievements: 0,
                    success_rate: 0,
                    member_since: new Date().toLocaleDateString('en-US', {
                        month: 'long', year: 'numeric'
                    }),
                    messenger_connected: true,
                    whatsapp_connected: false,
                });
                console.log(`[EcoFin] ✅ Created user profile for Facebook user: ${userId}`);
            }
            catch (dbErr) {
                console.error('[EcoFin] ❌ Failed to create user profile for Facebook user:', dbErr.message, dbErr);
                return res.redirect('/login.html?error=profile_creation_failed');
            }
            user = await getUserByFacebookId(fbUser.id);
        } else if (existingUser && !existingUser.facebook_id) {
            await updateUser(existingUser.id, { facebook_id: fbUser.id });
            console.log(`[EcoFin] 🔄 Linked Facebook ID to existing user: ${existingUser.id}`);
            user = await getUserByFacebookId(fbUser.id);
        } else {
            user = existingUser;
        }
    
        // 3. Establish session safely
        if (!user) {
            throw new Error("User profile resolution failed.");
        }

        req.session.userId = user.id;
        req.session.userName = user.name;
        req.session.userEmail = user.email || '';
        req.session.loggedIn = true;

        // Save session explicitly before redirecting to prevent race conditions
         res.redirect('/dashboard.html');

    }
    catch (err) {
        console.log('[EcoFin] ❌ Facebook OAuth error:', err.message);
        res.redirect('/login.html?error=oauth_failed');
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

        // Use Supabase user ID as the primary key for consistency
        const userId = data.user.id;

        // Check if user profile exists in custom users table
        const { data: userData } = await supabase
            .from('users')
            .select('*')
            .eq('id', userId)
            .single();

        if (!userData) {
            // User profile doesn't exist yet - create it
            const name = data.user.user_metadata?.name || email.split('@')[0];
            try {
                console.log(`[EcoFin] 🔄 Attempting to create user profile during login: ${userId}`);
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
                console.log(`[EcoFin] ✅ Created user profile during login: ${userId}`);
            } catch (dbErr) {
                console.error('[EcoFin] ❌ Failed to create user profile during login:', dbErr.message, dbErr);
                // Continue with session - user exists in auth system
            }
        }

    req.session.userId   = userId;
    req.session.userName = userData?.name || data.user.user_metadata?.name || email.split('@')[0];
    req.session.userEmail = email;
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
                emailRedirectTo: `${appUrl}/auth/verify-callback`,
            }
        });

        if (authError) {
            if (authError.message.toLowerCase().includes('already registered') ||
                authError.message.toLowerCase().includes('already exists')) {
                return res.status(400).json({ error: 'An account with this email already exists.' });
            }
            return res.status(400).json({ error: authError.message });
        }

        // Use Supabase user ID as the primary key for consistency
        const userId = data.user.id;

        try {
            console.log(`[EcoFin] 🔄 Attempting to save user profile during signup: ${userId}`);
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
            console.log(`[EcoFin] ✅ User profile saved during signup: ${userId}`);
        } catch (dbErr) {
            console.error('[EcoFin] ❌ Failed to save user profile during signup:', dbErr.message, dbErr);
            // Don't fail the entire signup - user can still verify and login
        }

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

app.get('/auth/verify-callback', async (req, res) => {
    // Supabase sends the token in the hash after email verification
    // The browser will have the session token, but we need to establish it server-side
    try {
        const { data: { session }, error } = await supabase.auth.getSession();
        
        if (error || !session) {
            console.error('[EcoFin] ⚠️ No session after email verification');
            // Redirect to login with a message
            return res.redirect('/login.html?verified=true');
        }

        const user = session.user;
        const userId = user.id;

        // Ensure user profile exists
        const { data: userData } = await supabase
            .from('users')
            .select('*')
            .eq('id', userId)
            .single();

        if (!userData) {
            // Create user profile if it doesn't exist
            const name = user.user_metadata?.name || user.email.split('@')[0];
            try {
                console.log(`[EcoFin] 🔄 Attempting to create user profile after email verification: ${userId}`);
                await saveUser(userId, {
                    name,
                    email: user.email,
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
                console.log(`[EcoFin] ✅ Created user profile after email verification: ${userId}`);
            } catch (dbErr) {
                console.error('[EcoFin] ❌ Failed to create user profile after verification:', dbErr.message, dbErr);
            }
        }

        // Establish server-side session
        req.session.userId = userId;
        req.session.userName = userData?.name || user.user_metadata?.name || user.email.split('@')[0];
        req.session.userEmail = user.email;
        req.session.loggedIn = true;

        req.session.save((err) => {
            if (err) {
                console.error('[EcoFin] ❌ Session save error during verification:', err);
                return res.redirect('/login.html?error=session_failed');
            }
            console.log(`[EcoFin] ✅ Session established after email verification: ${userId}`);
            res.redirect('/dashboard.html');
        });

    } catch (err) {
        console.error('[EcoFin] ❌ Email verification error:', err.message);
        res.redirect('/login.html?error=verification_failed');
    }
});


// ─────────────────────────────────────────────────────────────
// E. Get Current Logged-In User
// ─────────────────────────────────────────────────────────────

app.get('/api/me', async (req, res) => {
    console.log('SESSION:', req.session);

    
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
// app.get('/api/me', async (req, res) => {
//     if (!req.session.loggedIn) return res.status(401).json({ error: 'Not logged in' });

//     try {
//         // Query the Supabase internal auth management system instead of a custom table
//         const { data: { user }, error } = await supabase.auth.admin.getUserById(req.session.userId);

//         if (error || !user) {
//             return res.status(404).json({ error: 'User not found in authentication records' });
//         }

//         // Returns the full Supabase Auth user object (metadata, email, provider data, etc.)
//         res.json(user);
//     } catch (err) {
//         res.status(500).json({ error: err.message });
//     }
// });


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