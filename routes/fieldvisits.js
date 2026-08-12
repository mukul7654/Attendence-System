// Field Sales GPS Tracking - field/sales staff check in with their live GPS location when
// visiting a client/site, and check out when done. No map API key is needed to view a pin -
// we link out to OpenStreetMap, which works without any credentials.
const express = require('express');
const { readDb, writeDb } = require('../utils/db');
const { authenticate, requireManagerOrAdmin, getAccessibleEmployeeIds } = require('../middleware/auth');

const router = express.Router();

// POST /api/fieldvisits/checkin (authenticated) - start a site/client visit
// Body: { clientName, purpose, lat, lng, address, note }
router.post('/checkin', authenticate, (req, res) => {
  const { clientName, purpose, lat, lng, address, note } = req.body || {};
  if (!clientName || !String(clientName).trim()) {
    return res.status(400).json({ success: false, message: 'Client/site name is required' });
  }
  if (lat == null || lng == null) {
    return res.status(400).json({ success: false, message: 'Location is required to check in - please allow location access' });
  }

  const db = readDb();
  const emp = db.employees.find((e) => e.id === req.user.id);

  // Prevent checking into a second visit while one is still open
  const openVisit = db.fieldVisits.find((v) => v.employeeId === req.user.id && !v.checkedOutAt);
  if (openVisit) {
    return res.status(400).json({ success: false, message: `You still have an open visit at "${openVisit.clientName}". Please check out of that first.` });
  }

  const visit = {
    id: db.counters.fieldVisitId++,
    employeeId: req.user.id,
    employeeName: req.user.name,
    department: emp ? emp.department : null,
    clientName: String(clientName).trim(),
    purpose: (purpose || '').trim(),
    lat: Number(lat), lng: Number(lng),
    address: (address || '').trim(),
    note: (note || '').trim(),
    checkedInAt: new Date().toISOString(),
    checkedOutAt: null,
    checkoutLat: null, checkoutLng: null, checkoutNote: null
  };
  db.fieldVisits.push(visit);
  writeDb(db);
  res.status(201).json({ success: true, message: `Checked in at ${visit.clientName}`, visit });
});

// POST /api/fieldvisits/:id/checkout (owner only) - end a site/client visit
router.post('/:id/checkout', authenticate, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { lat, lng, note } = req.body || {};
  const db = readDb();
  const visit = db.fieldVisits.find((v) => v.id === id);
  if (!visit) return res.status(404).json({ success: false, message: 'Visit not found' });
  if (visit.employeeId !== req.user.id) {
    return res.status(403).json({ success: false, message: 'You can only check yourself out of a visit' });
  }
  if (visit.checkedOutAt) {
    return res.status(400).json({ success: false, message: 'This visit is already checked out' });
  }
  visit.checkedOutAt = new Date().toISOString();
  visit.checkoutLat = lat != null ? Number(lat) : null;
  visit.checkoutLng = lng != null ? Number(lng) : null;
  visit.checkoutNote = (note || '').trim();
  writeDb(db);
  res.json({ success: true, message: `Checked out of ${visit.clientName}`, visit });
});

// GET /api/fieldvisits/my?date= - my own visits
router.get('/my', authenticate, (req, res) => {
  const db = readDb();
  let list = db.fieldVisits.filter((v) => v.employeeId === req.user.id);
  if (req.query.date) list = list.filter((v) => v.checkedInAt.startsWith(req.query.date));
  list.sort((a, b) => (a.checkedInAt < b.checkedInAt ? 1 : -1));
  res.json({ success: true, visits: list });
});

// GET /api/fieldvisits/all?employeeId=&date= (admin: everyone; manager: own dept) - live team map data
router.get('/all', authenticate, requireManagerOrAdmin, (req, res) => {
  const db = readDb();
  const accessibleIds = getAccessibleEmployeeIds(db, req.user);
  let list = db.fieldVisits.filter((v) => !accessibleIds || accessibleIds.includes(v.employeeId));
  if (req.query.employeeId) list = list.filter((v) => v.employeeId === parseInt(req.query.employeeId, 10));
  if (req.query.date) list = list.filter((v) => v.checkedInAt.startsWith(req.query.date));
  list.sort((a, b) => (a.checkedInAt < b.checkedInAt ? 1 : -1));
  res.json({ success: true, visits: list });
});

module.exports = router;
