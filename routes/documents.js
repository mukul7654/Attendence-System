// Documents Module - Aadhaar, PAN, Offer Letter, Salary Slip, Experience Letter, Resume.
// Files are stored as base64 in db.json, same pattern already used for payslip uploads.
const express = require('express');
const { readDb, writeDb } = require('../utils/db');
const { authenticate, requireManagerOrAdmin, getAccessibleEmployeeIds } = require('../middleware/auth');
const events = require('../utils/events');

const router = express.Router();

const DOC_TYPES = ['aadhaar', 'pan', 'offer_letter', 'salary_slip', 'experience_letter', 'resume', 'other'];
const DOC_LABELS = {
  aadhaar: 'Aadhaar Card',
  pan: 'PAN Card',
  offer_letter: 'Offer Letter',
  salary_slip: 'Salary Slip',
  experience_letter: 'Experience Letter',
  resume: 'Resume / CV',
  other: 'Other'
};
// These document types are company-issued HR records - only admins (or managers, for
// their own team) can upload them. Everything else (Aadhaar/PAN/Resume/Other) is
// self-serve: an employee can upload their own copy.
const ADMIN_ISSUED_TYPES = ['offer_letter', 'salary_slip', 'experience_letter'];

function stripFile(doc) {
  const { fileData, ...rest } = doc;
  return rest;
}

// POST /api/documents (authenticated) - upload a document
// Body: { employeeId (defaults to self), type, file: { fileName, fileType, fileData }, note }
router.post('/', authenticate, (req, res) => {
  const { employeeId, type, file, note } = req.body || {};
  const targetId = employeeId ? parseInt(employeeId, 10) : req.user.id;

  if (!DOC_TYPES.includes(type)) {
    return res.status(400).json({ success: false, message: 'Invalid document type' });
  }
  if (!file || !file.fileData || !file.fileName) {
    return res.status(400).json({ success: false, message: 'Please attach a file to upload' });
  }
  if (file.fileData.length > 7000000) { // ~5MB after base64 overhead
    return res.status(413).json({ success: false, message: 'File is too large. Please upload a file under 5MB.' });
  }

  const db = readDb();
  const emp = db.employees.find((e) => e.id === targetId);
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

  // Access control
  if (req.user.role === 'employee') {
    if (targetId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'You can only upload your own documents' });
    }
    if (ADMIN_ISSUED_TYPES.includes(type)) {
      return res.status(403).json({ success: false, message: `${DOC_LABELS[type]} can only be issued by HR/Admin` });
    }
  } else if (req.user.role === 'manager') {
    const accessibleIds = getAccessibleEmployeeIds(db, req.user);
    if (!accessibleIds.includes(targetId)) {
      return res.status(403).json({ success: false, message: 'You do not have access to this employee' });
    }
    if (ADMIN_ISSUED_TYPES.includes(type) && targetId === req.user.id) {
      return res.status(403).json({ success: false, message: `${DOC_LABELS[type]} can only be issued by Admin` });
    }
  }
  // admin: unrestricted

  const doc = {
    id: db.counters.documentId++,
    employeeId: targetId,
    employeeName: emp.name,
    type,
    typeLabel: DOC_LABELS[type],
    fileName: file.fileName,
    fileType: file.fileType || 'application/octet-stream',
    fileData: file.fileData,
    note: (note || '').trim(),
    uploadedBy: req.user.id,
    uploadedByName: req.user.name,
    uploadedAt: new Date().toISOString()
  };
  db.documents.push(doc);
  writeDb(db);

  events.broadcast('document-uploaded', { employeeId: targetId, employeeName: emp.name, type, typeLabel: DOC_LABELS[type], uploadedByName: req.user.name });
  res.status(201).json({ success: true, message: `${DOC_LABELS[type]} uploaded successfully`, document: stripFile(doc) });
});

// GET /api/documents/my - my own documents (metadata only)
router.get('/my', authenticate, (req, res) => {
  const db = readDb();
  const list = db.documents.filter((d) => d.employeeId === req.user.id).map(stripFile).sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
  res.json({ success: true, documents: list });
});

// GET /api/documents/all?employeeId=&type= (admin: everyone; manager: own dept)
router.get('/all', authenticate, requireManagerOrAdmin, (req, res) => {
  const db = readDb();
  const accessibleIds = getAccessibleEmployeeIds(db, req.user);
  let list = db.documents.filter((d) => !accessibleIds || accessibleIds.includes(d.employeeId));
  if (req.query.employeeId) list = list.filter((d) => d.employeeId === parseInt(req.query.employeeId, 10));
  if (req.query.type) list = list.filter((d) => d.type === req.query.type);
  list = list.map(stripFile).sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
  res.json({ success: true, documents: list });
});

// GET /api/documents/:id/download (admin: any; manager: own dept; employee: own only)
router.get('/:id/download', authenticate, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = readDb();
  const doc = db.documents.find((d) => d.id === id);
  if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });

  if (req.user.role === 'employee' && doc.employeeId !== req.user.id) {
    return res.status(403).json({ success: false, message: 'You are not authorized to view this document' });
  }
  if (req.user.role === 'manager') {
    const accessibleIds = getAccessibleEmployeeIds(db, req.user);
    if (!accessibleIds.includes(doc.employeeId)) {
      return res.status(403).json({ success: false, message: 'You do not have access to this document' });
    }
  }
  res.json({ success: true, document: doc });
});

// DELETE /api/documents/:id (admin: any; owner: only their own self-serve-type docs)
router.delete('/:id', authenticate, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = readDb();
  const idx = db.documents.findIndex((d) => d.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Document not found' });
  const doc = db.documents[idx];

  const isOwner = doc.employeeId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isAdmin && !(isOwner && !ADMIN_ISSUED_TYPES.includes(doc.type))) {
    return res.status(403).json({ success: false, message: 'You are not authorized to delete this document' });
  }

  db.documents.splice(idx, 1);
  writeDb(db);
  res.json({ success: true, message: 'Document deleted' });
});

module.exports = router;
