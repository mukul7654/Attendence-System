const express = require('express');
const { readDb, writeDb } = require('../utils/db');
const { authenticate, requireAdmin, requireManagerOrAdmin, getAccessibleEmployeeIds } = require('../middleware/auth');
const events = require('../utils/events');

const router = express.Router();

function normalizeTime(t) {
  if (!t) return null;
  return t.length === 5 ? `${t}:00` : t;
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

// POST /api/regularization/apply - employee requests a correction for a specific date
router.post('/apply', authenticate, (req, res) => {
  const { date, requestedPunchIn, requestedPunchOut, reason } = req.body;

  if (!date) return res.status(400).json({ success: false, message: 'Date is required' });
  if (!requestedPunchIn && !requestedPunchOut) {
    return res.status(400).json({ success: false, message: 'Please provide at least a punch-in or punch-out time' });
  }
  if (!reason || !reason.trim()) {
    return res.status(400).json({ success: false, message: 'Please provide a reason for this regularization request' });
  }

  const db = readDb();
  const emp = db.employees.find((e) => e.id === req.user.id);
  if (!emp) return res.status(404).json({ success: false, message: 'User not found' });

  const existingPending = db.regularizations.find(
    (r) => r.employeeId === emp.id && r.date === date && r.status === 'pending'
  );
  if (existingPending) {
    return res.status(409).json({ success: false, message: 'You already have a pending regularization request for this date' });
  }

  const existingRecord = db.attendance.find((a) => a.employeeId === emp.id && a.date === date) || null;

  const record = {
    id: db.counters.regularizationId++,
    employeeId: emp.id,
    employeeName: emp.name,
    date,
    requestedPunchIn: normalizeTime(requestedPunchIn),
    requestedPunchOut: normalizeTime(requestedPunchOut),
    existingPunchIn: existingRecord ? existingRecord.punchIn : null,
    existingPunchOut: existingRecord ? existingRecord.punchOut : null,
    reason: reason.trim(),
    status: 'pending',
    appliedOn: new Date().toISOString(),
    decidedOn: null,
    decidedBy: null,
    adminNote: ''
  };
  db.regularizations.push(record);
  writeDb(db);
  events.broadcast('regularization-applied', { employeeId: emp.id, employeeName: emp.name, date });

  res.status(201).json({ success: true, message: 'Regularization request submitted successfully', record });
});

// GET /api/regularization/my - employee's own requests
router.get('/my', authenticate, (req, res) => {
  const db = readDb();
  let records = db.regularizations.filter((r) => r.employeeId === req.user.id);
  if (req.query.status) records = records.filter((r) => r.status === req.query.status);
  if (req.query.fromDate) records = records.filter((r) => r.date >= req.query.fromDate);
  if (req.query.toDate) records = records.filter((r) => r.date <= req.query.toDate);
  records.sort((a, b) => (a.appliedOn < b.appliedOn ? 1 : -1));
  res.json({ success: true, records });
});

// GET /api/regularization/all (admin/manager) - optional ?status=&employeeId=&fromDate=&toDate=
router.get('/all', authenticate, requireManagerOrAdmin, (req, res) => {
  const db = readDb();
  let records = [...db.regularizations];

  const accessibleIds = getAccessibleEmployeeIds(db, req.user);
  if (accessibleIds) records = records.filter((r) => accessibleIds.includes(r.employeeId));

  if (req.query.status) records = records.filter((r) => r.status === req.query.status);
  if (req.query.employeeId) records = records.filter((r) => r.employeeId === parseInt(req.query.employeeId, 10));
  if (req.query.fromDate) records = records.filter((r) => r.date >= req.query.fromDate);
  if (req.query.toDate) records = records.filter((r) => r.date <= req.query.toDate);

  records.sort((a, b) => (a.appliedOn < b.appliedOn ? 1 : -1));
  res.json({ success: true, records });
});

// PUT /api/regularization/:id/approve (admin/manager, scoped to their team) - applies the requested times to the attendance record
router.put('/:id/approve', authenticate, requireManagerOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = readDb();
  const reqRecord = db.regularizations.find((r) => r.id === id);
  if (!reqRecord) return res.status(404).json({ success: false, message: 'Regularization request not found' });

  const accessibleIds = getAccessibleEmployeeIds(db, req.user);
  if (accessibleIds && !accessibleIds.includes(reqRecord.employeeId)) {
    return res.status(403).json({ success: false, message: 'You do not have access to this request' });
  }
  if (reqRecord.employeeId === req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'You cannot approve your own request - ask an admin to review it' });
  }
  if (reqRecord.status !== 'pending') {
    return res.status(400).json({ success: false, message: 'This request has already been decided' });
  }

  let attRecord = db.attendance.find((a) => a.employeeId === reqRecord.employeeId && a.date === reqRecord.date);
  const punchIn = reqRecord.requestedPunchIn || (attRecord ? attRecord.punchIn : null);
  const punchOut = reqRecord.requestedPunchOut || (attRecord ? attRecord.punchOut : null);

  let workMinutes = 0;
  let workHours = null;
  if (punchIn && punchOut) {
    workMinutes = minutesBetween(reqRecord.date, punchIn, punchOut);
    workHours = formatDuration(workMinutes);
  }

  const settings = db.settings;
  const officeStart = settings.officeStartTime || '09:30';
  const lateThresholdMins = minutesBetween(reqRecord.date, '00:00:00', officeStart + ':00') + (settings.lateAfterMinutes || 15);
  const punchMinsFromMidnight = punchIn ? minutesBetween(reqRecord.date, '00:00:00', punchIn) : 0;
  const status = punchIn && punchMinsFromMidnight > lateThresholdMins ? 'late' : 'present';

  if (attRecord) {
    attRecord.punchIn = punchIn;
    attRecord.punchOut = punchOut;
    attRecord.workMinutes = workMinutes;
    attRecord.workHours = workHours;
    attRecord.status = status;
    attRecord.note = `Regularized: ${reqRecord.reason}`;
  } else {
    attRecord = {
      id: db.counters.attendanceId++,
      employeeId: reqRecord.employeeId,
      employeeName: reqRecord.employeeName,
      date: reqRecord.date,
      punchIn,
      punchOut,
      workMinutes,
      workHours,
      status,
      note: `Regularized: ${reqRecord.reason}`
    };
    db.attendance.push(attRecord);
  }

  reqRecord.status = 'approved';
  reqRecord.decidedOn = new Date().toISOString();
  reqRecord.decidedBy = req.user.name;
  reqRecord.adminNote = req.body.adminNote || '';

  writeDb(db);
  events.broadcast('regularization-decided', { employeeId: reqRecord.employeeId, employeeName: reqRecord.employeeName, status: 'approved', date: reqRecord.date });
  res.json({ success: true, message: 'Regularization approved and attendance updated', record: reqRecord, attendance: attRecord });
});

// PUT /api/regularization/:id/reject (admin/manager, scoped to their team)
router.put('/:id/reject', authenticate, requireManagerOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = readDb();
  const record = db.regularizations.find((r) => r.id === id);
  if (!record) return res.status(404).json({ success: false, message: 'Regularization request not found' });

  const accessibleIds = getAccessibleEmployeeIds(db, req.user);
  if (accessibleIds && !accessibleIds.includes(record.employeeId)) {
    return res.status(403).json({ success: false, message: 'You do not have access to this request' });
  }
  if (record.employeeId === req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'You cannot decide your own request - ask an admin to review it' });
  }
  if (record.status !== 'pending') {
    return res.status(400).json({ success: false, message: 'This request has already been decided' });
  }
  record.status = 'rejected';
  record.decidedOn = new Date().toISOString();
  record.decidedBy = req.user.name;
  record.adminNote = req.body.adminNote || '';
  writeDb(db);
  events.broadcast('regularization-decided', { employeeId: record.employeeId, employeeName: record.employeeName, status: 'rejected', date: record.date });
  res.json({ success: true, message: 'Regularization request rejected', record });
});

module.exports = router;
