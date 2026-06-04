// Initialize Supabase client
const SUPABASE_URL = 'https://gvafoedvirebultoehuk.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd2YWZvZWR2aXJlYnVsdG9laHVrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzcyNDcwODUsImV4cCI6MjA1MjgyMzA4NX0.oDZfBLvRhzFHOUZTLKJPfGgaBhBWBmNsL5GhKkfbCkc';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ✅ Listen to Supabase auth state changes (works for all providers including Facebook)
supabaseClient.auth.onAuthStateChange((event, session) => {
    console.log('[Auth Listener] Auth event:', event);
    console.log('[Auth Listener] Session user:', session?.user?.id);

    if (session) {
        // User is logged in via Supabase
        console.log('[Auth Listener] ✅ User authenticated:', session.user.id);
        console.log('[Auth Listener] Provider:', session.user.app_metadata?.provider);
        
        // Store in session/localStorage
        localStorage.setItem('sb-auth-session', JSON.stringify(session));
        
        // Dispatch event so dashboard can listen and update
        window.dispatchEvent(new CustomEvent('user-authenticated', { 
            detail: session.user 
        }));
        
        // Auto-redirect to dashboard if on login page
        if (window.location.pathname.includes('login') || window.location.pathname === '/') {
            setTimeout(() => {
                window.location.href = '/dashboard.html';
            }, 500);
        }
    } else {
        // User is logged out
        console.log('[Auth Listener] ⚠️ User logged out');
        localStorage.removeItem('sb-auth-session');
        window.dispatchEvent(new CustomEvent('user-logged-out'));
    }
});

// Check initial session on page load
supabaseClient.auth.getSession().then(({ data: { session } }) => {
    if (session) {
        console.log('[Auth Listener] Initial session found for:', session.user.email);
        // Trigger authenticated event
        window.dispatchEvent(new CustomEvent('user-authenticated', { 
            detail: session.user 
        }));
    } else {
        console.log('[Auth Listener] No initial session found');
    }
});
