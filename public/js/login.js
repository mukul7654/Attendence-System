// Redirect if already logged in
(function () {
  if (getToken()) {
    const user = getUser();
    window.location.href = user && (user.role === 'admin' || user.role === 'manager') ? '/admin.html' : '/dashboard.html';
  }
})();

const loginForm = document.getElementById('loginForm');
const errorBox = document.getElementById('errorBox');
const loginBtn = document.getElementById('loginBtn');

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.classList.remove('show');

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  loginBtn.disabled = true;
  loginBtn.innerHTML = '<span class="spinner"></span> Signing in...';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (!data.success) {
      throw new Error(data.message || 'Login failed');
    }

    setToken(data.token);
    setUser(data.user);

    window.location.href = (data.user.role === 'admin' || data.user.role === 'manager') ? '/admin.html' : '/dashboard.html';
  } catch (err) {
    errorBox.textContent = err.message || 'Something went wrong. Please try again.';
    errorBox.classList.add('show');
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign In';
  }
});
