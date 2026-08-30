const nodemailer = require('nodemailer');
const dns = require('dns');

// Prefer IPv4 when Node resolves hosts (helps Gmail SMTP)
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  /* older Node */
}

let transporter = null;
let transporterKey = '';

function getSmtpCredentials() {
  const user = (process.env.SMTP_USER || '').trim();
  // Gmail app passwords are often copied with spaces — strip them
  const pass = (process.env.SMTP_PASS || '').trim().replace(/\s+/g, '');
  return { user, pass };
}

function getFromAddress(senderName) {
  const fromName = senderName || process.env.SMTP_FROM_NAME || 'Connect';
  const fromAddress = (process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
  return { fromName, fromAddress };
}

function buildTransportOptions(port, secure) {
  const { user, pass } = getSmtpCredentials();
  const host = (process.env.SMTP_HOST || 'smtp.gmail.com').trim();

  return {
    host,
    port,
    secure,
    auth: { user, pass },
    family: 4,
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT) || 20000,
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT) || 15000,
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT) || 30000,
    tls: {
      servername: host,
      minVersion: 'TLSv1.2',
    },
    ...(secure ? {} : { requireTLS: true }),
  };
}

function getCandidateConfigs() {
  const preferredPort = Number(process.env.SMTP_PORT) || 587;
  const preferredSecure =
    process.env.SMTP_SECURE === 'true' ||
    (process.env.SMTP_SECURE !== 'false' && preferredPort === 465);

  const candidates = [{ port: preferredPort, secure: preferredSecure }];

  if (preferredPort === 465) {
    candidates.push({ port: 587, secure: false });
  } else {
    candidates.push({ port: 465, secure: true });
  }

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
    throw new Error('SMTP is not configured. Set SMTP_USER and SMTP_PASS.');
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

  throw new Error(`SMTP connection failed on all ports. Last errors: ${errors.join(' | ')}.`);
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
 * Send an email via SMTP (Nodemailer).
 * @param {string} email - Recipient address
 * @param {string|null} subject - Email subject (optional)
 * @param {string} message - Plain-text body
 * @param {string} senderName - Display name used in From / default subject
 * @param {{ replyTo?: string, html?: string, throwOnError?: boolean }} [options]
 * @returns {Promise<{ success: boolean, messageId?: string, error?: any, provider?: string }>}
 */
let sendEmailNotification = async (email, subject = null, message, senderName, options = {}) => {
  if (!email) {
    console.error('Error sending mail: missing recipient email');
    if (options.throwOnError) throw new Error('Missing recipient email');
    return { success: false, error: 'Missing recipient email' };
  }

  try {
    const mailTransport = await getTransporter();
    const { fromName, fromAddress } = getFromAddress(senderName);

    if (!fromAddress) {
      throw new Error('SMTP_FROM or SMTP_USER must be set');
    }

    const info = await mailTransport.sendMail({
      from: `"${fromName}" <${fromAddress}>`,
      to: email,
      subject: subject || `New message from ${senderName || 'Connect'} On Connect`,
      text: message,
      ...(options.html ? { html: options.html } : {}),
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    });

    console.log(`Mail sent successfully via SMTP (${transporterKey}):`, info.messageId);
    return { success: true, messageId: info.messageId, provider: 'smtp' };
  } catch (err) {
    const detail = err.message || err;
    console.error('Error sending mail:', detail);
    resetTransporter();
    if (options.throwOnError) {
      const wrapped = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
      throw wrapped;
    }
    return { success: false, error: detail };
  }
};

module.exports = sendEmailNotification;
