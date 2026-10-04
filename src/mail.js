'use strict';

const nodemailer = require('nodemailer');

// One sender for the whole service. Resend is preferred when its key is set;
// otherwise the SMTP relay (Postfix) is used exactly as before. The key is
// never logged: errors carry only the HTTP status.
function transport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'localhost',
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    requireTLS: process.env.SMTP_REQUIRE_TLS !== 'false',
    ignoreTLS: process.env.SMTP_REQUIRE_TLS === 'false',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    tls: { servername: process.env.SMTP_TLS_SERVERNAME || process.env.SMTP_HOST || 'localhost' },
  });
}

async function sendMail({ from, to, subject, text }) {
  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || 'PDFMint <noreply@mail.mintapis.com>',
        to, subject, text,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`resend returned ${res.status}`);
    return;
  }
  await transport().sendMail({ from, to, subject, text });
}

module.exports = { sendMail, transport };
