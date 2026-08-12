// Daily Task & Activity Tracker - employees log what they worked on each day;
// managers/admins can see their team's activity for the day/week.
const express = require('express');
const { readDb, writeDb } = require('../utils/db');
const { authenticate, requireManagerOrAdmin, getAccessibleEmployeeIds } = require('../middleware/auth');

const router = express.Router();

const STATUSES = ['pending', 'in-progress', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// POST /api/tasks (authenticated) - create a task for myself (or, if admin/manager, for
// someone on my team by passing employeeId).
router.post('/', authenticate, (req, res) => {
  const { title, description, date, priority, employeeId } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ success: false, message: 'Task title is required' });
  }

  const db = readDb();
  let targetId = req.user.id;
  if (employeeId && parseInt(employeeId, 10) !== req.user.id) {
    if (req.user.role === 'employee') {
      return res.status(403).json({ success: false, message: 'You can only add tasks for yourself' });
    }
    const accessibleIds = getAccessibleEmployeeIds(db, req.user);
    if (accessibleIds && !accessibleIds.includes(parseInt(employeeId, 10))) {
      return res.status(403).json({ success: false, message: 'You do not have access to this employee' });
    }
    targetId = parseInt(employeeId, 10);
  }
  const emp = db.employees.find((e) => e.id === targetId);
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

  const task = {
    id: db.counters.taskId++,
    employeeId: targetId,
    employeeName: emp.name,
    date: date || todayStr(),
    title: String(title).trim(),
    description: (description || '').trim(),
    priority: PRIORITIES.includes(priority) ? priority : 'medium',
    status: 'pending',
    assignedBy: req.user.id !== targetId ? req.user.name : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.tasks.push(task);
  writeDb(db);
  res.status(201).json({ success: true, message: 'Task added', task });
});

// GET /api/tasks/my?date=&status= - my own tasks
router.get('/my', authenticate, (req, res) => {
  const db = readDb();
  let list = db.tasks.filter((t) => t.employeeId === req.user.id);
  if (req.query.date) list = list.filter((t) => t.date === req.query.date);
  if (req.query.status) list = list.filter((t) => t.status === req.query.status);
  list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  res.json({ success: true, tasks: list });
});

// GET /api/tasks/all?employeeId=&date=&status= (admin: everyone; manager: own dept)
router.get('/all', authenticate, requireManagerOrAdmin, (req, res) => {
  const db = readDb();
  const accessibleIds = getAccessibleEmployeeIds(db, req.user);
  let list = db.tasks.filter((t) => !accessibleIds || accessibleIds.includes(t.employeeId));
  if (req.query.employeeId) list = list.filter((t) => t.employeeId === parseInt(req.query.employeeId, 10));
  if (req.query.date) list = list.filter((t) => t.date === req.query.date);
  if (req.query.status) list = list.filter((t) => t.status === req.query.status);
  list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  res.json({ success: true, tasks: list });
});

// PUT /api/tasks/:id (owner, or admin/manager with access) - update status/details
router.put('/:id', authenticate, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = readDb();
  const task = db.tasks.find((t) => t.id === id);
  if (!task) return res.status(404).json({ success: false, message: 'Task not found' });

  const isOwner = task.employeeId === req.user.id;
  if (!isOwner) {
    if (req.user.role === 'employee') return res.status(403).json({ success: false, message: 'You can only update your own tasks' });
    const accessibleIds = getAccessibleEmployeeIds(db, req.user);
    if (accessibleIds && !accessibleIds.includes(task.employeeId)) {
      return res.status(403).json({ success: false, message: 'You do not have access to this task' });
    }
  }

  const { title, description, priority, status } = req.body || {};
  if (title !== undefined) task.title = String(title).trim();
  if (description !== undefined) task.description = String(description).trim();
  if (priority !== undefined && PRIORITIES.includes(priority)) task.priority = priority;
  if (status !== undefined && STATUSES.includes(status)) task.status = status;
  task.updatedAt = new Date().toISOString();

  writeDb(db);
  res.json({ success: true, message: 'Task updated', task });
});

// DELETE /api/tasks/:id (owner, or admin/manager with access)
router.delete('/:id', authenticate, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = readDb();
  const idx = db.tasks.findIndex((t) => t.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Task not found' });
  const task = db.tasks[idx];

  const isOwner = task.employeeId === req.user.id;
  if (!isOwner) {
    if (req.user.role === 'employee') return res.status(403).json({ success: false, message: 'You can only delete your own tasks' });
    const accessibleIds = getAccessibleEmployeeIds(db, req.user);
    if (accessibleIds && !accessibleIds.includes(task.employeeId)) {
      return res.status(403).json({ success: false, message: 'You do not have access to this task' });
    }
  }

  db.tasks.splice(idx, 1);
  writeDb(db);
  res.json({ success: true, message: 'Task deleted' });
});

module.exports = router;
