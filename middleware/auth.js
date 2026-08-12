const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'maxim-realty-super-secret-key-change-in-production';

function authenticate(req, res, next) {
  const header = req.headers['authorization'];
  const headerToken = header && header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = headerToken || req.query.token || null;

  if (!token) {
    return res.status(401).json({ success: false, message: 'No authentication token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  next();
}

// Allows admins (full access) AND managers (scoped to their own department).
function requireManagerOrAdmin(req, res, next) {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'manager')) {
    return res.status(403).json({ success: false, message: 'Manager or Admin access required' });
  }
  next();
}

// Returns the list of employee IDs a user is allowed to see/manage.
// - admin -> null (meaning "no restriction", i.e. all employees)
// - manager -> IDs of every employee (including themself) in their department
// - employee -> just their own ID
function getAccessibleEmployeeIds(db, user) {
  if (user.role === 'admin') return null;

  if (user.role === 'manager') {
    const self = db.employees.find((e) => e.id === user.id);
    const dept = self ? self.department : null;
    return db.employees
      .filter((e) => e.department === dept)
      .map((e) => e.id);
  }

  return [user.id];
}

module.exports = { authenticate, requireAdmin, requireManagerOrAdmin, getAccessibleEmployeeIds, JWT_SECRET };
