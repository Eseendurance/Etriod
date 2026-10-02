// Minimal email sender. If SMTP_* env vars are set, sends a real email via
// nodemailer. Otherwise, logs the message to the console so local
// development and this environment's tests still work without a real
// email provider configured. Swap in SendGrid/Postmark/SES here for production.
const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
  if (!process.env.SMTP_HOST) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_PORT === '465',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text }) {
  const t = getTransporter();
  if (!t) {
    console.log(`[mailer] SMTP not configured — would have sent to ${to}:\n  Subject: ${subject}\n  Body: ${text}`);
    return { simulated: true };
  }
  return t.sendMail({ from: process.env.SMTP_FROM || 'ETriod <no-reply@etriod.app>', to, subject, text });
}

module.exports = { sendMail };
