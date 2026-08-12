const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { readDb, writeDb } = require('../utils/db');
const { authenticate, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required' });
  }

  const db = readDb();
  const user = db.employees.find(
    (e) => (e.username || '').toLowerCase() === String(username).trim().toLowerCase()
  );

  if (!user) {
    return res.status(401).json({ success: false, message: 'Invalid username or password' });
  }

  if (user.status === 'inactive') {
    return res.status(403).json({ success: false, message: 'Your account has been deactivated. Contact admin.' });
  }

  const valid = bcrypt.compareSync(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ success: false, message: 'Invalid username or password' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.json({
    success: true,
    token,
    user: {
      id: user.id,
      empCode: user.empCode,
      name: user.name,
      email: user.email,
      username: user.username,
      role: user.role,
      department: user.department,
      designation: user.designation
    }
  });
});

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => {
  const db = readDb();
  const user = db.employees.find((e) => e.id === req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  res.json({
    success: true,
    user: {
      id: user.id,
      empCode: user.empCode,
      name: user.name,
      email: user.email,
      username: user.username,
      role: user.role,
      department: user.department,
      designation: user.designation,
      phone: user.phone,
      joinDate: user.joinDate
    }
  });
});

// PUT /api/auth/profile - update own contact details (not username/role/department)
router.put('/profile', authenticate, (req, res) => {
  const { email, phone } = req.body;
  const db = readDb();
  const user = db.employees.find((e) => e.id === req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  if (email !== undefined) user.email = String(email).trim();
  if (phone !== undefined) user.phone = String(phone).trim();

  writeDb(db);
  res.json({
    success: true,
    message: 'Profile updated successfully',
    user: {
      id: user.id,
      empCode: user.empCode,
      name: user.name,
      email: user.email,
      username: user.username,
      role: user.role,
      department: user.department,
      designation: user.designation,
      phone: user.phone,
      joinDate: user.joinDate
    }
  });
});

// POST /api/auth/change-password
// Body: { currentPassword, newPassword, confirmPassword }
router.post('/change-password', authenticate, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, message: 'Both current and new password are required' });
  }
  if (newPassword.length < 4) {
    return res.status(400).json({ success: false, message: 'New password must be at least 4 characters' });
  }
  if (confirmPassword !== undefined && confirmPassword !== newPassword) {
    return res.status(400).json({ success: false, message: 'New password and confirm password do not match' });
  }

  const db = readDb();
  const user = db.employees.find((e) => e.id === req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  if (!bcrypt.compareSync(currentPassword, user.passwordHash)) {
    return res.status(401).json({ success: false, message: 'Current password is incorrect' });
  }

  user.passwordHash = bcrypt.hashSync(newPassword, 8);
  writeDb(db);
  res.json({ success: true, message: 'Password updated successfully' });
});

// POST /api/auth/forgot-password
// Body: { username } (email works too since we search both fields)
// This app doesn't have an SMTP/email service configured, so instead of
// emailing a link, it issues a short-lived reset token and returns it
// directly in the response (and logs it server-side). Wire up a real mailer
// in production and only log/return the token in a `devToken` field there.
router.post('/forgot-password', (req, res) => {
  const { username } = req.body;
  if (!username || !String(username).trim()) {
    return res.status(400).json({ success: false, message: 'Username or email is required' });
  }
  const lookup = String(username).trim().toLowerCase();

  const db = readDb();
  const user = db.employees.find(
    (e) =>
      (e.username || '').toLowerCase() === lookup ||
      (e.email && e.email.toLowerCase() === lookup)
  );

  // Always respond success (even if user not found) so this endpoint can't be
  // used to enumerate valid usernames/emails.
  if (!user) {
    return res.json({
      success: true,
      message: 'If an account with that username/email exists, a reset token has been issued.'
    });
  }

  const token = crypto.randomBytes(20).toString('hex');
  db.passwordResets = (db.passwordResets || []).filter((r) => r.userId !== user.id); // clear old tokens
  db.passwordResets.push({
    token,
    userId: user.id,
    expiresAt: Date.now() + RESET_TOKEN_TTL_MS,
    used: false
  });
  writeDb(db);

  console.log(`[Password Reset] Token for ${user.username}: ${token} (valid 30 minutes)`);

  res.json({
    success: true,
    message: 'A password reset token has been generated. No email server is configured, so it is shown below - copy it into the "Reset Password" screen.',
    // NOTE: only exposed because there's no email service wired up yet.
    devToken: token,
    expiresInMinutes: 30
  });
});

// POST /api/auth/reset-password
// Body: { token, newPassword, confirmPassword }
router.post('/reset-password', (req, res) => {
  const { newPassword, confirmPassword } = req.body;
  const token = req.body.token ? String(req.body.token).trim() : '';
  if (!token || !newPassword) {
    return res.status(400).json({ success: false, message: 'Token and new password are required' });
  }
  if (newPassword.length < 4) {
    return res.status(400).json({ success: false, message: 'New password must be at least 4 characters' });
  }
  if (confirmPassword !== undefined && confirmPassword !== newPassword) {
    return res.status(400).json({ success: false, message: 'New password and confirm password do not match' });
  }

  const db = readDb();
  const reset = (db.passwordResets || []).find((r) => r.token === token);
  if (!reset || reset.used) {
    return res.status(400).json({ success: false, message: 'Invalid or already-used reset token' });
  }
  if (Date.now() > reset.expiresAt) {
    return res.status(400).json({ success: false, message: 'This reset token has expired. Please request a new one.' });
  }

  const user = db.employees.find((e) => e.id === reset.userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  user.passwordHash = bcrypt.hashSync(newPassword, 8);
  reset.used = true;
  writeDb(db);

  res.json({ success: true, message: 'Password reset successfully. You can now log in with your new password.' });
});

module.exports = router;
