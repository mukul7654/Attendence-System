const express = require('express');
const { readDb, writeDb, guessHolidayIcon } = require('../utils/db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const events = require('../utils/events');

const router = express.Router();

// GET /api/settings - any authenticated user can read (employees need geofence info to punch in/out).
// WhatsApp API credentials are sensitive, so non-admins only see whether it's turned on, not the keys.
router.get('/', authenticate, (req, res) => {
  const db = readDb();
  if (req.user.role === 'admin') {
    return res.json({ success: true, settings: db.settings });
  }
  const { whatsapp, ...rest } = db.settings;
  res.json({ success: true, settings: { ...rest, whatsapp: { enabled: !!(whatsapp && whatsapp.enabled) } } });
});

// PUT /api/settings (admin only) - update company-wide settings, including geofencing
router.put('/', authenticate, requireAdmin, (req, res) => {
  const {
    companyName, officeStartTime, officeEndTime, lateAfterMinutes, targetWorkHours,
    officeLat, officeLng, geofenceRadius, enforceGeofence,
    weeklyOffByDepartment
  } = req.body;

  const db = readDb();
  const s = db.settings;

  if (companyName !== undefined) s.companyName = String(companyName).trim() || s.companyName;
  if (officeStartTime !== undefined) s.officeStartTime = officeStartTime;
  if (officeEndTime !== undefined) s.officeEndTime = officeEndTime;
  if (lateAfterMinutes !== undefined) s.lateAfterMinutes = Math.max(0, parseInt(lateAfterMinutes, 10) || 0);
  if (targetWorkHours !== undefined) {
    const t = parseFloat(targetWorkHours);
    s.targetWorkHours = Number.isFinite(t) && t > 0 ? Math.min(24, t) : s.targetWorkHours;
  }

  if (officeLat !== undefined && officeLng !== undefined) {
    const lat = officeLat === null || officeLat === '' ? null : parseFloat(officeLat);
    const lng = officeLng === null || officeLng === '' ? null : parseFloat(officeLng);
    s.officeLocation = { lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null };
  }
  if (geofenceRadius !== undefined) s.geofenceRadius = Math.max(10, parseInt(geofenceRadius, 10) || 100);
  if (enforceGeofence !== undefined) s.enforceGeofence = !!enforceGeofence;

  // weeklyOffByDepartment: { "Sales": [1], "Marketing": [0,6], "_default": [0] }
  if (weeklyOffByDepartment && typeof weeklyOffByDepartment === 'object') {
    s.weeklyOffByDepartment = { ...s.weeklyOffByDepartment, ...weeklyOffByDepartment };
  }

  writeDb(db);
  events.broadcast('settings-updated', { companyName: s.companyName, updatedBy: req.user.name });
  res.json({ success: true, message: 'Settings updated successfully', settings: s });
});

// GET /api/settings/holidays - list company holidays (any authenticated user)
router.get('/holidays', authenticate, (req, res) => {
  const db = readDb();
  res.json({ success: true, holidays: db.settings.holidays || [] });
});

// POST /api/settings/holidays (admin only) - add a company holiday
// Body: { date: 'YYYY-MM-DD', name: 'Diwali', icon: '🪔' (optional) }
router.post('/holidays', authenticate, requireAdmin, (req, res) => {
  const { date, name, icon } = req.body;
  if (!date || !name) {
    return res.status(400).json({ success: false, message: 'date and name are required' });
  }
  const db = readDb();
  db.settings.holidays = db.settings.holidays || [];
  if (db.settings.holidays.some((h) => h.date === date)) {
    return res.status(409).json({ success: false, message: 'A holiday is already set for this date' });
  }
  db.settings.holidays.push({ date, name: String(name).trim(), icon: icon || guessHolidayIcon(name) });
  db.settings.holidays.sort((a, b) => (a.date < b.date ? -1 : 1));
  writeDb(db);
  events.broadcast('holiday-updated', { date, name: String(name).trim(), action: 'added' });
  res.status(201).json({ success: true, message: 'Holiday added', holidays: db.settings.holidays });
});

// PUT /api/settings/holidays/:date (admin only) - update a holiday's name/icon
router.put('/holidays/:date', authenticate, requireAdmin, (req, res) => {
  const { name, icon } = req.body;
  const db = readDb();
  const holiday = (db.settings.holidays || []).find((h) => h.date === req.params.date);
  if (!holiday) return res.status(404).json({ success: false, message: 'Holiday not found' });
  if (name !== undefined) holiday.name = String(name).trim();
  if (icon !== undefined) holiday.icon = icon;
  writeDb(db);
  events.broadcast('holiday-updated', { date: holiday.date, name: holiday.name, action: 'updated' });
  res.json({ success: true, message: 'Holiday updated', holidays: db.settings.holidays });
});

// DELETE /api/settings/holidays/:date (admin only)
router.delete('/holidays/:date', authenticate, requireAdmin, (req, res) => {
  const db = readDb();
  const before = (db.settings.holidays || []).length;
  db.settings.holidays = (db.settings.holidays || []).filter((h) => h.date !== req.params.date);
  if (db.settings.holidays.length === before) {
    return res.status(404).json({ success: false, message: 'Holiday not found' });
  }
  writeDb(db);
  events.broadcast('holiday-updated', { date: req.params.date, action: 'removed' });
  res.json({ success: true, message: 'Holiday removed', holidays: db.settings.holidays });
});

// PUT /api/settings/whatsapp (admin only) - configure WhatsApp Business API integration
router.put('/whatsapp', authenticate, requireAdmin, (req, res) => {
  const {
    enabled, provider, accountSid, authToken, fromNumber, metaAccessToken, metaPhoneNumberId,
    notifyOnPunchIn, notifyOnPunchOut, notifyOnLeaveApplied, notifyOnLeaveDecided
  } = req.body || {};

  const db = readDb();
  const wa = db.settings.whatsapp;

  if (enabled !== undefined) wa.enabled = !!enabled;
  if (provider !== undefined) wa.provider = provider === 'meta_cloud' ? 'meta_cloud' : 'twilio';
  if (accountSid !== undefined) wa.accountSid = String(accountSid).trim();
  if (authToken !== undefined) wa.authToken = String(authToken).trim();
  if (fromNumber !== undefined) wa.fromNumber = String(fromNumber).trim();
  if (metaAccessToken !== undefined) wa.metaAccessToken = String(metaAccessToken).trim();
  if (metaPhoneNumberId !== undefined) wa.metaPhoneNumberId = String(metaPhoneNumberId).trim();
  if (notifyOnPunchIn !== undefined) wa.notifyOnPunchIn = !!notifyOnPunchIn;
  if (notifyOnPunchOut !== undefined) wa.notifyOnPunchOut = !!notifyOnPunchOut;
  if (notifyOnLeaveApplied !== undefined) wa.notifyOnLeaveApplied = !!notifyOnLeaveApplied;
  if (notifyOnLeaveDecided !== undefined) wa.notifyOnLeaveDecided = !!notifyOnLeaveDecided;

  writeDb(db);
  res.json({ success: true, message: 'WhatsApp settings updated', whatsapp: wa });
});

// GET /api/settings/whatsapp-log (admin only) - recent notification attempts (sent/failed/skipped)
router.get('/whatsapp-log', authenticate, requireAdmin, (req, res) => {
  const db = readDb();
  const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
  res.json({ success: true, log: (db.whatsappLog || []).slice(0, limit) });
});

module.exports = router;
