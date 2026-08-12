# Maxim Realty — Employee Attendance Management System

A complete, self-contained web application for tracking employee attendance —
punch in/out with geofencing, leave, regularization, payslips, a role-based
calendar with department weekly-offs, real-time live activity, and a full
admin/manager panel. Real working backend (Node.js + Express), not a mockup.

---

## ✨ Features

**Employee side**
- Secure login (username/password) with **Forgot Password** self-service reset
- Live clock + today's date
- One-click **Punch In** / **Punch Out** with exact timestamps and browser geolocation
- **Geofencing**: if the admin enables it, punch in *and* punch out both require being within a configured distance (default 100m) of the office location — an employee can't punch in from nearby and then punch out from anywhere
- Automatic work-hours calculation and late-arrival auto-detection
- Attendance history filterable by **month/year, quick "Today"/"This Week" buttons, or a custom From–To date range**
- **Leave**: apply for Casual/Sick/Earned/Unpaid leave, see live balances, cancel pending requests
- **Attendance Regularization**: request a correction if you forgot to punch in/out
- **Payslips**: view and download your own generated payslips
- **Calendar**: month view showing worked days, late days, weekly-offs, company holidays, and approved leave — color coded
- **My Profile** — edit contact details, change password

**Manager side** (new role)
- Scoped, read-mostly version of the admin panel limited to their own department
- View & filter their team's attendance, approve/reject their team's leave and regularization requests
- Cannot manage company-wide settings or other departments

**Admin side**
- Everything above, company-wide, plus:
- Dashboard overview with **real-time Live Activity feed** (Server-Sent Events) — punches, leave requests, and regularizations appear instantly without refreshing
- Full **Employee Management**: add, edit, deactivate/reactivate, delete employees; assign roles (**Employee / Manager / Admin**), departments, designations
- **Attendance Records** with flexible filters (employee, month/year, exact date, or date range) + manual correction + CSV export
- **Leave Approvals** and **Regularization Approvals** queues
- **Payslip generation** with full earnings/deductions breakdown, PDF/HTML download
- **Team Calendar** + company **Holiday** management
- **Settings**:
  - Company name & office timing (late-arrival grace period)
  - **Geofencing**: set the office's lat/lng (one click: "Use My Current Location"), allowed distance in meters, and an on/off switch
  - **Weekly Off by Department** — configure which weekday(s) each department gets off (e.g. Sales → Monday off, Marketing → Saturday & Sunday off); any other department falls back to a default

**Technical**
- Fully responsive — works on mobile, tablet, laptop, and desktop
- Real backend built with Node.js + Express — no mock data anywhere
- JWT-based authentication with password hashing (bcrypt)
- Role-based access control (employee / manager / admin) enforced on the server
- **Real-time updates** via Server-Sent Events (`/api/live`) — no external services required
- Self-service **password reset** (token-based; since no email/SMTP is configured, the reset token is shown directly on screen and logged server-side — wire up a real mailer in production)
- Data stored persistently in a local JSON database (`data/db.json`) — survives restarts, auto-migrates older data files when you update the app
- Clean REST API you can plug into a mobile app later

---

## 🖥️ System Requirements

- [Node.js](https://nodejs.org) version 16 or higher.
- Any modern web browser (Chrome, Edge, Safari, Firefox).

Check with:
```
node -v
```

---

## 🚀 How to Run

1. **Unzip** this package anywhere on your computer or server.
2. Open a terminal inside the extracted `maxim-realty-attendance` folder.
3. Run:
   ```
   npm install
   ```
4. Start the server:
   ```
   npm start
   ```
   or double-click `start.bat` (Windows) / run `./start.sh` (Mac/Linux).
5. Open your browser at **http://localhost:3000**

### Office network access
Find the server's local IP (e.g. `192.168.1.10`) and have others visit `http://192.168.1.10:3000`. Ensure your firewall allows port 3000.

### Running permanently
```
npm install -g pm2
pm2 start server.js --name maxim-attendance
pm2 save
```

---

## 🔐 Default Login Credentials

| Role     | Username | Password    | Department |
|----------|----------|-------------|------------|
| Admin    | `admin`  | `admin123`  | Management |
| Manager  | `priya`  | `priya123`  | Sales      |
| Employee | `rahul`  | `rahul123`  | Sales (Monday off) |
| Employee | `ananya` | `ananya123` | Marketing (Sat+Sun off) |

**⚠️ Change these immediately** after first login, especially the admin account.

Forgot a password? Use the **"Forgot password?"** link on the login page. Since
no email server is configured, the reset token is shown directly on screen
(and printed to the server console) instead of being emailed — hook up a real
mail provider (SendGrid, SES, SMTP, etc.) in `routes/auth.js` before using this
in production.

---

## 📍 Setting Up Geofencing (100m punch-in/out radius)

1. Log in as **admin** → **Settings** → *Geofencing*.
2. Click **"Use My Current Location as Office"** while standing at the office (or type the lat/lng manually).
3. Set **Allowed Distance** (defaults to 100 meters).
4. Set **Enforce Geofence** to **On**.
5. Click **Save Geofence Settings**.

From then on, every punch-in *and* punch-out requires the employee's browser
location to be within that radius — punching out doesn't skip the check.

## 🗓️ Setting Up Weekly Offs per Department

Log in as **admin** → **Settings** → *Weekly Off by Department*. Tick the
weekday(s) that should be off for each department (defaults: Sales → Monday,
Marketing → Saturday & Sunday, everything else → Sunday). These show up
automatically on every employee's Calendar tab.

---

## 👥 Adding Your Real Employees

1. Log in as `admin`.
2. Go to **Employees** → **+ Add Employee**.
3. Fill in name, username, temporary password, department, designation, and
   choose a **role**: Employee, Manager, or Admin.
4. A **Manager** can approve leave/regularization and view attendance only
   for their own department. An **Admin** sees and controls everything.

---

## 📁 Project Structure

```
maxim-realty-attendance/
├── server.js                  # Main server entry point + SSE live endpoint
├── package.json
├── data/
│   └── db.json                # Auto-created on first run
├── routes/
│   ├── auth.js                 # Login, profile, change/forgot/reset password
│   ├── employees.js            # Employee CRUD (admin/manager scoped)
│   ├── attendance.js           # Punch in/out (+ geofence), history, export
│   ├── leave.js                # Leave policy, balances, apply/approve/reject
│   ├── regularization.js       # Attendance correction requests
│   ├── payslips.js             # Payslip generation & download
│   ├── settings.js             # Company settings, geofence, weekly-off, holidays
│   └── calendar.js             # Per-employee month calendar view
├── middleware/
│   └── auth.js                 # JWT verification + admin/manager guards
├── utils/
│   ├── db.js                   # JSON file database + schema migration
│   ├── geo.js                  # Haversine distance calculation
│   ├── events.js               # In-memory pub/sub for real-time SSE
│   └── seed.js                 # Creates default demo accounts on first run
└── public/                     # Frontend
    ├── index.html               # Login page
    ├── forgot-password.html     # Password reset flow
    ├── dashboard.html            # Employee dashboard
    ├── admin.html                 # Admin / Manager panel
    ├── css/style.css
    └── js/ (api.js, login.js, dashboard.js, admin.js)
```

---

## 🗄️ Backing Up Your Data

All data lives in `data/db.json`. Copy it periodically to back up; replace and restart to restore.

---

## 🛠️ Troubleshooting

**"Port 3000 is already in use"**
```
PORT=4000 npm start        (Mac/Linux)
set PORT=4000 && npm start (Windows)
```

**Admin locked out and reset token flow isn't available**
Stop the server, delete `data/db.json`, and restart — this recreates the
default demo accounts (⚠️ wipes all data, only do this for testing).

**Employees can't access from their phones**
Same Wi-Fi/network as the server, using its local IP address instead of `localhost`.

**Geofence always rejects punches**
Make sure the browser has location permission granted for the site, and that
the office lat/lng in Settings actually matches where employees are standing.

---

## 📋 API Reference (for developers)

All endpoints are prefixed with `/api`. Authenticated endpoints require header
`Authorization: Bearer <token>` (or `?token=` query param, used for file
download links).

| Method | Endpoint | Access | Description |
|--------|----------|--------|--------------|
| POST   | /auth/login | Public | Log in, returns JWT |
| GET    | /auth/me | Any | Current user profile |
| PUT    | /auth/profile | Any | Update own email/phone |
| POST   | /auth/change-password | Any | Change own password |
| POST   | /auth/forgot-password | Public | Request a reset token |
| POST   | /auth/reset-password | Public | Reset password with token |
| GET    | /employees | Admin/Manager | List employees (manager scoped to dept) |
| POST/PUT/DELETE | /employees(/:id) | Admin | Create/update/delete employees |
| GET    | /attendance/status | Any | Today's punch status |
| POST   | /attendance/punch-in | Any | Punch in (body: `{lat, lng}`) |
| POST   | /attendance/punch-out | Any | Punch out (body: `{lat, lng}`) |
| GET    | /attendance/my | Any | Own history (filters: date/fromDate/toDate/month/year) |
| GET    | /attendance/all | Admin/Manager | Team/company history |
| GET    | /attendance/summary | Admin/Manager | Today's stats |
| POST   | /attendance/manual | Admin | Manually add/correct an entry |
| DELETE | /attendance/:id | Admin | Delete a record |
| GET    | /attendance/export | Admin | CSV export |
| GET/PUT | /leave/policy | Any/Admin | View/update leave entitlements |
| GET    | /leave/balance | Any | Own leave balance |
| POST   | /leave/apply | Any | Apply for leave |
| GET    | /leave/my | Any | Own leave history |
| PUT    | /leave/:id/cancel | Any | Cancel own pending request |
| GET    | /leave/all | Admin/Manager | Team leave requests |
| PUT    | /leave/:id/approve, /reject | Admin/Manager | Decide a request |
| POST   | /regularization/apply | Any | Request a punch correction |
| GET    | /regularization/my, /all | Any / Admin/Manager | View requests |
| PUT    | /regularization/:id/approve, /reject | Admin/Manager | Decide a request |
| POST   | /payslips | Admin | Generate/update a payslip |
| GET    | /payslips/my, /all, /:id | Any / Admin/Manager / Any (own) | View payslips |
| GET    | /payslips/:id/download | Any (own)/Admin/Manager | Download payslip |
| DELETE | /payslips/:id | Admin | Delete a payslip |
| GET/PUT | /settings | Any/Admin | View/update company settings + geofence + weekly-off |
| GET/POST/DELETE | /settings/holidays(/:date) | Any/Admin | Manage company holidays |
| GET    | /calendar | Any | Month calendar (own, or `?employeeId=` for admin/manager) |
| GET    | /live | Any | Server-Sent Events stream of real-time activity |

---

Built for **Maxim Realty**. Enjoy simpler, smarter attendance tracking! 🏢

---

## 🆕 Latest Updates

**Manager self-service**
- Managers (and admins) now get a **"My Attendance"** card at the top of their Overview tab to punch themselves in/out — from anywhere, with no location restriction (only regular employees are geofenced).
- A **"Request a Correction for My Own Attendance"** panel on the Regularization tab lets managers/admins submit their own punch corrections.
- A manager (or admin) can never approve/reject their **own** leave or regularization request — it always waits for an admin, closing a self-approval loophole.

**Leave Policy, per employee**
- New **Leave Policy** tab: set the company-wide default entitlement, then override Casual/Sick/Earned days for any individual employee (managers can do this for their own team).
- **Credit Leave to an Employee's Bucket**: top up one specific employee's balance (e.g. this month's earned-leave accrual) without touching anyone else's — with a full credit history log.
- Everyone (including managers/admins) can see their own **My Leave Balance** box on the Profile tab.

**Festival Calendar**
- Company Holidays now use a quick-pick icon strip (not a dropdown) plus a free-text emoji field, so any festival can be marked visually.
- All holidays are shown in a full **date-wise festival list**, filterable by year, spanning 10 years back to 100 years forward — not just the current month.
- Festival icons now show up directly on every employee's calendar.

**Responsive polish**
- Additional mobile breakpoints for the My Attendance card, festival list, icon picker, and modals so the whole app stays usable on small screens.
