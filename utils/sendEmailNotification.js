const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    throw new Error('SMTP_USER and SMTP_PASS must be set in server .env');
  }

  // Gmail SMTP (gsmtp) via nodemailer
  transporter = nodemailer.createTransport({
    service: 'gmail',
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_SECURE !== 'false',
    auth: {
      user,
      pass,
    },
  });

  return transporter;
}

/**
 * Send an email via Gmail SMTP (gsmtp).
 * @param {string} email - Recipient address
 * @param {string|null} subject - Email subject (optional)
 * @param {string} message - Plain-text body
 * @param {string} senderName - Display name used in From / default subject
 */
let sendEmailNotification = async (email, subject = null, message, senderName) => {
  if (!email) {
    console.error('Error sending mail: missing recipient email');
    return;
  }

  try {
    const mailTransport = getTransporter();
    const fromAddress = process.env.SMTP_FROM || process.env.SMTP_USER;
    const fromName = senderName || process.env.SMTP_FROM_NAME || 'Connect';

    const info = await mailTransport.sendMail({
      from: `"${fromName}" <${fromAddress}>`,
      to: email,
      subject: subject || `New message from ${senderName || 'Connect'} On Connect`,
      text: message,
    });

    console.log('Mail sent successfully via gsmtp:', info.messageId);
  } catch (err) {
    console.error('Error sending mail:', err.response || err.message || err);
  }
};

module.exports = sendEmailNotification;
