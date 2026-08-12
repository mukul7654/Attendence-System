// Seeds the database with a default Admin account (run automatically on first start)
const bcrypt = require('bcryptjs');
const { readDb, writeDb } = require('./db');

function seed() {
  const db = readDb();

  if (db.employees.length === 0) {
    const adminId = db.counters.employeeId++;
    db.employees.push({
      id: adminId,
      empCode: 'MR-ADMIN',
      name: 'System Administrator',
      email: 'admin@maximrealty.com',
      username: 'admin',
      passwordHash: bcrypt.hashSync('admin123', 8),
      role: 'admin',
      department: 'Management',
      designation: 'Administrator',
      phone: '',
      dob: '1985-11-02',
      joinDate: new Date().toISOString().slice(0, 10),
      status: 'active'
    });

    // A sample manager account (Sales team) so the manager role is demo-able
    const mgrId = db.counters.employeeId++;
    db.employees.push({
      id: mgrId,
      empCode: 'MR-1000',
      name: 'Priya Menon',
      email: 'priya.menon@maximrealty.com',
      username: 'priya',
      passwordHash: bcrypt.hashSync('priya123', 8),
      role: 'manager',
      department: 'Sales',
      designation: 'Sales Manager',
      phone: '9876500000',
      dob: '1990-09-15',
      joinDate: new Date().toISOString().slice(0, 10),
      status: 'active'
    });

    // A sample employee account so the system is immediately demo-able
    const empId = db.counters.employeeId++;
    db.employees.push({
      id: empId,
      empCode: 'MR-1001',
      name: 'Rahul Sharma',
      email: 'rahul.sharma@maximrealty.com',
      username: 'rahul',
      passwordHash: bcrypt.hashSync('rahul123', 8),
      role: 'employee',
      department: 'Sales',
      designation: 'Property Consultant',
      phone: '9876543210',
      dob: '1996-02-20',
      joinDate: new Date().toISOString().slice(0, 10),
      status: 'active'
    });

    // A sample Marketing employee so weekend-off rules (Sat+Sun) are demo-able
    const empId2 = db.counters.employeeId++;
    db.employees.push({
      id: empId2,
      empCode: 'MR-1002',
      name: 'Ananya Rao',
      email: 'ananya.rao@maximrealty.com',
      username: 'ananya',
      passwordHash: bcrypt.hashSync('ananya123', 8),
      role: 'employee',
      department: 'Marketing',
      designation: 'Marketing Executive',
      phone: '9876511111',
      dob: '1998-03-08',
      joinDate: new Date().toISOString().slice(0, 10),
      status: 'active'
    });

    writeDb(db);
    console.log('Database seeded with:');
    console.log('  Admin    -> admin / admin123');
    console.log('  Manager  -> priya / priya123   (Sales)');
    console.log('  Employee -> rahul / rahul123   (Sales, Monday off)');
    console.log('  Employee -> ananya / ananya123 (Marketing, Sat+Sun off)');
  }
}

module.exports = seed;
