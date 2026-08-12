// AI Reports - "AI" here means automatically-generated insights from the attendance/leave
// data already in the system (rule-based analytics, not a hosted ML model - this app has
// no network access to an AI provider, so nothing here is invented or hallucinated; every
// number is calculated directly from real records).
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

function monthlyStatsFor(db, employeeIds, month, year) {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const now = new Date();
  const daysInMonth = new Date(year, month, 0).getDate();
  const lastDay = (year === now.getFullYear() && month === now.getMonth() + 1) ? now.getDate() : daysInMonth;

  return employeeIds.map((id) => {
    const emp = db.employees.find((e) => e.id === id);
    const records = db.attendance.filter((a) => a.employeeId === id && a.date.startsWith(prefix));
    const attendedDays = records.filter((r) => r.punchIn).length;
    const lateDays = records.filter((r) => r.status === 'late').length;
    const overtimeMinutes = records.reduce((sum, r) => sum + (r.overtimeMinutes || 0), 0);

    let workingDaysSoFar = 0;
    for (let d = 1; d <= lastDay; d++) {
      const dateStr = `${prefix}-${String(d).padStart(2, '0')}`;
      if (!isWeeklyOff(db.settings, emp.department, dateStr) && !isHoliday(db.settings, dateStr)) workingDaysSoFar++;
    }
    const leaveDays = db.leaveRequests
      .filter((l) => l.employeeId === id && l.status === 'approved' && l.fromDate.startsWith(String(year)))
      .filter((l) => l.fromDate <= `${prefix}-31` && l.toDate >= `${prefix}-01`)
      .reduce((sum, l) => sum + l.days, 0);
    const absentDays = Math.max(0, workingDaysSoFar - attendedDays - Math.round(leaveDays));
    const attendancePercentage = workingDaysSoFar > 0 ? Math.round((attendedDays / workingDaysSoFar) * 100) : 100;

    return {
      employeeId: id,
      employeeName: emp.name,
      department: emp.department,
      attendedDays, lateDays, absentDays, workingDaysSoFar,
      overtimeMinutes,
      attendancePercentage
    };
  });
}

// GET /api/reports/insights?month=&year= (admin: company-wide; manager: own dept)
router.get('/insights', authenticate, requireManagerOrAdmin, (req, res) => {
  const db = readDb();
  const now = new Date();
  const month = parseInt(req.query.month, 10) || now.getMonth() + 1;
  const year = parseInt(req.query.year, 10) || now.getFullYear();
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;

  const accessibleIds = getAccessibleEmployeeIds(db, req.user);
  const pool = db.employees.filter((e) => e.role === 'employee' && e.status === 'active' && (!accessibleIds || accessibleIds.includes(e.id)));
  const ids = pool.map((e) => e.id);

  const stats = monthlyStatsFor(db, ids, month, year);
  const prevStats = monthlyStatsFor(db, ids, prevMonth, prevYear);

  // ---- Most punctual employee ----
  const withAttendance = stats.filter((s) => s.attendedDays > 0);
  const mostPunctual = withAttendance.length
    ? [...withAttendance].sort((a, b) => (a.lateDays - b.lateDays) || (b.attendancePercentage - a.attendancePercentage))[0]
    : null;

  // ---- Frequently late employees (2+ late days this month) ----
  const frequentlyLate = stats
    .filter((s) => s.lateDays >= 2)
    .sort((a, b) => b.lateDays - a.lateDays)
    .slice(0, 8);

  // ---- Highest absenteeism ----
  const highestAbsenteeism = stats
    .filter((s) => s.absentDays > 0)
    .sort((a, b) => b.absentDays - a.absentDays)
    .slice(0, 8);

  // ---- Department attendance trend (this month vs last month) ----
  const deptNames = [...new Set(pool.map((e) => e.department))];
  const departmentTrend = deptNames.map((dept) => {
    const deptIds = pool.filter((e) => e.department === dept).map((e) => e.id);
    const cur = stats.filter((s) => deptIds.includes(s.employeeId));
    const prev = prevStats.filter((s) => deptIds.includes(s.employeeId));
    const avg = (arr) => arr.length ? Math.round(arr.reduce((sum, s) => sum + s.attendancePercentage, 0) / arr.length) : 0;
    const curAvg = avg(cur);
    const prevAvg = avg(prev);
    const delta = curAvg - prevAvg;
    return {
      department: dept,
      currentAttendancePercentage: curAvg,
      previousAttendancePercentage: prevAvg,
      delta,
      trend: delta > 1 ? 'up' : delta < -1 ? 'down' : 'flat'
    };
  }).sort((a, b) => b.currentAttendancePercentage - a.currentAttendancePercentage);

  // ---- Monthly productivity report (company/team-wide roll-up) ----
  const totalOvertimeMinutes = stats.reduce((sum, s) => sum + s.overtimeMinutes, 0);
  const totalLateIncidents = stats.reduce((sum, s) => sum + s.lateDays, 0);
  const totalAbsentDays = stats.reduce((sum, s) => sum + s.absentDays, 0);
  const avgAttendance = stats.length ? Math.round(stats.reduce((sum, s) => sum + s.attendancePercentage, 0) / stats.length) : 0;
  const prevAvgAttendance = prevStats.length ? Math.round(prevStats.reduce((sum, s) => sum + s.attendancePercentage, 0) / prevStats.length) : 0;
  const attendanceDelta = avgAttendance - prevAvgAttendance;

  const monthName = new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long' });
  let summary = `In ${monthName} ${year}, the team averaged ${avgAttendance}% attendance`;
  summary += attendanceDelta > 0 ? `, up ${attendanceDelta} point(s) from last month.` : attendanceDelta < 0 ? `, down ${Math.abs(attendanceDelta)} point(s) from last month.` : `, unchanged from last month.`;
  if (totalLateIncidents > 0) summary += ` There were ${totalLateIncidents} late arrival(s) recorded.`;
  if (totalOvertimeMinutes > 0) summary += ` A total of ${Math.round(totalOvertimeMinutes / 60)} hour(s) of overtime were logged.`;
  if (totalAbsentDays > 0) summary += ` ${totalAbsentDays} unplanned absence day(s) occurred across the team.`;

  res.json({
    success: true,
    month, year,
    mostPunctual,
    frequentlyLate,
    highestAbsenteeism,
    departmentTrend,
    monthlyProductivity: {
      avgAttendance,
      attendanceDelta,
      totalOvertimeHours: Math.round((totalOvertimeMinutes / 60) * 10) / 10,
      totalLateIncidents,
      totalAbsentDays,
      teamSize: stats.length,
      summary
    }
  });
});

// GET /api/reports/leaderboard?month=&year= - KPI leaderboard (admin/manager: their scope;
// employee: their own department, ranked, for friendly competition - no salary/personal
// data is exposed, just name/department/score).
router.get('/leaderboard', authenticate, (req, res) => {
  const db = readDb();
  const now = new Date();
  const month = parseInt(req.query.month, 10) || now.getMonth() + 1;
  const year = parseInt(req.query.year, 10) || now.getFullYear();

  const emp = db.employees.find((e) => e.id === req.user.id);
  let pool;
  if (req.user.role === 'admin') {
    pool = db.employees.filter((e) => e.role === 'employee' && e.status === 'active');
  } else if (req.user.role === 'manager') {
    const accessibleIds = getAccessibleEmployeeIds(db, req.user);
    pool = db.employees.filter((e) => e.role === 'employee' && e.status === 'active' && accessibleIds.includes(e.id));
  } else {
    pool = db.employees.filter((e) => e.role === 'employee' && e.status === 'active' && e.department === (emp && emp.department));
  }

  const stats = monthlyStatsFor(db, pool.map((e) => e.id), month, year);
  const withScore = stats.map((s) => {
    const punctuality = s.attendedDays > 0 ? ((s.attendedDays - s.lateDays) / s.attendedDays) * 100 : 100;
    const score = Math.round(s.attendancePercentage * 0.6 + punctuality * 0.4);
    return { ...s, score: Math.max(0, Math.min(100, score)) };
  }).sort((a, b) => b.score - a.score);

  const medals = ['🥇', '🥈', '🥉'];
  const ranked = withScore.map((s, i) => ({ ...s, rank: i + 1, medal: medals[i] || null, isMe: s.employeeId === req.user.id }));

  res.json({ success: true, month, year, leaderboard: ranked });
});

// GET /api/reports/predictions?month=&year= (admin/manager) - "AI Attendance Insights &
// Predictions". Rule-based trend detection (this app has no ML model / network access to a
// hosted AI, so these are transparent statistical comparisons, not a black-box prediction) -
// comparing this month vs last month per employee to flag rising risk before it becomes
// a bigger problem.
router.get('/predictions', authenticate, requireManagerOrAdmin, (req, res) => {
  const db = readDb();
  const now = new Date();
  const month = parseInt(req.query.month, 10) || now.getMonth() + 1;
  const year = parseInt(req.query.year, 10) || now.getFullYear();
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;

  const accessibleIds = getAccessibleEmployeeIds(db, req.user);
  const pool = db.employees.filter((e) => e.role === 'employee' && e.status === 'active' && (!accessibleIds || accessibleIds.includes(e.id)));
  const ids = pool.map((e) => e.id);

  const cur = monthlyStatsFor(db, ids, month, year);
  const prev = monthlyStatsFor(db, ids, prevMonth, prevYear);
  const prevById = Object.fromEntries(prev.map((s) => [s.employeeId, s]));

  const risingLateTrend = [];
  const attritionRisk = [];
  const likelyTomorrowAbsentees = [];

  cur.forEach((s) => {
    const p = prevById[s.employeeId];
    if (p && s.lateDays > p.lateDays && s.lateDays >= 2) {
      risingLateTrend.push({ employeeId: s.employeeId, employeeName: s.employeeName, department: s.department, previousLateDays: p.lateDays, currentLateDays: s.lateDays });
    }
    // Attrition risk: attendance dropped 15+ points month-on-month, or absenteeism is high
    // and trending worse. Purely a statistical flag to prompt a supportive conversation,
    // not a certainty.
    if (p) {
      const drop = p.attendancePercentage - s.attendancePercentage;
      if (drop >= 15 || (s.attendancePercentage < 70 && drop > 0)) {
        attritionRisk.push({
          employeeId: s.employeeId, employeeName: s.employeeName, department: s.department,
          currentAttendance: s.attendancePercentage, previousAttendance: p.attendancePercentage,
          drop: Math.round(drop)
        });
      }
    }
  });

  // Likely-absent-tomorrow: for each employee, look at their historical attendance on that
  // specific weekday over the last 8 weeks - if they were absent more than 40% of the time
  // on that weekday, flag them as a heads-up for tomorrow's staffing.
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowWeekday = tomorrow.getDay();
  const eightWeeksAgo = new Date(now);
  eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);

  pool.forEach((e) => {
    const historicalSameWeekday = db.attendance.filter((a) => {
      if (a.employeeId !== e.id) return false;
      const d = new Date(`${a.date}T00:00:00`);
      return d.getDay() === tomorrowWeekday && d >= eightWeeksAgo && d < now;
    });
    if (historicalSameWeekday.length >= 3) {
      const absentCount = historicalSameWeekday.filter((a) => !a.punchIn).length;
      const rate = absentCount / historicalSameWeekday.length;
      if (rate >= 0.4) {
        likelyTomorrowAbsentees.push({
          employeeId: e.id, employeeName: e.name, department: e.department,
          historicalAbsenceRate: Math.round(rate * 100)
        });
      }
    }
  });

  res.json({
    success: true,
    month, year,
    risingLateTrend: risingLateTrend.sort((a, b) => b.currentLateDays - a.currentLateDays),
    attritionRisk: attritionRisk.sort((a, b) => b.drop - a.drop),
    likelyTomorrowAbsentees: likelyTomorrowAbsentees.sort((a, b) => b.historicalAbsenceRate - a.historicalAbsenceRate),
    tomorrowDate: tomorrow.toISOString().slice(0, 10)
  });
});

module.exports = router;
