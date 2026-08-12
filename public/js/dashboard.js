if (!requireAuth()) { /* redirected */ }

const user = getUser();

const STATUS_LABELS = {
  present: 'Present',
  late: 'Late',
  'holiday-worked': 'Present (Holiday)',
  'weekoff-worked': 'Present (Week Off)',
  absent: 'Absent'
};

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

document.getElementById('sidebarName').textContent = user ? user.name : '-';
document.getElementById('sidebarRole').textContent = user ? `${user.designation || ''}` : '-';
document.getElementById('sidebarAvatar').textContent = user ? initials(user.name) : '?';
document.getElementById('welcomeMsg').textContent = user ? `Welcome back, ${user.name.split(' ')[0]}!` : '';

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
const titles = { dashboard: 'My Dashboard', leave: 'Leave', regularization: 'Attendance Regularization', payslips: 'My Payslips', calendar: 'My Calendar', profile: 'My Profile', performance: 'My Performance', documents: 'Documents', tasks: 'Daily Tasks & Activity', fieldvisits: 'Field Visits' };

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

    if (tab === 'profile') loadProfile();
    if (tab === 'leave') { loadLeaveBalance(); loadLeaveHistory(); }
    if (tab === 'regularization') loadRegHistory();
    if (tab === 'payslips') loadPayslips();
    if (tab === 'calendar') { loadCalendar(); loadFestivalList(); }
    if (tab === 'performance') loadMyPerformance();
    if (tab === 'documents') loadMyDocuments();
    if (tab === 'tasks') loadMyTasks();
    if (tab === 'fieldvisits') loadMyFieldVisits();
  });
});

// ---------------- Live Clock ----------------
function tick() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-IN', { hour12: true });
  document.getElementById('topClock').textContent = timeStr;
  document.getElementById('bigClock').textContent = timeStr;
  document.getElementById('bigDate').textContent = now.toLocaleDateString('en-IN', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
  });
}
tick();
setInterval(tick, 1000);

// ---------------- Punch Status ----------------
const punchInBtn = document.getElementById('punchInBtn');
const punchOutBtn = document.getElementById('punchOutBtn');
const myAttMsg = document.getElementById('myAttMsg');

async function loadStatus() {
  try {
    const data = await apiRequest('/attendance/status');
    const r = data.record;
    window._lastAttRecord = r;
    if (r && r.punchIn) {
      document.getElementById('punchInVal').textContent = formatTime12(r.punchIn.slice(0, 5));
      punchInBtn.disabled = true;
    } else {
      document.getElementById('punchInVal').textContent = '--:--';
      punchInBtn.disabled = false;
    }
    if (r && r.punchOut) {
      document.getElementById('punchOutVal').textContent = formatTime12(r.punchOut.slice(0, 5));
      punchOutBtn.disabled = true;
    } else {
      document.getElementById('punchOutVal').textContent = '--:--';
      punchOutBtn.disabled = !(r && r.punchIn);
    }

    const statusEl = document.getElementById('statusVal');
    if (r && r.punchIn) {
      statusEl.textContent = STATUS_LABELS[r.status] || (r.status === 'late' ? 'Late' : 'Present');
      statusEl.className = `badge ${r.status === 'late' ? 'badge-late' : 'badge-present'}`;
    } else {
      statusEl.textContent = 'Not Marked';
      statusEl.className = 'badge badge-active';
    }
    updateAttMsg(r);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

punchInBtn.addEventListener('click', async () => {
  punchInBtn.disabled = true;
  const original = punchInBtn.textContent;
  punchInBtn.textContent = '📍 Getting location...';
  try {
    const { lat, lng } = await getCurrentLocation();
    punchInBtn.textContent = original;
    const data = await apiRequest('/attendance/punch-in', { method: 'POST', body: JSON.stringify({ lat, lng }) });
    showToast(data.message, 'success');
    await loadStatus();
    await loadHistory();
    await loadMySummary();
  } catch (err) {
    showToast(err.message, 'error');
    punchInBtn.disabled = false;
    punchInBtn.textContent = original;
  }
});

punchOutBtn.addEventListener('click', async () => {
  punchOutBtn.disabled = true;
  const original = punchOutBtn.textContent;
  punchOutBtn.textContent = '📍 Getting location...';
  try {
    const { lat, lng } = await getCurrentLocation();
    punchOutBtn.textContent = original;
    const data = await apiRequest('/attendance/punch-out', { method: 'POST', body: JSON.stringify({ lat, lng }) });
    showToast(data.message, 'success');
    await loadStatus();
    await loadHistory();
    await loadMySummary();
  } catch (err) {
    showToast(err.message, 'error');
    punchOutBtn.disabled = false;
    punchOutBtn.textContent = original;
  }
});

// ---------------- "Time to target" helper message ----------------
// Shows a friendly nudge under the punch card once punched in: how long until
// the configured target work hours (default 9h) is reached for the day, since
// that's what determines whether today is marked Present or Late.
let targetWorkHours = 9;
async function loadTargetHours() {
  try {
    const data = await apiRequest('/settings');
    targetWorkHours = (data.settings && data.settings.targetWorkHours) || 9;
    const note = document.getElementById('targetHoursNote');
    if (note) note.textContent = `${targetWorkHours} hour${targetWorkHours === 1 ? '' : 's'}`;
  } catch (err) { /* keep default */ }
}
loadTargetHours();

function updateAttMsg(record) {
  if (!myAttMsg) return;
  if (!record || !record.punchIn) { myAttMsg.textContent = ''; return; }
  if (record.punchOut) {
    myAttMsg.textContent = record.status === 'present'
      ? `✔ Target met - marked Present (${record.workHours || ''})`
      : `Worked ${record.workHours || '0h 0m'} - under the ${targetWorkHours}h target, marked Late`;
    return;
  }
  const [h, m, s] = record.punchIn.split(':').map(Number);
  const punchInMs = new Date();
  punchInMs.setHours(h, m, s || 0, 0);
  const elapsedMs = Math.max(0, Date.now() - punchInMs.getTime());
  const targetMs = targetWorkHours * 3600000;
  const remainingMs = targetMs - elapsedMs;
  if (remainingMs <= 0) {
    myAttMsg.textContent = '✔ Target reached - you will be marked Present when you punch out';
  } else {
    const remH = Math.floor(remainingMs / 3600000);
    const remM = Math.floor((remainingMs % 3600000) / 60000);
    myAttMsg.textContent = `${remH}h ${remM}m left to reach the ${targetWorkHours}h target for today`;
  }
}
setInterval(() => {
  if (window._lastAttRecord) updateAttMsg(window._lastAttRecord);
}, 30000);

// ---------------- Monthly analytics (attendance %, streak, overtime) ----------------
async function loadMySummary() {
  try {
    const data = await apiRequest('/attendance/my-summary');
    document.getElementById('attPercentCount').textContent = `${data.attendancePercentage}%`;
    document.getElementById('streakCount').textContent = data.punctualStreak;
    document.getElementById('overtimeCount').textContent = data.totalOvertimeHours || '0h 0m';
  } catch (err) { /* non-critical widget - fail silently */ }
}

// ---------------- Month/Year Selectors ----------------
const monthSelect = document.getElementById('monthSelect');
const yearSelect = document.getElementById('yearSelect');
const fromDateInput = document.getElementById('fromDate');
const toDateInput = document.getElementById('toDate');
const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function initSelectors() {
  const now = new Date();
  monthNames.forEach((m, i) => {
    const opt = document.createElement('option');
    opt.value = i + 1;
    opt.textContent = m;
    if (i + 1 === now.getMonth() + 1) opt.selected = true;
    monthSelect.appendChild(opt);
  });
  for (let y = now.getFullYear(); y >= now.getFullYear() - 3; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    if (y === now.getFullYear()) opt.selected = true;
    yearSelect.appendChild(opt);
  }
}
initSelectors();

// Selecting a month/year clears the date-range fields (mutually exclusive filters)
[monthSelect, yearSelect].forEach((el) => {
  el.addEventListener('change', () => {
    fromDateInput.value = '';
    toDateInput.value = '';
    loadHistory();
  });
});
[fromDateInput, toDateInput].forEach((el) => {
  el.addEventListener('change', () => {
    if (fromDateInput.value || toDateInput.value) loadHistory();
  });
});

function isoDate(d) { return d.toISOString().slice(0, 10); }

document.getElementById('quickTodayBtn').addEventListener('click', () => {
  const today = isoDate(new Date());
  fromDateInput.value = today;
  toDateInput.value = today;
  loadHistory();
});
document.getElementById('quickWeekBtn').addEventListener('click', () => {
  const now = new Date();
  const day = now.getDay() === 0 ? 6 : now.getDay() - 1; // Monday start
  const monday = new Date(now);
  monday.setDate(now.getDate() - day);
  fromDateInput.value = isoDate(monday);
  toDateInput.value = isoDate(now);
  loadHistory();
});
document.getElementById('clearRangeBtn').addEventListener('click', () => {
  fromDateInput.value = '';
  toDateInput.value = '';
  loadHistory();
});

// ---------------- History Table ----------------
async function loadHistory() {
  const tbody = document.getElementById('historyBody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Loading...</td></tr>';
  try {
    let query;
    if (fromDateInput.value || toDateInput.value) {
      query = `fromDate=${fromDateInput.value || ''}&toDate=${toDateInput.value || ''}`;
    } else {
      query = `month=${monthSelect.value}&year=${yearSelect.value}`;
    }
    const data = await apiRequest(`/attendance/my?${query}`);
    const records = data.records || [];

    if (records.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No attendance records for this period</td></tr>';
    } else {
      tbody.innerHTML = records.map(r => {
        const statusClass = r.status === 'late' ? 'badge-late' : r.status === 'absent' ? 'badge-absent' : 'badge-present';
        const statusLabel = STATUS_LABELS[r.status] || (r.punchIn ? 'Present' : 'Absent');
        return `
        <tr>
          <td>${formatDate(r.date)}</td>
          <td>${r.punchIn ? formatTime12(r.punchIn.slice(0,5)) : '-'}</td>
          <td>${r.punchOut ? formatTime12(r.punchOut.slice(0,5)) : '-'}</td>
          <td>${r.workHours || '-'}</td>
          <td><span class="badge ${statusClass}">${statusLabel}</span></td>
        </tr>
      `;
      }).join('');
    }

    const presentDays = records.filter(r => r.status !== 'late' && r.punchIn).length;
    const lateDays = records.filter(r => r.status === 'late').length;
    document.getElementById('presentCount').textContent = presentDays;
    document.getElementById('lateCount').textContent = lateDays;
    document.getElementById('totalDaysCount').textContent = records.length;
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">${err.message}</td></tr>`;
  }
}

// ================= PROFILE TAB =================
async function loadProfile() {
  try {
    const data = await apiRequest('/auth/me');
    const u = data.user;
    document.getElementById('profileAvatar').textContent = initials(u.name);
    document.getElementById('profileName').textContent = u.name;
    document.getElementById('profileDesig').textContent = `${u.designation} · ${u.department}`;
    document.getElementById('profileRoleBadge').textContent = u.role === 'admin' ? 'Admin' : 'Employee';
    document.getElementById('pfCode').textContent = u.empCode;
    document.getElementById('pfUsername').textContent = u.username;
    document.getElementById('pfDept').textContent = u.department;
    document.getElementById('pfJoin').textContent = formatDate(u.joinDate);
    document.getElementById('pfEmail').value = u.email || '';
    document.getElementById('pfPhone').value = u.phone || '';
  } catch (err) {
    showToast(err.message, 'error');
  }
  loadFaceEnrollStatus();
}

document.getElementById('pfSaveBtn').addEventListener('click', async () => {
  const email = document.getElementById('pfEmail').value.trim();
  const phone = document.getElementById('pfPhone').value.trim();
  try {
    const data = await apiRequest('/auth/profile', {
      method: 'PUT',
      body: JSON.stringify({ email, phone })
    });
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
    const data = await apiRequest('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
    });
    showToast(data.message, 'success');
    document.getElementById('curPwd').value = '';
    document.getElementById('newPwd').value = '';
    document.getElementById('confirmNewPwd').value = '';
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ================= LEAVE TAB =================
const LEAVE_LABELS = { casual: 'Casual', sick: 'Sick', earned: 'Earned', unpaid: 'Unpaid' };

async function loadLeaveBalance() {
  const grid = document.getElementById('leaveBalanceGrid');
  try {
    const data = await apiRequest('/leave/balance');
    grid.innerHTML = data.balance.map(b => `
      <div class="stat-card">
        <div class="icon icon-blue">🌴</div>
        <div>
          <div class="value">${b.balance === null ? '∞' : b.balance}</div>
          <div class="label">${b.label} left (of ${b.entitlement || '-'})</div>
        </div>
      </div>
    `).join('');
  } catch (err) {
    grid.innerHTML = `<div class="text-muted">${err.message}</div>`;
  }
}

async function loadLeaveHistory() {
  const tbody = document.getElementById('leaveHistoryBody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Loading...</td></tr>';
  try {
    const data = await apiRequest('/leave/my');
    const records = data.records || [];
    if (records.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No leave requests yet</td></tr>';
      return;
    }
    tbody.innerHTML = records.map(r => `
      <tr>
        <td>${LEAVE_LABELS[r.leaveType] || r.leaveType}</td>
        <td>${formatDate(r.fromDate)}</td>
        <td>${formatDate(r.toDate)}</td>
        <td>${r.days}</td>
        <td>${r.reason}</td>
        <td><span class="badge ${r.status === 'approved' ? 'badge-present' : r.status === 'rejected' ? 'badge-absent' : r.status === 'cancelled' ? 'badge-inactive' : 'badge-late'}">${r.status}</span></td>
        <td>${r.status === 'pending' ? `<button class="btn btn-outline btn-sm" data-cancel-leave="${r.id}">Cancel</button>` : '-'}</td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-cancel-leave]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const data = await apiRequest(`/leave/${btn.dataset.cancelLeave}/cancel`, { method: 'PUT' });
          showToast(data.message, 'success');
          loadLeaveHistory();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">${err.message}</td></tr>`;
  }
}

document.getElementById('leaveApplyBtn').addEventListener('click', async (e) => {
  const btn = e.target;
  const leaveType = document.getElementById('leaveType').value;
  const fromDate = document.getElementById('leaveFrom').value;
  const toDate = document.getElementById('leaveTo').value;
  const reason = document.getElementById('leaveReason').value.trim();
  if (!fromDate || !toDate || !reason) {
    showToast('Please fill in all leave fields', 'error');
    return;
  }
  btn.disabled = true;
  try {
    const data = await apiRequest('/leave/apply', {
      method: 'POST',
      body: JSON.stringify({ leaveType, fromDate, toDate, reason })
    });
    showToast(data.message, 'success');
    document.getElementById('leaveFrom').value = '';
    document.getElementById('leaveTo').value = '';
    document.getElementById('leaveReason').value = '';
    loadLeaveBalance();
    loadLeaveHistory();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ================= REGULARIZATION TAB =================
async function loadRegHistory() {
  const tbody = document.getElementById('regHistoryBody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Loading...</td></tr>';
  try {
    const data = await apiRequest('/regularization/my');
    const records = data.records || [];
    if (records.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No regularization requests yet</td></tr>';
      return;
    }
    tbody.innerHTML = records.map(r => `
      <tr>
        <td>${formatDate(r.date)}</td>
        <td>${r.requestedPunchIn ? formatTime12(r.requestedPunchIn.slice(0,5)) : '-'}</td>
        <td>${r.requestedPunchOut ? formatTime12(r.requestedPunchOut.slice(0,5)) : '-'}</td>
        <td>${r.reason}</td>
        <td><span class="badge ${r.status === 'approved' ? 'badge-present' : r.status === 'rejected' ? 'badge-absent' : 'badge-late'}">${r.status}</span></td>
        <td>-</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${err.message}</td></tr>`;
  }
}

document.getElementById('regApplyBtn').addEventListener('click', async (e) => {
  const btn = e.target;
  const date = document.getElementById('regDate').value;
  const requestedPunchIn = document.getElementById('regPunchIn').value;
  const requestedPunchOut = document.getElementById('regPunchOut').value;
  const reason = document.getElementById('regReason').value.trim();
  if (!date || (!requestedPunchIn && !requestedPunchOut) || !reason) {
    showToast('Please fill in the date, at least one time, and a reason', 'error');
    return;
  }
  btn.disabled = true;
  try {
    const data = await apiRequest('/regularization/apply', {
      method: 'POST',
      body: JSON.stringify({ date, requestedPunchIn, requestedPunchOut, reason })
    });
    showToast(data.message, 'success');
    document.getElementById('regReason').value = '';
    loadRegHistory();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ================= PAYSLIPS TAB =================
async function loadPayslips() {
  const tbody = document.getElementById('payslipsBody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Loading...</td></tr>';
  try {
    const data = await apiRequest('/payslips/my');
    const list = data.payslips || [];
    if (list.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No payslips generated yet</td></tr>';
      return;
    }
    tbody.innerHTML = list.map(p => `
      <tr>
        <td>${p.monthLabel}</td>
        <td>₹${p.grossEarnings.toFixed(2)}</td>
        <td>₹${p.totalDeductions.toFixed(2)}</td>
        <td><b>₹${p.netPay.toFixed(2)}</b></td>
        <td><a class="btn btn-outline btn-sm" href="/api/payslips/${p.id}/download?token=${encodeURIComponent(getToken())}" target="_blank">Download</a></td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">${err.message}</td></tr>`;
  }
}

// ================= CALENDAR TAB =================
const calMonth = document.getElementById('calMonth');
const calYear = document.getElementById('calYear');
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
calMonth.addEventListener('change', loadCalendar);
calYear.addEventListener('change', loadCalendar);

async function loadCalendar() {
  const grid = document.getElementById('calGrid');
  grid.innerHTML = 'Loading...';
  try {
    const data = await apiRequest(`/calendar?month=${calMonth.value}&year=${calYear.value}`);
    const weekdayLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const firstWeekday = new Date(`${data.days[0].date}T00:00:00`).getDay();

    let html = weekdayLabels.map(w => `<div class="cal-weekday">${w}</div>`).join('');
    for (let i = 0; i < firstWeekday; i++) html += `<div class="cal-day type-empty"></div>`;

    data.days.forEach((d) => {
      const dayNum = d.date.slice(-2);
      let note = '';
      if (d.dayType === 'holiday') note = `${d.holidayIcon || '🎉'} ${d.holidayName || 'Holiday'}`;
      else if (d.dayType === 'weekoff') note = 'Weekly Off';
      else if (d.dayType === 'leave') note = `${LEAVE_LABELS[d.leaveType] || d.leaveType} Leave`;
      else if (d.punchIn) note = `${formatTime12(d.punchIn.slice(0,5))}${d.punchOut ? ' - ' + formatTime12(d.punchOut.slice(0,5)) : ''}`;

      const typeClass = d.attendanceStatus ? `type-${d.attendanceStatus}` : `type-${d.dayType}`;
      html += `<div class="cal-day ${typeClass}"><div class="d-num">${parseInt(dayNum,10)}</div><div class="d-note">${note}</div></div>`;
    });

    grid.innerHTML = html;
  } catch (err) {
    grid.innerHTML = `<div class="text-muted">${err.message}</div>`;
  }
}

// ================= FESTIVAL CALENDAR (read-only, all company holidays) =================
let allHolidaysCache = [];

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
    </div>
  `).join('');
}

async function loadFestivalList() {
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

// ---------------- Upcoming Festivals (shown right on the home dashboard) ----------------
async function loadUpcomingFestivals() {
  const wrap = document.getElementById('upcomingFestivalsList');
  if (!wrap) return;
  wrap.innerHTML = 'Loading...';
  try {
    const data = await apiRequest('/settings/holidays');
    const todayStr = new Date().toISOString().slice(0, 10);
    const upcoming = (data.holidays || [])
      .filter((h) => h.date >= todayStr)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .slice(0, 5);

    if (upcoming.length === 0) {
      wrap.innerHTML = '<div class="text-muted" style="padding:12px 0;">No upcoming festivals scheduled</div>';
      return;
    }

    wrap.innerHTML = upcoming.map((h) => `
      <div class="festival-row">
        <div class="festival-icon">${h.icon || '🎉'}</div>
        <div class="festival-info">
          <div class="festival-name">${h.name}</div>
          <div class="festival-date text-muted">${formatDate(h.date)} · ${new Date(h.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long' })}</div>
        </div>
      </div>
    `).join('');
  } catch (err) {
    wrap.innerHTML = `<div class="text-muted">${err.message}</div>`;
  }
}

// ---------------- Real-time updates (Server-Sent Events) ----------------
// Keeps this dashboard in sync the instant an admin/manager approves a leave,
// issues a payslip, updates the leave policy, or changes the holiday calendar -
// no manual refresh needed.
function connectLiveUpdates() {
  const es = new EventSource(`/api/live?token=${encodeURIComponent(getToken())}`);
  const activeTab = () => document.querySelector('.nav-item.active')?.dataset.tab;

  es.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch (e) { return; }
    if (!msg.type || msg.type === 'connected') return;

    switch (msg.type) {
      case 'leave-decided':
        if (msg.payload.employeeId === user.id) {
          showToast(`Your leave request was ${msg.payload.status}`, msg.payload.status === 'approved' ? 'success' : 'error');
          loadLeaveBalance();
          if (activeTab() === 'leave') loadLeaveHistory();
        }
        break;
      case 'leave-credited':
        if (msg.payload.employeeId === user.id) {
          showToast(`${msg.payload.amount} day(s) of ${LEAVE_LABELS[msg.payload.type] || msg.payload.type} leave credited to your balance`, 'success');
          loadLeaveBalance();
        }
        break;
      case 'leave-policy-updated':
        if (msg.payload.scope === 'company' || msg.payload.employeeId === user.id) {
          loadLeaveBalance();
        }
        break;
      case 'regularization-decided':
        if (msg.payload.employeeId === user.id) {
          showToast(`Your attendance correction for ${formatDate(msg.payload.date)} was ${msg.payload.status}`, msg.payload.status === 'approved' ? 'success' : 'error');
          if (activeTab() === 'regularization') loadRegHistory();
          loadStatus();
          loadHistory();
        }
        break;
      case 'payslip-issued':
        if (msg.payload.employeeId === user.id) {
          showToast(`Your payslip for ${msg.payload.monthLabel} is now available`, 'success');
          if (activeTab() === 'payslips') loadPayslips();
        }
        break;
      case 'holiday-updated':
        showToast(`📅 Festival calendar updated: ${msg.payload.name || msg.payload.date}`, 'success');
        loadUpcomingFestivals();
        if (activeTab() === 'calendar') { loadCalendar(); loadFestivalList(); }
        break;
      case 'settings-updated':
        if (activeTab() === 'calendar') loadCalendar();
        break;
      default:
        break;
    }
  };

  es.onerror = () => { /* browser auto-reconnects EventSource */ };
}

// ---------------- Birthday / Anniversary Notifications ----------------
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
            <b style="font-size:15px;">${b.id === user.id ? 'Happy Birthday to you!' : `Happy Birthday, ${b.name}!`}</b>
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
            <b style="font-size:15px;">${a.id === user.id ? `Congrats, you completed ${a.years} year${a.years > 1 ? 's' : ''} with us today!` : `${a.name} completes ${a.years} year${a.years > 1 ? 's' : ''} with us today!`}</b>
            <div class="text-muted" style="font-size:12.5px;">${a.designation} · ${a.department} — happy work anniversary! 🎉</div>
          </div>
        </div>
      `);
    });
    el.innerHTML = cards.join('');
  } catch (err) { el.innerHTML = ''; }
}

// ---------------- My Performance ----------------
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
  perfMonth.addEventListener('change', loadMyPerformance);
  perfYear.addEventListener('change', loadMyPerformance);
}

async function loadMyPerformance() {
  initPerfSelectors();
  try {
    const data = await apiRequest(`/performance/me?month=${perfMonth.value}&year=${perfYear.value}`);
    const p = data.performance;
    const circle = document.getElementById('perfScoreCircle');
    circle.textContent = p.score;
    circle.style.background = p.score >= 85 ? 'var(--green)' : p.score >= 65 ? '#e9a23b' : 'var(--red)';
    document.getElementById('perfAttendance').textContent = `${p.attendancePercentage}%`;
    document.getElementById('perfLeaves').textContent = p.leaveDaysUsed;
    document.getElementById('perfLate').textContent = p.lateDays;
    document.getElementById('perfOvertime').textContent = p.overtimeHours;
  } catch (err) {
    showToast(err.message, 'error');
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
        <span>${p.medal || `#${p.rank}`} &nbsp; ${p.employeeName}${p.isMe ? ' (You)' : ''} <span class="text-muted" style="font-size:12px;">(${p.department})</span></span>
        <span class="badge ${p.score >= 85 ? 'badge-present' : p.score >= 65 ? 'badge-late' : 'badge-absent'}">${p.score} pts</span>
      </div>
    `).join('');
  } catch (err) {
    el.innerHTML = err.message;
  }
}

// ---------------- My Documents ----------------
const DOC_TYPE_OPTIONS = [['aadhaar', 'Aadhaar Card'], ['pan', 'PAN Card'], ['resume', 'Resume / CV'], ['other', 'Other']];

function initDocTypeSelect() {
  const sel = document.getElementById('docType');
  if (sel && !sel.options.length) {
    sel.innerHTML = DOC_TYPE_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  }
}

async function loadMyDocuments() {
  initDocTypeSelect();
  const tbody = document.getElementById('documentsBody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Loading...</td></tr>';
  try {
    const data = await apiRequest('/documents/my');
    const list = data.documents || [];
    if (list.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6">No documents uploaded yet</td></tr>';
      return;
    }
    tbody.innerHTML = list.map((d) => `
      <tr>
        <td>${d.typeLabel}</td>
        <td>${d.fileName}</td>
        <td>${d.note || '-'}</td>
        <td>${d.uploadedByName}</td>
        <td>${formatDate(d.uploadedAt.slice(0, 10))}</td>
        <td>
          <div class="action-icons">
            <button class="icon-btn" title="Download" onclick="downloadMyDocument(${d.id}, '${d.fileName.replace(/'/g, '')}')"><i class="bi bi-download"></i></button>
            ${d.type === 'offer_letter' || d.type === 'salary_slip' || d.type === 'experience_letter' ? '' : `<button class="icon-btn danger" title="Delete" onclick="deleteMyDocument(${d.id})"><i class="bi bi-trash-fill"></i></button>`}
          </div>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${err.message}</td></tr>`;
  }
}

async function downloadMyDocument(id, fileName) {
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
window.downloadMyDocument = downloadMyDocument;

async function deleteMyDocument(id) {
  if (!confirm('Delete this document? This cannot be undone.')) return;
  try {
    const data = await apiRequest(`/documents/${id}`, { method: 'DELETE' });
    showToast(data.message, 'success');
    loadMyDocuments();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.deleteMyDocument = deleteMyDocument;

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

const docFileInput = document.getElementById('docFile');
docFileInput.addEventListener('change', () => {
  const f = docFileInput.files[0];
  document.getElementById('docFileName').textContent = f ? `Selected: ${f.name} (${(f.size / 1024).toFixed(0)} KB)` : '';
});

document.getElementById('docUploadBtn').addEventListener('click', async () => {
  const btn = document.getElementById('docUploadBtn');
  const type = document.getElementById('docType').value;
  const note = document.getElementById('docNote').value.trim();
  const file = docFileInput.files[0];

  if (!type) { showToast('Please choose a document type', 'error'); return; }
  if (!file) { showToast('Please choose a file to upload', 'error'); return; }
  if (file.size > 5 * 1024 * 1024) { showToast('File is too large. Please upload a file under 5MB.', 'error'); return; }

  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Uploading...';
  try {
    const fileData = await readFileAsBase64(file);
    const data = await apiRequest('/documents', { method: 'POST', body: JSON.stringify({ type, file: fileData, note }) });
    showToast(data.message, 'success');
    document.getElementById('docNote').value = '';
    docFileInput.value = '';
    document.getElementById('docFileName').textContent = '';
    loadMyDocuments();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
});

// ---------------- Face Punch Enrollment ----------------
let faceEnrollStream = null;

async function loadFaceEnrollStatus() {
  const badge = document.getElementById('faceEnrollStatusBadge');
  const removeBtn = document.getElementById('faceEnrollRemoveBtn');
  if (!badge) return;
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

// ---------------- My Daily Tasks ----------------
async function loadMyTasks() {
  if (!document.getElementById('taskDate').value) document.getElementById('taskDate').value = new Date().toISOString().slice(0, 10);
  const tbody = document.getElementById('tasksBody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Loading...</td></tr>';
  try {
    const params = new URLSearchParams();
    const date = document.getElementById('taskFilterDate').value;
    const status = document.getElementById('taskFilterStatus').value;
    if (date) params.set('date', date);
    if (status) params.set('status', status);
    const data = await apiRequest(`/tasks/my?${params.toString()}`);
    const list = data.tasks || [];
    if (list.length === 0) { tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No tasks yet — add your first one above</td></tr>'; return; }
    tbody.innerHTML = list.map((t) => `
      <tr>
        <td>${formatDate(t.date)}</td>
        <td>${t.title}${t.description ? `<div class="text-muted" style="font-size:11.5px;">${t.description}</div>` : ''}${t.assignedBy ? `<div class="text-muted" style="font-size:11px;">Assigned by ${t.assignedBy}</div>` : ''}</td>
        <td><span class="badge ${t.priority === 'high' ? 'badge-absent' : t.priority === 'low' ? 'badge-inactive' : 'badge-late'}">${t.priority}</span></td>
        <td>
          <select onchange="updateMyTaskStatus(${t.id}, this.value)" style="padding:4px 8px; border-radius:6px; border:1px solid var(--border); font-size:12.5px;">
            <option value="pending" ${t.status === 'pending' ? 'selected' : ''}>Pending</option>
            <option value="in-progress" ${t.status === 'in-progress' ? 'selected' : ''}>In Progress</option>
            <option value="done" ${t.status === 'done' ? 'selected' : ''}>Done</option>
          </select>
        </td>
        <td><button class="icon-btn danger" title="Delete" onclick="deleteMyTask(${t.id})"><i class="bi bi-trash-fill"></i></button></td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">${err.message}</td></tr>`;
  }
}

async function updateMyTaskStatus(id, status) {
  try {
    await apiRequest(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify({ status }) });
    showToast('Task updated', 'success');
  } catch (err) {
    showToast(err.message, 'error');
    loadMyTasks();
  }
}
window.updateMyTaskStatus = updateMyTaskStatus;

async function deleteMyTask(id) {
  if (!confirm('Delete this task?')) return;
  try {
    await apiRequest(`/tasks/${id}`, { method: 'DELETE' });
    showToast('Task deleted', 'success');
    loadMyTasks();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.deleteMyTask = deleteMyTask;

document.getElementById('taskAddBtn').addEventListener('click', async () => {
  const title = document.getElementById('taskTitle').value.trim();
  const description = document.getElementById('taskDescription').value.trim();
  const date = document.getElementById('taskDate').value;
  const priority = document.getElementById('taskPriority').value;
  if (!title) { showToast('Please enter a task title', 'error'); return; }
  try {
    const data = await apiRequest('/tasks', { method: 'POST', body: JSON.stringify({ title, description, date, priority }) });
    showToast(data.message, 'success');
    document.getElementById('taskTitle').value = '';
    document.getElementById('taskDescription').value = '';
    loadMyTasks();
  } catch (err) {
    showToast(err.message, 'error');
  }
});
document.getElementById('taskFilterDate').addEventListener('change', loadMyTasks);
document.getElementById('taskFilterStatus').addEventListener('change', loadMyTasks);
document.getElementById('taskClearFilter').addEventListener('click', () => {
  document.getElementById('taskFilterDate').value = '';
  document.getElementById('taskFilterStatus').value = '';
  loadMyTasks();
});

// ---------------- Field Sales GPS Tracking ----------------
async function loadMyFieldVisits() {
  const tbody = document.getElementById('fieldVisitsBody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Loading...</td></tr>';
  try {
    const data = await apiRequest('/fieldvisits/my');
    const list = data.visits || [];
    if (list.length === 0) { tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No visits logged yet</td></tr>'; return; }
    tbody.innerHTML = list.map((v) => `
      <tr>
        <td>${v.clientName}${v.purpose ? `<div class="text-muted" style="font-size:11.5px;">${v.purpose}</div>` : ''}</td>
        <td>${new Date(v.checkedInAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
        <td>${v.checkedOutAt ? new Date(v.checkedOutAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '<span class="badge badge-late">Ongoing</span>'}</td>
        <td><a href="https://www.openstreetmap.org/?mlat=${v.lat}&mlon=${v.lng}#map=17/${v.lat}/${v.lng}" target="_blank">📍 View Map</a></td>
        <td>${v.checkedOutAt ? '-' : `<button class="btn btn-outline btn-sm" onclick="checkoutVisit(${v.id})">Check Out</button>`}</td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">${err.message}</td></tr>`;
  }
}

async function checkoutVisit(id) {
  try {
    const { lat, lng } = await getCurrentLocation().catch(() => ({ lat: null, lng: null }));
    const data = await apiRequest(`/fieldvisits/${id}/checkout`, { method: 'POST', body: JSON.stringify({ lat, lng }) });
    showToast(data.message, 'success');
    loadMyFieldVisits();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
window.checkoutVisit = checkoutVisit;

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
    loadMyFieldVisits();
  } catch (err) {
    msgEl.textContent = '';
    showToast(err.message, 'error');
  }
});

// ---------------- Init ----------------
loadStatus();
loadHistory();
loadMySummary();
loadCelebrationBanner();
loadUpcomingFestivals();
connectLiveUpdates();
setInterval(loadStatus, 30000);
