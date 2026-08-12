if (!requireAuth()) { /* redirected */ }
if (!requireStaffRole()) { /* redirected */ }

const user = getUser();
const isAdmin = user && user.role === 'admin';

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

document.getElementById('sidebarName').textContent = user ? user.name : '-';
document.getElementById('sidebarAvatar').textContent = user ? initials(user.name) : '?';
document.getElementById('sidebarRoleLabel').textContent = isAdmin ? 'Administrator' : 'Manager';

// Managers get a scoped, read-mostly view: hide admin-only controls (Settings nav,
// Add Employee, edit/delete actions, holiday management, payslip generation).
if (!isAdmin) {
  document.querySelectorAll('.admin-only').forEach((el) => (el.style.display = 'none'));
}
// Admins manage the system and don't have their own punch clock - only managers
// (and employees, on the separate employee dashboard) punch in/out.
if (isAdmin) {
  document.querySelectorAll('.manager-only').forEach((el) => (el.style.display = 'none'));
}

document.getElementById('logoutBtn').addEventListener('click', logout);

// ---------------- Sidebar toggle (mobile) ----------------
const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('overlay');
document.getElementById('hamburgerBtn').addEventListener('click', () => {
  sidebar.classList.add('open');
  overlay.classList.add('show');
});
overlay.addEventListener('click', () => {
  sidebar.classList.remove('open');
  overlay.classList.remove('show');
});

// ---------------- Tab Navigation ----------------
const navItems = document.querySelectorAll('.nav-item');
const pageTitle = document.getElementById('pageTitle');
const titles = {
  overview: 'Overview', employees: 'Employee Management', attendance: 'Attendance Records',
  leave: 'Leave Approvals', leavepolicy: 'Leave Policy', regularization: 'Regularization Requests', payslips: 'Payslips',
  calendar: 'Team Calendar', settings: 'Settings', profile: 'My Profile',
  performance: 'Performance Dashboard', reports: 'AI Reports', documents: 'Documents',
  tasks: 'Daily Tasks & Activity', fieldvisits: 'Field Sales GPS Tracking', payroll: 'Payroll & Commission'
};

const LEAVE_LABELS = { casual: 'Casual', sick: 'Sick', earned: 'Earned', unpaid: 'Unpaid' };
const STATUS_LABELS = {
  present: 'Present',
  late: 'Late',
  absent: 'Absent',
  'holiday-worked': 'Present (Holiday)',
  'weekoff-worked': 'Present (Week Off)'
};
function statusBadgeHtml(status) {
  const cls = status === 'late' ? 'badge-late' : status === 'absent' ? 'badge-absent' : 'badge-present';
  const label = STATUS_LABELS[status] || (status || '-');
  return `<span class="badge ${cls}">${label}</span>`;
}

navItems.forEach((item) => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const tab = item.dataset.tab;
    navItems.forEach((i) => i.classList.remove('active'));
    item.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach((p) => (p.style.display = 'none'));
    document.getElementById(`tab-${tab}`).style.display = 'block';
    pageTitle.textContent = titles[tab];
    sidebar.classList.remove('open');
    overlay.classList.remove('show');

    if (tab === 'employees') loadEmployees();
    if (tab === 'attendance') loadAttendance();
    if (tab === 'overview') loadOverview();
    if (tab === 'profile') loadProfile();
    if (tab === 'leave') { loadLeaveApprovals(); populateLeaveForEmployeeSelects(); }
    if (tab === 'leavepolicy') loadLeavePolicy();
    if (tab === 'regularization') loadRegApprovals();
    if (tab === 'payslips') loadPayslipsAdmin();
    if (tab === 'calendar') { loadTeamCalendar(); loadHolidays(); }
    if (tab === 'settings') loadSettings();
    if (tab === 'performance') loadPerformance();
    if (tab === 'reports') loadAiReports();
    if (tab === 'documents') loadDocuments();
    if (tab === 'tasks') loadTasks();
    if (tab === 'fieldvisits') loadFieldVisits();
    if (tab === 'payroll') loadPayroll();
  });
});

// ---------------- Live Clock ----------------
function tick() {
  document.getElementById('topClock').textContent = new Date().toLocaleTimeString('en-IN', { hour12: true });
}
tick();
setInterval(tick, 1000);

// ---------------- Real-time Live Activity Feed (Server-Sent Events) ----------------
function connectLiveFeed() {
  const badge = document.getElementById('liveStatusBadge');
  const feed = document.getElementById('liveFeed');
  if (!badge || !feed) return;

  const es = new EventSource(`/api/live?token=${encodeURIComponent(getToken())}`);

  es.onopen = () => {
    badge.textContent = 'Live';
    badge.className = 'badge badge-present';
  };

  es.onerror = () => {
    badge.textContent = 'Reconnecting…';
    badge.className = 'badge badge-late';
  };

  es.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch (e) { return; }
    if (msg.type === 'connected') return;

    const labelMap = {
      'punch-in': (p) => `🟢 ${p.employeeName} punched in at ${formatTime12(p.time.slice(0,5))}`,
      'punch-out': (p) => `🔴 ${p.employeeName} punched out at ${formatTime12(p.time.slice(0,5))} · worked ${p.workHours || ''}${p.status === 'late' ? ' (Late - under target)' : ''}`,
      'leave-applied': (p) => `🌴 ${p.employeeName} applied for ${LEAVE_LABELS[p.leaveType] || p.leaveType} leave (${p.days} day${p.days > 1 ? 's' : ''})`,
      'leave-decided': (p) => `📋 Leave for ${p.employeeName} was ${p.status}`,
      'leave-credited': (p) => `🎁 ${p.amount} day(s) of ${LEAVE_LABELS[p.type] || p.type} leave credited to ${p.employeeName}`,
      'leave-policy-updated': (p) => p.scope === 'company' ? `📜 Company-wide leave policy was updated` : `📜 Leave policy updated for ${p.employeeName}`,
      'regularization-applied': (p) => `✏️ ${p.employeeName} requested a correction for ${formatDate(p.date)}`,
      'regularization-decided': (p) => `✅ Correction for ${p.employeeName} on ${formatDate(p.date)} was ${p.status}`,
      'employee-added': (p) => `👋 ${p.name} was added to ${p.department}`,
      'employee-updated': (p) => `✎ ${p.name}'s profile was updated`,
      'employee-removed': (p) => `🗑 ${p.name} was removed`,
      'settings-updated': (p) => `⚙️ Company settings were updated by ${p.updatedBy}`,
      'holiday-updated': (p) => `📅 Holiday calendar updated: ${p.name || p.date} (${p.action})`,
      'payslip-issued': (p) => `💰 Payslip for ${p.monthLabel} issued to ${p.employeeName}`,
      'absentees-marked': (p) => `🚫 ${p.count} employee(s) marked absent for ${formatDate(p.date)}`
    };
    const build = labelMap[msg.type];
    if (!build) return;

    if (feed.querySelector('.text-muted')) feed.innerHTML = '';

    const row = document.createElement('div');
    row.className = 'live-feed-item';
    row.innerHTML = `<span>${build(msg.payload)}</span><small class="text-muted">${new Date(msg.time).toLocaleTimeString('en-IN', { hour12: true })}</small>`;
    feed.prepend(row);
    while (feed.children.length > 25) feed.removeChild(feed.lastChild);

    // Keep other tabs fresh when something relevant happens
    const tab = document.querySelector('.nav-item.active')?.dataset.tab;
    if (msg.type === 'punch-in' || msg.type === 'punch-out') { loadOverview(); if (tab === 'attendance') loadAttendance(); }
    if ((msg.type === 'leave-applied' || msg.type === 'leave-decided') && tab === 'leave') loadLeaveApprovals();
    if (msg.type === 'leave-policy-updated' && tab === 'leavepolicy') loadLeavePolicy();
    if ((msg.type === 'regularization-applied' || msg.type === 'regularization-decided') && tab === 'regularization') loadRegApprovals();
    if ((msg.type === 'employee-added' || msg.type === 'employee-updated' || msg.type === 'employee-removed')) {
      if (tab === 'employees') loadEmployees(); else loadEmployeesCache();
    }
    if (msg.type === 'settings-updated' && tab === 'settings') loadSettings();
    if (msg.type === 'holiday-updated' && tab === 'calendar') loadHolidays();
    if (msg.type === 'payslip-issued' && tab === 'payslips' && isAdmin) loadPayslipsAdmin();
    if (msg.type === 'absentees-marked' && tab === 'attendance') loadAttendance();
    if (msg.type === 'document-uploaded' && tab === 'documents') loadDocuments();
  };
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

// ================= MY ATTENDANCE (self punch in/out - managers & admins) =================
function myAttClockTick() {
  const el = document.getElementById('myAttClock');
  if (el) el.textContent = new Date().toLocaleTimeString('en-IN', { hour12: true });
}
myAttClockTick();
setInterval(myAttClockTick, 1000);

async function loadMyAttendance() {
  if (isAdmin) return; // admins don't punch in/out
  try {
    const data = await apiRequest('/attendance/status');
    const record = data.record;
    window._lastMyAttRecord = record;
    document.getElementById('myAttIn').textContent = record && record.punchIn ? formatTime12(record.punchIn.slice(0, 5)) : '-';
    document.getElementById('myAttOut').textContent = record && record.punchOut ? formatTime12(record.punchOut.slice(0, 5)) : '-';

    const statusEl = document.getElementById('myAttStatus');
    const inBtn = document.getElementById('myPunchInBtn');
    const outBtn = document.getElementById('myPunchOutBtn');

    if (!record || !record.punchIn) {
      statusEl.textContent = 'Not punched in yet';
      inBtn.disabled = false; outBtn.disabled = true;
    } else if (record.punchIn && !record.punchOut) {
      statusEl.textContent = 'Punched in';
      inBtn.disabled = true; outBtn.disabled = false;
    } else {
      statusEl.textContent = `Day complete · worked ${record.workHours || ''} · ${STATUS_LABELS[record.status] || record.status}`;
      inBtn.disabled = true; outBtn.disabled = true;
    }
    updateMyAttTargetMsg(record);
  } catch (err) {
    document.getElementById('myAttStatus').textContent = 'Unable to load';
  }
}

// Friendly nudge showing progress toward the target work hours (default 9h) that
// determines whether the day ends up marked Present or Late.
let myTargetWorkHours = 9;
async function loadMyTargetHours() {
  try {
    const data = await apiRequest('/settings');
    myTargetWorkHours = (data.settings && data.settings.targetWorkHours) || 9;
  } catch (err) { /* keep default */ }
}

function updateMyAttTargetMsg(record) {
  const msgEl = document.getElementById('myAttMsg');
  if (!msgEl || isAdmin) return;
  if (!record || !record.punchIn) { msgEl.textContent = ''; return; }
  if (record.punchOut) {
    msgEl.textContent = record.status === 'present'
      ? `✔ Target met - marked Present`
      : `Worked ${record.workHours || '0h 0m'} - under the ${myTargetWorkHours}h target, marked Late`;
    return;
  }
  const [h, m, s] = record.punchIn.split(':').map(Number);
  const punchInDate = new Date();
  punchInDate.setHours(h, m, s || 0, 0);
  const elapsedMs = Math.max(0, Date.now() - punchInDate.getTime());
  const remainingMs = myTargetWorkHours * 3600000 - elapsedMs;
  if (remainingMs <= 0) {
    msgEl.textContent = '✔ Target reached - will be marked Present on punch out';
  } else {
    const remH = Math.floor(remainingMs / 3600000);
    const remM = Math.floor((remainingMs % 3600000) / 60000);
    msgEl.textContent = `${remH}h ${remM}m left to reach the ${myTargetWorkHours}h target`;
  }
}
if (!isAdmin) {
  loadMyTargetHours();
  setInterval(() => { if (window._lastMyAttRecord) updateMyAttTargetMsg(window._lastMyAttRecord); }, 30000);
}

async function doMyPunch(kind) {
  const btn = kind === 'in' ? document.getElementById('myPunchInBtn') : document.getElementById('myPunchOutBtn');
  const msgEl = document.getElementById('myAttMsg');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Please wait...';
  msgEl.textContent = '';
  try {
    // Managers/admins aren't geofenced, but we still try to attach a location if
    // the browser has it handy (purely informational for the admin's records).
    let lat = null, lng = null;
    try {
      const loc = await getCurrentLocation();
      lat = loc.lat; lng = loc.lng;
    } catch (e) { /* location optional for managers/admins - proceed without it */ }

    const data = await apiRequest(`/attendance/punch-${kind}`, { method: 'POST', body: JSON.stringify({ lat, lng }) });
    showToast(data.message, 'success');
    msgEl.textContent = data.message;
    loadMyAttendance();
    loadOverview();
  } catch (err) {
    showToast(err.message, 'error');
    msgEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

const myPunchInBtn = document.getElementById('myPunchInBtn');
const myPunchOutBtn = document.getElementById('myPunchOutBtn');
if (myPunchInBtn) myPunchInBtn.addEventListener('click', () => doMyPunch('in'));
if (myPunchOutBtn) myPunchOutBtn.addEventListener('click', () => doMyPunch('out'));

// ---------------- Currently Working (live) ----------------
async function loadWorkingNow() {
  const tbody = document.getElementById('workingNowBody');
  if (!tbody) return;
  try {
    const data = await apiRequest('/attendance/working-now');
    const list = data.working || [];
    if (list.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No one is currently punched in</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((w) => `
      <tr>
        <td>${w.employeeName}</td>
        <td>${w.department || '-'}</td>
        <td>${formatTime12(w.punchIn.slice(0, 5))}</td>
        <td>${statusBadgeHtml(w.status)}</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="4">${err.message}</td></tr>`;
  }
}

// ---------------- Mark Absentees (admin) ----------------
const markAbsenteesBtn = document.getElementById('markAbsenteesBtn');
if (markAbsenteesBtn) {
  markAbsenteesBtn.addEventListener('click', async () => {
    const dateInput = document.getElementById('markAbsenteesDate');
    const date = dateInput.value || isoDate(new Date());
    if (!confirm(`Mark every active employee with no attendance record on ${date} as absent (skipping weekly-offs, holidays, and approved leave)?`)) return;
    markAbsenteesBtn.disabled = true;
    try {
      const data = await apiRequest('/attendance/mark-absentees', { method: 'POST', body: JSON.stringify({ date }) });
      showToast(data.message, 'success');
      loadAttendance();
      loadOverview();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      markAbsenteesBtn.disabled = false;
    }
  });
}

// ================= OVERVIEW =================
async function loadOverview() {
  loadMyAttendance();
  loadWorkingNow();
  loadCelebrationBanner();
  document.getElementById('todayDateLabel').textContent = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
  });
  try {
    const summary = await apiRequest('/attendance/summary');
    document.getElementById('statTotal').textContent = summary.totalEmployees;
    document.getElementById('statPresent').textContent = summary.presentToday;
    document.getElementById('statAbsent').textContent = summary.absentToday;
    document.getElementById('statLate').textContent = summary.lateToday;

    const today = summary.date;
    const data = await apiRequest(`/attendance/all?date=${today}`);
    const tbody = document.getElementById('todayBody');
    if (employeesCache.length === 0) await loadEmployeesCache();
    const empMap = {};
    employeesCache.forEach((e) => (empMap[e.id] = e));

    if (data.records.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No punches recorded yet today</td></tr>';
    } else {
      tbody.innerHTML = data.records.map((r) => {
        const emp = empMap[r.employeeId] || {};
        return `
          <tr>
            <td>${r.employeeName}</td>
            <td>${emp.department || '-'}</td>
            <td>${r.punchIn ? formatTime12(r.punchIn.slice(0,5)) : '-'}</td>
            <td>${r.punchOut ? formatTime12(r.punchOut.slice(0,5)) : '-'}</td>
            <td>${r.workHours || '-'}</td>
            <td>${statusBadgeHtml(r.status)}</td>
          </tr>`;
      }).join('');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ================= EMPLOYEES =================
let employeesCache = [];

async function loadEmployeesCache() {
  const data = await apiRequest('/employees');
  employeesCache = data.employees;
  populateEmployeeFilter();
  populateDeptSuggestions();
  populateManualEmployeeSelect();
}

async function loadEmployees() {
  const tbody = document.getElementById('employeesBody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Loading...</td></tr>';
  try {
    const search = document.getElementById('empSearchInput').value.trim();
    const dept = document.getElementById('empDeptFilter').value;
    const status = document.getElementById('empStatusFilter').value;

    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (dept) params.set('department', dept);
    if (status) params.set('status', status);

    const data = await apiRequest(`/employees?${params.toString()}`);
    const list = data.employees;

    // Keep a full cache (unfiltered) for filters/selects — only refresh if this is an unfiltered load
    if (!search && !dept && !status) {
      employeesCache = list;
      populateEmployeeFilter();
      populateDeptSuggestions();
      populateManualEmployeeSelect();
    }

    if (list.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No employees found</td></tr>';
      return;
    }

    tbody.innerHTML = list.map((e) => `
      <tr>
        <td>
          <div class="name-cell">
            <div class="avatar-circle-sm">${initials(e.name)}</div>
            <div class="who-info"><b>${e.name}</b><span>${e.username}</span></div>
          </div>
        </td>
        <td>${e.empCode}</td>
        <td>${e.department}</td>
        <td>${e.designation}</td>
        <td><span class="badge badge-active">${e.role}</span></td>
        <td><span class="badge ${e.status === 'active' ? 'badge-active' : 'badge-inactive'}">${e.status}</span></td>
        <td>
          <div class="action-icons">
            <button class="icon-btn" title="View Profile" onclick="openEmployeeDetail(${e.id})">👁</button>
            <button class="icon-btn" title="Edit" onclick="openEditEmployee(${e.id})">✎</button>
            <button class="icon-btn danger" title="Delete" onclick="openDeleteEmployee(${e.id})">🗑</button>
          </div>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">${err.message}</td></tr>`;
  }
}

document.getElementById('empSearchInput').addEventListener('input', debounce(loadEmployees, 300));
document.getElementById('empDeptFilter').addEventListener('change', loadEmployees);
document.getElementById('empStatusFilter').addEventListener('change', loadEmployees);

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function populateEmployeeFilter() {
  const filterEmployee = document.getElementById('filterEmployee');
  const current = filterEmployee.value;
  filterEmployee.innerHTML = '<option value="">All Employees</option>' +
    employeesCache.map((e) => `<option value="${e.id}">${e.name}</option>`).join('');
  filterEmployee.value = current;
}

function populateDeptSuggestions() {
  const depts = [...new Set(employeesCache.map((e) => e.department).filter(Boolean))].sort();
  const deptFilter = document.getElementById('empDeptFilter');
  const current = deptFilter.value;
  deptFilter.innerHTML = '<option value="">All Departments</option>' +
    depts.map((d) => `<option value="${d}">${d}</option>`).join('');
  deptFilter.value = current;

  const datalist = document.getElementById('deptSuggestions');
  datalist.innerHTML = depts.map((d) => `<option value="${d}"></option>`).join('');

  const attDeptFilter = document.getElementById('filterDepartment');
  if (attDeptFilter) {
    const currentAtt = attDeptFilter.value;
    attDeptFilter.innerHTML = '<option value="">All Departments</option>' +
      depts.map((d) => `<option value="${d}">${d}</option>`).join('');
    attDeptFilter.value = currentAtt;
  }
}

function populateManualEmployeeSelect() {
  const sel = document.getElementById('manualEmployee');
  sel.innerHTML = employeesCache.map((e) => `<option value="${e.id}">${e.name} (${e.empCode})</option>`).join('');
}

// --- Employee Add/Edit Modal ---
const empModal = document.getElementById('empModal');
document.getElementById('addEmpBtn').addEventListener('click', () => openAddEmployee());
document.getElementById('empCancelBtn').addEventListener('click', () => empModal.classList.remove('show'));

function resetEmpForm() {
  document.getElementById('empId').value = '';
  document.getElementById('empName').value = '';
  document.getElementById('empEmail').value = '';
  document.getElementById('empUsername').value = '';
  document.getElementById('empPassword').value = '';
  document.getElementById('empConfirmPassword').value = '';
  document.getElementById('empDept').value = '';
  document.getElementById('empDesig').value = '';
  document.getElementById('empPhone').value = '';
  document.getElementById('empDob').value = '';
  document.getElementById('empRole').value = 'employee';
  document.getElementById('empStatus').value = 'active';
}

function openAddEmployee() {
  resetEmpForm();
  document.getElementById('empModalTitle').textContent = 'Add Employee';
  document.getElementById('empUsername').disabled = false;
  document.getElementById('empPwdLabel').textContent = 'Password';
  document.getElementById('empPassword').placeholder = '';
  document.getElementById('empConfirmPwdLabel').textContent = 'Confirm Password';
  document.getElementById('empConfirmPassword').placeholder = '';
  document.getElementById('empStatusField').style.display = 'none';
  empModal.classList.add('show');
}

function openEditEmployee(id) {
  const emp = employeesCache.find((e) => e.id === id);
  if (!emp) return;
  document.getElementById('empModalTitle').textContent = 'Edit Employee';
  document.getElementById('empId').value = emp.id;
  document.getElementById('empName').value = emp.name;
  document.getElementById('empEmail').value = emp.email;
  document.getElementById('empUsername').value = emp.username;
  document.getElementById('empUsername').disabled = true;
  document.getElementById('empPassword').value = '';
  document.getElementById('empPwdLabel').textContent = 'New Password (optional)';
  document.getElementById('empPassword').placeholder = 'Leave blank to keep unchanged';
  document.getElementById('empConfirmPassword').value = '';
  document.getElementById('empConfirmPwdLabel').textContent = 'Confirm New Password';
  document.getElementById('empConfirmPassword').placeholder = 'Leave blank to keep unchanged';
  document.getElementById('empDept').value = emp.department;
  document.getElementById('empDesig').value = emp.designation;
  document.getElementById('empPhone').value = emp.phone || '';
  document.getElementById('empDob').value = emp.dob || '';
  document.getElementById('empRole').value = emp.role;
  document.getElementById('empStatus').value = emp.status;
  document.getElementById('empStatusField').style.display = 'block';
  empModal.classList.add('show');
}
window.openEditEmployee = openEditEmployee;

document.getElementById('empSaveBtn').addEventListener('click', async () => {
  const id = document.getElementById('empId').value;
  const password = document.getElementById('empPassword').value;
  const confirmPassword = document.getElementById('empConfirmPassword').value;
  const payload = {
    name: document.getElementById('empName').value.trim(),
    email: document.getElementById('empEmail').value.trim(),
    username: document.getElementById('empUsername').value.trim(),
    password,
    confirmPassword,
    department: document.getElementById('empDept').value.trim(),
    designation: document.getElementById('empDesig').value.trim(),
    phone: document.getElementById('empPhone').value.trim(),
    dob: document.getElementById('empDob').value || null,
    role: document.getElementById('empRole').value,
    status: document.getElementById('empStatus').value
  };

  if (!payload.name || !payload.username || (!id && !payload.password)) {
    showToast('Name, username and password are required', 'error');
    return;
  }
  if (payload.password && payload.password !== confirmPassword) {
    showToast('Password and confirm password do not match', 'error');
    return;
  }

  try {
    if (id) {
      const data = await apiRequest(`/employees/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      showToast(data.message, 'success');
    } else {
      const data = await apiRequest('/employees', { method: 'POST', body: JSON.stringify(payload) });
      showToast(data.message, 'success');
    }
    empModal.classList.remove('show');
    loadEmployees();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// --- Employee Detail / Profile Modal ---
const empDetailModal = document.getElementById('empDetailModal');
async function openEmployeeDetail(id) {
  empDetailModal.classList.add('show');
  document.getElementById('edRecentBody').innerHTML = '<tr class="empty-row"><td colspan="5">Loading...</td></tr>';
  try {
    const data = await apiRequest(`/employees/${id}`);
    const e = data.employee;
    document.getElementById('edAvatar').textContent = initials(e.name);
    document.getElementById('edName').textContent = e.name;
    document.getElementById('edDesig').textContent = `${e.designation} · ${e.department}`;
    document.getElementById('edCode').textContent = e.empCode;
    document.getElementById('edUsername').textContent = e.username;
    document.getElementById('edEmail').textContent = e.email || '-';
    document.getElementById('edPhone').textContent = e.phone || '-';
    document.getElementById('edDept').textContent = e.department;
    document.getElementById('edJoin').textContent = formatDate(e.joinDate);
    document.getElementById('edStatus').textContent = e.status;

    document.getElementById('edPresent').textContent = data.monthSummary.presentDays;
    document.getElementById('edLate').textContent = data.monthSummary.lateDays;
    document.getElementById('edTotal').textContent = data.monthSummary.totalDaysRecorded;

    const recentBody = document.getElementById('edRecentBody');
    if (data.recentRecords.length === 0) {
      recentBody.innerHTML = '<tr class="empty-row"><td colspan="5">No punches recorded yet</td></tr>';
    } else {
      recentBody.innerHTML = data.recentRecords.map((r) => `
        <tr>
          <td>${formatDate(r.date)}</td>
          <td>${r.punchIn ? formatTime12(r.punchIn.slice(0,5)) : '-'}</td>
          <td>${r.punchOut ? formatTime12(r.punchOut.slice(0,5)) : '-'}</td>
          <td>${r.workHours || '-'}</td>
          <td>${statusBadgeHtml(r.status)}</td>
        </tr>
      `).join('');
    }
  } catch (err) {
    showToast(err.message, 'error');
    empDetailModal.classList.remove('show');
  }
}
window.openEmployeeDetail = openEmployeeDetail;
document.getElementById('edCloseBtn').addEventListener('click', () => empDetailModal.classList.remove('show'));

// --- Delete Employee Modal ---
const deleteModal = document.getElementById('deleteModal');
let pendingDeleteId = null;

function openDeleteEmployee(id) {
  const emp = employeesCache.find((e) => e.id === id);
  if (!emp) return;
  pendingDeleteId = id;
  document.getElementById('deleteEmpName').textContent = emp.name;
  deleteModal.classList.add('show');
}
window.openDeleteEmployee = openDeleteEmployee;

document.getElementById('deleteCancelBtn').addEventListener('click', () => {
  deleteModal.classList.remove('show');
  pendingDeleteId = null;
});

document.getElementById('deleteConfirmBtn').addEventListener('click', async () => {
  if (!pendingDeleteId) return;
  try {
    const data = await apiRequest(`/employees/${pendingDeleteId}`, { method: 'DELETE' });
    showToast(data.message, 'success');
    deleteModal.classList.remove('show');
    loadEmployees();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ================= ATTENDANCE RECORDS =================
const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const filterMonth = document.getElementById('filterMonth');
const filterYear = document.getElementById('filterYear');
const filterFromDate = document.getElementById('filterFromDate');
const filterToDate = document.getElementById('filterToDate');
const filterEmployee = document.getElementById('filterEmployee');
const filterDepartment = document.getElementById('filterDepartment');
const filterStatus = document.getElementById('filterStatus');

function initAttendanceFilters() {
  const now = new Date();
  monthNames.forEach((m, i) => {
    const opt = document.createElement('option');
    opt.value = i + 1;
    opt.textContent = m;
    if (i + 1 === now.getMonth() + 1) opt.selected = true;
    filterMonth.appendChild(opt);
  });
  for (let y = now.getFullYear(); y >= now.getFullYear() - 3; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    if (y === now.getFullYear()) opt.selected = true;
    filterYear.appendChild(opt);
  }
}
initAttendanceFilters();

[filterMonth, filterYear].forEach((el) => {
  el.addEventListener('change', () => {
    filterFromDate.value = '';
    filterToDate.value = '';
    loadAttendance();
  });
});
filterEmployee.addEventListener('change', loadAttendance);
filterDepartment.addEventListener('change', loadAttendance);
filterStatus.addEventListener('change', loadAttendance);
[filterFromDate, filterToDate].forEach((el) => {
  el.addEventListener('change', () => {
    if (filterFromDate.value || filterToDate.value) loadAttendance();
  });
});

document.getElementById('quickTodayBtn').addEventListener('click', () => {
  const today = isoDate(new Date());
  filterFromDate.value = today;
  filterToDate.value = today;
  loadAttendance();
});
document.getElementById('quickWeekBtn').addEventListener('click', () => {
  const now = new Date();
  const day = now.getDay() === 0 ? 6 : now.getDay() - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - day);
  filterFromDate.value = isoDate(monday);
  filterToDate.value = isoDate(now);
  loadAttendance();
});
document.getElementById('clearFilterBtn').addEventListener('click', () => {
  filterFromDate.value = '';
  filterToDate.value = '';
  loadAttendance();
});

function currentAttendanceQuery() {
  const params = new URLSearchParams();
  if (filterFromDate.value || filterToDate.value) {
    if (filterFromDate.value) params.set('fromDate', filterFromDate.value);
    if (filterToDate.value) params.set('toDate', filterToDate.value);
  } else {
    params.set('month', filterMonth.value);
    params.set('year', filterYear.value);
  }
  if (filterEmployee.value) params.set('employeeId', filterEmployee.value);
  if (filterDepartment.value) params.set('department', filterDepartment.value);
  if (filterStatus.value) params.set('status', filterStatus.value);
  return params;
}

let lastLoadedRecords = [];

async function loadAttendance() {
  const tbody = document.getElementById('attendanceBody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="8">Loading...</td></tr>';
  try {
    const params = currentAttendanceQuery();
    const data = await apiRequest(`/attendance/all?${params.toString()}`);
    lastLoadedRecords = data.records;
    const empMap = {};
    employeesCache.forEach((e) => (empMap[e.id] = e));

    if (data.records.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No attendance records found</td></tr>';
      return;
    }

    tbody.innerHTML = data.records.map((r) => {
      const emp = empMap[r.employeeId] || {};
      return `
        <tr>
          <td>${formatDate(r.date)}</td>
          <td>${r.employeeName}</td>
          <td>${emp.department || '-'}</td>
          <td>${r.punchIn ? formatTime12(r.punchIn.slice(0,5)) : '-'}</td>
          <td>${r.punchOut ? formatTime12(r.punchOut.slice(0,5)) : '-'}</td>
          <td>${r.workHours || '-'}</td>
          <td>${statusBadgeHtml(r.status)}</td>
          <td>
            <div class="action-icons">
              <button class="icon-btn" title="Edit" onclick="openManualEntry(${r.employeeId}, '${r.date}')">✎</button>
              <button class="icon-btn danger" title="Delete" onclick="openDeleteRecord(${r.id})">🗑</button>
            </div>
          </td>
        </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">${err.message}</td></tr>`;
  }
}

document.getElementById('exportBtn').addEventListener('click', () => {
  const params = currentAttendanceQuery();
  fetch(`/api/attendance/export?${params.toString()}`, {
    headers: { Authorization: `Bearer ${getToken()}` }
  })
    .then((res) => res.blob())
    .then((blob) => {
      const link = document.createElement('a');
      link.href = window.URL.createObjectURL(blob);
      link.download = `attendance-export.csv`;
      link.click();
      showToast('Export downloaded successfully', 'success');
    })
    .catch(() => showToast('Export failed', 'error'));
});

// --- Manual Entry Modal ---
const manualModal = document.getElementById('manualModal');
document.getElementById('manualEntryBtn').addEventListener('click', () => {
  document.getElementById('manualDate').value = isoDate(new Date());
  document.getElementById('manualPunchIn').value = '';
  document.getElementById('manualPunchOut').value = '';
  document.getElementById('manualStatus').value = 'present';
  document.getElementById('manualNote').value = '';
  manualModal.classList.add('show');
});
document.getElementById('manualCancelBtn').addEventListener('click', () => manualModal.classList.remove('show'));

function openManualEntry(employeeId, date) {
  document.getElementById('manualEmployee').value = employeeId;
  document.getElementById('manualDate').value = date;
  const existing = lastLoadedRecords.find((r) => r.employeeId === employeeId && r.date === date);
  document.getElementById('manualPunchIn').value = existing && existing.punchIn ? existing.punchIn.slice(0,5) : '';
  document.getElementById('manualPunchOut').value = existing && existing.punchOut ? existing.punchOut.slice(0,5) : '';
  document.getElementById('manualStatus').value = existing ? existing.status : 'present';
  document.getElementById('manualNote').value = existing ? (existing.note || '') : '';
  manualModal.classList.add('show');
}
window.openManualEntry = openManualEntry;

document.getElementById('manualSaveBtn').addEventListener('click', async () => {
  const payload = {
    employeeId: parseInt(document.getElementById('manualEmployee').value, 10),
    date: document.getElementById('manualDate').value,
    punchIn: document.getElementById('manualPunchIn').value,
    punchOut: document.getElementById('manualPunchOut').value,
    status: document.getElementById('manualStatus').value,
    note: document.getElementById('manualNote').value
  };
  if (!payload.employeeId || !payload.date) {
    showToast('Please select an employee and date', 'error');
    return;
  }
  try {
    const data = await apiRequest('/attendance/manual', { method: 'POST', body: JSON.stringify(payload) });
    showToast(data.message, 'success');
    manualModal.classList.remove('show');
    loadAttendance();
    loadOverview();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// --- Delete Attendance Record Modal ---
const deleteRecordModal = document.getElementById('deleteRecordModal');
let pendingDeleteRecordId = null;
function openDeleteRecord(id) {
  pendingDeleteRecordId = id;
  deleteRecordModal.classList.add('show');
}
window.openDeleteRecord = openDeleteRecord;
document.getElementById('deleteRecordCancelBtn').addEventListener('click', () => {
  deleteRecordModal.classList.remove('show');
  pendingDeleteRecordId = null;
});
document.getElementById('deleteRecordConfirmBtn').addEventListener('click', async () => {
  if (!pendingDeleteRecordId) return;
  try {
    const data = await apiRequest(`/attendance/${pendingDeleteRecordId}`, { method: 'DELETE' });
    showToast(data.message, 'success');
    deleteRecordModal.classList.remove('show');
    loadAttendance();
    loadOverview();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ================= MY PROFILE =================
async function loadProfile() {
  try {
    const data = await apiRequest('/auth/me');
    const u = data.user;
    document.getElementById('profileAvatar').textContent = initials(u.name);
    document.getElementById('profileName').textContent = u.name;
    document.getElementById('profileDesig').textContent = `${u.designation} · ${u.department}`;
    document.getElementById('pfCode').textContent = u.empCode;
    document.getElementById('pfUsername').textContent = u.username;
    document.getElementById('pfDept').textContent = u.department;
    document.getElementById('pfJoin').textContent = formatDate(u.joinDate);
    document.getElementById('pfEmail').value = u.email || '';
    document.getElementById('pfPhone').value = u.phone || '';
    const badge = document.getElementById('profileRoleBadge');
    badge.textContent = u.role.charAt(0).toUpperCase() + u.role.slice(1);
  } catch (err) {
    showToast(err.message, 'error');
  }

  loadMyLeaveBalance();
  loadFaceEnrollStatus();
}

async function loadMyLeaveBalance() {
  const grid = document.getElementById('myLeaveBalanceGrid');
  if (!grid) return;
  try {
    const data = await apiRequest('/leave/balance');
    grid.innerHTML = (data.balance || []).filter((b) => b.type !== 'unpaid').map((b) => `
      <div class="stat-card">
        <div class="icon ${b.type === 'casual' ? 'icon-blue' : b.type === 'sick' ? 'icon-orange' : 'icon-green'}">${b.type === 'casual' ? '🌴' : b.type === 'sick' ? '🤒' : '⭐'}</div>
        <div>
          <div class="value">${b.balance}</div>
          <div class="label">${b.label} left ${b.credited ? `<span style="color:var(--green);">(+${b.credited} credited)</span>` : ''}</div>
        </div>
      </div>
    `).join('');
  } catch (err) {
    grid.innerHTML = `<div class="text-muted">${err.message}</div>`;
  }
}

document.getElementById('pfSaveBtn').addEventListener('click', async () => {
  const email = document.getElementById('pfEmail').value.trim();
  const phone = document.getElementById('pfPhone').value.trim();
  try {
    const data = await apiRequest('/auth/profile', { method: 'PUT', body: JSON.stringify({ email, phone }) });
    setUser(Object.assign({}, getUser(), { email, phone }));
    showToast(data.message, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('pwdSaveBtn').addEventListener('click', async () => {
  const currentPassword = document.getElementById('curPwd').value;
  const newPassword = document.getElementById('newPwd').value;
  const confirmPassword = document.getElementById('confirmNewPwd').value;
  if (!currentPassword || !newPassword || !confirmPassword) {
    showToast('Please fill all password fields', 'error');
    return;
  }
  if (newPassword !== confirmPassword) {
    showToast('New password and confirm password do not match', 'error');
    return;
  }
  try {
    const data = await apiRequest('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword, confirmPassword }) });
    showToast(data.message, 'success');
    document.getElementById('curPwd').value = '';
    document.getElementById('confirmNewPwd').value = '';
    document.getElementById('newPwd').value = '';
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ================= LEAVE APPROVALS =================
const leaveStatusFilter = document.getElementById('leaveStatusFilter');
const leaveEmployeeFilter = document.getElementById('leaveEmployeeFilter');
leaveStatusFilter.addEventListener('change', loadLeaveApprovals);
leaveEmployeeFilter.addEventListener('change', loadLeaveApprovals);

function populateLeaveForEmployeeSelects() {
  if (employeesCache.length === 0) return;
  const opts = employeesCache
    .filter((e) => e.role === 'employee' || e.role === 'manager')
    .map((e) => `<option value="${e.id}">${e.name} (${e.department})</option>`).join('');

  const applySel = document.getElementById('leaveForEmployee');
  if (applySel && !applySel.dataset.loaded) {
    applySel.innerHTML = opts;
    applySel.dataset.loaded = '1';
  }
  if (leaveEmployeeFilter && !leaveEmployeeFilter.dataset.loaded) {
    leaveEmployeeFilter.innerHTML = '<option value="">All Employees</option>' + opts;
    leaveEmployeeFilter.dataset.loaded = '1';
  }
}

async function loadLeaveApprovals() {
  const tbody = document.getElementById('leaveApprovalBody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="8">Loading...</td></tr>';
  try {
    if (employeesCache.length === 0) await loadEmployeesCache();
    populateLeaveForEmployeeSelects();

    const params = new URLSearchParams();
    if (leaveStatusFilter.value) params.set('status', leaveStatusFilter.value);
    if (leaveEmployeeFilter.value) params.set('employeeId', leaveEmployeeFilter.value);
    const data = await apiRequest(`/leave/all?${params.toString()}`);
    const records = data.records || [];
    if (records.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No leave requests found</td></tr>';
      return;
    }
    tbody.innerHTML = records.map((r) => `
      <tr>
        <td>${r.employeeName}</td>
        <td>${LEAVE_LABELS[r.leaveType] || r.leaveType}</td>
        <td>${formatDate(r.fromDate)}</td>
        <td>${formatDate(r.toDate)}</td>
        <td>${r.days}</td>
        <td>${r.reason}</td>
        <td><span class="badge ${r.status === 'approved' ? 'badge-present' : r.status === 'rejected' ? 'badge-absent' : r.status === 'cancelled' ? 'badge-inactive' : 'badge-late'}">${r.status}</span></td>
        <td>
          ${r.status === 'pending'
            ? (r.employeeId === user.id && !isAdmin
                ? '<span class="text-muted">Awaiting admin</span>'
                : `<div class="action-icons">
                     <button class="icon-btn" title="Approve" onclick="decideLeave(${r.id}, 'approve')">✔</button>
                     <button class="icon-btn danger" title="Reject" onclick="decideLeave(${r.id}, 'reject')">✖</button>
                   </div>`)
            : '-'}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">${err.message}</td></tr>`;
  }
}

async function decideLeave(id, action) {
  try {
    const data = await apiRequest(`/leave/${id}/${action}`, { method: 'PUT', body: JSON.stringify({}) });
    showToast(data.message, 'success');
    loadLeaveApprovals();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.decideLeave = decideLeave;

const leaveForApplyBtn = document.getElementById('leaveForApplyBtn');
if (leaveForApplyBtn) {
  leaveForApplyBtn.addEventListener('click', async () => {
    const employeeId = document.getElementById('leaveForEmployee').value;
    const leaveType = document.getElementById('leaveForType').value;
    const fromDate = document.getElementById('leaveForFrom').value;
    const toDate = document.getElementById('leaveForTo').value;
    const reason = document.getElementById('leaveForReason').value.trim();

    if (!employeeId || !fromDate || !toDate) {
      showToast('Please select an employee and both dates', 'error');
      return;
    }
    try {
      const data = await apiRequest(`/leave/apply-for/${employeeId}`, {
        method: 'POST',
        body: JSON.stringify({ leaveType, fromDate, toDate, reason })
      });
      showToast(data.message, 'success');
      document.getElementById('leaveForFrom').value = '';
      document.getElementById('leaveForTo').value = '';
      document.getElementById('leaveForReason').value = '';
      loadLeaveApprovals();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

// ================= LEAVE POLICY =================
async function loadLeavePolicy() {
  if (employeesCache.length === 0) await loadEmployeesCache();
  populateCreditEmployeeSelect();

  try {
    const data = await apiRequest('/leave/policy/employees');

    if (isAdmin) {
      document.getElementById('defCasual').value = data.defaultPolicy.casual;
      document.getElementById('defSick').value = data.defaultPolicy.sick;
      document.getElementById('defEarned').value = data.defaultPolicy.earned;
    }

    const tbody = document.getElementById('policyBody');
    const list = data.employees || [];
    if (list.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No employees found</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((e) => `
      <tr>
        <td>${e.name}</td>
        <td>${e.department}</td>
        <td><input type="number" min="0" class="policy-input" data-emp="${e.employeeId}" data-type="casual" value="${e.override.casual ?? ''}" placeholder="${data.defaultPolicy.casual}" style="width:64px;" /></td>
        <td><input type="number" min="0" class="policy-input" data-emp="${e.employeeId}" data-type="sick" value="${e.override.sick ?? ''}" placeholder="${data.defaultPolicy.sick}" style="width:64px;" /></td>
        <td><input type="number" min="0" class="policy-input" data-emp="${e.employeeId}" data-type="earned" value="${e.override.earned ?? ''}" placeholder="${data.defaultPolicy.earned}" style="width:64px;" /></td>
        <td style="font-size:12.5px;">
          C:${e.policy.casual} · S:${e.policy.sick} · E:${e.policy.earned}
        </td>
        <td><button class="btn btn-outline btn-sm" onclick="savePolicyOverride(${e.employeeId})">Save</button></td>
      </tr>
    `).join('');
  } catch (err) {
    showToast(err.message, 'error');
  }

  loadCreditHistory();
}

async function savePolicyOverride(employeeId) {
  const inputs = document.querySelectorAll(`.policy-input[data-emp="${employeeId}"]`);
  const payload = {};
  inputs.forEach((inp) => {
    payload[inp.dataset.type] = inp.value === '' ? null : inp.value;
  });
  try {
    const data = await apiRequest(`/leave/policy/${employeeId}`, { method: 'PUT', body: JSON.stringify(payload) });
    showToast(data.message, 'success');
    loadLeavePolicy();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.savePolicyOverride = savePolicyOverride;

const saveDefaultPolicyBtn = document.getElementById('saveDefaultPolicyBtn');
if (saveDefaultPolicyBtn) {
  saveDefaultPolicyBtn.addEventListener('click', async () => {
    try {
      const data = await apiRequest('/leave/policy', {
        method: 'PUT',
        body: JSON.stringify({
          casual: document.getElementById('defCasual').value,
          sick: document.getElementById('defSick').value,
          earned: document.getElementById('defEarned').value
        })
      });
      showToast(data.message, 'success');
      loadLeavePolicy();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

function populateCreditEmployeeSelect() {
  const sel = document.getElementById('creditEmployee');
  if (!sel || sel.dataset.loaded) return;
  sel.innerHTML = employeesCache
    .filter((e) => e.role === 'employee' || e.role === 'manager')
    .map((e) => `<option value="${e.id}">${e.name} (${e.department})</option>`).join('');
  sel.dataset.loaded = '1';
}

const creditApplyBtn = document.getElementById('creditApplyBtn');
if (creditApplyBtn) {
  creditApplyBtn.addEventListener('click', async () => {
    const employeeId = document.getElementById('creditEmployee').value;
    const type = document.getElementById('creditType').value;
    const amount = document.getElementById('creditAmount').value;
    const note = document.getElementById('creditNote').value.trim();

    if (!employeeId || !amount || parseFloat(amount) <= 0) {
      showToast('Please select an employee and a positive number of days', 'error');
      return;
    }
    try {
      const data = await apiRequest('/leave/credit', { method: 'POST', body: JSON.stringify({ employeeId, type, amount, note }) });
      showToast(data.message, 'success');
      document.getElementById('creditNote').value = '';
      loadCreditHistory();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

async function loadCreditHistory() {
  const tbody = document.getElementById('creditHistoryBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Loading...</td></tr>';
  try {
    const data = await apiRequest('/leave/credits');
    const list = data.credits || [];
    if (list.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No credits recorded yet</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((c) => `
      <tr>
        <td>${formatDate(c.creditedOn.slice(0, 10))}</td>
        <td>${c.employeeName}</td>
        <td>${LEAVE_LABELS[c.type] || c.type}</td>
        <td>+${c.amount}</td>
        <td>${c.note || '-'}</td>
        <td>${c.creditedBy}</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${err.message}</td></tr>`;
  }
}

// ================= REGULARIZATION APPROVALS =================
const regStatusFilter = document.getElementById('regStatusFilter');
regStatusFilter.addEventListener('change', loadRegApprovals);

async function loadRegApprovals() {
  const tbody = document.getElementById('regApprovalBody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Loading...</td></tr>';
  try {
    const params = new URLSearchParams();
    if (regStatusFilter.value) params.set('status', regStatusFilter.value);
    const data = await apiRequest(`/regularization/all?${params.toString()}`);
    const records = data.records || [];
    if (records.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No regularization requests found</td></tr>';
      return;
    }
    tbody.innerHTML = records.map((r) => `
      <tr>
        <td>${r.employeeName}</td>
        <td>${formatDate(r.date)}</td>
        <td>${r.requestedPunchIn ? formatTime12(r.requestedPunchIn.slice(0,5)) : '-'}</td>
        <td>${r.requestedPunchOut ? formatTime12(r.requestedPunchOut.slice(0,5)) : '-'}</td>
        <td>${r.reason}</td>
        <td><span class="badge ${r.status === 'approved' ? 'badge-present' : r.status === 'rejected' ? 'badge-absent' : 'badge-late'}">${r.status}</span></td>
        <td>
          ${r.status === 'pending'
            ? (r.employeeId === user.id && !isAdmin
                ? '<span class="text-muted">Awaiting admin</span>'
                : `<div class="action-icons">
                     <button class="icon-btn" title="Approve" onclick="decideReg(${r.id}, 'approve')">✔</button>
                     <button class="icon-btn danger" title="Reject" onclick="decideReg(${r.id}, 'reject')">✖</button>
                   </div>`)
            : '-'}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">${err.message}</td></tr>`;
  }
}

async function decideReg(id, action) {
  try {
    const data = await apiRequest(`/regularization/${id}/${action}`, { method: 'PUT', body: JSON.stringify({}) });
    showToast(data.message, 'success');
    loadRegApprovals();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.decideReg = decideReg;

const myRegApplyBtn = document.getElementById('myRegApplyBtn');
if (myRegApplyBtn) {
  myRegApplyBtn.addEventListener('click', async () => {
    const date = document.getElementById('myRegDate').value;
    const requestedPunchIn = document.getElementById('myRegIn').value;
    const requestedPunchOut = document.getElementById('myRegOut').value;
    const reason = document.getElementById('myRegReason').value.trim();

    if (!date || !reason) {
      showToast('Please provide a date and a reason', 'error');
      return;
    }
    if (!requestedPunchIn && !requestedPunchOut) {
      showToast('Please provide a corrected punch in and/or punch out time', 'error');
      return;
    }
    try {
      const data = await apiRequest('/regularization/apply', {
        method: 'POST',
        body: JSON.stringify({
          date,
          requestedPunchIn: requestedPunchIn ? `${requestedPunchIn}:00` : undefined,
          requestedPunchOut: requestedPunchOut ? `${requestedPunchOut}:00` : undefined,
          reason
        })
      });
      showToast(data.message, 'success');
      document.getElementById('myRegDate').value = '';
      document.getElementById('myRegIn').value = '';
      document.getElementById('myRegOut').value = '';
      document.getElementById('myRegReason').value = '';
      loadRegApprovals();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

// ================= PAYSLIPS (ADMIN) =================
function populatePayslipEmployeeSelects() {
  const filterSel = document.getElementById('payslipEmployeeFilter');
  filterSel.innerHTML = '<option value="">All Employees</option>' +
    employeesCache.map((e) => `<option value="${e.id}">${e.name}</option>`).join('');

  const modalSel = document.getElementById('psEmployee');
  if (modalSel) modalSel.innerHTML = employeesCache.map((e) => `<option value="${e.id}">${e.name} (${e.empCode})</option>`).join('');
}

document.getElementById('payslipEmployeeFilter').addEventListener('change', loadPayslipsAdmin);
document.getElementById('payslipMonthFilter').addEventListener('change', loadPayslipsAdmin);
document.getElementById('payslipClearFilter').addEventListener('click', () => {
  document.getElementById('payslipEmployeeFilter').value = '';
  document.getElementById('payslipMonthFilter').value = '';
  loadPayslipsAdmin();
});

async function loadPayslipsAdmin() {
  const tbody = document.getElementById('payslipsBody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Loading...</td></tr>';
  try {
    if (employeesCache.length === 0) await loadEmployeesCache();
    populatePayslipEmployeeSelects();

    const params = new URLSearchParams();
    const empId = document.getElementById('payslipEmployeeFilter').value;
    const month = document.getElementById('payslipMonthFilter').value;
    if (empId) params.set('employeeId', empId);
    if (month) params.set('month', month);

    const data = await apiRequest(`/payslips/all?${params.toString()}`);
    const list = data.payslips || [];
    if (list.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No payslips found</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((p) => `
      <tr>
        <td>${p.employeeName}</td>
        <td>${p.monthLabel}</td>
        <td>₹${p.grossEarnings.toFixed(2)}</td>
        <td>₹${p.totalDeductions.toFixed(2)}</td>
        <td><b>₹${p.netPay.toFixed(2)}</b></td>
        <td>
          <div class="action-icons">
            <a class="icon-btn" title="Download" href="/api/payslips/${p.id}/download?token=${encodeURIComponent(getToken())}" target="_blank">⬇</a>
            ${isAdmin ? `<button class="icon-btn danger" title="Delete" onclick="deletePayslip(${p.id})">🗑</button>` : ''}
          </div>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${err.message}</td></tr>`;
  }
}

async function deletePayslip(id) {
  if (!confirm('Delete this payslip?')) return;
  try {
    const data = await apiRequest(`/payslips/${id}`, { method: 'DELETE' });
    showToast(data.message, 'success');
    loadPayslipsAdmin();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.deletePayslip = deletePayslip;

const payslipModal = document.getElementById('payslipModal');
const genPayslipBtn = document.getElementById('genPayslipBtn');
if (genPayslipBtn) {
  genPayslipBtn.addEventListener('click', () => {
    populatePayslipEmployeeSelects();
    ['psBasic','psHra','psConveyance','psMedical','psSpecial','psOtherEarnings','psPf','psPt','psTds','psOtherDeductions'].forEach((id) => {
      document.getElementById(id).value = 0;
    });
    document.getElementById('psRemarks').value = '';
    document.getElementById('psMonth').value = new Date().toISOString().slice(0, 7);
    const psFile = document.getElementById('psFile');
    if (psFile) psFile.value = '';
    document.getElementById('psFileName').textContent = '';
    payslipModal.classList.add('show');
  });
}
const psCancelBtn = document.getElementById('psCancelBtn');
if (psCancelBtn) psCancelBtn.addEventListener('click', () => payslipModal.classList.remove('show'));

const psFileInput = document.getElementById('psFile');
if (psFileInput) {
  psFileInput.addEventListener('change', () => {
    const f = psFileInput.files[0];
    document.getElementById('psFileName').textContent = f ? `Selected: ${f.name}` : '';
  });
}

// Reads a File object and resolves to { fileName, fileType, fileData } where
// fileData is base64 WITHOUT the data-url prefix, ready for the payslips API.
function readFileAsPayslipAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1] || '';
      resolve({ fileName: file.name, fileType: file.type || 'application/octet-stream', fileData: base64 });
    };
    reader.onerror = () => reject(new Error('Could not read the selected file'));
    reader.readAsDataURL(file);
  });
}

const psSaveBtn = document.getElementById('psSaveBtn');
if (psSaveBtn) {
  psSaveBtn.addEventListener('click', async () => {
    const payload = {
      employeeId: parseInt(document.getElementById('psEmployee').value, 10),
      month: document.getElementById('psMonth').value,
      basic: parseFloat(document.getElementById('psBasic').value) || 0,
      hra: parseFloat(document.getElementById('psHra').value) || 0,
      conveyance: parseFloat(document.getElementById('psConveyance').value) || 0,
      medical: parseFloat(document.getElementById('psMedical').value) || 0,
      specialAllowance: parseFloat(document.getElementById('psSpecial').value) || 0,
      otherEarnings: parseFloat(document.getElementById('psOtherEarnings').value) || 0,
      pf: parseFloat(document.getElementById('psPf').value) || 0,
      professionalTax: parseFloat(document.getElementById('psPt').value) || 0,
      tds: parseFloat(document.getElementById('psTds').value) || 0,
      otherDeductions: parseFloat(document.getElementById('psOtherDeductions').value) || 0,
      remarks: document.getElementById('psRemarks').value.trim()
    };
    if (!payload.employeeId || !payload.month) {
      showToast('Please select an employee and month', 'error');
      return;
    }
    psSaveBtn.disabled = true;
    const originalLabel = psSaveBtn.textContent;
    try {
      const file = psFileInput && psFileInput.files[0];
      if (file) {
        if (file.size > 6 * 1024 * 1024) {
          showToast('File is too large (max ~6MB)', 'error');
          psSaveBtn.disabled = false;
          return;
        }
        psSaveBtn.textContent = 'Uploading file...';
        payload.file = await readFileAsPayslipAttachment(file);
      }
      const data = await apiRequest('/payslips', { method: 'POST', body: JSON.stringify(payload) });
      showToast(data.message, 'success');
      payslipModal.classList.remove('show');
      loadPayslipsAdmin();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      psSaveBtn.disabled = false;
      psSaveBtn.textContent = originalLabel;
    }
  });
}

// ================= TEAM CALENDAR =================
const calMonth = document.getElementById('calMonth');
const calYear = document.getElementById('calYear');
const calEmployee = document.getElementById('calEmployee');

function initCalendarSelectors() {
  monthNames.forEach((m, i) => {
    const opt = document.createElement('option');
    opt.value = i + 1;
    opt.textContent = m;
    if (i + 1 === new Date().getMonth() + 1) opt.selected = true;
    calMonth.appendChild(opt);
  });
  for (let y = new Date().getFullYear() - 10; y <= new Date().getFullYear() + 100; y++) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    if (y === new Date().getFullYear()) opt.selected = true;
    calYear.appendChild(opt);
  }
}
initCalendarSelectors();

function populateCalendarEmployeeSelect() {
  calEmployee.innerHTML = employeesCache.map((e) => `<option value="${e.id}">${e.name} (${e.department})</option>`).join('');
}

calMonth.addEventListener('change', loadTeamCalendar);
calYear.addEventListener('change', loadTeamCalendar);
calEmployee.addEventListener('change', loadTeamCalendar);

async function loadTeamCalendar() {
  const grid = document.getElementById('calGrid');
  grid.innerHTML = 'Loading...';
  try {
    if (employeesCache.length === 0) await loadEmployeesCache();
    if (!calEmployee.value) populateCalendarEmployeeSelect();

    const empId = calEmployee.value || (employeesCache[0] ? employeesCache[0].id : user.id);
    const data = await apiRequest(`/calendar?month=${calMonth.value}&year=${calYear.value}&employeeId=${empId}`);
    const weekdayLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const firstWeekday = new Date(`${data.days[0].date}T00:00:00`).getDay();

    let html = weekdayLabels.map((w) => `<div class="cal-weekday">${w}</div>`).join('');
    for (let i = 0; i < firstWeekday; i++) html += `<div class="cal-day type-empty"></div>`;

    data.days.forEach((d) => {
      const dayNum = d.date.slice(-2);
      let note = '';
      if (d.dayType === 'holiday') note = `${d.holidayIcon || '🎉'} ${d.holidayName || 'Holiday'}`;
      else if (d.dayType === 'weekoff') note = 'Weekly Off';
      else if (d.dayType === 'leave') note = `${LEAVE_LABELS[d.leaveType] || d.leaveType} Leave`;
      else if (d.punchIn) note = `${formatTime12(d.punchIn.slice(0,5))}${d.punchOut ? ' - ' + formatTime12(d.punchOut.slice(0,5)) : ''}`;

      const typeClass = d.attendanceStatus ? `type-${d.attendanceStatus}` : `type-${d.dayType}`;
      html += `<div class="cal-day ${typeClass}"><div class="d-num">${parseInt(dayNum, 10)}</div><div class="d-note">${note}</div></div>`;
    });

    grid.innerHTML = html;
  } catch (err) {
    grid.innerHTML = `<div class="text-muted">${err.message}</div>`;
  }
}

const HOLIDAY_ICON_CHOICES = ['🎉','🪔','🎨','🎄','🎆','🌙','🇮🇳','🕊️','🌾','🐘','🪄','🎀','✝️','🎂'];
let selectedHolidayIcon = '🎉';
let allHolidaysCache = [];

function renderHolidayIconPicker() {
  const wrap = document.getElementById('holidayIconPicker');
  if (!wrap || wrap.dataset.loaded) return;
  wrap.innerHTML = HOLIDAY_ICON_CHOICES.map((ic) =>
    `<button type="button" class="icon-pick-btn" data-icon="${ic}">${ic}</button>`
  ).join('');
  wrap.dataset.loaded = '1';
  wrap.querySelectorAll('.icon-pick-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('.icon-pick-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedHolidayIcon = btn.dataset.icon;
      document.getElementById('holidayIcon').value = selectedHolidayIcon;
    });
  });
  wrap.querySelector('.icon-pick-btn').classList.add('active');
}
renderHolidayIconPicker();

function populateHolidayYearFilter() {
  const sel = document.getElementById('holidayYearFilter');
  if (!sel || sel.dataset.loaded) return;
  const thisYear = new Date().getFullYear();
  let html = '<option value="">All Years</option>';
  for (let y = thisYear - 10; y <= thisYear + 100; y++) {
    html += `<option value="${y}" ${y === thisYear ? 'selected' : ''}>${y}</option>`;
  }
  sel.innerHTML = html;
  sel.dataset.loaded = '1';
  sel.addEventListener('change', renderFestivalList);
}

function renderFestivalList() {
  const wrap = document.getElementById('festivalList');
  if (!wrap) return;
  const yearFilter = document.getElementById('holidayYearFilter').value;
  let list = [...allHolidaysCache];
  if (yearFilter) list = list.filter((h) => h.date.startsWith(yearFilter));
  list.sort((a, b) => (a.date < b.date ? -1 : 1));

  if (list.length === 0) {
    wrap.innerHTML = '<div class="text-muted" style="padding:12px 0;">No holidays added yet for this selection</div>';
    return;
  }

  wrap.innerHTML = list.map((h) => `
    <div class="festival-row">
      <div class="festival-icon">${h.icon || '🎉'}</div>
      <div class="festival-info">
        <div class="festival-name">${h.name}</div>
        <div class="festival-date text-muted">${formatDate(h.date)} · ${new Date(h.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long' })}</div>
      </div>
      ${isAdmin ? `<button class="icon-btn danger" title="Remove" onclick="removeHoliday('${h.date}')">🗑</button>` : ''}
    </div>
  `).join('');
}

async function loadHolidays() {
  populateHolidayYearFilter();
  const wrap = document.getElementById('festivalList');
  if (!wrap) return;
  wrap.innerHTML = 'Loading...';
  try {
    const data = await apiRequest('/settings/holidays');
    allHolidaysCache = data.holidays || [];
    renderFestivalList();
  } catch (err) {
    wrap.innerHTML = `<div class="text-muted">${err.message}</div>`;
  }
}

const addHolidayBtn = document.getElementById('addHolidayBtn');
if (addHolidayBtn) {
  addHolidayBtn.addEventListener('click', async () => {
    const date = document.getElementById('holidayDate').value;
    const name = document.getElementById('holidayName').value.trim();
    const icon = document.getElementById('holidayIcon').value.trim() || selectedHolidayIcon;
    if (!date || !name) {
      showToast('Please provide both a date and a name', 'error');
      return;
    }
    try {
      const data = await apiRequest('/settings/holidays', { method: 'POST', body: JSON.stringify({ date, name, icon }) });
      showToast(data.message, 'success');
      document.getElementById('holidayDate').value = '';
      document.getElementById('holidayName').value = '';
      document.getElementById('holidayIcon').value = '';
      loadHolidays();
      loadTeamCalendar();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

async function removeHoliday(date) {
  try {
    const data = await apiRequest(`/settings/holidays/${date}`, { method: 'DELETE' });
    showToast(data.message, 'success');
    loadHolidays();
    loadTeamCalendar();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.removeHoliday = removeHoliday;

// ================= SETTINGS (admin only) =================
let currentSettings = null;

async function loadSettings() {
  if (!isAdmin) return;
  try {
    const data = await apiRequest('/settings');
    currentSettings = data.settings;

    document.getElementById('setCompanyName').value = currentSettings.companyName || '';
    document.getElementById('setOfficeStart').value = currentSettings.officeStartTime || '09:30';
    document.getElementById('setOfficeEnd').value = currentSettings.officeEndTime || '18:30';
    document.getElementById('setLateAfter').value = currentSettings.lateAfterMinutes || 15;
    document.getElementById('setTargetHours').value = currentSettings.targetWorkHours || 9;

    const loc = currentSettings.officeLocation || {};
    document.getElementById('setOfficeLat').value = loc.lat != null ? loc.lat : '';
    document.getElementById('setOfficeLng').value = loc.lng != null ? loc.lng : '';
    document.getElementById('setGeoRadius').value = currentSettings.geofenceRadius || 100;
    document.getElementById('setEnforceGeo').value = currentSettings.enforceGeofence ? 'true' : 'false';

    renderWeeklyOffEditor(currentSettings.weeklyOffByDepartment || {});

    const wa = currentSettings.whatsapp || {};
    document.getElementById('waEnabled').value = wa.enabled ? 'true' : 'false';
    document.getElementById('waProvider').value = wa.provider || 'twilio';
    document.getElementById('waAccountSid').value = wa.accountSid || '';
    document.getElementById('waAuthToken').value = wa.authToken || '';
    document.getElementById('waFromNumber').value = wa.fromNumber || '';
    document.getElementById('waMetaAccessToken').value = wa.metaAccessToken || '';
    document.getElementById('waMetaPhoneNumberId').value = wa.metaPhoneNumberId || '';
    document.getElementById('waNotifyPunchIn').checked = !!wa.notifyOnPunchIn;
    document.getElementById('waNotifyPunchOut').checked = !!wa.notifyOnPunchOut;
    document.getElementById('waNotifyLeaveApplied').checked = !!wa.notifyOnLeaveApplied;
    document.getElementById('waNotifyLeaveDecided').checked = !!wa.notifyOnLeaveDecided;
    toggleWaProviderFields();
    loadWhatsappLog();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function toggleWaProviderFields() {
  const isMeta = document.getElementById('waProvider').value === 'meta_cloud';
  document.getElementById('twilioFields').style.display = isMeta ? 'none' : 'block';
  document.getElementById('metaFields').style.display = isMeta ? 'block' : 'none';
}
document.getElementById('waProvider').addEventListener('change', toggleWaProviderFields);

document.getElementById('saveWhatsappBtn').addEventListener('click', async () => {
  try {
    const data = await apiRequest('/settings/whatsapp', {
      method: 'PUT',
      body: JSON.stringify({
        enabled: document.getElementById('waEnabled').value === 'true',
        provider: document.getElementById('waProvider').value,
        accountSid: document.getElementById('waAccountSid').value.trim(),
        authToken: document.getElementById('waAuthToken').value.trim(),
        fromNumber: document.getElementById('waFromNumber').value.trim(),
        metaAccessToken: document.getElementById('waMetaAccessToken').value.trim(),
        metaPhoneNumberId: document.getElementById('waMetaPhoneNumberId').value.trim(),
        notifyOnPunchIn: document.getElementById('waNotifyPunchIn').checked,
        notifyOnPunchOut: document.getElementById('waNotifyPunchOut').checked,
        notifyOnLeaveApplied: document.getElementById('waNotifyLeaveApplied').checked,
        notifyOnLeaveDecided: document.getElementById('waNotifyLeaveDecided').checked
      })
    });
    showToast(data.message, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

async function loadWhatsappLog() {
  const tbody = document.getElementById('whatsappLogBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Loading...</td></tr>';
  try {
    const data = await apiRequest('/settings/whatsapp-log?limit=50');
    const list = data.log || [];
    if (list.length === 0) { tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No notifications logged yet</td></tr>'; return; }
    tbody.innerHTML = list.map((l) => `
      <tr>
        <td>${new Date(l.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
        <td>${l.employeeName}</td>
        <td>${l.event}</td>
        <td><span class="badge ${l.status === 'sent' ? 'badge-present' : l.status === 'failed' ? 'badge-absent' : 'badge-inactive'}">${l.status}</span></td>
        <td class="text-muted" style="font-size:12px;">${l.detail}</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">${err.message}</td></tr>`;
  }
}

const saveTimingBtn = document.getElementById('saveTimingBtn');
if (saveTimingBtn) {
  saveTimingBtn.addEventListener('click', async () => {
    try {
      const data = await apiRequest('/settings', {
        method: 'PUT',
        body: JSON.stringify({
          companyName: document.getElementById('setCompanyName').value.trim(),
          officeStartTime: document.getElementById('setOfficeStart').value,
          officeEndTime: document.getElementById('setOfficeEnd').value,
          lateAfterMinutes: document.getElementById('setLateAfter').value,
          targetWorkHours: document.getElementById('setTargetHours').value
        })
      });
      showToast(data.message, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

const useMyLocationBtn = document.getElementById('useMyLocationBtn');
if (useMyLocationBtn) {
  useMyLocationBtn.addEventListener('click', async () => {
    useMyLocationBtn.disabled = true;
    const original = useMyLocationBtn.textContent;
    useMyLocationBtn.textContent = '📍 Locating...';
    try {
      const { lat, lng } = await getCurrentLocation();
      if (lat == null) {
        showToast('Could not get your location. Please allow location access.', 'error');
      } else {
        document.getElementById('setOfficeLat').value = lat.toFixed(6);
        document.getElementById('setOfficeLng').value = lng.toFixed(6);
        showToast('Location captured. Click "Save Geofence Settings" to apply.', 'success');
      }
    } finally {
      useMyLocationBtn.disabled = false;
      useMyLocationBtn.textContent = original;
    }
  });
}

const saveGeoBtn = document.getElementById('saveGeoBtn');
if (saveGeoBtn) {
  saveGeoBtn.addEventListener('click', async () => {
    try {
      const data = await apiRequest('/settings', {
        method: 'PUT',
        body: JSON.stringify({
          officeLat: document.getElementById('setOfficeLat').value,
          officeLng: document.getElementById('setOfficeLng').value,
          geofenceRadius: document.getElementById('setGeoRadius').value,
          enforceGeofence: document.getElementById('setEnforceGeo').value === 'true'
        })
      });
      showToast(data.message, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

const WEEKDAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function renderWeeklyOffEditor(map) {
  const editor = document.getElementById('weeklyOffEditor');
  if (!editor) return;

  const depts = [...new Set(employeesCache.map((e) => e.department).filter(Boolean))].sort();
  const rows = ['_default', ...depts.filter((d) => d !== '_default')];

  editor.innerHTML = rows.map((dept) => {
    const label = dept === '_default' ? 'Default (any other department)' : dept;
    const selected = map[dept] || (dept === '_default' ? [0] : []);
    const checkboxes = WEEKDAY_NAMES.map((name, idx) => `
      <label style="display:inline-flex; align-items:center; gap:4px; margin-right:12px; font-size:13px; font-weight:400;">
        <input type="checkbox" data-dept="${dept}" value="${idx}" ${selected.includes(idx) ? 'checked' : ''} />
        ${name}
      </label>
    `).join('');
    return `
      <div class="field" style="margin-bottom:14px;">
        <label>${label}</label>
        <div>${checkboxes}</div>
      </div>
    `;
  }).join('');
}

const saveWeeklyOffBtn = document.getElementById('saveWeeklyOffBtn');
if (saveWeeklyOffBtn) {
  saveWeeklyOffBtn.addEventListener('click', async () => {
    const editor = document.getElementById('weeklyOffEditor');
    const byDept = {};
    editor.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      const dept = cb.dataset.dept;
      if (!byDept[dept]) byDept[dept] = [];
      if (cb.checked) byDept[dept].push(parseInt(cb.value, 10));
    });
    try {
      const data = await apiRequest('/settings', { method: 'PUT', body: JSON.stringify({ weeklyOffByDepartment: byDept }) });
      showToast(data.message, 'success');
      currentSettings = data.settings;
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

// ================= BIRTHDAY / ANNIVERSARY NOTIFICATIONS =================
async function loadCelebrationBanner() {
  const el = document.getElementById('celebrationBanner');
  if (!el) return;
  try {
    const data = await apiRequest('/notifications/today');
    if (!data.hasNotifications) { el.innerHTML = ''; return; }

    const cards = [];
    data.birthdaysToday.forEach((b) => {
      cards.push(`
        <div class="card" style="background:linear-gradient(135deg,#fff3e0,#ffe8cc); margin-bottom:12px; display:flex; align-items:center; gap:14px;">
          <div style="font-size:32px;">🎂</div>
          <div>
            <b style="font-size:15px;">Happy Birthday, ${b.name}!</b>
            <div class="text-muted" style="font-size:12.5px;">${b.designation} · ${b.department} — wish them a great day! 🎉</div>
          </div>
        </div>
      `);
    });
    data.anniversariesToday.forEach((a) => {
      cards.push(`
        <div class="card" style="background:linear-gradient(135deg,#e3f7ec,#d3f2e4); margin-bottom:12px; display:flex; align-items:center; gap:14px;">
          <div style="font-size:32px;">🎊</div>
          <div>
            <b style="font-size:15px;">${a.name} completes ${a.years} year${a.years > 1 ? 's' : ''} with us today!</b>
            <div class="text-muted" style="font-size:12.5px;">${a.designation} · ${a.department} — happy work anniversary! 🎉</div>
          </div>
        </div>
      `);
    });
    el.innerHTML = cards.join('');
  } catch (err) { el.innerHTML = ''; }
}

// ================= PERFORMANCE DASHBOARD =================
const perfMonth = document.getElementById('perfMonth');
const perfYear = document.getElementById('perfYear');

function initPerfSelectors() {
  if (!perfMonth || perfMonth.options.length) return;
  monthNames.forEach((m, i) => {
    const opt = document.createElement('option');
    opt.value = i + 1; opt.textContent = m;
    if (i + 1 === new Date().getMonth() + 1) opt.selected = true;
    perfMonth.appendChild(opt);
  });
  for (let y = new Date().getFullYear() - 5; y <= new Date().getFullYear(); y++) {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    if (y === new Date().getFullYear()) opt.selected = true;
    perfYear.appendChild(opt);
  }
  perfMonth.addEventListener('change', loadPerformance);
  perfYear.addEventListener('change', loadPerformance);
}

function scoreBadgeClass(score) {
  if (score >= 85) return 'badge-present';
  if (score >= 65) return 'badge-late';
  return 'badge-absent';
}

async function loadPerformance() {
  initPerfSelectors();
  const tbody = document.getElementById('performanceBody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Loading...</td></tr>';
  try {
    const data = await apiRequest(`/performance/all?month=${perfMonth.value}&year=${perfYear.value}`);
    const list = data.performance || [];
    if (list.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No employees to show</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((p) => `
      <tr>
        <td>${p.employeeName}</td>
        <td>${p.department}</td>
        <td>${p.attendancePercentage}%</td>
        <td>${p.leaveDaysUsed}</td>
        <td>${p.lateDays}</td>
        <td>${p.overtimeHours}</td>
        <td><span class="badge ${scoreBadgeClass(p.score)}">${p.score} / 100</span></td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">${err.message}</td></tr>`;
  }
  loadLeaderboard();
}

async function loadLeaderboard() {
  const el = document.getElementById('leaderboardList');
  if (!el) return;
  el.innerHTML = 'Loading...';
  try {
    const data = await apiRequest(`/reports/leaderboard?month=${perfMonth.value}&year=${perfYear.value}`);
    const list = data.leaderboard || [];
    if (list.length === 0) { el.innerHTML = '<div class="text-muted">No data yet</div>'; return; }
    el.innerHTML = list.map((p) => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:9px 0; border-bottom:1px solid var(--border); ${p.isMe ? 'background:#fff8df;' : ''}">
        <span>${p.medal || `#${p.rank}`} &nbsp; ${p.employeeName} <span class="text-muted" style="font-size:12px;">(${p.department})</span></span>
        <span class="badge ${scoreBadgeClass(p.score)}">${p.score} pts</span>
      </div>
    `).join('');
  } catch (err) {
    el.innerHTML = err.message;
  }
}

// ================= AI REPORTS =================
const repMonth = document.getElementById('repMonth');
const repYear = document.getElementById('repYear');

function initReportsSelectors() {
  if (!repMonth || repMonth.options.length) return;
  monthNames.forEach((m, i) => {
    const opt = document.createElement('option');
    opt.value = i + 1; opt.textContent = m;
    if (i + 1 === new Date().getMonth() + 1) opt.selected = true;
    repMonth.appendChild(opt);
  });
  for (let y = new Date().getFullYear() - 5; y <= new Date().getFullYear(); y++) {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    if (y === new Date().getFullYear()) opt.selected = true;
    repYear.appendChild(opt);
  }
  repMonth.addEventListener('change', loadAiReports);
  repYear.addEventListener('change', loadAiReports);
}

async function loadAiReports() {
  initReportsSelectors();
  const banner = document.getElementById('reportsSummaryBanner');
  const mostPunctualCard = document.getElementById('mostPunctualCard');
  const lateList = document.getElementById('frequentlyLateList');
  const absList = document.getElementById('highestAbsenteeismList');
  const trendList = document.getElementById('deptTrendList');
  [banner, mostPunctualCard, lateList, absList, trendList].forEach((el) => { if (el) el.innerHTML = 'Loading...'; });

  try {
    const data = await apiRequest(`/reports/insights?month=${repMonth.value}&year=${repYear.value}`);

    banner.innerHTML = `📊 ${data.monthlyProductivity.summary}`;

    mostPunctualCard.innerHTML = data.mostPunctual
      ? `<div style="display:flex; align-items:center; gap:12px;">
           <div style="font-size:30px;">🏆</div>
           <div>
             <b>${data.mostPunctual.employeeName}</b>
             <div class="text-muted" style="font-size:12.5px;">${data.mostPunctual.department} · ${data.mostPunctual.attendancePercentage}% attendance · ${data.mostPunctual.lateDays} late day(s)</div>
           </div>
         </div>`
      : '<div class="text-muted">Not enough data yet this month</div>';

    lateList.innerHTML = data.frequentlyLate.length
      ? data.frequentlyLate.map((e) => `
          <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border);">
            <span>${e.employeeName} <span class="text-muted" style="font-size:12px;">(${e.department})</span></span>
            <span class="badge badge-late">${e.lateDays} late</span>
          </div>`).join('')
      : '<div class="text-muted">No frequently-late employees this month 🎉</div>';

    absList.innerHTML = data.highestAbsenteeism.length
      ? data.highestAbsenteeism.map((e) => `
          <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border);">
            <span>${e.employeeName} <span class="text-muted" style="font-size:12px;">(${e.department})</span></span>
            <span class="badge badge-absent">${e.absentDays} absent</span>
          </div>`).join('')
      : '<div class="text-muted">No absenteeism recorded this month 🎉</div>';

    trendList.innerHTML = data.departmentTrend.length
      ? data.departmentTrend.map((d) => {
          const arrow = d.trend === 'up' ? '📈' : d.trend === 'down' ? '📉' : '➡️';
          const color = d.trend === 'up' ? 'var(--green)' : d.trend === 'down' ? 'var(--red)' : 'var(--muted)';
          return `
            <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--border);">
              <span>${d.department}</span>
              <span style="color:${color};">${arrow} ${d.currentAttendancePercentage}% ${d.delta !== 0 ? `(${d.delta > 0 ? '+' : ''}${d.delta} pt)` : ''}</span>
            </div>`;
        }).join('')
      : '<div class="text-muted">No department data yet</div>';
  } catch (err) {
    banner.innerHTML = err.message;
  }
  loadPredictions();
}

async function loadPredictions() {
  const risingEl = document.getElementById('predRisingLate');
  const attritionEl = document.getElementById('predAttrition');
  const tomorrowEl = document.getElementById('predTomorrow');
  const tomorrowHeading = document.getElementById('predTomorrowHeading');
  if (!risingEl) return;
  [risingEl, attritionEl, tomorrowEl].forEach((el) => { el.innerHTML = 'Loading...'; });

  try {
    const data = await apiRequest(`/reports/predictions?month=${repMonth.value}&year=${repYear.value}`);

    risingEl.innerHTML = data.risingLateTrend.length
      ? data.risingLateTrend.map((e) => `
          <div style="display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid var(--border); font-size:13px;">
            <span>${e.employeeName} <span class="text-muted" style="font-size:11.5px;">(${e.department})</span></span>
            <span class="badge badge-late">${e.previousLateDays} → ${e.currentLateDays}</span>
          </div>`).join('')
      : '<div class="text-muted" style="font-size:13px;">No rising late trends detected 🎉</div>';

    attritionEl.innerHTML = data.attritionRisk.length
      ? data.attritionRisk.map((e) => `
          <div style="display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid var(--border); font-size:13px;">
            <span>${e.employeeName} <span class="text-muted" style="font-size:11.5px;">(${e.department})</span></span>
            <span class="badge badge-absent">${e.previousAttendance}% → ${e.currentAttendance}%</span>
          </div>`).join('')
      : '<div class="text-muted" style="font-size:13px;">No attrition risk flags this month 🎉</div>';

    tomorrowHeading.textContent = `📅 Likely Absentees Tomorrow (${data.tomorrowDate})`;
    tomorrowEl.innerHTML = data.likelyTomorrowAbsentees.length
      ? data.likelyTomorrowAbsentees.map((e) => `
          <div style="display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid var(--border); font-size:13px;">
            <span>${e.employeeName} <span class="text-muted" style="font-size:11.5px;">(${e.department})</span></span>
            <span class="badge badge-late">${e.historicalAbsenceRate}% historical absence on this weekday</span>
          </div>`).join('')
      : '<div class="text-muted" style="font-size:13px;">No strong pattern detected for tomorrow</div>';
  } catch (err) {
    risingEl.innerHTML = err.message;
  }
}

// ================= DOCUMENTS MODULE =================
const DOC_TYPE_OPTIONS = [
  ['aadhaar', 'Aadhaar Card'], ['pan', 'PAN Card'], ['resume', 'Resume / CV'],
  ['offer_letter', 'Offer Letter'], ['salary_slip', 'Salary Slip'], ['experience_letter', 'Experience Letter'],
  ['other', 'Other']
];

function initDocumentSelectors() {
  const typeSel = document.getElementById('docType');
  const filterTypeSel = document.getElementById('docFilterType');
  if (typeSel && !typeSel.options.length) {
    typeSel.innerHTML = DOC_TYPE_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  }
  if (filterTypeSel && filterTypeSel.options.length <= 1) {
    filterTypeSel.innerHTML = '<option value="">All Types</option>' + DOC_TYPE_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  }
  const empSel = document.getElementById('docEmployee');
  const filterEmpSel = document.getElementById('docFilterEmployee');
  if (empSel) empSel.innerHTML = employeesCache.map((e) => `<option value="${e.id}">${e.name} (${e.department})</option>`).join('');
  if (filterEmpSel) {
    const current = filterEmpSel.value;
    filterEmpSel.innerHTML = '<option value="">All Employees</option>' + employeesCache.map((e) => `<option value="${e.id}">${e.name}</option>`).join('');
    filterEmpSel.value = current;
  }
}

async function loadDocuments() {
  if (employeesCache.length === 0) await loadEmployeesCache();
  initDocumentSelectors();

  const tbody = document.getElementById('documentsBody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Loading...</td></tr>';
  try {
    const empId = document.getElementById('docFilterEmployee').value;
    const type = document.getElementById('docFilterType').value;
    const params = new URLSearchParams();
    if (empId) params.set('employeeId', empId);
    if (type) params.set('type', type);
    const data = await apiRequest(`/documents/all?${params.toString()}`);
    const list = data.documents || [];
    if (list.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No documents uploaded yet</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((d) => `
      <tr>
        <td>${d.employeeName}</td>
        <td>${d.typeLabel}</td>
        <td>${d.fileName}</td>
        <td>${d.note || '-'}</td>
        <td>${d.uploadedByName}</td>
        <td>${formatDate(d.uploadedAt.slice(0, 10))}</td>
        <td>
          <div class="action-icons">
            <button class="icon-btn" title="Download" onclick="downloadDocument(${d.id}, '${d.fileName.replace(/'/g, '')}')"><i class="bi bi-download"></i></button>
            <button class="icon-btn danger" title="Delete" onclick="deleteDocument(${d.id})"><i class="bi bi-trash-fill"></i></button>
          </div>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">${err.message}</td></tr>`;
  }
}

async function downloadDocument(id, fileName) {
  try {
    const data = await apiRequest(`/documents/${id}/download`);
    const doc = data.document;
    const link = document.createElement('a');
    link.href = doc.fileData.startsWith('data:') ? doc.fileData : `data:${doc.fileType};base64,${doc.fileData}`;
    link.download = fileName || doc.fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.downloadDocument = downloadDocument;

async function deleteDocument(id) {
  if (!confirm('Delete this document? This cannot be undone.')) return;
  try {
    const data = await apiRequest(`/documents/${id}`, { method: 'DELETE' });
    showToast(data.message, 'success');
    loadDocuments();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.deleteDocument = deleteDocument;

document.getElementById('docFilterEmployee').addEventListener('change', loadDocuments);
document.getElementById('docFilterType').addEventListener('change', loadDocuments);
document.getElementById('docClearFilter').addEventListener('click', () => {
  document.getElementById('docFilterEmployee').value = '';
  document.getElementById('docFilterType').value = '';
  loadDocuments();
});

const docFileInput = document.getElementById('docFile');
docFileInput.addEventListener('change', () => {
  const f = docFileInput.files[0];
  document.getElementById('docFileName').textContent = f ? `Selected: ${f.name} (${(f.size / 1024).toFixed(0)} KB)` : '';
});

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result || '').split(',')[1] || '';
      resolve({ fileName: file.name, fileType: file.type || 'application/octet-stream', fileData: base64 });
    };
    reader.onerror = () => reject(new Error('Could not read the selected file'));
    reader.readAsDataURL(file);
  });
}

document.getElementById('docUploadBtn').addEventListener('click', async () => {
  const btn = document.getElementById('docUploadBtn');
  const employeeId = document.getElementById('docEmployee').value;
  const type = document.getElementById('docType').value;
  const note = document.getElementById('docNote').value.trim();
  const file = docFileInput.files[0];

  if (!employeeId || !type) { showToast('Please choose an employee and document type', 'error'); return; }
  if (!file) { showToast('Please choose a file to upload', 'error'); return; }
  if (file.size > 5 * 1024 * 1024) { showToast('File is too large. Please upload a file under 5MB.', 'error'); return; }

  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Uploading...';
  try {
    const fileData = await readFileAsBase64(file);
    const data = await apiRequest('/documents', { method: 'POST', body: JSON.stringify({ employeeId, type, file: fileData, note }) });
    showToast(data.message, 'success');
    document.getElementById('docNote').value = '';
    docFileInput.value = '';
    document.getElementById('docFileName').textContent = '';
    loadDocuments();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

// ================= FACE PUNCH ENROLLMENT (managers/employees) =================
let faceEnrollStream = null;

async function loadFaceEnrollStatus() {
  const badge = document.getElementById('faceEnrollStatusBadge');
  const removeBtn = document.getElementById('faceEnrollRemoveBtn');
  if (!badge || isAdmin) return;
  try {
    const data = await apiRequest('/face/status');
    if (data.faceEnrolled) {
      badge.textContent = 'Enrolled';
      badge.className = 'badge badge-present';
      removeBtn.style.display = 'inline-block';
    } else {
      badge.textContent = 'Not Enrolled';
      badge.className = 'badge badge-inactive';
      removeBtn.style.display = 'none';
    }
  } catch (err) { /* ignore */ }
}

const faceEnrollStartCamBtn = document.getElementById('faceEnrollStartCamBtn');
const faceEnrollCaptureBtn = document.getElementById('faceEnrollCaptureBtn');
const faceEnrollRemoveBtn = document.getElementById('faceEnrollRemoveBtn');
const faceEnrollVideo = document.getElementById('faceEnrollVideo');
const faceEnrollCanvas = document.getElementById('faceEnrollCanvas');
const faceEnrollMsg = document.getElementById('faceEnrollMsg');

if (faceEnrollStartCamBtn) {
  faceEnrollStartCamBtn.addEventListener('click', async () => {
    try {
      faceEnrollStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      faceEnrollVideo.srcObject = faceEnrollStream;
      faceEnrollCaptureBtn.disabled = false;
      faceEnrollMsg.textContent = 'Camera on. Center your face and click Capture & Save.';
    } catch (err) {
      faceEnrollMsg.textContent = 'Could not access the camera. Please allow camera permission and try again.';
    }
  });
}

if (faceEnrollCaptureBtn) {
  faceEnrollCaptureBtn.addEventListener('click', async () => {
    if (!faceEnrollStream) return;
    const w = faceEnrollVideo.videoWidth || 320;
    const h = faceEnrollVideo.videoHeight || 240;
    faceEnrollCanvas.width = w;
    faceEnrollCanvas.height = h;
    const ctx = faceEnrollCanvas.getContext('2d');
    ctx.drawImage(faceEnrollVideo, 0, 0, w, h);
    const photo = faceEnrollCanvas.toDataURL('image/jpeg', 0.85);

    faceEnrollCaptureBtn.disabled = true;
    faceEnrollCaptureBtn.textContent = 'Saving...';
    try {
      const data = await apiRequest('/face/enroll', { method: 'POST', body: JSON.stringify({ photo }) });
      showToast(data.message, 'success');
      document.getElementById('faceEnrollPreview').src = photo;
      document.getElementById('faceEnrollPreview').style.display = 'block';
      faceEnrollMsg.textContent = 'Enrolled! You can now use the Face Punch kiosk.';
      loadFaceEnrollStatus();
      if (faceEnrollStream) { faceEnrollStream.getTracks().forEach((t) => t.stop()); faceEnrollStream = null; }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      faceEnrollCaptureBtn.disabled = false;
      faceEnrollCaptureBtn.textContent = 'Capture & Save';
    }
  });
}

if (faceEnrollRemoveBtn) {
  faceEnrollRemoveBtn.addEventListener('click', async () => {
    if (!confirm('Remove your face enrollment? You will not be able to use the Face Punch kiosk until you re-enroll.')) return;
    try {
      const data = await apiRequest('/face/enroll', { method: 'DELETE' });
      showToast(data.message, 'success');
      document.getElementById('faceEnrollPreview').style.display = 'none';
      loadFaceEnrollStatus();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

// ================= DAILY TASKS =================
function populateTaskEmployeeSelects() {
  const empSel = document.getElementById('taskEmployee');
  const filterSel = document.getElementById('taskFilterEmployee');
  if (empSel) empSel.innerHTML = employeesCache.map((e) => `<option value="${e.id}">${e.name}</option>`).join('');
  if (filterSel) {
    const cur = filterSel.value;
    filterSel.innerHTML = '<option value="">All Employees</option>' + employeesCache.map((e) => `<option value="${e.id}">${e.name}</option>`).join('');
    filterSel.value = cur;
  }
}

async function loadTasks() {
  if (employeesCache.length === 0) await loadEmployeesCache();
  populateTaskEmployeeSelects();
  if (!document.getElementById('taskDate').value) document.getElementById('taskDate').value = new Date().toISOString().slice(0, 10);

  const tbody = document.getElementById('tasksBody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Loading...</td></tr>';
  try {
    const params = new URLSearchParams();
    const empId = document.getElementById('taskFilterEmployee').value;
    const date = document.getElementById('taskFilterDate').value;
    const status = document.getElementById('taskFilterStatus').value;
    if (empId) params.set('employeeId', empId);
    if (date) params.set('date', date);
    if (status) params.set('status', status);
    const data = await apiRequest(`/tasks/all?${params.toString()}`);
    const list = data.tasks || [];
    if (list.length === 0) { tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No tasks found</td></tr>'; return; }
    tbody.innerHTML = list.map((t) => `
      <tr>
        <td>${t.employeeName}</td>
        <td>${formatDate(t.date)}</td>
        <td>${t.title}${t.description ? `<div class="text-muted" style="font-size:11.5px;">${t.description}</div>` : ''}</td>
        <td><span class="badge ${t.priority === 'high' ? 'badge-absent' : t.priority === 'low' ? 'badge-inactive' : 'badge-late'}">${t.priority}</span></td>
        <td>
          <select onchange="updateTaskStatus(${t.id}, this.value)" style="padding:4px 8px; border-radius:6px; border:1px solid var(--border); font-size:12.5px;">
            <option value="pending" ${t.status === 'pending' ? 'selected' : ''}>Pending</option>
            <option value="in-progress" ${t.status === 'in-progress' ? 'selected' : ''}>In Progress</option>
            <option value="done" ${t.status === 'done' ? 'selected' : ''}>Done</option>
          </select>
        </td>
        <td><button class="icon-btn danger" title="Delete" onclick="deleteTask(${t.id})"><i class="bi bi-trash-fill"></i></button></td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${err.message}</td></tr>`;
  }
}

async function updateTaskStatus(id, status) {
  try {
    await apiRequest(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ status }) });
    showToast('Task updated', 'success');
  } catch (err) {
    showToast(err.message, 'error');
    loadTasks();
  }
}
window.updateTaskStatus = updateTaskStatus;

async function deleteTask(id) {
  if (!confirm('Delete this task?')) return;
  try {
    await apiRequest(`/tasks/${id}`, { method: 'DELETE' });
    showToast('Task deleted', 'success');
    loadTasks();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.deleteTask = deleteTask;

document.getElementById('taskAddBtn').addEventListener('click', async () => {
  const employeeId = document.getElementById('taskEmployee').value;
  const title = document.getElementById('taskTitle').value.trim();
  const description = document.getElementById('taskDescription').value.trim();
  const date = document.getElementById('taskDate').value;
  const priority = document.getElementById('taskPriority').value;
  if (!title) { showToast('Please enter a task title', 'error'); return; }
  try {
    const data = await apiRequest('/tasks', { method: 'POST', body: JSON.stringify({ employeeId, title, description, date, priority }) });
    showToast(data.message, 'success');
    document.getElementById('taskTitle').value = '';
    document.getElementById('taskDescription').value = '';
    loadTasks();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('taskFilterEmployee').addEventListener('change', loadTasks);
document.getElementById('taskFilterDate').addEventListener('change', loadTasks);
document.getElementById('taskFilterStatus').addEventListener('change', loadTasks);
document.getElementById('taskClearFilter').addEventListener('click', () => {
  document.getElementById('taskFilterEmployee').value = '';
  document.getElementById('taskFilterDate').value = '';
  document.getElementById('taskFilterStatus').value = '';
  loadTasks();
});

// ================= FIELD VISITS (GPS TRACKING) =================
function populateFvEmployeeSelect() {
  const filterSel = document.getElementById('fvFilterEmployee');
  if (filterSel) {
    const cur = filterSel.value;
    filterSel.innerHTML = '<option value="">All Employees</option>' + employeesCache.map((e) => `<option value="${e.id}">${e.name}</option>`).join('');
    filterSel.value = cur;
  }
}

async function loadFieldVisits() {
  if (employeesCache.length === 0) await loadEmployeesCache();
  populateFvEmployeeSelect();

  const tbody = document.getElementById('fieldVisitsBody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Loading...</td></tr>';
  try {
    const params = new URLSearchParams();
    const empId = document.getElementById('fvFilterEmployee').value;
    const date = document.getElementById('fvFilterDate').value;
    if (empId) params.set('employeeId', empId);
    if (date) params.set('date', date);
    const data = await apiRequest(`/fieldvisits/all?${params.toString()}`);
    const list = data.visits || [];
    if (list.length === 0) { tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No visits logged yet</td></tr>'; return; }
    tbody.innerHTML = list.map((v) => `
      <tr>
        <td>${v.employeeName}</td>
        <td>${v.clientName}${v.purpose ? `<div class="text-muted" style="font-size:11.5px;">${v.purpose}</div>` : ''}</td>
        <td>${new Date(v.checkedInAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
        <td>${v.checkedOutAt ? new Date(v.checkedOutAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '<span class="badge badge-late">Ongoing</span>'}</td>
        <td><a href="https://www.openstreetmap.org/?mlat=${v.lat}&mlon=${v.lng}#map=17/${v.lat}/${v.lng}" target="_blank">📍 View Map</a></td>
        <td>-</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${err.message}</td></tr>`;
  }
}

document.getElementById('fvFilterEmployee').addEventListener('change', loadFieldVisits);
document.getElementById('fvFilterDate').addEventListener('change', loadFieldVisits);
document.getElementById('fvClearFilter').addEventListener('click', () => {
  document.getElementById('fvFilterEmployee').value = '';
  document.getElementById('fvFilterDate').value = '';
  loadFieldVisits();
});

document.getElementById('fvCheckinBtn').addEventListener('click', async () => {
  const clientName = document.getElementById('fvClientName').value.trim();
  const purpose = document.getElementById('fvPurpose').value.trim();
  const note = document.getElementById('fvNote').value.trim();
  const msgEl = document.getElementById('fvMsg');
  if (!clientName) { showToast('Please enter the client/site name', 'error'); return; }

  msgEl.textContent = 'Getting your location...';
  try {
    const { lat, lng } = await getCurrentLocation();
    const data = await apiRequest('/fieldvisits/checkin', { method: 'POST', body: JSON.stringify({ clientName, purpose, note, lat, lng }) });
    showToast(data.message, 'success');
    msgEl.textContent = '';
    document.getElementById('fvClientName').value = '';
    document.getElementById('fvPurpose').value = '';
    document.getElementById('fvNote').value = '';
    loadFieldVisits();
  } catch (err) {
    msgEl.textContent = '';
    showToast(err.message, 'error');
  }
});

// ================= PAYROLL + INCENTIVE + COMMISSION =================
let payrollConfigCache = null;

function renderTiersEditor(tiers) {
  const el = document.getElementById('commissionTiersEditor');
  el.innerHTML = tiers.map((t, i) => `
    <div class="grid grid-2" style="margin-bottom:8px;" data-tier-row="${i}">
      <div class="field" style="margin-bottom:0;">
        <label>Deal Value Up To (₹, blank = no limit)</label>
        <input type="number" class="tier-upto" value="${t.upTo == null ? '' : t.upTo}" min="0" />
      </div>
      <div class="field" style="margin-bottom:0;">
        <label>Commission Rate (%)</label>
        <input type="number" class="tier-rate" value="${t.rate}" min="0" step="0.1" />
      </div>
    </div>
  `).join('');
}

function renderRulesEditor(rules) {
  const el = document.getElementById('incentiveRulesEditor');
  el.innerHTML = rules.map((r, i) => `
    <div class="grid grid-3" style="margin-bottom:8px;" data-rule-row="${i}">
      <div class="field" style="margin-bottom:0;">
        <label>Rule Name</label>
        <input type="text" class="rule-name" value="${r.name}" />
      </div>
      <div class="field" style="margin-bottom:0;">
        <label>Condition</label>
        <input type="text" class="rule-condition" value="${r.condition}" placeholder="attendance>=100" />
      </div>
      <div class="field" style="margin-bottom:0;">
        <label>Bonus Amount (₹)</label>
        <input type="number" class="rule-amount" value="${r.amount}" min="0" />
      </div>
    </div>
  `).join('');
}

async function loadPayroll() {
  if (employeesCache.length === 0) await loadEmployeesCache();
  const selects = ['commEmployee', 'calcEmployee'];
  selects.forEach((id) => {
    const sel = document.getElementById(id);
    if (sel) sel.innerHTML = employeesCache.map((e) => `<option value="${e.id}">${e.name}</option>`).join('');
  });
  const commFilter = document.getElementById('commFilterEmployee');
  if (commFilter && commFilter.options.length <= 1) {
    commFilter.innerHTML = '<option value="">All Employees</option>' + employeesCache.map((e) => `<option value="${e.id}">${e.name}</option>`).join('');
  }
  if (!document.getElementById('commMonth').value) document.getElementById('commMonth').value = new Date().toISOString().slice(0, 7);

  const calcMonthSel = document.getElementById('calcMonth');
  const calcYearSel = document.getElementById('calcYear');
  if (calcMonthSel && !calcMonthSel.options.length) {
    monthNames.forEach((m, i) => {
      const opt = document.createElement('option');
      opt.value = i + 1; opt.textContent = m;
      if (i + 1 === new Date().getMonth() + 1) opt.selected = true;
      calcMonthSel.appendChild(opt);
    });
    for (let y = new Date().getFullYear() - 3; y <= new Date().getFullYear(); y++) {
      const opt = document.createElement('option');
      opt.value = y; opt.textContent = y;
      if (y === new Date().getFullYear()) opt.selected = true;
      calcYearSel.appendChild(opt);
    }
  }

  try {
    const data = await apiRequest('/payroll/config');
    payrollConfigCache = data.config;
    renderTiersEditor(payrollConfigCache.commissionTiers);
    renderRulesEditor(payrollConfigCache.incentiveRules);
  } catch (err) {
    showToast(err.message, 'error');
  }

  loadCommissionLedger();
}

document.getElementById('addTierBtn').addEventListener('click', () => {
  payrollConfigCache.commissionTiers.push({ upTo: null, rate: 1 });
  renderTiersEditor(payrollConfigCache.commissionTiers);
});
document.getElementById('addRuleBtn').addEventListener('click', () => {
  payrollConfigCache.incentiveRules.push({ name: '', condition: '', amount: 0 });
  renderRulesEditor(payrollConfigCache.incentiveRules);
});

document.getElementById('savePayrollConfigBtn').addEventListener('click', async () => {
  const tiers = [...document.querySelectorAll('[data-tier-row]')].map((row) => ({
    upTo: row.querySelector('.tier-upto').value === '' ? null : row.querySelector('.tier-upto').value,
    rate: row.querySelector('.tier-rate').value
  }));
  const rules = [...document.querySelectorAll('[data-rule-row]')].map((row) => ({
    name: row.querySelector('.rule-name').value,
    condition: row.querySelector('.rule-condition').value,
    amount: row.querySelector('.rule-amount').value
  })).filter((r) => r.name && r.condition);

  try {
    const data = await apiRequest('/payroll/config', { method: 'PUT', body: JSON.stringify({ commissionTiers: tiers, incentiveRules: rules }) });
    showToast(data.message, 'success');
    payrollConfigCache = data.config;
    renderTiersEditor(payrollConfigCache.commissionTiers);
    renderRulesEditor(payrollConfigCache.incentiveRules);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('commLogBtn').addEventListener('click', async () => {
  const employeeId = document.getElementById('commEmployee').value;
  const dealValue = document.getElementById('commDealValue').value;
  const clientName = document.getElementById('commClientName').value.trim();
  const month = document.getElementById('commMonth').value;
  if (!employeeId || !dealValue) { showToast('Please choose an employee and enter a deal value', 'error'); return; }
  try {
    const data = await apiRequest('/payroll/commission', { method: 'POST', body: JSON.stringify({ employeeId, dealValue, clientName, month }) });
    showToast(data.message, 'success');
    document.getElementById('commDealValue').value = '';
    document.getElementById('commClientName').value = '';
    loadCommissionLedger();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

async function loadCommissionLedger() {
  const tbody = document.getElementById('commissionBody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Loading...</td></tr>';
  try {
    const params = new URLSearchParams();
    const empId = document.getElementById('commFilterEmployee').value;
    const month = document.getElementById('commFilterMonth').value;
    if (empId) params.set('employeeId', empId);
    if (month) params.set('month', month);
    const data = await apiRequest(`/payroll/commission?${params.toString()}`);
    document.getElementById('commTotalBadge').textContent = `Total: ₹${data.totalCommission.toLocaleString('en-IN')}`;
    const list = data.entries || [];
    if (list.length === 0) { tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No commission entries yet</td></tr>'; return; }
    tbody.innerHTML = list.map((c) => `
      <tr>
        <td>${c.employeeName}</td>
        <td>${c.clientName || '-'}</td>
        <td>₹${c.dealValue.toLocaleString('en-IN')}</td>
        <td>${c.commissionRate}%</td>
        <td>₹${c.commissionAmount.toLocaleString('en-IN')}</td>
        <td>${c.month}</td>
        <td><button class="icon-btn danger" title="Delete" onclick="deleteCommission(${c.id})"><i class="bi bi-trash-fill"></i></button></td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">${err.message}</td></tr>`;
  }
}
document.getElementById('commFilterEmployee').addEventListener('change', loadCommissionLedger);
document.getElementById('commFilterMonth').addEventListener('change', loadCommissionLedger);
document.getElementById('commClearFilter').addEventListener('click', () => {
  document.getElementById('commFilterEmployee').value = '';
  document.getElementById('commFilterMonth').value = '';
  loadCommissionLedger();
});

async function deleteCommission(id) {
  if (!confirm('Delete this commission entry?')) return;
  try {
    await apiRequest(`/payroll/commission/${id}`, { method: 'DELETE' });
    showToast('Commission entry removed', 'success');
    loadCommissionLedger();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.deleteCommission = deleteCommission;

document.getElementById('calcRunBtn').addEventListener('click', async () => {
  const employeeId = document.getElementById('calcEmployee').value;
  const month = document.getElementById('calcMonth').value;
  const year = document.getElementById('calcYear').value;
  const resultEl = document.getElementById('calcResult');
  resultEl.innerHTML = 'Calculating...';
  try {
    const data = await apiRequest(`/payroll/calculate/${employeeId}?month=${month}&year=${year}`);
    resultEl.innerHTML = `
      <div class="card" style="background:#f8faff; margin:0;">
        <div><b>${data.employeeName}</b> — ${monthNames[data.month - 1]} ${data.year}</div>
        <div class="text-muted" style="font-size:13px; margin:6px 0;">Attendance: ${data.attendance}% · Late days: ${data.lateDays}</div>
        <div>Commission earned: <b>₹${data.commissionTotal.toLocaleString('en-IN')}</b></div>
        ${data.incentiveBonuses.length ? data.incentiveBonuses.map((b) => `<div>+ ${b.name}: <b>₹${b.amount.toLocaleString('en-IN')}</b></div>`).join('') : '<div class="text-muted" style="font-size:12.5px;">No incentive bonuses earned this month</div>'}
        <hr class="divider" />
        <div style="font-size:16px;">Suggested "Other Earnings" for payslip: <b>₹${data.suggestedOtherEarnings.toLocaleString('en-IN')}</b></div>
      </div>
    `;
  } catch (err) {
    resultEl.innerHTML = err.message;
  }
});

// ================= INIT =================
(async function init() {
  await loadEmployeesCache();
  await loadOverview();
  connectLiveFeed();
})();
