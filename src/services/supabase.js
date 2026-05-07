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
    // 1. Get the user row first so we can access auth_id
    const user = await getUserById(userId);

    if (!user) {
        throw new Error('User not found');
    }

    if (!user.auth_id) {
        throw new Error('Missing auth_id for this user');
    }

    if (!user.auth_id || user.facebook_id) {
        const user = await getUserById(appUserId);

        if (!user) {
            throw new Error('User not found');
        }

        console.log('Deleting app user:', appUserId);

        // delete dependent data
        await deleteCatches(appUserId);

        // delete local user row only
        const { error } = await supabase
            .from('users')
            .delete()
            .eq('id', appUserId);

        if (error) {
            throw new Error(`User delete failed: ${error.message}`);
        }

        return {
            success: true,
            deletedFromAuth: false,
            hadFacebookId: !!user.facebook_id
        };
    }
    // 2. Delete from your public users table
    const { error: tableError } = await supabase
        .from('users')
        .delete()
        .eq('id', userId);

    if (tableError) throw new Error(tableError.message);

    // 3. Delete from Supabase Auth using the real auth UUID
    const { error: authError } = await supabase.auth.admin.deleteUser(user.auth_id);

    if (authError) throw new Error(authError.message);
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
    updateUser,
    saveCatch,
    countCatches,
    deleteCatches,
    deleteUser,
    getUserById,
    supabase
};