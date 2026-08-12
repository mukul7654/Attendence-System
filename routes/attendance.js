const express = require('express');
const { readDb, writeDb } = require('../utils/db');
const { authenticate, requireAdmin, requireManagerOrAdmin, getAccessibleEmployeeIds } = require('../middleware/auth');
const { distanceInMeters } = require('../utils/geo');
const events = require('../utils/events');
const { sendWhatsApp } = require('../utils/whatsapp');

const router = express.Router();

function todayStr(d = new Date()) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function timeStr(d = new Date()) {
  return d.toTimeString().slice(0, 8); // HH:MM:SS
}

// Returns true if `dateStr` (YYYY-MM-DD) is a scheduled weekly off for the
// given department, based on settings.weeklyOffByDepartment.
function isWeeklyOff(settings, department, dateStr) {
  const weekday = new Date(`${dateStr}T00:00:00`).getDay(); // 0=Sun..6=Sat
  const map = settings.weeklyOffByDepartment || {};
  const days = map[department] || map._default || [0];
  return days.includes(weekday);
}

function isHoliday(settings, dateStr) {
  return (settings.holidays || []).some((h) => h.date === dateStr);
}

// Validates the punch location against the configured office geofence.
// Returns { ok: true } or { ok: false, message } - callers should reject the
// punch with a 403 when ok is false.
// `role` bypasses the check entirely for managers/admins, who are frequently
// out visiting sites/clients and are trusted to punch in/out from anywhere.
function checkGeofence(settings, lat, lng, role) {
  if (role && role !== 'employee') return { ok: true, bypassed: true };
  if (!settings.enforceGeofence) return { ok: true };

  const office = settings.officeLocation || {};
  if (office.lat == null || office.lng == null) {
    // Geofencing is turned on but no office location has been configured yet -
    // don't block employees because of an admin setup gap.
    return { ok: true };
  }

  if (lat == null || lng == null) {
    return {
      ok: false,
      message: 'Location is required to punch in/out. Please allow location access and try again.'
    };
  }

  const radius = settings.geofenceRadius || 100;
  const distance = distanceInMeters(Number(lat), Number(lng), office.lat, office.lng);

  if (distance > radius) {
    return {
      ok: false,
      message: `You are ${distance}m away from the office. You must be within ${radius}m to punch in/out.`,
      distance
    };
  }

  return { ok: true, distance };
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

// Shared date filtering logic used by /my, /all, /export.
// Priority: exact `date` > `fromDate`/`toDate` range > `month`+`year` (defaults to current month).
function filterRecordsByDate(records, query) {
  if (query.date) {
    return records.filter((a) => a.date === query.date);
  }
  if (query.fromDate || query.toDate) {
    const from = query.fromDate || '0000-01-01';
    const to = query.toDate || '9999-12-31';
    return records.filter((a) => a.date >= from && a.date <= to);
  }
  const now = new Date();
  const month = parseInt(query.month, 10) || now.getMonth() + 1;
  const year = parseInt(query.year, 10) || now.getFullYear();
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  return records.filter((a) => a.date.startsWith(prefix));
}

// GET /api/attendance/status - today's punch status for logged-in user
router.get('/status', authenticate, (req, res) => {
  const db = readDb();
  const today = todayStr();
  const record = db.attendance.find((a) => a.employeeId === req.user.id && a.date === today);
  res.json({ success: true, date: today, record: record || null });
});

// POST /api/attendance/punch-in
// Body: { lat, lng } - required whenever the admin has enforceGeofence turned on
// Admins manage the system and do not have their own punch clock - only
// managers and employees do. Admins correct/add entries via /manual instead.
router.post('/punch-in', authenticate, (req, res) => {
  if (req.user.role === 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Admin accounts do not punch in/out. Use Attendance Records to add or correct entries for staff.'
    });
  }
  const db = readDb();
  const today = todayStr();
  const now = new Date();
  const { lat, lng } = req.body || {};

  let record = db.attendance.find((a) => a.employeeId === req.user.id && a.date === today);
  if (record && record.punchIn) {
    return res.status(400).json({ success: false, message: 'You have already punched in today' });
  }

  const settings = db.settings;

  const geo = checkGeofence(settings, lat, lng, req.user.role);
  if (!geo.ok) {
    return res.status(403).json({ success: false, message: geo.message, distance: geo.distance });
  }

  const emp = db.employees.find((e) => e.id === req.user.id);
  const department = emp ? emp.department : null;

  // The day's final status (Present vs Late) is decided at punch-out based on total
  // hours worked against the target (see punch-out below) - not by the punch-in clock
  // time. At punch-in we only know whether it's a holiday/week-off being worked.
  let status = 'present';
  if (isHoliday(settings, today)) status = 'holiday-worked';
  else if (isWeeklyOff(settings, department, today)) status = 'weekoff-worked';

  if (record) {
    record.punchIn = timeStr(now);
    record.status = status;
    record.punchInLocation = lat != null && lng != null ? { lat: Number(lat), lng: Number(lng) } : null;
    record.punchInDistance = geo.distance != null ? geo.distance : null;
  } else {
    record = {
      id: db.counters.attendanceId++,
      employeeId: req.user.id,
      employeeName: req.user.name,
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
      punchOutDistance: null
    };
    db.attendance.push(record);
  }

  writeDb(db);
  events.broadcast('punch-in', { employeeId: req.user.id, employeeName: req.user.name, date: today, time: record.punchIn, status: record.status });
  if (db.settings.whatsapp.notifyOnPunchIn) {
    sendWhatsApp({
      employeeId: req.user.id, employeeName: req.user.name, phone: emp ? emp.phone : null,
      event: 'punch-in', message: `Hi ${req.user.name.split(' ')[0]}, your punch-in at ${record.punchIn} on ${today} has been recorded. - Maxim Realty`
    }).catch(() => {});
  }
  res.json({ success: true, message: `Punched in at ${record.punchIn}`, record });
});

// POST /api/attendance/punch-out
// Body: { lat, lng } - required whenever the admin has enforceGeofence turned on.
// The same 100m (configurable) distance rule that applies to punch-in also
// applies here - punching out does NOT skip the location/distance check.
router.post('/punch-out', authenticate, (req, res) => {
  if (req.user.role === 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Admin accounts do not punch in/out. Use Attendance Records to add or correct entries for staff.'
    });
  }
  const db = readDb();
  const today = todayStr();
  const now = new Date();
  const { lat, lng } = req.body || {};

  const record = db.attendance.find((a) => a.employeeId === req.user.id && a.date === today);
  if (!record || !record.punchIn) {
    return res.status(400).json({ success: false, message: 'You must punch in before punching out' });
  }
  if (record.punchOut) {
    return res.status(400).json({ success: false, message: 'You have already punched out today' });
  }

  const geo = checkGeofence(db.settings, lat, lng, req.user.role);
  if (!geo.ok) {
    return res.status(403).json({ success: false, message: geo.message, distance: geo.distance });
  }

  record.punchOut = timeStr(now);
  const grossMinutes = minutesBetween(today, record.punchIn, record.punchOut);
  record.workMinutes = grossMinutes;
  record.workHours = formatDuration(record.workMinutes);

  // Whether today counts as Present or Late is decided right here, based on total
  // hours actually worked against the target - not on what time the employee
  // punched in. Holiday/week-off-worked days keep their special status either way.
  const targetMinutes = (db.settings.targetWorkHours || 9) * 60;
  record.overtimeMinutes = Math.max(0, record.workMinutes - targetMinutes);
  record.overtimeHours = record.overtimeMinutes > 0 ? formatDuration(record.overtimeMinutes) : null;

  if (record.status !== 'holiday-worked' && record.status !== 'weekoff-worked') {
    record.status = record.workMinutes >= targetMinutes ? 'present' : 'late';
  }

  record.punchOutLocation = lat != null && lng != null ? { lat: Number(lat), lng: Number(lng) } : null;
  record.punchOutDistance = geo.distance != null ? geo.distance : null;

  writeDb(db);
  events.broadcast('punch-out', { employeeId: req.user.id, employeeName: req.user.name, date: today, time: record.punchOut, workHours: record.workHours, overtimeHours: record.overtimeHours, status: record.status });
  if (db.settings.whatsapp.notifyOnPunchOut) {
    const emp = db.employees.find((e) => e.id === req.user.id);
    sendWhatsApp({
      employeeId: req.user.id, employeeName: req.user.name, phone: emp ? emp.phone : null,
      event: 'punch-out', message: `Hi ${req.user.name.split(' ')[0]}, your punch-out at ${record.punchOut} has been recorded. Worked ${record.workHours} today. - Maxim Realty`
    }).catch(() => {});
  }
  res.json({ success: true, message: `Punched out at ${record.punchOut}. Worked ${record.workHours}${record.status === 'late' ? ` - under the ${db.settings.targetWorkHours || 9}h target, marked Late` : ' - marked Present'}.`, record });
});

// GET /api/attendance/working-now (admin/manager) - who is currently punched in
// (no punch-out yet) right now, including whether they're on a break.
router.get('/working-now', authenticate, requireManagerOrAdmin, (req, res) => {
  const db = readDb();
  const today = todayStr();
  const accessibleIds = getAccessibleEmployeeIds(db, req.user);

  const empMap = {};
  db.employees.forEach((e) => (empMap[e.id] = e));

  const working = db.attendance
    .filter((a) => a.date === today && a.punchIn && !a.punchOut && (!accessibleIds || accessibleIds.includes(a.employeeId)))
    .map((a) => {
      const emp = empMap[a.employeeId] || {};
      return {
        employeeId: a.employeeId,
        employeeName: a.employeeName,
        empCode: emp.empCode || '',
        department: emp.department || '',
        punchIn: a.punchIn,
        status: a.status
      };
    })
    .sort((a, b) => (a.punchIn > b.punchIn ? 1 : -1));

  res.json({ success: true, date: today, working });
});

// GET /api/attendance/my-summary?month=&year= - attendance analytics for the logged-in user:
// present/late/absent/leave day counts, total worked hours, and a punctuality
// percentage for the selected month (defaults to the current month).
router.get('/my-summary', authenticate, (req, res) => {
  const db = readDb();
  const now = new Date();
  const month = parseInt(req.query.month, 10) || now.getMonth() + 1;
  const year = parseInt(req.query.year, 10) || now.getFullYear();
  const prefix = `${year}-${String(month).padStart(2, '0')}`;

  const emp = db.employees.find((e) => e.id === req.user.id);
  const department = emp ? emp.department : null;

  const records = db.attendance.filter((a) => a.employeeId === req.user.id && a.date.startsWith(prefix));
  const presentDays = records.filter((r) => r.punchIn && r.status !== 'late').length;
  const lateDays = records.filter((r) => r.status === 'late').length;
  const totalWorkMinutes = records.reduce((sum, r) => sum + (r.workMinutes || 0), 0);
  const totalOvertimeMinutes = records.reduce((sum, r) => sum + (r.overtimeMinutes || 0), 0);

  const leaveDays = db.leaveRequests
    .filter((l) => l.employeeId === req.user.id && l.status === 'approved' && l.fromDate.startsWith(prefix.slice(0, 4)))
    .filter((l) => l.fromDate <= `${prefix}-31` && l.toDate >= `${prefix}-01`)
    .reduce((sum, l) => sum + l.days, 0);

  // Count elapsed working days this month (excluding weekly-offs and holidays) up to today
  // so "absent" only counts days that have actually passed.
  const daysInMonth = new Date(year, month, 0).getDate();
  const lastDay = (year === now.getFullYear() && month === now.getMonth() + 1) ? now.getDate() : daysInMonth;
  let workingDaysSoFar = 0;
  for (let d = 1; d <= lastDay; d++) {
    const dateStr = `${prefix}-${String(d).padStart(2, '0')}`;
    if (!isWeeklyOff(db.settings, department, dateStr) && !isHoliday(db.settings, dateStr)) workingDaysSoFar++;
  }
  const attendedDays = new Set(records.filter((r) => r.punchIn).map((r) => r.date)).size;
  const absentDays = Math.max(0, workingDaysSoFar - attendedDays - Math.round(leaveDays));
  const attendancePercentage = workingDaysSoFar > 0 ? Math.round((attendedDays / workingDaysSoFar) * 100) : 100;

  // Current on-time punctual streak (consecutive most-recent working days present & not late)
  let streak = 0;
  const sortedRecords = [...db.attendance.filter((a) => a.employeeId === req.user.id)].sort((a, b) => (a.date < b.date ? 1 : -1));
  for (const r of sortedRecords) {
    if (r.punchIn && r.status !== 'late') streak++;
    else break;
  }

  res.json({
    success: true,
    month, year,
    presentDays, lateDays, absentDays,
    leaveDays: Math.round(leaveDays * 10) / 10,
    workingDaysSoFar,
    totalWorkHours: formatDuration(totalWorkMinutes),
    totalOvertimeHours: formatDuration(totalOvertimeMinutes),
    attendancePercentage,
    punctualStreak: streak
  });
});

// POST /api/attendance/mark-absentees (admin) - bulk-mark employees as absent for a past
// date if they have no attendance record and weren't on approved leave, skipping
// weekly-offs and holidays. Useful as an end-of-day sweep since this demo build has no
// background job scheduler.
router.post('/mark-absentees', authenticate, requireAdmin, (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ success: false, message: 'date is required' });
  if (date > todayStr()) {
    return res.status(400).json({ success: false, message: 'Cannot mark absentees for a future date' });
  }

  const db = readDb();
  const activeEmployees = db.employees.filter((e) => e.role === 'employee' && e.status === 'active');
  let markedCount = 0;
  const markedNames = [];

  activeEmployees.forEach((emp) => {
    if (isWeeklyOff(db.settings, emp.department, date) || isHoliday(db.settings, date)) return;

    const hasRecord = db.attendance.some((a) => a.employeeId === emp.id && a.date === date);
    if (hasRecord) return;

    const onApprovedLeave = db.leaveRequests.some(
      (l) => l.employeeId === emp.id && l.status === 'approved' && l.fromDate <= date && l.toDate >= date
    );
    if (onApprovedLeave) return;

    db.attendance.push({
      id: db.counters.attendanceId++,
      employeeId: emp.id,
      employeeName: emp.name,
      date,
      punchIn: null,
      punchOut: null,
      workMinutes: 0,
      workHours: null,
      status: 'absent',
      note: 'Auto-marked absent (no punch recorded)'
    });
    markedCount++;
    markedNames.push(emp.name);
  });

  writeDb(db);
  if (markedCount > 0) {
    events.broadcast('absentees-marked', { date, count: markedCount });
  }
  res.json({
    success: true,
    message: markedCount > 0
      ? `Marked ${markedCount} employee(s) absent for ${date}`
      : `No employees needed to be marked absent for ${date}`,
    markedCount,
    markedNames
  });
});

// GET /api/attendance/my?month=&year= OR ?date= OR ?fromDate=&toDate=  - logged-in user's own history
router.get('/my', authenticate, (req, res) => {
  const db = readDb();
  let records = db.attendance.filter((a) => a.employeeId === req.user.id);
  records = filterRecordsByDate(records, req.query);
  records.sort((a, b) => (a.date < b.date ? 1 : -1));

  res.json({ success: true, records });
});

// GET /api/attendance/all?date=&employeeId=&month=&year=&fromDate=&toDate=  (admin: all; manager: own dept) - view records
// GET /api/attendance/all?date=&employeeId=&department=&status=&month=&year=&fromDate=&toDate=  (admin: all; manager: own dept)
router.get('/all', authenticate, requireManagerOrAdmin, (req, res) => {
  const db = readDb();
  const accessibleIds = getAccessibleEmployeeIds(db, req.user);

  let records = [...db.attendance];
  if (accessibleIds) records = records.filter((a) => accessibleIds.includes(a.employeeId));
  records = filterRecordsByDate(records, req.query);

  if (req.query.employeeId) {
    records = records.filter((a) => a.employeeId === parseInt(req.query.employeeId, 10));
  }
  if (req.query.status) {
    records = records.filter((a) => a.status === req.query.status);
  }
  if (req.query.department) {
    const empIdsInDept = new Set(
      db.employees.filter((e) => e.department.toLowerCase() === String(req.query.department).toLowerCase()).map((e) => e.id)
    );
    records = records.filter((a) => empIdsInDept.has(a.employeeId));
  }

  records.sort((a, b) => (a.date < b.date ? 1 : -1));
  res.json({ success: true, records });
});

// GET /api/attendance/summary (admin: company-wide; manager: own dept) - dashboard stats for today
router.get('/summary', authenticate, requireManagerOrAdmin, (req, res) => {
  const db = readDb();
  const today = todayStr();
  const accessibleIds = getAccessibleEmployeeIds(db, req.user);
  const activeEmployees = db.employees.filter(
    (e) => e.role === 'employee' && e.status === 'active' && (!accessibleIds || accessibleIds.includes(e.id))
  );
  const todaysRecords = db.attendance.filter(
    (a) => a.date === today && (!accessibleIds || accessibleIds.includes(a.employeeId))
  );

  const presentIds = new Set(todaysRecords.filter((r) => r.punchIn).map((r) => r.employeeId));
  const lateCount = todaysRecords.filter((r) => r.status === 'late').length;
  const stillWorking = todaysRecords.filter((r) => r.punchIn && !r.punchOut).length;

  res.json({
    success: true,
    date: today,
    totalEmployees: activeEmployees.length,
    presentToday: presentIds.size,
    absentToday: Math.max(0, activeEmployees.length - presentIds.size),
    lateToday: lateCount,
    currentlyWorking: stillWorking
  });
});

// GET /api/attendance/export?month=&year=&employeeId=&date=&fromDate=&toDate= (admin) - CSV export
router.get('/export', authenticate, requireAdmin, (req, res) => {
  const db = readDb();
  let records = [...db.attendance];
  records = filterRecordsByDate(records, req.query);

  if (req.query.employeeId) {
    records = records.filter((a) => a.employeeId === parseInt(req.query.employeeId, 10));
  }
  records.sort((a, b) => (a.date < b.date ? 1 : -1));

  const empMap = {};
  db.employees.forEach((e) => (empMap[e.id] = e));

  let csv = 'Employee Code,Employee Name,Department,Date,Punch In,Punch Out,Work Hours,Status\n';
  records.forEach((r) => {
    const emp = empMap[r.employeeId] || {};
    csv += `${emp.empCode || ''},${r.employeeName},${emp.department || ''},${r.date},${r.punchIn || '-'},${r.punchOut || '-'},${r.workHours || '-'},${r.status}\n`;
  });

  let filenameSuffix;
  if (req.query.date) filenameSuffix = req.query.date;
  else if (req.query.fromDate || req.query.toDate) filenameSuffix = `${req.query.fromDate || 'start'}_to_${req.query.toDate || 'end'}`;
  else {
    const now = new Date();
    const month = parseInt(req.query.month, 10) || now.getMonth() + 1;
    const year = parseInt(req.query.year, 10) || now.getFullYear();
    filenameSuffix = `${year}-${String(month).padStart(2, '0')}`;
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${filenameSuffix}.csv"`);
  res.send(csv);
});

// POST /api/attendance/manual (admin) - manually add or correct an attendance entry
// Useful for fixing a missed punch-in/out. Body: { employeeId, date, punchIn, punchOut, status, note }
router.post('/manual', authenticate, requireAdmin, (req, res) => {
  const { employeeId, date, punchIn, punchOut, status, note } = req.body;

  if (!employeeId || !date) {
    return res.status(400).json({ success: false, message: 'employeeId and date are required' });
  }

  const db = readDb();
  const emp = db.employees.find((e) => e.id === parseInt(employeeId, 10));
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

  let record = db.attendance.find((a) => a.employeeId === emp.id && a.date === date);

  let workMinutes = 0;
  let workHours = null;
  if (punchIn && punchOut) {
    workMinutes = minutesBetween(date, punchIn.length === 5 ? punchIn + ':00' : punchIn, punchOut.length === 5 ? punchOut + ':00' : punchOut);
    workHours = formatDuration(workMinutes);
  }

  if (record) {
    record.punchIn = punchIn ? (punchIn.length === 5 ? punchIn + ':00' : punchIn) : null;
    record.punchOut = punchOut ? (punchOut.length === 5 ? punchOut + ':00' : punchOut) : null;
    record.workMinutes = workMinutes;
    record.workHours = workHours;
    record.status = status || record.status;
    record.note = note !== undefined ? note : record.note;
  } else {
    record = {
      id: db.counters.attendanceId++,
      employeeId: emp.id,
      employeeName: emp.name,
      date,
      punchIn: punchIn ? (punchIn.length === 5 ? punchIn + ':00' : punchIn) : null,
      punchOut: punchOut ? (punchOut.length === 5 ? punchOut + ':00' : punchOut) : null,
      workMinutes,
      workHours,
      status: status || 'present',
      note: note || ''
    };
    db.attendance.push(record);
  }

  writeDb(db);
  res.json({ success: true, message: 'Attendance entry saved successfully', record });
});

// DELETE /api/attendance/:id (admin) - remove a single attendance record
router.delete('/:id', authenticate, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = readDb();
  const idx = db.attendance.findIndex((a) => a.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Attendance record not found' });

  db.attendance.splice(idx, 1);
  writeDb(db);
  res.json({ success: true, message: 'Attendance record deleted' });
});

module.exports = router;
