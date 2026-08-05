const Portfolio = require('../models/Portfolio');
const defaults = require('../data/portfolioDefaults');
const sendEmailNotification = require('../utils/sendEmailNotification');

const ALLOWED_ROOT_KEYS = [
  'profile',
  'social',
  'hero',
  'homeAbout',
  'skills',
  'projects',
  'homeExperience',
  'homeContact',
  'aboutPage',
  'resumePage',
  'experiences',
  'education',
  'blogs',
  'contactPage',
  'seo',
  'footerText',
];

async function ensurePortfolio() {
  let doc = await Portfolio.findOne();
  if (!doc) {
    doc = await Portfolio.create(defaults);
  }
  return doc;
}

exports.getPortfolio = async (req, res, next) => {
  try {
    const doc = await ensurePortfolio();
    return res.status(200).json(doc);
  } catch (error) {
    next(error);
  }
};

exports.updatePortfolio = async (req, res, next) => {
  try {
    const payload = {};
    for (const key of ALLOWED_ROOT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        payload[key] = req.body[key];
      }
    }

    let doc = await Portfolio.findOne();
    if (!doc) {
      doc = await Portfolio.create({ ...defaults, ...payload });
      return res.status(200).json(doc);
    }

    for (const key of Object.keys(payload)) {
      doc.set(key, payload[key]);
      doc.markModified(key);
    }
    await doc.save();
    return res.status(200).json(doc);
  } catch (error) {
    next(error);
  }
};

exports.resetPortfolio = async (req, res, next) => {
  try {
    await Portfolio.deleteMany({});
    const doc = await Portfolio.create(defaults);
    return res.status(200).json(doc);
  } catch (error) {
    next(error);
  }
};

/**
 * Public contact form — sends mail via server SMTP to the portfolio owner.
 * Body: { name, email, message, subject? }
 */
exports.sendContactMessage = async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim();
    const message = String(req.body?.message || '').trim();
    const subjectInput = String(req.body?.subject || '').trim();

    if (!name || !email || !message) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, and message are required',
      });
    }

    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid email address',
      });
    }

    if (message.length > 5000) {
      return res.status(400).json({
        success: false,
        message: 'Message is too long (max 5000 characters)',
      });
    }

    const portfolio = await Portfolio.findOne().lean();
    const ownerEmail =
      (process.env.SMTP_TO || '').trim() ||
      portfolio?.profile?.email ||
      (process.env.SMTP_FROM || '').trim() ||
      (process.env.SMTP_USER || '').trim();

    if (!ownerEmail) {
      return res.status(500).json({
        success: false,
        message: 'Portfolio recipient email is not configured',
      });
    }

    const subject =
      subjectInput ||
      `${portfolio?.contactPage?.mailSubjectPrefix || 'Portfolio contact'} — ${name}`;

    const text = [
      'New message from the Connect portfolio contact form',
      '',
      `Name: ${name}`,
      `Email: ${email}`,
      '',
      'Message:',
      message,
    ].join('\n');

    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
        <h2 style="margin:0 0 12px">New portfolio contact message</h2>
        <p><strong>Name:</strong> ${escapeHtml(name)}</p>
        <p><strong>Email:</strong> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>
        <p><strong>Message:</strong></p>
        <p style="white-space:pre-wrap;border-left:3px solid #6a77ff;padding-left:12px">${escapeHtml(message)}</p>
      </div>
    `;

    const result = await sendEmailNotification(
      ownerEmail,
      subject,
      text,
      name,
      {
        replyTo: email,
        html,
        throwOnError: true,
      }
    );

    return res.status(200).json({
      success: true,
      message: 'Message sent successfully',
      messageId: result.messageId,
    });
  } catch (error) {
    console.error('Portfolio contact mail failed:', error.message || error);
    return res.status(500).json({
      success: false,
      message:
        error.message?.includes('SMTP_USER')
          ? 'Email service is not configured on the server'
          : 'Failed to send message. Please try again later.',
    });
  }
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
