const express = require('express');
const { readDb, writeDb } = require('../utils/db');
const { authenticate, requireAdmin, requireManagerOrAdmin, getAccessibleEmployeeIds } = require('../middleware/auth');
const events = require('../utils/events');
const { sendWhatsApp } = require('../utils/whatsapp');

const router = express.Router();

const LEAVE_TYPES = ['casual', 'sick', 'earned', 'unpaid'];
const LEAVE_TYPE_LABELS = { casual: 'Casual Leave', sick: 'Sick Leave', earned: 'Earned Leave', unpaid: 'Unpaid Leave' };

function daysInclusive(fromDate, toDate) {
  const from = new Date(`${fromDate}T00:00:00`);
  const to = new Date(`${toDate}T00:00:00`);
  const diff = Math.round((to - from) / 86400000) + 1;
  return Math.max(1, diff);
}

function currentYear() {
  return new Date().getFullYear();
}

// Returns the effective leave policy for one employee: company default with
// any per-employee override values merged on top.
function effectivePolicy(db, employeeId) {
  const base = db.leavePolicy;
  const override = (db.leavePolicyOverrides || {})[String(employeeId)] || {};
  return { ...base, ...override };
}

// Computes how many days of each leave type an employee has used (approved, this year)
// and returns balance = entitlement + credits - used, per type.
function computeBalance(db, employeeId, year) {
  const policy = effectivePolicy(db, employeeId);
  const used = { casual: 0, sick: 0, earned: 0, unpaid: 0 };
  const credited = { casual: 0, sick: 0, earned: 0, unpaid: 0 };

  db.leaveRequests
    .filter((l) => l.employeeId === employeeId && l.status === 'approved')
    .forEach((l) => {
      // Only count the portion of the leave that actually falls in the requested year
      if (String(l.fromDate).slice(0, 4) === String(year)) {
        used[l.leaveType] = (used[l.leaveType] || 0) + l.days;
      }
    });

  (db.leaveCredits || [])
    .filter((c) => c.employeeId === employeeId && String(c.creditedOn).slice(0, 4) === String(year))
    .forEach((c) => { credited[c.type] = (credited[c.type] || 0) + c.amount; });

  return LEAVE_TYPES.map((type) => ({
    type,
    label: LEAVE_TYPE_LABELS[type],
    entitlement: policy[type] || 0,
    credited: credited[type] || 0,
    used: used[type] || 0,
    balance: type === 'unpaid' ? null : Math.max(0, (policy[type] || 0) + (credited[type] || 0) - (used[type] || 0)),
    isOverridden: type !== 'unpaid' && (db.leavePolicyOverrides[String(employeeId)] || {})[type] !== undefined
  }));
}

// GET /api/leave/policy - view current leave policy (any authenticated user)
router.get('/policy', authenticate, (req, res) => {
  const db = readDb();
  res.json({ success: true, policy: db.leavePolicy });
});

// PUT /api/leave/policy (admin) - update annual leave entitlements
router.put('/policy', authenticate, requireAdmin, (req, res) => {
  const { casual, sick, earned, notes } = req.body;
  const db = readDb();
  if (casual !== undefined) db.leavePolicy.casual = Math.max(0, parseInt(casual, 10) || 0);
  if (sick !== undefined) db.leavePolicy.sick = Math.max(0, parseInt(sick, 10) || 0);
  if (earned !== undefined) db.leavePolicy.earned = Math.max(0, parseInt(earned, 10) || 0);
  if (notes !== undefined) db.leavePolicy.notes = String(notes);
  writeDb(db);
  events.broadcast('leave-policy-updated', { scope: 'company', policy: db.leavePolicy });
  res.json({ success: true, message: 'Leave policy updated successfully', policy: db.leavePolicy });
});

// GET /api/leave/policy/employees (admin/manager) - effective policy for every accessible employee,
// flagging which types have a custom (per-employee) override. Used by the admin "Leave Policy" screen.
router.get('/policy/employees', authenticate, requireManagerOrAdmin, (req, res) => {
  const db = readDb();
  const accessibleIds = getAccessibleEmployeeIds(db, req.user);
  const list = db.employees
    .filter((e) => e.role === 'employee' && (!accessibleIds || accessibleIds.includes(e.id)))
    .map((e) => {
      const override = (db.leavePolicyOverrides || {})[String(e.id)] || {};
      return {
        employeeId: e.id,
        name: e.name,
        empCode: e.empCode,
        department: e.department,
        policy: effectivePolicy(db, e.id),
        override
      };
    });
  res.json({ success: true, defaultPolicy: db.leavePolicy, employees: list });
});

// PUT /api/leave/policy/:employeeId (admin: any employee; manager: only their own team) -
// set a per-employee override for casual/sick/earned entitlements. Send a value of
// null (or omit) to clear an override and fall back to the company default.
router.put('/policy/:employeeId', authenticate, requireManagerOrAdmin, (req, res) => {
  const employeeId = parseInt(req.params.employeeId, 10);
  const db = readDb();
  const accessibleIds = getAccessibleEmployeeIds(db, req.user);
  if (accessibleIds && !accessibleIds.includes(employeeId)) {
    return res.status(403).json({ success: false, message: 'You do not have access to this employee' });
  }
  const emp = db.employees.find((e) => e.id === employeeId);
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

  const { casual, sick, earned } = req.body;
  db.leavePolicyOverrides = db.leavePolicyOverrides || {};
  const key = String(employeeId);
  const override = { ...(db.leavePolicyOverrides[key] || {}) };

  [['casual', casual], ['sick', sick], ['earned', earned]].forEach(([type, value]) => {
    if (value === null || value === '') {
      delete override[type];
    } else if (value !== undefined) {
      override[type] = Math.max(0, parseInt(value, 10) || 0);
    }
  });

  if (Object.keys(override).length === 0) {
    delete db.leavePolicyOverrides[key];
  } else {
    db.leavePolicyOverrides[key] = override;
  }

  writeDb(db);
  events.broadcast('leave-policy-updated', { scope: 'employee', employeeId, employeeName: emp.name, policy: effectivePolicy(db, employeeId) });
  res.json({
    success: true,
    message: `Leave policy updated for ${emp.name}`,
    policy: effectivePolicy(db, employeeId),
    override: db.leavePolicyOverrides[key] || {}
  });
});

// POST /api/leave/credit (admin/manager, scoped to their team) - top up ONE employee's
// leave bucket (e.g. monthly earned-leave accrual, a correction, a goodwill bonus).
// This never touches any other employee's balance.
router.post('/credit', authenticate, requireManagerOrAdmin, (req, res) => {
  const { employeeId, type, amount, note } = req.body;
  const empId = parseInt(employeeId, 10);
  const amt = parseFloat(amount);

  if (!empId || !LEAVE_TYPES.includes(type) || type === 'unpaid') {
    return res.status(400).json({ success: false, message: 'A valid employee and leave type (casual/sick/earned) are required' });
  }
  if (!amt || amt <= 0) {
    return res.status(400).json({ success: false, message: 'Credit amount must be a positive number of days' });
  }

  const db = readDb();
  const accessibleIds = getAccessibleEmployeeIds(db, req.user);
  if (accessibleIds && !accessibleIds.includes(empId)) {
    return res.status(403).json({ success: false, message: 'You do not have access to this employee' });
  }
  const emp = db.employees.find((e) => e.id === empId);
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

  db.leaveCredits = db.leaveCredits || [];
  const credit = {
    id: db.counters.leaveCreditId++,
    employeeId: empId,
    employeeName: emp.name,
    type,
    amount: amt,
    note: (note || '').trim(),
    creditedBy: req.user.name,
    creditedOn: new Date().toISOString()
  };
  db.leaveCredits.push(credit);
  writeDb(db);
  events.broadcast('leave-credited', { employeeId: empId, employeeName: emp.name, type, amount: amt });

  res.status(201).json({
    success: true,
    message: `${amt} day(s) of ${LEAVE_TYPE_LABELS[type]} credited to ${emp.name}'s balance`,
    credit,
    balance: computeBalance(db, empId, new Date().getFullYear())
  });
});

// GET /api/leave/credits?employeeId= - credit history (admin/manager scoped; employee sees only their own)
router.get('/credits', authenticate, (req, res) => {
  const db = readDb();
  let list = [...(db.leaveCredits || [])];

  if (req.user.role === 'employee') {
    list = list.filter((c) => c.employeeId === req.user.id);
  } else {
    const accessibleIds = getAccessibleEmployeeIds(db, req.user);
    if (accessibleIds) list = list.filter((c) => accessibleIds.includes(c.employeeId));
    if (req.query.employeeId) list = list.filter((c) => c.employeeId === parseInt(req.query.employeeId, 10));
  }

  list.sort((a, b) => (a.creditedOn < b.creditedOn ? 1 : -1));
  res.json({ success: true, credits: list });
});

// GET /api/leave/balance - own leave balance (employee) for a given year (default current)
router.get('/balance', authenticate, (req, res) => {
  const db = readDb();
  const year = parseInt(req.query.year, 10) || currentYear();
  res.json({ success: true, year, balance: computeBalance(db, req.user.id, year) });
});

// GET /api/leave/balance/:employeeId (admin/manager) - view any accessible employee's balance
router.get('/balance/:employeeId', authenticate, requireManagerOrAdmin, (req, res) => {
  const db = readDb();
  const employeeId = parseInt(req.params.employeeId, 10);
  const year = parseInt(req.query.year, 10) || currentYear();

  const accessibleIds = getAccessibleEmployeeIds(db, req.user);
  if (accessibleIds && !accessibleIds.includes(employeeId)) {
    return res.status(403).json({ success: false, message: 'You do not have access to this employee' });
  }

  const emp = db.employees.find((e) => e.id === employeeId);
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
  res.json({ success: true, year, balance: computeBalance(db, employeeId, year) });
});

// POST /api/leave/apply - employee applies for leave
router.post('/apply', authenticate, (req, res) => {
  const { leaveType, fromDate, toDate, reason } = req.body;

  if (!leaveType || !LEAVE_TYPES.includes(leaveType)) {
    return res.status(400).json({ success: false, message: 'A valid leave type is required' });
  }
  if (!fromDate || !toDate) {
    return res.status(400).json({ success: false, message: 'From date and to date are required' });
  }
  if (fromDate > toDate) {
    return res.status(400).json({ success: false, message: '"From date" cannot be after "to date"' });
  }
  if (!reason || !reason.trim()) {
    return res.status(400).json({ success: false, message: 'Please provide a reason for the leave' });
  }

  const db = readDb();
  const emp = db.employees.find((e) => e.id === req.user.id);
  if (!emp) return res.status(404).json({ success: false, message: 'User not found' });

  const days = daysInclusive(fromDate, toDate);

  // Warn (but still allow, since admin can review) if this would exceed remaining balance
  const year = parseInt(fromDate.slice(0, 4), 10);
  const balanceRow = computeBalance(db, req.user.id, year).find((b) => b.type === leaveType);
  const exceedsBalance = balanceRow && balanceRow.balance !== null && days > balanceRow.balance;

  const record = {
    id: db.counters.leaveId++,
    employeeId: emp.id,
    employeeName: emp.name,
    leaveType,
    fromDate,
    toDate,
    days,
    reason: reason.trim(),
    status: 'pending',
    appliedOn: new Date().toISOString(),
    decidedOn: null,
    decidedBy: null,
    adminNote: ''
  };
  db.leaveRequests.push(record);
  writeDb(db);
  events.broadcast('leave-applied', { employeeId: emp.id, employeeName: emp.name, leaveType, fromDate, toDate, days });
  if (db.settings.whatsapp.notifyOnLeaveApplied) {
    sendWhatsApp({
      employeeId: emp.id, employeeName: emp.name, phone: emp.phone,
      event: 'leave-applied', message: `Hi ${emp.name.split(' ')[0]}, your ${LEAVE_TYPE_LABELS[leaveType]} request for ${fromDate} to ${toDate} (${days} day${days > 1 ? 's' : ''}) has been submitted and is pending approval. - Maxim Realty`
    }).catch(() => {});
  }

  res.status(201).json({
    success: true,
    message: exceedsBalance
      ? `Leave request submitted. Note: this exceeds your remaining ${LEAVE_TYPE_LABELS[leaveType]} balance for ${year}.`
      : 'Leave request submitted successfully',
    record
  });
});

// POST /api/leave/apply-for/:employeeId (admin/manager, scoped to their team)
// Lets a manager/admin directly record a leave for an employee (e.g. the
// employee called in sick, or asked in person). It is auto-approved since the
// admin/manager is initiating it themselves.
router.post('/apply-for/:employeeId', authenticate, requireManagerOrAdmin, (req, res) => {
  const employeeId = parseInt(req.params.employeeId, 10);
  const { leaveType, fromDate, toDate, reason } = req.body;

  if (!leaveType || !LEAVE_TYPES.includes(leaveType)) {
    return res.status(400).json({ success: false, message: 'A valid leave type is required' });
  }
  if (!fromDate || !toDate) {
    return res.status(400).json({ success: false, message: 'From date and to date are required' });
  }
  if (fromDate > toDate) {
    return res.status(400).json({ success: false, message: '"From date" cannot be after "to date"' });
  }

  const db = readDb();
  const accessibleIds = getAccessibleEmployeeIds(db, req.user);
  if (accessibleIds && !accessibleIds.includes(employeeId)) {
    return res.status(403).json({ success: false, message: 'You do not have access to this employee' });
  }

  const emp = db.employees.find((e) => e.id === employeeId);
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

  const days = daysInclusive(fromDate, toDate);

  const record = {
    id: db.counters.leaveId++,
    employeeId: emp.id,
    employeeName: emp.name,
    leaveType,
    fromDate,
    toDate,
    days,
    reason: (reason || '').trim() || `Recorded by ${req.user.name}`,
    status: 'approved',
    appliedOn: new Date().toISOString(),
    decidedOn: new Date().toISOString(),
    decidedBy: req.user.name,
    adminNote: 'Applied directly by admin/manager on behalf of the employee'
  };
  db.leaveRequests.push(record);
  writeDb(db);
  events.broadcast('leave-applied', { employeeId: emp.id, employeeName: emp.name, leaveType, fromDate, toDate, days });

  res.status(201).json({ success: true, message: `${LEAVE_TYPE_LABELS[leaveType]} recorded for ${emp.name} and auto-approved`, record });
});

// GET /api/leave/my - employee's own leave history (optional ?status=&fromDate=&toDate=)
router.get('/my', authenticate, (req, res) => {
  const db = readDb();
  let records = db.leaveRequests.filter((l) => l.employeeId === req.user.id);
  if (req.query.status) records = records.filter((l) => l.status === req.query.status);
  if (req.query.fromDate) records = records.filter((l) => l.toDate >= req.query.fromDate);
  if (req.query.toDate) records = records.filter((l) => l.fromDate <= req.query.toDate);
  records.sort((a, b) => (a.appliedOn < b.appliedOn ? 1 : -1));
  res.json({ success: true, records });
});

// PUT /api/leave/:id/cancel - employee cancels their own pending request
router.put('/:id/cancel', authenticate, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = readDb();
  const record = db.leaveRequests.find((l) => l.id === id);
  if (!record) return res.status(404).json({ success: false, message: 'Leave request not found' });
  if (record.employeeId !== req.user.id) {
    return res.status(403).json({ success: false, message: 'You can only cancel your own leave requests' });
  }
  if (record.status !== 'pending') {
    return res.status(400).json({ success: false, message: 'Only pending requests can be cancelled' });
  }
  record.status = 'cancelled';
  record.decidedOn = new Date().toISOString();
  writeDb(db);
  res.json({ success: true, message: 'Leave request cancelled', record });
});

// GET /api/leave/all (admin/manager) - view accessible leave requests, optional ?status=&employeeId=&fromDate=&toDate=
router.get('/all', authenticate, requireManagerOrAdmin, (req, res) => {
  const db = readDb();
  let records = [...db.leaveRequests];

  const accessibleIds = getAccessibleEmployeeIds(db, req.user);
  if (accessibleIds) records = records.filter((l) => accessibleIds.includes(l.employeeId));

  if (req.query.status) records = records.filter((l) => l.status === req.query.status);
  if (req.query.employeeId) records = records.filter((l) => l.employeeId === parseInt(req.query.employeeId, 10));
  if (req.query.fromDate) records = records.filter((l) => l.toDate >= req.query.fromDate);
  if (req.query.toDate) records = records.filter((l) => l.fromDate <= req.query.toDate);

  records.sort((a, b) => (a.appliedOn < b.appliedOn ? 1 : -1));
  res.json({ success: true, records });
});

// PUT /api/leave/:id/approve (admin/manager, scoped to their team)
router.put('/:id/approve', authenticate, requireManagerOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = readDb();
  const record = db.leaveRequests.find((l) => l.id === id);
  if (!record) return res.status(404).json({ success: false, message: 'Leave request not found' });

  const accessibleIds = getAccessibleEmployeeIds(db, req.user);
  if (accessibleIds && !accessibleIds.includes(record.employeeId)) {
    return res.status(403).json({ success: false, message: 'You do not have access to this leave request' });
  }
  if (record.employeeId === req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'You cannot approve your own leave request - ask an admin to review it' });
  }
  if (record.status !== 'pending') {
    return res.status(400).json({ success: false, message: 'This request has already been decided' });
  }
  record.status = 'approved';
  record.decidedOn = new Date().toISOString();
  record.decidedBy = req.user.name;
  record.adminNote = req.body.adminNote || '';
  writeDb(db);
  events.broadcast('leave-decided', { employeeId: record.employeeId, employeeName: record.employeeName, status: 'approved' });
  if (db.settings.whatsapp.notifyOnLeaveDecided) {
    const emp = db.employees.find((e) => e.id === record.employeeId);
    sendWhatsApp({
      employeeId: record.employeeId, employeeName: record.employeeName, phone: emp ? emp.phone : null,
      event: 'leave-decided', message: `Hi ${record.employeeName.split(' ')[0]}, your ${LEAVE_TYPE_LABELS[record.leaveType]} request (${record.fromDate} to ${record.toDate}) has been APPROVED. - Maxim Realty`
    }).catch(() => {});
  }
  res.json({ success: true, message: 'Leave request approved', record });
});

// PUT /api/leave/:id/reject (admin/manager, scoped to their team)
router.put('/:id/reject', authenticate, requireManagerOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = readDb();
  const record = db.leaveRequests.find((l) => l.id === id);
  if (!record) return res.status(404).json({ success: false, message: 'Leave request not found' });

  const accessibleIds = getAccessibleEmployeeIds(db, req.user);
  if (accessibleIds && !accessibleIds.includes(record.employeeId)) {
    return res.status(403).json({ success: false, message: 'You do not have access to this leave request' });
  }
  if (record.employeeId === req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'You cannot decide your own leave request - ask an admin to review it' });
  }
  if (record.status !== 'pending') {
    return res.status(400).json({ success: false, message: 'This request has already been decided' });
  }
  record.status = 'rejected';
  record.decidedOn = new Date().toISOString();
  record.decidedBy = req.user.name;
  record.adminNote = req.body.adminNote || '';
  writeDb(db);
  events.broadcast('leave-decided', { employeeId: record.employeeId, employeeName: record.employeeName, status: 'rejected' });
  if (db.settings.whatsapp.notifyOnLeaveDecided) {
    const emp = db.employees.find((e) => e.id === record.employeeId);
    sendWhatsApp({
      employeeId: record.employeeId, employeeName: record.employeeName, phone: emp ? emp.phone : null,
      event: 'leave-decided', message: `Hi ${record.employeeName.split(' ')[0]}, your ${LEAVE_TYPE_LABELS[record.leaveType]} request (${record.fromDate} to ${record.toDate}) has been REJECTED.${record.adminNote ? ` Note: ${record.adminNote}` : ''} - Maxim Realty`
    }).catch(() => {});
  }
  res.json({ success: true, message: 'Leave request rejected', record });
});

module.exports = router;
