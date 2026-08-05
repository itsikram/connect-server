const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const user = (process.env.SMTP_USER || '').trim();
  // Gmail app passwords are often copied with spaces — strip them
  const pass = (process.env.SMTP_PASS || '').trim().replace(/\s+/g, '');

  if (!user || !pass) {
    throw new Error('SMTP_USER and SMTP_PASS must be set in server .env');
  }

  const port = Number(process.env.SMTP_PORT) || 465;
  const secure =
    process.env.SMTP_SECURE === 'true' ||
    (process.env.SMTP_SECURE !== 'false' && port === 465);

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure,
    auth: {
      user,
      pass,
    },
  });

  return transporter;
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
    const mailTransport = getTransporter();
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

    console.log('Mail sent successfully via SMTP:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('Error sending mail:', err.response || err.message || err);
    if (options.throwOnError) throw err;
    return { success: false, error: err.message || err };
  }
};

module.exports = sendEmailNotification;
