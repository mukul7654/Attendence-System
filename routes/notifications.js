// Birthday & Work Anniversary reminders - computed from employees' dob / joinDate.
// No cron/scheduler needed - since this is date-driven, simply computing "does
// month-day match today?" on each request is always correct and needs no background job.
const express = require('express');
const { readDb } = require('../utils/db');
const { authenticate, getAccessibleEmployeeIds } = require('../middleware/auth');

const router = express.Router();

function monthDay(dateStr) {
  if (!dateStr) return null;
  return dateStr.slice(5, 10); // 'MM-DD'
}

function yearsSince(dateStr, today) {
  const start = new Date(dateStr);
  const now = new Date(today);
  return now.getFullYear() - start.getFullYear();
}

function daysUntilNext(dateStr, today) {
  const md = monthDay(dateStr);
  if (!md) return null;
  const now = new Date(today);
  let next = new Date(`${now.getFullYear()}-${md}T00:00:00`);
  if (next < now) next = new Date(`${now.getFullYear() + 1}-${md}T00:00:00`);
  return Math.round((next - now) / 86400000);
}

// GET /api/notifications/today - birthdays & work anniversaries happening today, plus the
// next 7 days upcoming, scoped to what the caller can see (admin: everyone, manager: own
// dept, employee: company-wide announcements only - so everyone gets to celebrate together).
router.get('/today', authenticate, (req, res) => {
  const db = readDb();
  const today = new Date().toISOString().slice(0, 10);

  // Employees only see company-wide birthday/anniversary shout-outs (nice culture touch),
  // but managers/admins get the same scoping as everywhere else in the app.
  const accessibleIds = req.user.role === 'employee' ? null : getAccessibleEmployeeIds(db, req.user);
  const pool = db.employees.filter((e) => e.status === 'active' && (!accessibleIds || accessibleIds.includes(e.id)));

  const todayMd = monthDay(today);

  const birthdaysToday = pool
    .filter((e) => monthDay(e.dob) === todayMd)
    .map((e) => ({ id: e.id, name: e.name, department: e.department, designation: e.designation }));

  const anniversariesToday = pool
    .filter((e) => monthDay(e.joinDate) === todayMd && yearsSince(e.joinDate, today) >= 1)
    .map((e) => ({ id: e.id, name: e.name, department: e.department, designation: e.designation, years: yearsSince(e.joinDate, today) }));

  const upcomingBirthdays = pool
    .filter((e) => e.dob && monthDay(e.dob) !== todayMd)
    .map((e) => ({ id: e.id, name: e.name, department: e.department, daysUntil: daysUntilNext(e.dob, today) }))
    .filter((e) => e.daysUntil !== null && e.daysUntil <= 7)
    .sort((a, b) => a.daysUntil - b.daysUntil);

  const upcomingAnniversaries = pool
    .filter((e) => e.joinDate && monthDay(e.joinDate) !== todayMd && yearsSince(e.joinDate, today) >= 0)
    .map((e) => ({
      id: e.id,
      name: e.name,
      department: e.department,
      daysUntil: daysUntilNext(e.joinDate, today),
      years: yearsSince(e.joinDate, today) + 1
    }))
    .filter((e) => e.daysUntil !== null && e.daysUntil <= 7)
    .sort((a, b) => a.daysUntil - b.daysUntil);

  res.json({
    success: true,
    date: today,
    birthdaysToday,
    anniversariesToday,
    upcomingBirthdays,
    upcomingAnniversaries,
    hasNotifications: birthdaysToday.length > 0 || anniversariesToday.length > 0
  });
});

module.exports = router;
