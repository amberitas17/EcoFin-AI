(function () {
    const IDENTITY_STORAGE_KEY = 'ecofin_webapp_user';
    let identityMode = 'login';
    let signedOut = false;
    const EXPORT_COLUMNS = [
        { header: 'Angler', value: (c) => c.users?.name || 'Unknown angler' },
        { header: 'Account Location', value: (c) => c.users?.location },
        { header: 'Species', value: (c) => c.fish },
        { header: 'Weight', value: (c) => c.weight },
        { header: 'Size', value: (c) => c.size },
        { header: 'Source', value: (c) => c.source },
        { header: 'Catch Location', value: (c) => c.location },
        { header: 'Depth', value: (c) => c.depth },
        { header: 'Date', value: (c) => c.date }
    ];
    let allCatches = [];
    let currentCatches = [];
    let aggregateTopLocation = '--';

    function escapeHtml(str) {
        return String(str ?? '--').replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    async function loadCatches() {
        try {
            const res = await fetch('/api/all-catches');
            if (!res.ok) throw new Error('Request failed');
            const data = await res.json();
            allCatches = Array.isArray(data) ? data : [];
        } catch (err) {
            allCatches = [];
            document.getElementById('catchTableBody').innerHTML =
                '<tr><td colspan="9" class="empty-row">Could not load catch data. Please try again later.</td></tr>';
        }
        renderStats(allCatches);
        await initIdentity();
    }

    // Collapses "Malolos, Bulacan, Philippines" and "Bulacan, Philippines" down to "Bulacan"
    // (the province/state segment, second-to-last comma part).
    function extractRegion(location) {
        const parts = location.split(',').map((p) => p.trim()).filter(Boolean);
        return parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    }

    // Removes every option except "All Locations", so no other user's location can show up
    function clearLocationOptions() {
        const select = document.getElementById('locationSelect');
        [...select.options].forEach((o) => { if (o.value) o.remove(); });
    }

    // Restores a previously-saved webapp_users identity, or shows the sign-in form
    async function initIdentity() {
        const stored = localStorage.getItem(IDENTITY_STORAGE_KEY);

        if (stored) {
            try {
                const { id } = JSON.parse(stored);
                const res = await fetch(`/api/webapp-users/${id}`);
                if (res.ok) {
                    const user = await res.json();
                    signedOut = false;
                    showIdentityBanner(user);
                    applyLocationFilter(user.location);
                    setTopLocationDisplay(extractRegion(user.location));
                    return;
                }
            } catch {
                // fall through to the sign-in form
            }
            localStorage.removeItem(IDENTITY_STORAGE_KEY);
        }

        signedOut = true;
        showIdentityForm();
        applyFilters();
    }

    function showIdentityForm() {
        document.getElementById('identityForm').hidden = false;
        document.getElementById('identityBanner').hidden = true;
    }

    function showIdentityError(message) {
        document.getElementById('identitySuccess').hidden = true;
        const error = document.getElementById('identityError');
        error.textContent = message;
        error.hidden = false;
    }

    function showIdentitySuccess(message) {
        document.getElementById('identityError').hidden = true;
        const success = document.getElementById('identitySuccess');
        success.textContent = message;
        success.hidden = false;
    }

    function isValidEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
    }

    // Switches the identity form between Log In, Sign Up and Forgot Password, toggling
    // the name/location/confirm-password fields that only apply to certain modes.
    function setIdentityMode(mode) {
        identityMode = mode;
        document.getElementById('identityError').hidden = true;
        document.getElementById('identitySuccess').hidden = true;
        document.getElementById('identityTabs').hidden = mode === 'forgot';
        document.getElementById('tabLogin').classList.toggle('active', mode === 'login');
        document.getElementById('tabSignup').classList.toggle('active', mode === 'signup');
        document.getElementById('identityName').hidden = mode !== 'signup';
        document.getElementById('identityLocation').hidden = mode !== 'signup';
        document.getElementById('identityConfirmPassword').hidden = mode !== 'forgot';
        document.getElementById('identityPassword').placeholder = mode === 'forgot' ? 'New password' : 'Password';
        document.getElementById('identityLabel').textContent = mode === 'forgot'
            ? 'Enter your account email and a new password:'
            : 'Sign in with your email so we can show catches near you:';
        document.getElementById('identityForgotLink').textContent = mode === 'forgot' ? 'Back to Log In' : 'Forgot password?';
        document.getElementById('identitySubmit').textContent =
            mode === 'signup' ? 'Sign Up' : mode === 'forgot' ? 'Reset Password' : 'Log In';
    }

    function showIdentityBanner(user) {
        document.getElementById('identityForm').hidden = true;
        document.getElementById('identityBanner').hidden = false;
        document.getElementById('identityBannerText').textContent =
            `Showing catches near ${user.name} — ${user.location}`;
    }

    // Sets the dropdown to contain only the signed-up user's own region — no one else's
    function applyLocationFilter(location) {
        const region = extractRegion(location);
        const select = document.getElementById('locationSelect');
        clearLocationOptions();
        const option = document.createElement('option');
        option.value = region;
        option.textContent = region;
        select.appendChild(option);
        select.value = region;
        applyFilters();
    }

    async function handleIdentitySubmit() {
        if (identityMode === 'forgot') return handleForgotPassword();

        const name = document.getElementById('identityName').value.trim();
        const email = document.getElementById('identityEmail').value.trim();
        const password = document.getElementById('identityPassword').value;
        const location = document.getElementById('identityLocation').value.trim();
        const error = document.getElementById('identityError');
        error.hidden = true;

        if (!email || !isValidEmail(email)) {
            showIdentityError('Please enter a valid email address.');
            return;
        }
        if (!password || password.length < 6) {
            showIdentityError('Password must be at least 6 characters.');
            return;
        }
        if (identityMode === 'signup' && (!name || !location)) {
            showIdentityError('Please enter your full name and location.');
            return;
        }

        const endpoint = identityMode === 'signup' ? '/api/webapp-auth/signup' : '/api/webapp-auth/login';
        const body = identityMode === 'signup' ? { name, email, password, location } : { email, password };

        const submitBtn = document.getElementById('identitySubmit');
        submitBtn.disabled = true;

        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok) {
                showIdentityError(data.error || 'Something went wrong. Please try again.');
                return;
            }

            localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify({ id: data.id }));
            signedOut = false;
            showIdentityBanner(data);
            applyLocationFilter(data.location);
            setTopLocationDisplay(extractRegion(data.location));
        } catch {
            showIdentityError('Could not reach the server. Please try again.');
        } finally {
            submitBtn.disabled = false;
        }
    }

    // Resets a webapp_users account's password_hash via email, no old password required
    async function handleForgotPassword() {
        const email = document.getElementById('identityEmail').value.trim();
        const newPassword = document.getElementById('identityPassword').value;
        const confirmPassword = document.getElementById('identityConfirmPassword').value;

        if (!email || !isValidEmail(email)) {
            showIdentityError('Please enter a valid email address.');
            return;
        }
        if (!newPassword || newPassword.length < 6) {
            showIdentityError('New password must be at least 6 characters.');
            return;
        }
        if (newPassword !== confirmPassword) {
            showIdentityError('Passwords do not match.');
            return;
        }

        const submitBtn = document.getElementById('identitySubmit');
        submitBtn.disabled = true;

        try {
            const res = await fetch('/api/webapp-auth/forgot-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, newPassword })
            });
            const data = await res.json();
            if (!res.ok) {
                showIdentityError(data.error || 'Something went wrong. Please try again.');
                return;
            }

            document.getElementById('identityPassword').value = '';
            document.getElementById('identityConfirmPassword').value = '';
            setIdentityMode('login');
            showIdentitySuccess('Password updated. You can now log in.');
        } catch {
            showIdentityError('Could not reach the server. Please try again.');
        } finally {
            submitBtn.disabled = false;
        }
    }

    function handleIdentityChange() {
        localStorage.removeItem(IDENTITY_STORAGE_KEY);
        document.getElementById('identityName').value = '';
        document.getElementById('identityEmail').value = '';
        document.getElementById('identityPassword').value = '';
        document.getElementById('identityConfirmPassword').value = '';
        document.getElementById('identityLocation').value = '';
        document.getElementById('identityError').hidden = true;
        document.getElementById('identitySuccess').hidden = true;
        clearLocationOptions();
        document.getElementById('locationSelect').value = '';
        setIdentityMode('login');
        showIdentityForm();
        signedOut = true;
        setTopLocationDisplay(aggregateTopLocation);
        applyFilters();
    }

    function renderStats(catches) {
        const totalCatches = catches.length;
        const accountIds = new Set(catches.map((c) => c.user_id).filter(Boolean));

        const speciesCount = {};
        const locationCount = {};
        catches.forEach((c) => {
            if (c.fish) speciesCount[c.fish] = (speciesCount[c.fish] || 0) + 1;
            // Tally by the angler's registered account location, not the catch location
            const accountLocation = c.users?.location;
            if (accountLocation) locationCount[accountLocation] = (locationCount[accountLocation] || 0) + 1;
        });

        const topSpecies = Object.entries(speciesCount).sort((a, b) => b[1] - a[1])[0]?.[0] || '--';
        aggregateTopLocation = Object.entries(locationCount).sort((a, b) => b[1] - a[1])[0]?.[0] || '--';

        document.getElementById('statTotalCatches').textContent = totalCatches;
        document.getElementById('statTotalAccounts').textContent = accountIds.size;
        document.getElementById('statTopSpecies').textContent = topSpecies;
        setTopLocationDisplay(aggregateTopLocation);
    }

    // Shows the signed-in user's own registered region instead of the site-wide aggregate
    function setTopLocationDisplay(text) {
        document.getElementById('statTopLocation').textContent = text || '--';
    }

    function sortCatches(catches, mode) {
        const sorted = [...catches];
        if (mode === 'heaviest') {
            sorted.sort((a, b) => (parseFloat(b.weight) || 0) - (parseFloat(a.weight) || 0));
        } else if (mode === 'oldest') {
            sorted.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
        } else {
            sorted.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        }
        return sorted;
    }

    function applyFilters() {
        if (signedOut) {
            renderTable([], 'Sign in to see catch data near you.');
            return;
        }

        const query = document.getElementById('searchInput').value.trim().toLowerCase();
        const sortMode = document.getElementById('sortSelect').value;
        const selectedLocation = document.getElementById('locationSelect').value;

        let filtered = allCatches;

        // Catch locations are auto reverse-geocoded (e.g. "Malolos, Bulacan, Philippines")
        // while account locations are freeform (e.g. "Bulacan, Philippines"), so match by
        // substring both ways instead of requiring an exact string match.
        if (selectedLocation) {
            const sel = selectedLocation.toLowerCase();
            filtered = filtered.filter((c) => {
                const accountLoc = (c.users?.location || '').toLowerCase();
                const catchLoc = (c.location || '').toLowerCase();
                return (
                    (accountLoc && (accountLoc.includes(sel) || sel.includes(accountLoc))) ||
                    (catchLoc && (catchLoc.includes(sel) || sel.includes(catchLoc)))
                );
            });
        }

        if (query) {
            filtered = filtered.filter((c) => {
                const angler = c.users?.name || '';
                return (
                    (c.fish || '').toLowerCase().includes(query) ||
                    (c.location || '').toLowerCase().includes(query) ||
                    angler.toLowerCase().includes(query)
                );
            });
        }

        renderTable(sortCatches(filtered, sortMode));
    }

    function renderTable(catches, emptyMessage = 'No catches match your search.') {
        const body = document.getElementById('catchTableBody');
        currentCatches = catches;
        updateExportButtons();

        if (!catches.length) {
            body.innerHTML = `<tr><td colspan="9" class="empty-row">${escapeHtml(emptyMessage)}</td></tr>`;
            return;
        }

        body.innerHTML = catches.map((c) => `
            <tr>
                <td>${escapeHtml(c.users?.name || 'Unknown angler')}</td>
                <td>${escapeHtml(c.users?.location)}</td>
                <td>${escapeHtml(c.fish)}</td>
                <td>${escapeHtml(c.weight)}</td>
                <td>${escapeHtml(c.size)}</td>
                <td>${escapeHtml(c.source)}</td>
                <td>${escapeHtml(c.location)}</td>
                <td>${escapeHtml(c.depth)}</td>
                <td>${escapeHtml(c.date)}</td>
            </tr>
        `).join('');
    }

    function updateExportButtons() {
        const disabled = currentCatches.length === 0;
        document.getElementById('exportCsvBtn').disabled = disabled;
        document.getElementById('exportPdfBtn').disabled = disabled;
    }

    function triggerDownload(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    // Wraps a CSV field in quotes and escapes embedded quotes, per RFC 4180
    function csvField(value) {
        const str = String(value ?? '--');
        return `"${str.replace(/"/g, '""')}"`;
    }

    function exportCsv() {
        if (!currentCatches.length) return;
        const header = EXPORT_COLUMNS.map((col) => csvField(col.header)).join(',');
        const rows = currentCatches.map((c) =>
            EXPORT_COLUMNS.map((col) => csvField(col.value(c))).join(',')
        );
        const csv = [header, ...rows].join('\r\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        triggerDownload(blob, `ecofin-catches-${Date.now()}.csv`);
    }

    function exportPdf() {
        if (!currentCatches.length) return;
        const { jsPDF } = window.jspdf || {};
        if (!jsPDF) {
            alert('PDF export is unavailable right now. Please try again later.');
            return;
        }

        const doc = new jsPDF({ orientation: 'landscape' });
        doc.setFontSize(14);
        doc.text('EcoFin AI — Catch Showcase', 14, 14);

        doc.autoTable({
            startY: 20,
            head: [EXPORT_COLUMNS.map((col) => col.header)],
            body: currentCatches.map((c) => EXPORT_COLUMNS.map((col) => String(col.value(c) ?? '--'))),
            styles: { fontSize: 8 },
            headStyles: { fillColor: [31, 77, 46] }
        });

        doc.save(`ecofin-catches-${Date.now()}.pdf`);
    }

    // ─── Weather code → description + emoji (same mapping as the mobile dashboard) ──
    function describeWeather(code) {
        if (code === 0) return { text: 'Clear Sky', emoji: '☀️' };
        if (code <= 2) return { text: 'Partly Cloudy', emoji: '⛅' };
        if (code === 3) return { text: 'Overcast', emoji: '☁️' };
        if (code <= 49) return { text: 'Foggy', emoji: '🌫️' };
        if (code <= 59) return { text: 'Drizzle', emoji: '🌦️' };
        if (code <= 69) return { text: 'Rain', emoji: '🌧️' };
        if (code <= 79) return { text: 'Snow / Sleet', emoji: '🌨️' };
        if (code <= 84) return { text: 'Rain Showers', emoji: '🌧️' };
        if (code <= 94) return { text: 'Thunderstorm', emoji: '⛈️' };
        return { text: 'Severe Storm', emoji: '🌩️' };
    }

    async function getLocationName(lat, lng) {
        try {
            const res = await fetch(
                `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
                { headers: { 'Accept-Language': 'en' } }
            );
            const data = await res.json();
            const a = data.address || {};
            return [
                a.city || a.municipality || a.town || a.county,
                a.state,
                a.country
            ].filter(Boolean).join(', ') || 'Philippines';
        } catch {
            return 'Philippines';
        }
    }

    async function loadWeather(lat, lng) {
        try {
            const locationName = await getLocationName(lat, lng);
            document.getElementById('weatherLocation').textContent = `📍 ${locationName}`;

            const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
                `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,precipitation` +
                `&wind_speed_unit=kmh&timezone=Asia%2FManila&forecast_days=1`;

            const res = await fetch(url);
            if (!res.ok) throw new Error('Weather API failed');
            const data = await res.json();
            const curr = data.current;

            const temp = Math.round(curr.temperature_2m);
            const humidity = curr.relative_humidity_2m;
            const wind = Math.round(curr.wind_speed_10m);
            const rain = curr.precipitation || 0;
            const { text: weatherText, emoji } = describeWeather(curr.weather_code);

            document.getElementById('weatherContent').innerHTML = `
                <div class="weather-main-row">
                    <span style="font-size:36px;">${emoji}</span>
                    <div>
                        <div class="weather-temp">${temp}°C</div>
                        <div class="weather-desc">${weatherText}</div>
                    </div>
                </div>
                <div class="weather-details">
                    <div>💨 Wind: ${wind} km/h</div>
                    <div>💧 Humidity: ${humidity}%</div>
                    <div>🌧️ Rain: ${rain} mm</div>
                    <div>📍 ${locationName.split(',')[0]}</div>
                </div>
            `;
        } catch (err) {
            document.getElementById('weatherContent').innerHTML =
                '<p class="weather-error">⚠️ Could not load weather data.</p>';
        }
    }

    // Defaults to Manila when geolocation is denied or unavailable, same as the mobile dashboard
    function initWeather() {
        const defaultLat = 14.5995;
        const defaultLng = 120.9842;

        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (pos) => loadWeather(pos.coords.latitude, pos.coords.longitude),
                () => loadWeather(defaultLat, defaultLng),
                { enableHighAccuracy: true, timeout: 8000 }
            );
        } else {
            loadWeather(defaultLat, defaultLng);
        }
    }

    document.getElementById('searchInput').addEventListener('input', applyFilters);
    document.getElementById('locationSelect').addEventListener('change', applyFilters);
    document.getElementById('sortSelect').addEventListener('change', applyFilters);
    document.getElementById('identitySubmit').addEventListener('click', handleIdentitySubmit);
    document.getElementById('identityChange').addEventListener('click', handleIdentityChange);
    document.getElementById('tabLogin').addEventListener('click', () => setIdentityMode('login'));
    document.getElementById('tabSignup').addEventListener('click', () => setIdentityMode('signup'));
    document.getElementById('identityForgotLink').addEventListener('click', () => setIdentityMode(identityMode === 'forgot' ? 'login' : 'forgot'));
    document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);
    document.getElementById('exportPdfBtn').addEventListener('click', exportPdf);

    loadCatches();
    initWeather();
})();
