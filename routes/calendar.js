const express = require('express');
const { readDb } = require('../utils/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate(); // month is 1-indexed here
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// GET /api/calendar?month=&year=&employeeId=(admin/manager only)
// Returns a day-by-day view of the given month for the target employee
// (defaults to the logged-in user): weekly off, holiday, leave, and
// attendance status for every date.
router.get('/', authenticate, (req, res) => {
  const db = readDb();
  const now = new Date();
  const year = parseInt(req.query.year, 10) || now.getFullYear();
  const month = parseInt(req.query.month, 10) || now.getMonth() + 1; // 1-12

  let targetId = req.user.id;
  if (req.query.employeeId && (req.user.role === 'admin' || req.user.role === 'manager')) {
    targetId = parseInt(req.query.employeeId, 10);
  }

  const emp = db.employees.find((e) => e.id === targetId);
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

  // Managers may only view calendars for people in their own department
  if (req.user.role === 'manager') {
    const self = db.employees.find((e) => e.id === req.user.id);
    if (!self || self.department !== emp.department) {
      return res.status(403).json({ success: false, message: 'You do not have access to this employee' });
    }
  } else if (req.user.role === 'employee' && targetId !== req.user.id) {
    return res.status(403).json({ success: false, message: 'You can only view your own calendar' });
  }

  const settings = db.settings;
  const weeklyOffMap = settings.weeklyOffByDepartment || {};
  const offDays = weeklyOffMap[emp.department] || weeklyOffMap._default || [0];
  const holidays = settings.holidays || [];

  const monthPrefix = `${year}-${pad2(month)}`;
  const attendanceByDate = {};
  db.attendance
    .filter((a) => a.employeeId === targetId && a.date.startsWith(monthPrefix))
    .forEach((a) => { attendanceByDate[a.date] = a; });

  const leaveByDate = {};
  db.leaveRequests
    .filter((l) => l.employeeId === targetId && l.status === 'approved')
    .forEach((l) => {
      let d = new Date(`${l.fromDate}T00:00:00`);
      const to = new Date(`${l.toDate}T00:00:00`);
      while (d <= to) {
        const ds = d.toISOString().slice(0, 10);
        if (ds.startsWith(monthPrefix)) leaveByDate[ds] = l.leaveType;
        d.setDate(d.getDate() + 1);
      }
    });

  const total = daysInMonth(year, month);
  const days = [];
  for (let day = 1; day <= total; day++) {
    const dateStr = `${monthPrefix}-${pad2(day)}`;
    const weekday = new Date(`${dateStr}T00:00:00`).getDay();
    const holiday = holidays.find((h) => h.date === dateStr);
    const isWeekOff = offDays.includes(weekday);
    const attendance = attendanceByDate[dateStr] || null;
    const onLeave = leaveByDate[dateStr] || null;

    let dayType = 'workday';
    if (holiday) dayType = 'holiday';
    else if (isWeekOff) dayType = 'weekoff';
    if (onLeave) dayType = 'leave';

    days.push({
      date: dateStr,
      weekday,
      dayType,
      holidayName: holiday ? holiday.name : null,
      holidayIcon: holiday ? (holiday.icon || '🎉') : null,
      leaveType: onLeave,
      attendanceStatus: attendance ? attendance.status : null,
      punchIn: attendance ? attendance.punchIn : null,
      punchOut: attendance ? attendance.punchOut : null
    });
  }

  res.json({
    success: true,
    year,
    month,
    employee: { id: emp.id, name: emp.name, department: emp.department },
    weeklyOffDays: offDays,
    days
  });
});

module.exports = router;
