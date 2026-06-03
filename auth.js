// auth.js — Include this in every HTML page
// It checks if user is logged in and returns their data
 
// async function requireLogin() {
//   try {
//     const res = await fetch('/api/me');
//     if (!res.ok) {
//       window.location.href = '/login.html';
//       return null;
//     }
//     return await res.json();
//   } catch (err) {
//     window.location.href = '/login.html';
//     return null;
//   }
// }
async function requireLogin() {
  try {
    // CRITICAL: You must include credentials: 'include' 
    // to pass the cross-site session cookie to your server!
    const res = await fetch('/api/me', { credentials: 'include' });
    
    if (!res.ok) {
      window.location.href = '/login.html';
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error('Auth check failed:', err);
    window.location.href = '/login.html';
    return null;
  }
}