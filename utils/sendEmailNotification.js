const nodemailer = require('nodemailer');
const axios = require('axios');
const dns = require('dns');

// Prefer IPv4 when Node resolves hosts (helps local SMTP; Render still blocks SMTP ports)
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
  const fromAddress = (
    process.env.RESEND_FROM ||
    process.env.SENDGRID_FROM ||
    process.env.SMTP_FROM ||
    process.env.SMTP_USER ||
    ''
  ).trim();
  return { fromName, fromAddress };
}

function resolveProvider() {
  const forced = (process.env.EMAIL_PROVIDER || '').trim().toLowerCase();
  if (forced === 'resend' || forced === 'sendgrid' || forced === 'smtp') {
    return forced;
  }
  // Render / most PaaS block outbound SMTP — prefer HTTPS APIs when configured
  if ((process.env.RESEND_API_KEY || '').trim()) return 'resend';
  if ((process.env.SENDGRID_API_KEY || '').trim()) return 'sendgrid';
  return 'smtp';
}

async function sendViaResend({ to, fromName, fromAddress, subject, text, html, replyTo }) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');

  // Free Resend accounts can use onboarding@resend.dev until a domain is verified
  const from =
    fromAddress.includes('<')
      ? fromAddress
      : `"${fromName}" <${fromAddress || 'onboarding@resend.dev'}>`;

  const { data } = await axios.post(
    'https://api.resend.com/emails',
    {
      from,
      to: [to],
      subject,
      text,
      ...(html ? { html } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: Number(process.env.SMTP_CONNECTION_TIMEOUT) || 20000,
    }
  );

  return { success: true, messageId: data.id, provider: 'resend' };
}

async function sendViaSendGrid({ to, fromName, fromAddress, subject, text, html, replyTo }) {
  const apiKey = (process.env.SENDGRID_API_KEY || '').trim();
  if (!apiKey) throw new Error('SENDGRID_API_KEY is not set');
  if (!fromAddress) throw new Error('SENDGRID_FROM or SMTP_FROM must be set');

  const { data, headers } = await axios.post(
    'https://api.sendgrid.com/v3/mail/send',
    {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: fromAddress, name: fromName },
      subject,
      content: [
        { type: 'text/plain', value: text || ' ' },
        ...(html ? [{ type: 'text/html', value: html }] : []),
      ],
      ...(replyTo ? { reply_to: { email: replyTo } } : {}),
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: Number(process.env.SMTP_CONNECTION_TIMEOUT) || 20000,
      validateStatus: (s) => s < 300,
    }
  );

  const messageId = headers['x-message-id'] || data?.id || 'sendgrid';
  return { success: true, messageId, provider: 'sendgrid' };
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
    throw new Error(
      'No email provider configured. Set RESEND_API_KEY (recommended on Render) ' +
        'or SMTP_USER/SMTP_PASS for local SMTP.'
    );
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
      'Render (and many hosts) block outbound SMTP on 587/465. ' +
      'Set RESEND_API_KEY in the Render env and redeploy — email will use HTTPS instead.'
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

async function sendViaSmtp(email, subject, message, senderName, options) {
  const mailTransport = await getTransporter();
  const { fromName, fromAddress } = getFromAddress(senderName);

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
}

/**
 * Send an email via Resend/SendGrid (HTTPS — works on Render) or SMTP (local).
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

  const provider = resolveProvider();
  const { fromName, fromAddress } = getFromAddress(senderName);
  const mailSubject = subject || `New message from ${senderName || 'Connect'} On Connect`;

  try {
    if (provider === 'resend') {
      console.log('Mail: sending via Resend (HTTPS)...');
      const result = await sendViaResend({
        to: email,
        fromName,
        fromAddress: fromAddress || 'onboarding@resend.dev',
        subject: mailSubject,
        text: message,
        html: options.html,
        replyTo: options.replyTo,
      });
      console.log('Mail sent successfully via Resend:', result.messageId);
      return result;
    }

    if (provider === 'sendgrid') {
      console.log('Mail: sending via SendGrid (HTTPS)...');
      const result = await sendViaSendGrid({
        to: email,
        fromName,
        fromAddress,
        subject: mailSubject,
        text: message,
        html: options.html,
        replyTo: options.replyTo,
      });
      console.log('Mail sent successfully via SendGrid:', result.messageId);
      return result;
    }

    return await sendViaSmtp(email, subject, message, senderName, options);
  } catch (err) {
    const detail =
      err.response?.data?.message ||
      err.response?.data?.errors?.[0]?.message ||
      err.message ||
      err;
    console.error('Error sending mail:', detail);
    if (provider === 'smtp') resetTransporter();
    if (options.throwOnError) {
      const wrapped = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
      throw wrapped;
    }
    return { success: false, error: detail };
  }
};

module.exports = sendEmailNotification;
