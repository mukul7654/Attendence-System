// Simple, dependency-free JSON file database
// Handles all reads/writes for employees, attendance, leave, payslips,
// regularization, password resets, and settings.
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

// Default weekly-off configuration, keyed by department name.
// Values are arrays of JS weekday numbers (0 = Sunday ... 6 = Saturday).
//   Sales      -> Monday off
//   Marketing  -> Saturday & Sunday off
//   (anything else) -> Sunday off
const DEFAULT_WEEKLY_OFF = {
  Sales: [1],
  Marketing: [0, 6],
  _default: [0]
};

// Suggests a festival icon based on keywords in the holiday name, so holidays
// added without an explicit icon still look reasonable. Admin can always
// override the icon.
const ICON_KEYWORDS = [
  [/diwali|deepavali/i, '🪔'],
  [/holi/i, '🎨'],
  [/christmas|xmas/i, '🎄'],
  [/new year/i, '🎆'],
  [/eid/i, '🌙'],
  [/independence/i, '🇮🇳'],
  [/republic/i, '🇮🇳'],
  [/gandhi/i, '🕊️'],
  [/pongal|onam|harvest/i, '🌾'],
  [/ganesh/i, '🐘'],
  [/navratri|durga|dussehra/i, '🪄'],
  [/rakhi|raksha/i, '🎀'],
  [/good friday|easter/i, '✝️'],
  [/birthday|jayanti/i, '🎂']
];

function guessHolidayIcon(name) {
  const found = ICON_KEYWORDS.find(([re]) => re.test(name || ''));
  return found ? found[1] : '🎉';
}

function defaultData() {
  return {
    employees: [],
    attendance: [],
    leaveRequests: [],
    regularizations: [],
    payslips: [],
    passwordResets: [],
    leavePolicy: {
      casual: 12,
      sick: 8,
      earned: 15,
      notes: 'Standard annual leave entitlement. Unpaid leave has no cap.'
    },
    // Per-employee overrides of the default leave policy, keyed by employeeId.
    // e.g. { "1002": { casual: 15, sick: 10 } } - any type not present falls back
    // to the company-wide leavePolicy above.
    leavePolicyOverrides: {},
    // Extra one-off leave credits given to a single employee (e.g. monthly earned-leave
    // accrual, a goodwill top-up, a correction). Never affects any other employee.
    // { id, employeeId, type, amount, note, creditedBy, creditedOn }
    leaveCredits: [],
    // Employee documents: Aadhaar, PAN, Offer Letter, Salary Slip, Experience Letter, Resume, etc.
    // { id, employeeId, type, fileName, fileType, fileData(base64), note, uploadedBy, uploadedByName, uploadedAt }
    documents: [],
    // Daily Task & Activity Tracker - { id, employeeId, date, title, description, status
    // ('pending'|'in-progress'|'done'), priority ('low'|'medium'|'high'), createdAt, updatedAt }
    tasks: [],
    // Field Sales GPS Tracking - site/client visit check-ins for field staff.
    // { id, employeeId, clientName, purpose, lat, lng, address, note, photo(base64, optional),
    //   checkedInAt, checkedOutAt }
    fieldVisits: [],
    // WhatsApp notification outbox/log. Real sending needs a configured WhatsApp Business
    // API (Twilio/Meta Cloud API) - see settings.whatsapp below. Every attempt is logged here
    // with a status so admins can see what would have gone out even without live credentials.
    // { id, employeeId, employeeName, phone, event, message, status('sent'|'failed'|'skipped'),
    //   detail, createdAt }
    whatsappLog: [],
    // Payroll: commission/incentive rules and recorded commission entries (real-estate style -
    // e.g. % commission on a deal value). Feeds into payslip "otherEarnings" when generating pay.
    payrollConfig: {
      commissionEnabled: true,
      // Tiered commission - the rate applied is based on the deal value slab.
      // e.g. deals under 5,000,000 -> 1%, up to 20,000,000 -> 1.5%, above -> 2%
      commissionTiers: [
        { upTo: 5000000, rate: 1 },
        { upTo: 20000000, rate: 1.5 },
        { upTo: null, rate: 2 }
      ],
      incentiveRules: [
        { name: 'Perfect Attendance Bonus', condition: 'attendance>=100', amount: 2000 },
        { name: 'Zero Late Bonus', condition: 'lateDays==0', amount: 1000 }
      ]
    },
    // Individual deal/commission entries logged against an employee.
    // { id, employeeId, dealValue, commissionRate, commissionAmount, clientName, note, month, recordedBy, recordedAt }
    commissionEntries: [],
    settings: {
      companyName: 'Maxim Realty',
      officeStartTime: '09:30',
      officeEndTime: '18:30',
      lateAfterMinutes: 15,
      // How many hours an employee must work in a day to be marked "Present".
      // If they punch out having worked less than this, the day is marked "Late" instead
      // (regardless of what time they punched in) - see routes/attendance.js.
      targetWorkHours: 9,
      // Geofencing - punch in/out must be within geofenceRadius meters of officeLocation
      officeLocation: { lat: null, lng: null },
      geofenceRadius: 100,
      enforceGeofence: false,
      // Weekly off calendar, per department
      weeklyOffByDepartment: DEFAULT_WEEKLY_OFF,
      holidays: [], // [{ date: 'YYYY-MM-DD', name: 'Diwali' }, ...]
      // WhatsApp Business API integration point. Provide your own provider credentials to
      // enable live sending (this app has no network access to test live sends itself, so
      // without these filled in every notification is safely logged as 'skipped' instead of
      // silently pretending to succeed).
      whatsapp: {
        enabled: false,
        provider: 'twilio', // 'twilio' | 'meta_cloud'
        accountSid: '',
        authToken: '',
        fromNumber: '',
        metaAccessToken: '',
        metaPhoneNumberId: '',
        notifyOnPunchIn: true,
        notifyOnPunchOut: false,
        notifyOnLeaveApplied: true,
        notifyOnLeaveDecided: true
      }
    },
    counters: {
      employeeId: 1000,
      attendanceId: 1,
      leaveId: 1,
      regularizationId: 1,
      payslipId: 1,
      leaveCreditId: 1,
      documentId: 1,
      taskId: 1,
      fieldVisitId: 1,
      whatsappLogId: 1,
      commissionEntryId: 1
    }
  };
}

// Fills in any fields missing from an older db.json so upgrades never crash
// existing installs. Mutates and returns `data`.
function migrate(data) {
  const fresh = defaultData();

  if (!Array.isArray(data.employees)) data.employees = [];
  if (!Array.isArray(data.attendance)) data.attendance = [];
  if (!Array.isArray(data.leaveRequests)) data.leaveRequests = [];
  if (!Array.isArray(data.regularizations)) data.regularizations = [];
  if (!Array.isArray(data.payslips)) data.payslips = [];
  if (!Array.isArray(data.passwordResets)) data.passwordResets = [];
  if (!Array.isArray(data.leaveCredits)) data.leaveCredits = [];
  if (!Array.isArray(data.documents)) data.documents = [];
  if (!Array.isArray(data.tasks)) data.tasks = [];
  if (!Array.isArray(data.fieldVisits)) data.fieldVisits = [];
  if (!Array.isArray(data.whatsappLog)) data.whatsappLog = [];
  if (!Array.isArray(data.commissionEntries)) data.commissionEntries = [];
  data.payrollConfig = { ...fresh.payrollConfig, ...(data.payrollConfig || {}) };
  if (!Array.isArray(data.payrollConfig.commissionTiers)) data.payrollConfig.commissionTiers = fresh.payrollConfig.commissionTiers;
  if (!Array.isArray(data.payrollConfig.incentiveRules)) data.payrollConfig.incentiveRules = fresh.payrollConfig.incentiveRules;

  data.leavePolicy = { ...fresh.leavePolicy, ...(data.leavePolicy || {}) };
  if (!data.leavePolicyOverrides || typeof data.leavePolicyOverrides !== 'object') {
    data.leavePolicyOverrides = {};
  }

  data.settings = { ...fresh.settings, ...(data.settings || {}) };
  data.settings.officeLocation = { ...fresh.settings.officeLocation, ...(data.settings.officeLocation || {}) };
  data.settings.weeklyOffByDepartment = {
    ...fresh.settings.weeklyOffByDepartment,
    ...(data.settings.weeklyOffByDepartment || {})
  };
  if (!Array.isArray(data.settings.holidays)) data.settings.holidays = [];
  data.settings.holidays.forEach((h) => { if (!h.icon) h.icon = guessHolidayIcon(h.name); });
  data.settings.whatsapp = { ...fresh.settings.whatsapp, ...(data.settings.whatsapp || {}) };

  data.counters = { ...fresh.counters, ...(data.counters || {}) };

  // Backfill role field so old employees default to 'employee' if missing
  data.employees.forEach((e) => {
    if (!e.role) e.role = 'employee';
    if (e.dob === undefined) e.dob = null; // 'YYYY-MM-DD', used for Birthday Reminder
    if (e.facePhoto === undefined) e.facePhoto = null; // base64 reference photo for Face Punch
    if (e.faceEnrolled === undefined) e.faceEnrolled = false;
  });

  return data;
}

function ensureDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultData(), null, 2));
  }
}

function readDb() {
  ensureDb();
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  try {
    const data = migrate(JSON.parse(raw));
    return data;
  } catch (e) {
    console.error('DB parse error, resetting to default:', e.message);
    const fresh = defaultData();
    writeDb(fresh);
    return fresh;
  }
}

function writeDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

module.exports = { readDb, writeDb, DB_PATH, DEFAULT_WEEKLY_OFF, guessHolidayIcon };
