// WhatsApp notification sender.
//
// HONEST NOTE: This app has no network access in the environment it was built/tested in,
// so live sending could not be tested end-to-end here. What IS real:
//   - If you fill in valid Twilio or Meta (WhatsApp Cloud API) credentials under
//     Settings -> WhatsApp, this code makes a genuine HTTPS API call to send the message
//     (using Node's built-in https module - no extra packages to install).
//   - Every attempt (successful or not) is written to db.whatsappLog so you always have a
//     record of what was sent/attempted, from Settings -> WhatsApp -> Notification Log.
//   - If WhatsApp isn't enabled/configured, the message is logged with status 'skipped'
//     instead of silently pretending to succeed.
const https = require('https');
const { readDb, writeDb } = require('./db');

function httpsRequestJson(options, bodyObj) {
  return new Promise((resolve) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : (options.formBody || '');
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, body: data });
      });
    });
    req.on('error', (err) => resolve({ statusCode: 0, body: '', error: err.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ statusCode: 0, body: '', error: 'Request timed out' }); });
    req.write(body);
    req.end();
  });
}

async function sendViaTwilio(wa, toPhone, message) {
  const auth = Buffer.from(`${wa.accountSid}:${wa.authToken}`).toString('base64');
  const formBody = new URLSearchParams({
    From: `whatsapp:${wa.fromNumber}`,
    To: `whatsapp:${toPhone}`,
    Body: message
  }).toString();
  const result = await httpsRequestJson({
    hostname: 'api.twilio.com',
    path: `/2010-04-01/Accounts/${wa.accountSid}/Messages.json`,
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(formBody)
    },
    formBody
  });
  return result;
}

async function sendViaMetaCloud(wa, toPhone, message) {
  const bodyObj = {
    messaging_product: 'whatsapp',
    to: toPhone.replace(/[^0-9]/g, ''),
    type: 'text',
    text: { body: message }
  };
  const bodyStr = JSON.stringify(bodyObj);
  const result = await httpsRequestJson({
    hostname: 'graph.facebook.com',
    path: `/v19.0/${wa.metaPhoneNumberId}/messages`,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${wa.metaAccessToken}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr)
    }
  }, bodyObj);
  return result;
}

// sendWhatsApp({ employeeId, employeeName, phone, event, message })
// Always resolves (never throws) - logs the outcome to db.whatsappLog and returns it.
async function sendWhatsApp({ employeeId, employeeName, phone, event, message }) {
  const db = readDb();
  const wa = db.settings.whatsapp || {};
  const logEntry = {
    id: db.counters.whatsappLogId++,
    employeeId, employeeName, phone, event, message,
    status: 'skipped',
    detail: 'WhatsApp notifications are not enabled/configured in Settings',
    createdAt: new Date().toISOString()
  };

  if (!wa.enabled) {
    db.whatsappLog.unshift(logEntry);
    writeDb(db);
    return logEntry;
  }
  if (!phone) {
    logEntry.detail = 'This employee has no phone number on file';
    db.whatsappLog.unshift(logEntry);
    writeDb(db);
    return logEntry;
  }

  try {
    let result;
    if (wa.provider === 'meta_cloud') {
      if (!wa.metaAccessToken || !wa.metaPhoneNumberId) {
        logEntry.detail = 'Meta Cloud API credentials are incomplete';
        db.whatsappLog.unshift(logEntry);
        writeDb(db);
        return logEntry;
      }
      result = await sendViaMetaCloud(wa, phone, message);
    } else {
      if (!wa.accountSid || !wa.authToken || !wa.fromNumber) {
        logEntry.detail = 'Twilio credentials are incomplete';
        db.whatsappLog.unshift(logEntry);
        writeDb(db);
        return logEntry;
      }
      result = await sendViaTwilio(wa, phone, message);
    }

    if (result.error) {
      logEntry.status = 'failed';
      logEntry.detail = `Network error: ${result.error} (no internet access reaches the WhatsApp API from this server/environment)`;
    } else if (result.statusCode >= 200 && result.statusCode < 300) {
      logEntry.status = 'sent';
      logEntry.detail = `Provider responded with HTTP ${result.statusCode}`;
    } else {
      logEntry.status = 'failed';
      logEntry.detail = `Provider responded with HTTP ${result.statusCode}: ${String(result.body).slice(0, 200)}`;
    }
  } catch (err) {
    logEntry.status = 'failed';
    logEntry.detail = err.message;
  }

  db.whatsappLog.unshift(logEntry);
  if (db.whatsappLog.length > 500) db.whatsappLog.length = 500; // keep the log from growing forever
  writeDb(db);
  return logEntry;
}

module.exports = { sendWhatsApp };
