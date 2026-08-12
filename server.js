const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const seed = require('./utils/seed');
const authRoutes = require('./routes/auth');
const employeeRoutes = require('./routes/employees');
const attendanceRoutes = require('./routes/attendance');
const leaveRoutes = require('./routes/leave');
const payslipRoutes = require('./routes/payslips');
const regularizationRoutes = require('./routes/regularization');
const settingsRoutes = require('./routes/settings');
const calendarRoutes = require('./routes/calendar');
const faceRoutes = require('./routes/face');
const notificationRoutes = require('./routes/notifications');
const performanceRoutes = require('./routes/performance');
const reportsRoutes = require('./routes/reports');
const documentsRoutes = require('./routes/documents');
const tasksRoutes = require('./routes/tasks');
const fieldVisitsRoutes = require('./routes/fieldvisits');
const payrollRoutes = require('./routes/payroll');
const { authenticate } = require('./middleware/auth');
const events = require('./utils/events');

// Initialize database with default admin account on first run
seed();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '8mb' })); // higher limit to allow uploaded payslip PDFs
app.use(bodyParser.urlencoded({ extended: true }));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/leave', leaveRoutes);
app.use('/api/payslips', payslipRoutes);
app.use('/api/regularization', regularizationRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/face', faceRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/performance', performanceRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/fieldvisits', fieldVisitsRoutes);
app.use('/api/payroll', payrollRoutes);

// GET /api/live - real-time event stream (Server-Sent Events).
// Any logged-in user can connect; admins/managers typically use this to get
// live punch-in/out, leave, and regularization updates on their dashboard
// without polling.
app.get('/api/live', authenticate, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'connected', payload: {}, time: new Date().toISOString() })}\n\n`);

  events.addClient(res);

  // Heartbeat so proxies/browsers don't time out the connection
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) { /* ignore */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    events.removeClient(res);
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Maxim Realty Attendance System API is running', time: new Date().toISOString() });
});

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('==========================================================');
  console.log('  MAXIM REALTY - Attendance Management System');
  console.log(`  Server running at: http://localhost:${PORT}`);
  
  console.log('==========================================================');
});
