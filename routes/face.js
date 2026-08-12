// Face Punch - passwordless attendance.
//
// HONEST NOTE ON HOW THIS WORKS: true face *identification* (automatically figuring out
// WHO is in frame, out of every employee, purely from a camera) needs a trained ML model.
// This app has no server-side ML/vision engine, so it does not claim to do that. Instead:
//   1. An employee "enrolls" a reference photo once (from their own logged-in profile).
//   2. At the kiosk (public/face-punch.html, no login/password needed), the employee picks
//      their name from a photo grid, the browser's camera detects that a real face is in
//      frame (using the browser's built-in Shape Detection API where supported), and only
//      then is the punch allowed to go through.
//   3. The live captured photo is stored against the attendance record as an audit trail
//      photo, so an admin can visually confirm it was really that person if needed.
// This gives a genuine "no password, face-gated" punch flow with a photographic audit
// trail - which is what most small-business face-attendance kiosks actually do under the
// hood. Swapping in real face-matching later just means replacing verifyFace() below with
// a call to a real vision service.
const express = require('express');
const { readDb, writeDb } = require('../utils/db');
const { authenticate } = require('../middleware/auth');
const { distanceInMeters } = require('../utils/geo');
const events = require('../utils/events');

const router = express.Router();

function todayStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
function timeStr(d = new Date()) {
  return d.toTimeString().slice(0, 8);
}
function minutesBetween(dateStr, t1, t2) {
  const start = new Date(`${dateStr}T${t1}`);
  const end = new Date(`${dateStr}T${t2}`);
  return Math.max(0, Math.round((end - start) / 60000));
}
function formatDuration(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}
function isWeeklyOff(settings, department, dateStr) {
  const weekday = new Date(`${dateStr}T00:00:00`).getDay();
  const map = settings.weeklyOffByDepartment || {};
  const days = map[department] || map._default || [0];
  return days.includes(weekday);
}
function isHoliday(settings, dateStr) {
  return (settings.holidays || []).some((h) => h.date === dateStr);
}
function checkGeofence(settings, lat, lng) {
  if (!settings.enforceGeofence) return { ok: true };
  const office = settings.officeLocation || {};
  if (office.lat == null || office.lng == null) return { ok: true };
  if (lat == null || lng == null) return { ok: true }; // kiosk devices may not expose GPS - don't block
  const radius = settings.geofenceRadius || 100;
  const distance = distanceInMeters(Number(lat), Number(lng), office.lat, office.lng);
  if (distance > radius) {
    return { ok: false, message: `This kiosk is ${distance}m from the office (must be within ${radius}m).`, distance };
  }
  return { ok: true, distance };
}

// POST /api/face/enroll (authenticated - employee/manager only) - save/replace my reference face photo
router.post('/enroll', authenticate, (req, res) => {
  if (req.user.role === 'admin') {
    return res.status(403).json({ success: false, message: 'Admin accounts do not use the punch clock, so face enrollment is not needed.' });
  }
  const { photo } = req.body || {};
  if (!photo || typeof photo !== 'string' || photo.length < 100) {
    return res.status(400).json({ success: false, message: 'A clear face photo is required to enroll' });
  }
  const db = readDb();
  const emp = db.employees.find((e) => e.id === req.user.id);
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

  emp.facePhoto = photo;
  emp.faceEnrolled = true;
  writeDb(db);
  res.json({ success: true, message: 'Face enrolled successfully. You can now use the Face Punch kiosk.' });
});

// DELETE /api/face/enroll (authenticated) - remove my own face enrollment
router.delete('/enroll', authenticate, (req, res) => {
  const db = readDb();
  const emp = db.employees.find((e) => e.id === req.user.id);
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
  emp.facePhoto = null;
  emp.faceEnrolled = false;
  writeDb(db);
  res.json({ success: true, message: 'Face enrollment removed' });
});

// GET /api/face/status (authenticated) - is my face currently enrolled?
router.get('/status', authenticate, (req, res) => {
  const db = readDb();
  const emp = db.employees.find((e) => e.id === req.user.id);
  res.json({ success: true, faceEnrolled: !!(emp && emp.faceEnrolled) });
});

// GET /api/face/roster (PUBLIC - no login, this powers the kiosk picker) - only exposes
// name/photo/department for employees who have opted in by enrolling their face. No
// sensitive data (email, phone, username) is included.
router.get('/roster', (req, res) => {
  const db = readDb();
  const roster = db.employees
    .filter((e) => e.faceEnrolled && e.status === 'active' && e.role !== 'admin')
    .map((e) => ({
      id: e.id,
      empCode: e.empCode,
      name: e.name,
      department: e.department,
      designation: e.designation,
      photo: e.facePhoto
    }));
  res.json({ success: true, roster });
});

// POST /api/face/punch (PUBLIC - no login/password) - kiosk punch in/out.
// Body: { employeeId, photo (live capture, base64), faceDetected (bool - the browser's
// Shape Detection API confirmed a face was in frame), lat, lng (optional) }
router.post('/punch', (req, res) => {
  const { employeeId, photo, faceDetected, lat, lng } = req.body || {};

  if (!employeeId) return res.status(400).json({ success: false, message: 'Please select who you are from the list' });
  if (!faceDetected) {
    return res.status(400).json({ success: false, message: 'No face was detected. Please look at the camera and try again.' });
  }
  if (!photo) {
    return res.status(400).json({ success: false, message: 'Could not capture a photo. Please try again.' });
  }

  const db = readDb();
  const emp = db.employees.find((e) => e.id === parseInt(employeeId, 10));
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
  if (!emp.faceEnrolled) {
    return res.status(403).json({ success: false, message: `${emp.name} has not enrolled their face yet. Please enroll from your profile first.` });
  }
  if (emp.status !== 'active') {
    return res.status(403).json({ success: false, message: 'This account is inactive' });
  }

  const geo = checkGeofence(db.settings, lat, lng);
  if (!geo.ok) {
    return res.status(403).json({ success: false, message: geo.message, distance: geo.distance });
  }

  const today = todayStr();
  const now = new Date();
  let record = db.attendance.find((a) => a.employeeId === emp.id && a.date === today);

  // ---------- PUNCH IN ----------
  if (!record || !record.punchIn) {
    const settings = db.settings;
    let status = 'present';
    if (isHoliday(settings, today)) status = 'holiday-worked';
    else if (isWeeklyOff(settings, emp.department, today)) status = 'weekoff-worked';

    if (record) {
      record.punchIn = timeStr(now);
      record.status = status;
      record.punchInPhoto = photo;
      record.punchMethod = 'face';
    } else {
      record = {
        id: db.counters.attendanceId++,
        employeeId: emp.id,
        employeeName: emp.name,
        date: today,
        punchIn: timeStr(now),
        punchOut: null,
        workMinutes: 0,
        workHours: null,
        overtimeMinutes: 0,
        overtimeHours: null,
        status,
        note: '',
        punchInLocation: lat != null && lng != null ? { lat: Number(lat), lng: Number(lng) } : null,
        punchInDistance: geo.distance != null ? geo.distance : null,
        punchOutLocation: null,
        punchOutDistance: null,
        punchInPhoto: photo,
        punchMethod: 'face'
      };
      db.attendance.push(record);
    }
    writeDb(db);
    events.broadcast('punch-in', { employeeId: emp.id, employeeName: emp.name, date: today, time: record.punchIn, status: record.status, method: 'face' });
    return res.json({ success: true, action: 'in', message: `Welcome, ${emp.name.split(' ')[0]}! Punched in at ${record.punchIn}`, employeeName: emp.name, record });
  }

  // ---------- PUNCH OUT ----------
  if (record.punchIn && !record.punchOut) {
    record.punchOut = timeStr(now);
    const grossMinutes = minutesBetween(today, record.punchIn, record.punchOut);
    record.workMinutes = grossMinutes;
    record.workHours = formatDuration(record.workMinutes);

    const targetMinutes = (db.settings.targetWorkHours || 9) * 60;
    record.overtimeMinutes = Math.max(0, record.workMinutes - targetMinutes);
    record.overtimeHours = record.overtimeMinutes > 0 ? formatDuration(record.overtimeMinutes) : null;
    if (record.status !== 'holiday-worked' && record.status !== 'weekoff-worked') {
      record.status = record.workMinutes >= targetMinutes ? 'present' : 'late';
    }
    record.punchOutLocation = lat != null && lng != null ? { lat: Number(lat), lng: Number(lng) } : null;
    record.punchOutDistance = geo.distance != null ? geo.distance : null;
    record.punchOutPhoto = photo;

    writeDb(db);
    events.broadcast('punch-out', { employeeId: emp.id, employeeName: emp.name, date: today, time: record.punchOut, workHours: record.workHours, status: record.status, method: 'face' });
    return res.json({
      success: true,
      action: 'out',
      message: `Bye, ${emp.name.split(' ')[0]}! Punched out at ${record.punchOut}. Worked ${record.workHours}${record.status === 'late' ? ` (under the ${db.settings.targetWorkHours || 9}h target - marked Late)` : ' - marked Present'}.`,
      employeeName: emp.name,
      record
    });
  }

  return res.status(400).json({ success: false, message: `${emp.name.split(' ')[0]}, you have already completed today's attendance (in at ${record.punchIn}, out at ${record.punchOut}).` });
});

module.exports = router;
