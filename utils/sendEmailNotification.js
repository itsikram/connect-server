const nodemailer = require('nodemailer');

let transporter = null;
let transporterKey = '';

function getSmtpCredentials() {
  const user = (process.env.SMTP_USER || '').trim();
  // Gmail app passwords are often copied with spaces — strip them
  const pass = (process.env.SMTP_PASS || '').trim().replace(/\s+/g, '');
  return { user, pass };
}

function buildTransportOptions(port, secure) {
  const { user, pass } = getSmtpCredentials();
  const host = (process.env.SMTP_HOST || 'smtp.gmail.com').trim();

  return {
    host,
    port,
    secure,
    auth: { user, pass },
    // Prefer IPv4 — IPv6 routes to Gmail often time out on some networks/hosts
    family: 4,
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT) || 20000,
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT) || 15000,
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT) || 30000,
    tls: {
      servername: host,
      minVersion: 'TLSv1.2',
    },
    ...(secure
      ? {}
      : {
          requireTLS: true,
        }),
  };
}

function getCandidateConfigs() {
  const preferredPort = Number(process.env.SMTP_PORT) || 587;
  const preferredSecure =
    process.env.SMTP_SECURE === 'true' ||
    (process.env.SMTP_SECURE !== 'false' && preferredPort === 465);

  const candidates = [
    { port: preferredPort, secure: preferredSecure },
  ];

  // Always keep a fallback between 587 (STARTTLS) and 465 (SSL)
  if (preferredPort === 465) {
    candidates.push({ port: 587, secure: false });
  } else {
    candidates.push({ port: 465, secure: true });
  }

  // Deduplicate by port
  const seen = new Set();
  return candidates.filter((c) => {
    if (seen.has(c.port)) return false;
    seen.add(c.port);
    return true;
  });
}

async function createWorkingTransporter() {
  const { user, pass } = getSmtpCredentials();
  if (!user || !pass) {
    throw new Error('SMTP_USER and SMTP_PASS must be set in server .env');
  }

  const candidates = getCandidateConfigs();
  const errors = [];

  for (const candidate of candidates) {
    const options = buildTransportOptions(candidate.port, candidate.secure);
    const transport = nodemailer.createTransport(options);

    try {
      console.log(
        `SMTP: verifying ${options.host}:${options.port} (secure=${options.secure}, family=4)...`
      );
      await transport.verify();
      console.log(`SMTP: connected via ${options.host}:${options.port}`);
      transporterKey = `${options.host}:${options.port}:${options.secure}`;
      return transport;
    } catch (err) {
      const msg = err.message || String(err);
      console.warn(`SMTP: ${options.host}:${options.port} failed — ${msg}`);
      errors.push(`${options.port}: ${msg}`);
      try {
        transport.close();
      } catch {
        /* ignore */
      }
    }
  }

  throw new Error(
    `SMTP connection failed on all ports. Last errors: ${errors.join(' | ')}. ` +
      'If you are on a restricted network/host (ISP/firewall/Render free tier), outbound SMTP may be blocked.'
  );
}

async function getTransporter() {
  if (transporter) return transporter;
  transporter = await createWorkingTransporter();
  return transporter;
}

function resetTransporter() {
  if (transporter) {
    try {
      transporter.close();
    } catch {
      /* ignore */
    }
  }
  transporter = null;
  transporterKey = '';
}

/**
 * Send an email via SMTP (Gmail / gsmtp compatible).
 * @param {string} email - Recipient address
 * @param {string|null} subject - Email subject (optional)
 * @param {string} message - Plain-text body
 * @param {string} senderName - Display name used in From / default subject
 * @param {{ replyTo?: string, html?: string, throwOnError?: boolean }} [options]
 * @returns {Promise<{ success: boolean, messageId?: string, error?: any }>}
 */
let sendEmailNotification = async (email, subject = null, message, senderName, options = {}) => {
  if (!email) {
    console.error('Error sending mail: missing recipient email');
    if (options.throwOnError) throw new Error('Missing recipient email');
    return { success: false, error: 'Missing recipient email' };
  }

  try {
    const mailTransport = await getTransporter();
    const fromAddress = (process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
    const fromName = senderName || process.env.SMTP_FROM_NAME || 'Connect';

    const info = await mailTransport.sendMail({
      from: `"${fromName}" <${fromAddress}>`,
      to: email,
      subject: subject || `New message from ${senderName || 'Connect'} On Connect`,
      text: message,
      ...(options.html ? { html: options.html } : {}),
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    });

    console.log(`Mail sent successfully via SMTP (${transporterKey}):`, info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('Error sending mail:', err.response || err.message || err);
    // Drop cached transporter so next attempt can retry alternate ports
    resetTransporter();
    if (options.throwOnError) throw err;
    return { success: false, error: err.message || err };
  }
};

module.exports = sendEmailNotification;
