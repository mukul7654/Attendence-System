// Performance Dashboard - Attendance %, Leaves used, Late Count, Overtime, and a
// composite Performance Score, computed straight from existing attendance/leave data
// (no separate "performance" data entry needed - it's always in sync).
const express = require('express');
const { readDb } = require('../utils/db');
const { authenticate, requireManagerOrAdmin, getAccessibleEmployeeIds } = require('../middleware/auth');

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
function formatDuration(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${h}h ${m}m`;
}

// Computes { attendancePercentage, presentDays, lateDays, absentDays, leaveDaysUsed,
// overtimeMinutes, overtimeHours, workingDaysSoFar, score } for one employee/month.
//
// Score formula (out of 100), transparent and simple by design:
//   50% weight -> Attendance % (days attended / working days so far)
//   30% weight -> Punctuality rate (non-late days / days attended)
//   20% weight -> Leave discipline (100, minus 5 points per leave day taken that month, floor 0)
// This rewards consistent, on-time attendance while not over-punishing planned/approved leave.
function computeEmployeePerformance(db, employeeId, month, year) {
  const emp = db.employees.find((e) => e.id === employeeId);
  if (!emp) return null;

  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const now = new Date();
  const records = db.attendance.filter((a) => a.employeeId === employeeId && a.date.startsWith(prefix));

  const presentDays = records.filter((r) => r.punchIn && r.status !== 'late').length;
  const lateDays = records.filter((r) => r.status === 'late').length;
  const attendedDays = records.filter((r) => r.punchIn).length;
  const overtimeMinutes = records.reduce((sum, r) => sum + (r.overtimeMinutes || 0), 0);

  const leaveDaysUsed = db.leaveRequests
    .filter((l) => l.employeeId === employeeId && l.status === 'approved' && l.fromDate.startsWith(String(year)))
    .filter((l) => l.fromDate <= `${prefix}-31` && l.toDate >= `${prefix}-01`)
    .reduce((sum, l) => sum + l.days, 0);

  const daysInMonth = new Date(year, month, 0).getDate();
  const lastDay = (year === now.getFullYear() && month === now.getMonth() + 1) ? now.getDate() : daysInMonth;
  let workingDaysSoFar = 0;
  for (let d = 1; d <= lastDay; d++) {
    const dateStr = `${prefix}-${String(d).padStart(2, '0')}`;
    if (!isWeeklyOff(db.settings, emp.department, dateStr) && !isHoliday(db.settings, dateStr)) workingDaysSoFar++;
  }
  const absentDays = Math.max(0, workingDaysSoFar - attendedDays - Math.round(leaveDaysUsed));

  const attendancePercentage = workingDaysSoFar > 0 ? (attendedDays / workingDaysSoFar) * 100 : 100;
  const punctualityRate = attendedDays > 0 ? (presentDays / attendedDays) * 100 : 100;
  const leaveDiscipline = Math.max(0, 100 - leaveDaysUsed * 5);

  const score = Math.round(attendancePercentage * 0.5 + punctualityRate * 0.3 + leaveDiscipline * 0.2);

  return {
    employeeId,
    employeeName: emp.name,
    empCode: emp.empCode,
    department: emp.department,
    designation: emp.designation,
    month, year,
    workingDaysSoFar,
    attendedDays,
    presentDays,
    lateDays,
    absentDays,
    leaveDaysUsed: Math.round(leaveDaysUsed * 10) / 10,
    overtimeMinutes,
    overtimeHours: formatDuration(overtimeMinutes),
    attendancePercentage: Math.round(attendancePercentage),
    punctualityRate: Math.round(punctualityRate),
    score: Math.max(0, Math.min(100, score))
  };
}

function resolveMonthYear(query) {
  const now = new Date();
  return {
    month: parseInt(query.month, 10) || now.getMonth() + 1,
    year: parseInt(query.year, 10) || now.getFullYear()
  };
}

// GET /api/performance/me?month=&year= - my own performance (any authenticated user)
router.get('/me', authenticate, (req, res) => {
  const db = readDb();
  const { month, year } = resolveMonthYear(req.query);
  const perf = computeEmployeePerformance(db, req.user.id, month, year);
  if (!perf) return res.status(404).json({ success: false, message: 'Employee not found' });
  res.json({ success: true, performance: perf });
});

// GET /api/performance/all?month=&year=&department= (admin: everyone; manager: own dept) - leaderboard
router.get('/all', authenticate, requireManagerOrAdmin, (req, res) => {
  const db = readDb();
  const { month, year } = resolveMonthYear(req.query);
  const accessibleIds = getAccessibleEmployeeIds(db, req.user);

  let pool = db.employees.filter((e) => e.role === 'employee' && e.status === 'active' && (!accessibleIds || accessibleIds.includes(e.id)));
  if (req.query.department) {
    pool = pool.filter((e) => e.department.toLowerCase() === String(req.query.department).toLowerCase());
  }

  const list = pool
    .map((e) => computeEmployeePerformance(db, e.id, month, year))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  res.json({ success: true, month, year, performance: list });
});

// GET /api/performance/:id?month=&year= (admin: any; manager: own dept; employee: self only)
router.get('/:id', authenticate, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = readDb();

  if (req.user.role === 'employee' && req.user.id !== id) {
    return res.status(403).json({ success: false, message: 'You can only view your own performance' });
  }
  if (req.user.role === 'manager') {
    const accessibleIds = getAccessibleEmployeeIds(db, req.user);
    if (!accessibleIds.includes(id)) {
      return res.status(403).json({ success: false, message: 'You do not have access to this employee' });
    }
  }

  const { month, year } = resolveMonthYear(req.query);
  const perf = computeEmployeePerformance(db, id, month, year);
  if (!perf) return res.status(404).json({ success: false, message: 'Employee not found' });
  res.json({ success: true, performance: perf });
});

module.exports = router;
