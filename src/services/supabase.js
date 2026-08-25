const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ─── Save or update a user ────────────────────────────────────
async function saveUser(userId, userData) {
    const { error } = await supabase
        .from('users')
        .upsert({ id: userId, ...userData }, { onConflict: 'id' });
    if (error) throw new Error(error.message);
    console.log(`[Supabase] ✅ User saved: ${userId}`);
}

// ─── Get a user by their Messenger PSID ──────────────────────
async function getUserByPSID(psid) {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('psid', psid)
        .single();
    if (error || !data) return null;
    return data;
}

// ─── Get a user by their WhatsApp number ─────────────────────
async function getUserByWhatsApp(phone) {
    const normalized = phone.replace(/^\+/, '');

    let { data } = await supabase
        .from('users')
        .select('*')
        .eq('whatsapp', normalized)
        .single();

    if (!data) {
        const result = await supabase
            .from('users')
            .select('*')
            .eq('whatsapp', '+' + normalized)
            .single();
        data = result.data;
    }

    return data || null;
}

// ─── Get all catches for a user ───────────────────────────────
async function getCatchesByUser(userId) {
    const { data, error } = await supabase
        .from('catches')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true });
    if (error || !data) return [];
    return data;
}

// ─── Save a webapp-only user (separate from the chatbot `users` table) ──
async function saveWebappUser(id, data) {
    const { error } = await supabase
        .from('webapp_users')
        .upsert({ id, ...data }, { onConflict: 'id' });
    if (error) throw new Error(error.message);
}

// ─── Get a webapp-only user by id ─────────────────────────────
async function getWebappUserById(id) {
    const { data, error } = await supabase
        .from('webapp_users')
        .select('*')
        .eq('id', id)
        .single();
    if (error || !data) return null;
    return data;
}

// ─── Get a webapp-only user by email ──────────────────────────
async function getWebappUserByEmail(email) {
    const { data, error } = await supabase
        .from('webapp_users')
        .select('*')
        .eq('email', email)
        .single();
    if (error || !data) return null;
    return data;
}

// ─── Update a webapp-only user's password hash ────────────────
async function updateWebappUserPassword(email, passwordHash) {
    const { error } = await supabase
        .from('webapp_users')
        .update({ password_hash: passwordHash })
        .eq('email', email);
    if (error) throw new Error(error.message);
}

// ─── Get all catches across all accounts (joined with user info) ──
async function getAllCatches() {
    const { data, error } = await supabase
        .from('catches')
        .select('*, users ( id, name, location, member_since )')
        .order('created_at', { ascending: false });
    if (error || !data) return [];
    return data;
}

// ─── Get a user by Facebook ID ───────────────────────────────
async function getUserByFacebookId(facebookId) {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('facebook_id', facebookId)
        .single();
    if (error || !data) return null;
    return data;
}

// ─── Update a user ────────────────────────────────────────────
async function updateUser(userId, updates) {
    const { error } = await supabase
        .from('users')
        .update(updates)
        .eq('id', userId);
    if (error) throw new Error(error.message);
}

// ─── Save a catch ─────────────────────────────────────────────
async function saveCatch(userId, catchId, catchData) {
    const { error } = await supabase
        .from('catches')
        .insert({ id: catchId, user_id: userId, ...catchData });
    if (error) throw new Error(error.message);
}

// ─── Count catches for a user ─────────────────────────────────
async function countCatches(userId) {
    const { count, error } = await supabase
        .from('catches')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);
    if (error) return 0;
    return count || 0;
}

// ─── Delete all catches for a user ───────────────────────────
async function deleteCatches(userId) {
    const { error } = await supabase
        .from('catches')
        .delete()
        .eq('user_id', userId);
    if (error) throw new Error(error.message);
}

// ─── Delete a user ────────────────────────────────────────────
async function deleteUser(userId) {

    const user = await getUserById(userId);

    if (!user) {
        throw new Error('User not found');
    }

    console.log('Deleting user:', userId);

    // Delete related data first
    await deleteCatches(userId);

    // Delete local user row
    const { error: tableError } = await supabase
        .from('users')
        .delete()
        .eq('id', userId);

    if (tableError) {
        throw new Error(`User delete failed: ${tableError.message}`);
    }

    // Delete from Supabase Auth ONLY if linked
    if (user.auth_id) {

        const { error: authError } =
            await supabase.auth.admin.deleteUser(user.auth_id);

        if (authError) {
            throw new Error(`Auth delete failed: ${authError.message}`);
        }

        console.log('Deleted from Supabase Auth');
    } else {
        console.log('Facebook/custom user deleted locally only');
    }

    return {
        success: true
    };
}

async function getUserById(userId) {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .single();

    if (error) throw new Error(error.message);
    return data;
}

// async function signInWithFacebook() {
//   const { data, error } = await supabase.auth.signInWithOAuth({
//     provider: 'facebook',
//     options: {
//       redirectTo: `${window.location.origin}/dashboard.html`
//     }
//   });

//   if (error) {
//     console.error('Error signing in with Facebook:', error.message);
//     alert('Facebook login failed: ' + error.message);
//     return;
//   }

//   // Supabase will redirect the browser to Facebook
// }

//
module.exports = {
    saveUser,
    getUserByPSID,
    getUserByWhatsApp,
    getUserByFacebookId,
    getCatchesByUser,
    getAllCatches,
    saveWebappUser,
    getWebappUserById,
    getWebappUserByEmail,
    updateWebappUserPassword,
    updateUser,
    saveCatch,
    countCatches,
    deleteCatches,
    deleteUser,
    getUserById,
    supabase
};