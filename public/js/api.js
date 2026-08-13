// Shared API helper for Maxim Realty Attendance System
const API_BASE = '/api';

function getToken() {
  return localStorage.getItem('mr_token');
}
function setToken(token) {
  localStorage.setItem('mr_token', token);
}
function clearToken() {f
  localStorage.removeItem('mr_token');
  localStorage.removeItem('mr_user');
}
function getUser() {
  try {
    return JSON.parse(localStorage.getItem('mr_user') || 'null');
  } catch (e) {
    return null;
  }
}
function setUser(user) {
  localStorage.setItem('mr_user', JSON.stringify(user));
}

async function apiRequest(path, options = {}) {
  const token = getToken();
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    options.headers || {}
  );
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });


  function clearToken() {
  localStorage.removeItem('mr_token');
  localStorage.removeItem('mr_user');
}

  let data;
  try {
    data = await res.json();
  } catch (e) {
    data = { success: false, message: 'Unexpected server response' };
  }

  if (res.status === 401) {
    clearToken();
    if (!window.location.pathname.endsWith('index.html') && window.location.pathname !== '/') {
      window.location.href = '/index.html';
    }
  }

  if (!res.ok) {
    throw new Error(data.message || 'Request failed');
  }
  return data;
}

function requireAuth() {
  if (!getToken()) {
    window.location.href = '/index.html';
    return false;
  }
  return true;
}

function requireAdminRole() {
  const user = getUser();
  if (!user || user.role !== 'admin') {
    window.location.href = '/dashboard.html';
    return false;
  }
  return true;
}

// Admin OR manager - used for the shared admin.html panel
function requireStaffRole() {
  const user = getUser();
  if (!user || (user.role !== 'admin' && user.role !== 'manager')) {
    window.location.href = '/dashboard.html';
    return false;
  }
  return true;
}

// Wraps navigator.geolocation in a promise. Resolves { lat, lng } on success,
// resolves { lat: null, lng: null } if location isn't available/allowed so
// punch in/out can still proceed when the admin hasn't turned on geofencing.
function getCurrentLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ lat: null, lng: null });
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve({ lat: null, lng: null }),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  });
}

function logout() {
  clearToken();
  window.location.href = '/index.html';
}

function showToast(message, type = '') {
  let toast = document.getElementById('globalToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'globalToast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => {
    toast.className = 'toast';
  }, 3200);
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatTime12(timeStr) {
  if (!timeStr) return '-';

  // Server se aaya time UTC maana ja raha hai
  const parts = timeStr.split(':');
  const h = parseInt(parts[0], 10);
  const m = parts[1] || '00';
  const s = parts[2] || '00';

  const now = new Date();
  // Aaj ki date + UTC time se Date object banao
  const utcDate = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    h, parseInt(m, 10), parseInt(s, 10)
  ));

  return utcDate.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}
