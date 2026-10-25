/**
 * email.js
 * Email alert system using Nodemailer.
 * Sends:
 *  - Real-time alerts for significant earthquakes (M6+)
 *  - Daily digest summaries
 *  - Swarm / pattern alerts
 */

import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

// ─── Transporter ──────────────────────────────────────────────────────────────

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: { rejectUnauthorized: process.env.NODE_ENV === 'production' },
  });

  return transporter;
}

function getRecipients() {
  const raw = process.env.ALERT_RECIPIENTS || '';
  return raw.split(',').map(e => e.trim()).filter(Boolean);
}

// ─── Color helpers ────────────────────────────────────────────────────────────

const SEVERITY_COLORS = {
  great:    { bg: '#FF0000', text: '#fff' },
  major:    { bg: '#FF4500', text: '#fff' },
  strong:   { bg: '#FF8C00', text: '#fff' },
  moderate: { bg: '#FFA500', text: '#000' },
  light:    { bg: '#FFD700', text: '#000' },
  minor:    { bg: '#9ACD32', text: '#000' },
  micro:    { bg: '#4CAF50', text: '#fff' },
};

const ALERT_COLORS = {
  red:    '#FF0000',
  orange: '#FF8C00',
  yellow: '#FFD700',
  green:  '#4CAF50',
};

// ─── HTML Templates ───────────────────────────────────────────────────────────

function earthquakeAlertHTML(eq) {
  const sColor = SEVERITY_COLORS[eq.severity] || { bg: '#666', text: '#fff' };
  const alertColor = ALERT_COLORS[eq.alert] || '#888';
  const time = new Date(eq.time).toUTCString();
  const [lng, lat] = eq.location?.coordinates || [0, 0];
  const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}&z=7`;
  const usgsUrl = eq.url || `https://earthquake.usgs.gov/earthquakes/eventpage/${eq.eventId}`;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Earthquake Alert — M${eq.magnitude}</title>
</head>
<body style="margin:0;padding:0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;background:#0a0a0a;color:#e0e0e0;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;">

    <!-- Header -->
    <div style="background:#111;border:1px solid #222;border-radius:8px;overflow:hidden;margin-bottom:16px;">
      <div style="background:#1a1a1a;padding:16px 20px;border-bottom:1px solid #222;display:flex;align-items:center;gap:12px;">
        <span style="font-size:24px;">🌍</span>
        <div>
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#666;margin-bottom:2px;">SEISMIC ALERT</div>
          <div style="font-size:18px;font-weight:700;color:#fff;">Earthquake Data Aggregator</div>
        </div>
      </div>

      <!-- Magnitude badge -->
      <div style="padding:24px 20px;text-align:center;">
        <div style="display:inline-block;background:${sColor.bg};color:${sColor.text};padding:12px 28px;border-radius:6px;font-size:42px;font-weight:900;letter-spacing:-1px;margin-bottom:8px;">
          M${eq.magnitude}
        </div>
        <div style="font-size:13px;font-weight:600;letter-spacing:3px;text-transform:uppercase;color:${sColor.bg};margin-bottom:4px;">
          ${eq.severity?.toUpperCase()} EARTHQUAKE
        </div>
        <div style="font-size:14px;color:#aaa;">${eq.place || 'Unknown location'}</div>
      </div>
    </div>

    <!-- Details grid -->
    <div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px;margin-bottom:16px;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        ${detail('🕐 Time (UTC)', time)}
        ${detail('📍 Depth', eq.depth !== null ? `${eq.depth} km` : 'Unknown')}
        ${detail('📌 Coordinates', `${lat?.toFixed(3)}°, ${lng?.toFixed(3)}°`)}
        ${detail('⚠️ Risk Score', `${eq.riskScore}/100`)}
        ${detail('🌊 Tsunami', eq.tsunami ? '⚡ WARNING ISSUED' : 'No warning')}
        ${detail('🔔 PAGER Alert', eq.alert ? eq.alert.toUpperCase() : 'N/A')}
        ${detail('📊 Felt Reports', eq.felt || '0')}
        ${detail('📡 Source', eq.source)}
      </div>
    </div>

    <!-- Risk bar -->
    <div style="background:#111;border:1px solid #222;border-radius:8px;padding:16px 20px;margin-bottom:16px;">
      <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#666;margin-bottom:8px;">RISK SCORE</div>
      <div style="background:#1a1a1a;border-radius:4px;height:8px;margin-bottom:6px;">
        <div style="background:${sColor.bg};height:8px;border-radius:4px;width:${eq.riskScore}%;transition:width 0.3s;"></div>
      </div>
      <div style="font-size:13px;color:#aaa;">${eq.riskScore}/100 — ${riskLabel(eq.riskScore)}</div>
    </div>

    <!-- Actions -->
    <div style="text-align:center;margin-bottom:24px;">
      <a href="${mapsUrl}" style="display:inline-block;background:#1a6ef7;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;margin:0 6px;">View on Map</a>
      <a href="${usgsUrl}" style="display:inline-block;background:#222;color:#aaa;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;margin:0 6px;">USGS Details</a>
    </div>

    <!-- Footer -->
    <div style="text-align:center;font-size:11px;color:#444;letter-spacing:0.5px;">
      Earthquake Data Aggregator • Automated seismic monitoring<br>
      Data sources: USGS FDSN &amp; EMSC SeismicPortal
    </div>
  </div>
</body>
</html>`;
}

function detail(label, value) {
  return `
    <div style="background:#1a1a1a;padding:12px;border-radius:6px;">
      <div style="font-size:10px;color:#555;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">${label}</div>
      <div style="font-size:13px;color:#ddd;font-weight:600;">${value}</div>
    </div>`;
}

function riskLabel(score) {
  if (score >= 80) return 'Extreme Risk';
  if (score >= 60) return 'High Risk';
  if (score >= 40) return 'Moderate Risk';
  if (score >= 20) return 'Low Risk';
  return 'Minimal Risk';
}

// ─── Daily Digest Template ────────────────────────────────────────────────────

function dailyDigestHTML(stats) {
  const rows = Object.entries(stats.bySeverity || {})
    .map(([sev, count]) => `
      <tr>
        <td style="padding:8px 12px;color:#aaa;text-transform:capitalize;">${sev}</td>
        <td style="padding:8px 12px;color:#fff;font-weight:600;text-align:right;">${count}</td>
      </tr>`).join('');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Daily Earthquake Digest</title></head>
<body style="margin:0;padding:0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;background:#0a0a0a;color:#e0e0e0;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;">
    <div style="background:#111;border:1px solid #222;border-radius:8px;overflow:hidden;margin-bottom:16px;">
      <div style="background:#1a1a1a;padding:16px 20px;border-bottom:1px solid #222;">
        <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#666;">DAILY DIGEST</div>
        <div style="font-size:20px;font-weight:700;color:#fff;margin-top:2px;">
          Earthquake Summary — ${new Date().toDateString()}
        </div>
      </div>
      <div style="padding:20px;display:grid;grid-template-columns:repeat(3,1fr);gap:12px;text-align:center;">
        <div><div style="font-size:32px;font-weight:900;color:#1a6ef7;">${stats.total || 0}</div><div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:1px;">Total Events</div></div>
        <div><div style="font-size:32px;font-weight:900;color:#FF8C00;">${stats.avgMagnitude || 'N/A'}</div><div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:1px;">Avg Magnitude</div></div>
        <div><div style="font-size:32px;font-weight:900;color:${stats.maxEarthquake?.magnitude >= 6 ? '#FF4500' : '#4CAF50'};">${stats.maxEarthquake?.magnitude || 'N/A'}</div><div style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:1px;">Max Magnitude</div></div>
      </div>
    </div>

    <div style="background:#111;border:1px solid #222;border-radius:8px;overflow:hidden;margin-bottom:16px;">
      <div style="padding:12px 20px;background:#1a1a1a;border-bottom:1px solid #222;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#666;">By Severity</div>
      <table style="width:100%;border-collapse:collapse;">
        ${rows}
      </table>
    </div>

    <div style="text-align:center;font-size:11px;color:#444;">Earthquake Data Aggregator • Automated daily digest</div>
  </div>
</body>
</html>`;
}

// ─── Email Send Functions ─────────────────────────────────────────────────────

/**
 * Send a real-time earthquake alert for a significant event
 * @param {object} earthquake - Normalized earthquake document
 * @param {string[]} [recipients] - Override recipient list
 */
export async function sendEarthquakeAlert(earthquake, recipients) {
  const to = (recipients || getRecipients()).join(', ');
  if (!to) return { skipped: true, reason: 'No recipients configured' };

  const mag = earthquake.magnitude || earthquake.magnitudeRaw;
  const subject = `🚨 M${mag} ${earthquake.severity?.toUpperCase()} Earthquake — ${earthquake.place}`;

  try {
    const info = await getTransporter().sendMail({
      from:    process.env.ALERT_FROM || process.env.SMTP_USER,
      to,
      subject,
      html:    earthquakeAlertHTML(earthquake),
      text:    `Earthquake Alert: M${mag} ${earthquake.severity} near ${earthquake.place} at ${new Date(earthquake.time).toUTCString()}. Depth: ${earthquake.depth}km. Risk Score: ${earthquake.riskScore}/100.`,
    });

    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('Email send error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send daily digest email with aggregated stats
 * @param {object} stats - Stats object from /api/stats
 * @param {string[]} [recipients]
 */
export async function sendDailySummary(stats, recipients) {
  const to = (recipients || getRecipients()).join(', ');
  if (!to) return { skipped: true, reason: 'No recipients configured' };

  try {
    const info = await getTransporter().sendMail({
      from:    process.env.ALERT_FROM || process.env.SMTP_USER,
      to,
      subject: `📊 Daily Earthquake Digest — ${new Date().toDateString()} (${stats.total} events)`,
      html:    dailyDigestHTML(stats),
    });

    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('Daily digest error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send a pattern alert (swarm, surge, escalation)
 * @param {object} pattern - Pattern object from analyzePatterns()
 * @param {string[]} [recipients]
 */
export async function sendPatternAlert(pattern, recipients) {
  const to = (recipients || getRecipients()).join(', ');
  if (!to) return { skipped: true };

  const icons = { swarm: '🔴', surge: '⚡', escalation: '📈', lull: '😶' };
  const icon = icons[pattern.type] || '⚠️';

  try {
    await getTransporter().sendMail({
      from:    process.env.ALERT_FROM || process.env.SMTP_USER,
      to,
      subject: `${icon} Seismic Pattern Alert: ${pattern.type?.toUpperCase()} detected`,
      html:    `<div style="font-family:sans-serif;background:#0a0a0a;color:#e0e0e0;padding:24px;max-width:560px;margin:0 auto;">
        <h2 style="color:#FF8C00;">${icon} Seismic Pattern: ${pattern.type}</h2>
        <p style="color:#aaa;">${pattern.message}</p>
        <p style="color:#555;font-size:12px;">Severity: ${pattern.severity} | ${new Date().toUTCString()}</p>
      </div>`,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Verify SMTP connection is working
 */
export async function verifyConnection() {
  try {
    await getTransporter().verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}