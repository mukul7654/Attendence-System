const express = require('express');
const { readDb, writeDb } = require('../utils/db');
const { authenticate, requireAdmin, requireManagerOrAdmin, getAccessibleEmployeeIds } = require('../middleware/auth');
const events = require('../utils/events');

const router = express.Router();

function monthLabel(monthStr) {
  const [y, m] = monthStr.split('-');
  const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${names[parseInt(m, 10) - 1]} ${y}`;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function stripFile(p) {
  const { fileData, ...rest } = p;
  return { ...rest, hasFile: !!fileData };
}

// POST /api/payslips (admin) - create or update (upsert by employeeId+month) a payslip
// Body: { employeeId, month: 'YYYY-MM', basic, hra, conveyance, medical, specialAllowance, otherEarnings,
//         pf, professionalTax, tds, otherDeductions, remarks,
//         file: { fileName, fileType, fileData (base64, no data-url prefix) }  <- optional uploaded payslip document
router.post('/', authenticate, requireAdmin, (req, res) => {
  const {
    employeeId, month,
    basic = 0, hra = 0, conveyance = 0, medical = 0, specialAllowance = 0, otherEarnings = 0,
    pf = 0, professionalTax = 0, tds = 0, otherDeductions = 0,
    remarks = '', file
  } = req.body;

  if (!employeeId || !month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ success: false, message: 'employeeId and month (YYYY-MM) are required' });
  }

  const db = readDb();
  const emp = db.employees.find((e) => e.id === parseInt(employeeId, 10));
  if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

  const grossEarnings = round2(basic) + round2(hra) + round2(conveyance) + round2(medical) + round2(specialAllowance) + round2(otherEarnings);
  const totalDeductions = round2(pf) + round2(professionalTax) + round2(tds) + round2(otherDeductions);
  const netPay = round2(grossEarnings - totalDeductions);

  let payslip = db.payslips.find((p) => p.employeeId === emp.id && p.month === month);
  const isUpdate = !!payslip;

  const payload = {
    employeeId: emp.id,
    employeeName: emp.name,
    empCode: emp.empCode,
    department: emp.department,
    designation: emp.designation,
    month,
    monthLabel: monthLabel(month),
    basic: round2(basic), hra: round2(hra), conveyance: round2(conveyance), medical: round2(medical),
    specialAllowance: round2(specialAllowance), otherEarnings: round2(otherEarnings),
    pf: round2(pf), professionalTax: round2(professionalTax), tds: round2(tds), otherDeductions: round2(otherDeductions),
    grossEarnings, totalDeductions, netPay,
    remarks: remarks || '',
    generatedOn: new Date().toISOString(),
    generatedBy: req.user.name
  };

  if (file && file.fileData) {
    payload.fileName = file.fileName || `Payslip-${emp.empCode}-${month}.pdf`;
    payload.fileType = file.fileType || 'application/pdf';
    payload.fileData = file.fileData;
  } else if (payslip) {
    // keep previously uploaded file if this update didn't include a new one
    payload.fileName = payslip.fileName;
    payload.fileType = payslip.fileType;
    payload.fileData = payslip.fileData;
  }

  if (payslip) {
    Object.assign(payslip, payload);
  } else {
    payslip = { id: db.counters.payslipId++, ...payload };
    db.payslips.push(payslip);
  }

  writeDb(db);
  events.broadcast('payslip-issued', { employeeId: emp.id, employeeName: emp.name, month, monthLabel: monthLabel(month), isUpdate });
  res.status(isUpdate ? 200 : 201).json({
    success: true,
    message: isUpdate ? 'Payslip updated successfully' : 'Payslip generated successfully',
    payslip: stripFile(payslip)
  });
});

// GET /api/payslips/my - employee's own payslips, optional ?year=
router.get('/my', authenticate, (req, res) => {
  const db = readDb();
  let list = db.payslips.filter((p) => p.employeeId === req.user.id);
  if (req.query.year) list = list.filter((p) => p.month.startsWith(String(req.query.year)));
  list.sort((a, b) => (a.month < b.month ? 1 : -1));
  res.json({ success: true, payslips: list.map(stripFile) });
});

// GET /api/payslips/all (admin only) - optional ?employeeId=&month=&year=
router.get('/all', authenticate, requireAdmin, (req, res) => {
  const db = readDb();
  let list = [...db.payslips];

  if (req.query.employeeId) list = list.filter((p) => p.employeeId === parseInt(req.query.employeeId, 10));
  if (req.query.month) list = list.filter((p) => p.month === req.query.month);
  else if (req.query.year) list = list.filter((p) => p.month.startsWith(String(req.query.year)));
  list.sort((a, b) => (a.month < b.month ? 1 : -1));
  res.json({ success: true, payslips: list.map(stripFile) });
});

// GET /api/payslips/:id - detail (admin: any; employee: only their own. Managers cannot view payslips.)
router.get('/:id', authenticate, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = readDb();
  const payslip = db.payslips.find((p) => p.id === id);
  if (!payslip) return res.status(404).json({ success: false, message: 'Payslip not found' });

  if (req.user.role !== 'admin' && payslip.employeeId !== req.user.id) {
    return res.status(403).json({ success: false, message: 'You are not authorized to view this payslip' });
  }
  res.json({ success: true, payslip: stripFile(payslip) });
});

// GET /api/payslips/:id/download - returns the uploaded file if present, otherwise a
// generated printable HTML payslip (can be saved / printed to PDF from the browser).
// Admin: any payslip. Employee: only their own. Managers are not authorized here either.
router.get('/:id/download', authenticate, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = readDb();
  const payslip = db.payslips.find((p) => p.id === id);
  if (!payslip) return res.status(404).json({ success: false, message: 'Payslip not found' });

  if (req.user.role !== 'admin' && payslip.employeeId !== req.user.id) {
    return res.status(403).json({ success: false, message: 'You are not authorized to view this payslip' });
  }

  if (payslip.fileData) {
    const buffer = Buffer.from(payslip.fileData, 'base64');
    res.setHeader('Content-Type', payslip.fileType || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${payslip.fileName}"`);
    return res.send(buffer);
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Payslip - ${payslip.employeeName} - ${payslip.monthLabel}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; padding: 30px; color: #1c2b45; }
  h1 { font-size: 20px; margin-bottom: 0; color: #0b1f3a; }
  .sub { color: #666; margin-top: 4px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e5e5e5; font-size: 13.5px; }
  th { color: #666; font-weight: 600; }
  .amount { text-align: right; }
  .total-row td { font-weight: 700; border-top: 2px solid #0b1f3a; }
  .net-pay { background: #f5f8ff; padding: 14px 18px; border-radius: 8px; font-size: 17px; font-weight: 800; color: #0b1f3a; margin-top: 10px; }
  .meta { display:flex; justify-content: space-between; margin-bottom: 20px; font-size: 13.5px; }
</style>
</head>
<body>
  <h1>Maxim Realty</h1>
  <div class="sub">Payslip for ${payslip.monthLabel}</div>

  <div class="meta">
    <div>
      <b>${payslip.employeeName}</b> (${payslip.empCode})<br/>
      ${payslip.designation} · ${payslip.department}
    </div>
    <div>Generated: ${new Date(payslip.generatedOn).toLocaleDateString('en-IN')}</div>
  </div>

  <table>
    <thead><tr><th>Earnings</th><th class="amount">Amount (₹)</th></tr></thead>
    <tbody>
      <tr><td>Basic Salary</td><td class="amount">${payslip.basic.toFixed(2)}</td></tr>
      <tr><td>House Rent Allowance</td><td class="amount">${payslip.hra.toFixed(2)}</td></tr>
      <tr><td>Conveyance Allowance</td><td class="amount">${payslip.conveyance.toFixed(2)}</td></tr>
      <tr><td>Medical Allowance</td><td class="amount">${payslip.medical.toFixed(2)}</td></tr>
      <tr><td>Special Allowance</td><td class="amount">${payslip.specialAllowance.toFixed(2)}</td></tr>
      <tr><td>Other Earnings</td><td class="amount">${payslip.otherEarnings.toFixed(2)}</td></tr>
      <tr class="total-row"><td>Gross Earnings</td><td class="amount">${payslip.grossEarnings.toFixed(2)}</td></tr>
    </tbody>
  </table>

  <table>
    <thead><tr><th>Deductions</th><th class="amount">Amount (₹)</th></tr></thead>
    <tbody>
      <tr><td>Provident Fund</td><td class="amount">${payslip.pf.toFixed(2)}</td></tr>
      <tr><td>Professional Tax</td><td class="amount">${payslip.professionalTax.toFixed(2)}</td></tr>
      <tr><td>TDS</td><td class="amount">${payslip.tds.toFixed(2)}</td></tr>
      <tr><td>Other Deductions</td><td class="amount">${payslip.otherDeductions.toFixed(2)}</td></tr>
      <tr class="total-row"><td>Total Deductions</td><td class="amount">${payslip.totalDeductions.toFixed(2)}</td></tr>
    </tbody>
  </table>

  <div class="net-pay">Net Pay: ₹ ${payslip.netPay.toFixed(2)}</div>
  ${payslip.remarks ? `<p style="margin-top:20px; color:#666;"><b>Remarks:</b> ${payslip.remarks}</p>` : ''}

  <script>window.onload = () => setTimeout(() => window.print(), 300);</script>
</body></html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// DELETE /api/payslips/:id (admin)
router.delete('/:id', authenticate, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = readDb();
  const idx = db.payslips.findIndex((p) => p.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Payslip not found' });
  db.payslips.splice(idx, 1);
  writeDb(db);
  res.json({ success: true, message: 'Payslip deleted successfully' });
});

module.exports = router;
