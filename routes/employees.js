const express = require('express');
const bcrypt = require('bcryptjs');
const { readDb, writeDb } = require('../utils/db');
const { authenticate, requireAdmin, requireManagerOrAdmin, getAccessibleEmployeeIds } = require('../middleware/auth');
const events = require('../utils/events');

const router = express.Router();

// GET /api/employees  (admin: all; manager: their own department only)
// Query params: search (name/empCode/username), department, status
router.get('/', authenticate, requireManagerOrAdmin, (req, res) => {
  const db = readDb();
  const accessibleIds = getAccessibleEmployeeIds(db, req.user);

  let list = db.employees
    .filter((e) => !accessibleIds || accessibleIds.includes(e.id))
    .map((e) => ({
      id: e.id,
      empCode: e.empCode,
      name: e.name,
      email: e.email,
      username: e.username,
      role: e.role,
      department: e.department,
      designation: e.designation,
      phone: e.phone,
      dob: e.dob || null,
      joinDate: e.joinDate,
      status: e.status,
      faceEnrolled: !!e.faceEnrolled
    }));

  const { search, department, status } = req.query;
  if (search) {
    const q = String(search).toLowerCase();
    list = list.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.empCode.toLowerCase().includes(q) ||
        e.username.toLowerCase().includes(q)
    );
  }
  if (department) {
    list = list.filter((e) => e.department.toLowerCase() === String(department).toLowerCase());
  }
  if (status) {
    list = list.filter((e) => e.status === status);
  }

  res.json({ success: true, employees: list });
});

// GET /api/employees/:id (admin: any; manager: their own department only) - profile + attendance summary
router.get('/:id', authenticate, requireManagerOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = readDb();
  const emp = db.employees.find((e) => e.id === id);
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

  const accessibleIds = getAccessibleEmployeeIds(db, req.user);
  if (accessibleIds && !accessibleIds.includes(id)) {
    return res.status(403).json({ success: false, message: 'You do not have access to this employee' });
  }

  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthRecords = db.attendance.filter((a) => a.employeeId === id && a.date.startsWith(monthPrefix));

  const presentDays = monthRecords.filter((r) => r.status !== 'late' && r.punchIn).length;
  const lateDays = monthRecords.filter((r) => r.status === 'late').length;

  const recentRecords = db.attendance
    .filter((a) => a.employeeId === id)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 10);

  res.json({
    success: true,
    employee: {
      id: emp.id,
      empCode: emp.empCode,
      name: emp.name,
      email: emp.email,
      username: emp.username,
      role: emp.role,
      department: emp.department,
      designation: emp.designation,
      phone: emp.phone,
      dob: emp.dob || null,
      joinDate: emp.joinDate,
      status: emp.status,
      faceEnrolled: !!emp.faceEnrolled
    },
    monthSummary: {
      presentDays,
      lateDays,
      totalDaysRecorded: monthRecords.length
    },
    recentRecords
  });
});

// POST /api/employees (admin only) - create new employee
router.post('/', authenticate, requireAdmin, (req, res) => {
  const { name, email, username, password, confirmPassword, department, designation, phone, role, dob } = req.body;

  if (!name || !username || !password) {
    return res.status(400).json({ success: false, message: 'Name, username and password are required' });
  }
  if (confirmPassword !== undefined && confirmPassword !== password) {
    return res.status(400).json({ success: false, message: 'Password and confirm password do not match' });
  }

  const db = readDb();
  const exists = db.employees.find((e) => e.username.toLowerCase() === String(username).toLowerCase());
  if (exists) {
    return res.status(409).json({ success: false, message: 'Username already exists' });
  }

  const id = db.counters.employeeId++;
  const empCode = `MR-${id}`;

  const newEmp = {
    id,
    empCode,
    name,
    email: email || '',
    username,
    passwordHash: bcrypt.hashSync(password, 8),
    role: ['admin', 'manager'].includes(role) ? role : 'employee',
    department: department || 'General',
    designation: designation || 'Staff',
    phone: phone || '',
    dob: dob || null,
    joinDate: new Date().toISOString().slice(0, 10),
    status: 'active',
    facePhoto: null,
    faceEnrolled: false
  };

  db.employees.push(newEmp);
  writeDb(db);
  events.broadcast('employee-added', { employeeId: newEmp.id, name: newEmp.name, department: newEmp.department, role: newEmp.role });

  res.status(201).json({
    success: true,
    message: 'Employee created successfully',
    employee: { ...newEmp, passwordHash: undefined }
  });
});

// PUT /api/employees/:id (admin only) - update employee
router.put('/:id', authenticate, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = readDb();
  const emp = db.employees.find((e) => e.id === id);
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

  const { name, email, department, designation, phone, role, status, password, confirmPassword, dob } = req.body;

  if (password && confirmPassword !== undefined && confirmPassword !== password) {
    return res.status(400).json({ success: false, message: 'Password and confirm password do not match' });
  }

  if (name) emp.name = name;
  if (email !== undefined) emp.email = email;
  if (department) emp.department = department;
  if (designation) emp.designation = designation;
  if (phone !== undefined) emp.phone = phone;
  if (dob !== undefined) emp.dob = dob || null;
  if (role) emp.role = ['admin', 'manager'].includes(role) ? role : 'employee';
  if (status) emp.status = status === 'inactive' ? 'inactive' : 'active';
  if (password) emp.passwordHash = bcrypt.hashSync(password, 8);

  writeDb(db);
  events.broadcast('employee-updated', { employeeId: emp.id, name: emp.name, department: emp.department, status: emp.status });
  res.json({ success: true, message: 'Employee updated successfully' });
});

// DELETE /api/employees/:id (admin only)
router.delete('/:id', authenticate, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = readDb();

  if (req.user.id === id) {
    return res.status(400).json({ success: false, message: 'You cannot delete your own account' });
  }

  const idx = db.employees.findIndex((e) => e.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Employee not found' });

  const removedName = db.employees[idx].name;
  db.employees.splice(idx, 1);
  // Also remove their attendance records
  db.attendance = db.attendance.filter((a) => a.employeeId !== id);
  writeDb(db);
  events.broadcast('employee-removed', { employeeId: id, name: removedName });

  res.json({ success: true, message: 'Employee deleted successfully' });
});

module.exports = router;
