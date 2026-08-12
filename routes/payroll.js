// Payroll + Incentive + Commission Calculator - real-estate style: sales staff earn a
// tiered commission on each closed deal, plus rule-based incentive bonuses (e.g. perfect
// attendance). This feeds numbers an admin can enter into a payslip's "Other Earnings" -
// it's a calculator/ledger, not a replacement for the existing Payslip generator.
const express = require('express');
const { readDb, writeDb } = require('../utils/db');
const { authenticate, requireAdmin, requireManagerOrAdmin, getAccessibleEmployeeIds } = require('../middleware/auth');

const router = express.Router();

function isWeeklyOff(settings, department, dateStr) {
  const weekday = new Date(`${dateStr}T00:00:00`).getDay();
  const map = settings.weeklyOffByDepartment || {};
  const days = map[department] || map._default || [0];
  return days.includes(weekday);
}
function isHoliday(settings, dateStr) {
  return (settings.holidays || []).some((h) => h.date === dateStr);
}

// Picks the commission rate for a given deal value from the configured tiers.
function rateForDealValue(tiers, dealValue) {
  const sorted = [...tiers].sort((a, b) => (a.upTo == null ? Infinity : a.upTo) - (b.upTo == null ? Infinity : b.upTo));
  const tier = sorted.find((t) => t.upTo == null || dealValue <= t.upTo);
  return tier ? tier.rate : 0;
}

// GET /api/payroll/config (admin only) - commission tiers + incentive rules
router.get('/config', authenticate, requireAdmin, (req, res) => {
  const db = readDb();
  res.json({ success: true, config: db.payrollConfig });
});

// PUT /api/payroll/config (admin only)
router.put('/config', authenticate, requireAdmin, (req, res) => {
  const { commissionEnabled, commissionTiers, incentiveRules } = req.body || {};
  const db = readDb();
  const cfg = db.payrollConfig;

  if (commissionEnabled !== undefined) cfg.commissionEnabled = !!commissionEnabled;
  if (Array.isArray(commissionTiers)) {
    cfg.commissionTiers = commissionTiers
      .map((t) => ({ upTo: t.upTo === '' || t.upTo == null ? null : Number(t.upTo), rate: Number(t.rate) || 0 }))
      .filter((t) => Number.isFinite(t.rate));
  }
  if (Array.isArray(incentiveRules)) {
    cfg.incentiveRules = incentiveRules
      .map((r) => ({ name: String(r.name || '').trim(), condition: String(r.condition || '').trim(), amount: Number(r.amount) || 0 }))
      .filter((r) => r.name && r.condition);
  }
  writeDb(db);
  res.json({ success: true, message: 'Payroll configuration updated', config: cfg });
});

// POST /api/payroll/commission (admin: any employee; manager: own team) - log a closed deal
// Body: { employeeId, dealValue, clientName, note, month ('YYYY-MM') }
router.post('/commission', authenticate, requireManagerOrAdmin, (req, res) => {
  const { employeeId, dealValue, clientName, note, month } = req.body || {};
  const value = Number(dealValue);
  if (!employeeId || !Number.isFinite(value) || value <= 0) {
    return res.status(400).json({ success: false, message: 'Employee and a valid deal value are required' });
  }
  const db = readDb();
  const emp = db.employees.find((e) => e.id === parseInt(employeeId, 10));
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

  const accessibleIds = getAccessibleEmployeeIds(db, req.user);
  if (accessibleIds && !accessibleIds.includes(emp.id)) {
    return res.status(403).json({ success: false, message: 'You do not have access to this employee' });
  }
  if (!db.payrollConfig.commissionEnabled) {
    return res.status(400).json({ success: false, message: 'Commission is currently disabled in Payroll settings' });
  }

  const rate = rateForDealValue(db.payrollConfig.commissionTiers, value);
  const amount = Math.round(value * (rate / 100) * 100) / 100;

  const entry = {
    id: db.counters.commissionEntryId++,
    employeeId: emp.id,
    employeeName: emp.name,
    dealValue: value,
    commissionRate: rate,
    commissionAmount: amount,
    clientName: (clientName || '').trim(),
    note: (note || '').trim(),
    month: month || new Date().toISOString().slice(0, 7),
    recordedBy: req.user.name,
    recordedAt: new Date().toISOString()
  };
  db.commissionEntries.push(entry);
  writeDb(db);
  res.status(201).json({ success: true, message: `Commission of ₹${amount.toLocaleString('en-IN')} (${rate}%) logged for ${emp.name}`, entry });
});

// GET /api/payroll/commission?employeeId=&month= (admin: everyone; manager: own team)
router.get('/commission', authenticate, requireManagerOrAdmin, (req, res) => {
  const db = readDb();
  const accessibleIds = getAccessibleEmployeeIds(db, req.user);
  let list = db.commissionEntries.filter((c) => !accessibleIds || accessibleIds.includes(c.employeeId));
  if (req.query.employeeId) list = list.filter((c) => c.employeeId === parseInt(req.query.employeeId, 10));
  if (req.query.month) list = list.filter((c) => c.month === req.query.month);
  list.sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1));
  const total = list.reduce((sum, c) => sum + c.commissionAmount, 0);
  res.json({ success: true, entries: list, totalCommission: Math.round(total * 100) / 100 });
});

// DELETE /api/payroll/commission/:id (admin only)
router.delete('/commission/:id', authenticate, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = readDb();
  const idx = db.commissionEntries.findIndex((c) => c.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Entry not found' });
  db.commissionEntries.splice(idx, 1);
  writeDb(db);
  res.json({ success: true, message: 'Commission entry removed' });
});

// GET /api/payroll/calculate/:employeeId?month=&year= (admin: any; manager: own team; employee: self)
// Suggests total incentive/commission pay for the month, based on commission entries logged
// plus rule-based incentive bonuses evaluated against that employee's real attendance stats.
router.get('/calculate/:employeeId', authenticate, (req, res) => {
  const employeeId = parseInt(req.params.employeeId, 10);
  const db = readDb();

  if (req.user.role === 'employee' && req.user.id !== employeeId) {
    return res.status(403).json({ success: false, message: 'You can only view your own payroll calculation' });
  }
  if (req.user.role === 'manager') {
    const accessibleIds = getAccessibleEmployeeIds(db, req.user);
    if (!accessibleIds.includes(employeeId)) {
      return res.status(403).json({ success: false, message: 'You do not have access to this employee' });
    }
  }

  const emp = db.employees.find((e) => e.id === employeeId);
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

  const now = new Date();
  const month = parseInt(req.query.month, 10) || now.getMonth() + 1;
  const year = parseInt(req.query.year, 10) || now.getFullYear();
  const prefix = `${year}-${String(month).padStart(2, '0')}`;

  // Commission earned this month
  const commissionEntries = db.commissionEntries.filter((c) => c.employeeId === employeeId && c.month === prefix);
  const commissionTotal = Math.round(commissionEntries.reduce((sum, c) => sum + c.commissionAmount, 0) * 100) / 100;

  // Attendance stats needed to evaluate incentive rule conditions
  const records = db.attendance.filter((a) => a.employeeId === employeeId && a.date.startsWith(prefix));
  const lateDays = records.filter((r) => r.status === 'late').length;
  const daysInMonth = new Date(year, month, 0).getDate();
  const lastDay = (year === now.getFullYear() && month === now.getMonth() + 1) ? now.getDate() : daysInMonth;
  let workingDaysSoFar = 0;
  for (let d = 1; d <= lastDay; d++) {
    const dateStr = `${prefix}-${String(d).padStart(2, '0')}`;
    if (!isWeeklyOff(db.settings, emp.department, dateStr) && !isHoliday(db.settings, dateStr)) workingDaysSoFar++;
  }
  const attendedDays = records.filter((r) => r.punchIn).length;
  const attendance = workingDaysSoFar > 0 ? Math.round((attendedDays / workingDaysSoFar) * 100) : 100;

  // Evaluate each incentive rule's simple condition (supports >=, <=, ==, >, < against
  // `attendance` or `lateDays`) against this employee's real numbers.
  const context = { attendance, lateDays };
  const incentiveBonuses = [];
  (db.payrollConfig.incentiveRules || []).forEach((rule) => {
    const match = rule.condition.match(/^(attendance|lateDays)\s*(>=|<=|==|>|<)\s*(\d+(\.\d+)?)$/);
    if (!match) return;
    const [, field, op, valueStr] = match;
    const actual = context[field];
    const target = parseFloat(valueStr);
    let met = false;
    if (op === '>=') met = actual >= target;
    else if (op === '<=') met = actual <= target;
    else if (op === '==') met = actual === target;
    else if (op === '>') met = actual > target;
    else if (op === '<') met = actual < target;
    if (met) incentiveBonuses.push({ name: rule.name, amount: rule.amount });
  });
  const incentiveTotal = incentiveBonuses.reduce((sum, b) => sum + b.amount, 0);

  res.json({
    success: true,
    employeeId, employeeName: emp.name, month, year,
    attendance, lateDays,
    commissionTotal, commissionEntries,
    incentiveBonuses, incentiveTotal,
    suggestedOtherEarnings: Math.round((commissionTotal + incentiveTotal) * 100) / 100
  });
});

module.exports = router;
