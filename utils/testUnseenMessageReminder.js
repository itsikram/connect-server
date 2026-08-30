/**
 * Test script for unseen message reminder functionality
 * 
 * Usage: node utils/testUnseenMessageReminder.js [testName]
 * Examples:
 *   node utils/testUnseenMessageReminder.js checkConfig
 *   node utils/testUnseenMessageReminder.js checkMessages
 *   node utils/testUnseenMessageReminder.js testEmail
 */

const mongoose = require('mongoose');
require('dotenv').config();

const Message = require('../models/Message');
const Profile = require('../models/Profile');
const User = require('../models/User');
const sendEmailNotification = require('./sendEmailNotification');

// Color codes for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function section(title) {
  log(`\n${'='.repeat(60)}`, 'cyan');
  log(`  ${title}`, 'cyan');
  log(`${'='.repeat(60)}\n`, 'cyan');
}

async function checkConfig() {
  section('Unseen Message Reminder Configuration Check');

  log('Email Provider Settings (SMTP):', 'bright');
  log(`  EMAIL_PROVIDER: ${process.env.EMAIL_PROVIDER || 'smtp'}`);
  const smtpUser = process.env.SMTP_USER ? '✓ Set' : '✗ Not set';
  const smtpPass = process.env.SMTP_PASS ? '✓ Set' : '✗ Not set';
  log(`  SMTP_USER: ${smtpUser}`, process.env.SMTP_USER ? 'green' : 'red');
  log(`  SMTP_PASS: ${smtpPass}`, process.env.SMTP_PASS ? 'green' : 'red');
  log(`  SMTP_HOST: ${process.env.SMTP_HOST || 'smtp.gmail.com'}`);
  log(`  SMTP_PORT: ${process.env.SMTP_PORT || '587'}`);

  log(`\nWorker Settings:`, 'bright');
  log(`  DELAY_MS: ${process.env.UNSEEN_MESSAGE_REMINDER_DELAY_MS || '300000'} (default: 5 minutes)`);
  log(`  INTERVAL_MS: ${process.env.UNSEEN_MESSAGE_REMINDER_INTERVAL_MS || '60000'} (default: 1 minute)`);
  log(`  STALE_LOCK_MS: ${process.env.UNSEEN_MESSAGE_REMINDER_STALE_LOCK_MS || '600000'} (default: 10 minutes)`);
  log(`  MAX_GROUPS_PER_RUN: ${process.env.UNSEEN_MESSAGE_REMINDER_MAX_GROUPS_PER_RUN || '20'}`);
  log(`  DISABLED: ${process.env.DISABLE_UNSEEN_MESSAGE_REMINDERS === 'true' ? 'YES ⚠️' : 'NO ✓'}`, 
      process.env.DISABLE_UNSEEN_MESSAGE_REMINDERS === 'true' ? 'yellow' : 'green');

  log(`\nClient URL:`, 'bright');
  const clientUrl = process.env.CLIENT_URL || process.env.REACT_APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000';
  log(`  ${clientUrl}`);

  log(`\nEmail From Address:`, 'bright');
  const fromAddress = process.env.SMTP_FROM || process.env.SMTP_USER || 'not-configured';
  const fromName = process.env.SMTP_FROM_NAME || 'Connect';
  log(`  Name: ${fromName}`);
  log(`  Email: ${fromAddress}`);
}

async function checkMessages() {
  section('Unseen Messages Status');

  try {
    // Connect to database
    const mongoUri = process.env.DEV_MONGODB_URI || process.env.PROD_MONGODB_URI;
    if (!mongoUri) {
      log('Error: No MongoDB URI configured', 'red');
      return;
    }

    await mongoose.connect(mongoUri);
    log('Connected to MongoDB ✓', 'green');

    // Count unseen messages
    const totalMessages = await Message.countDocuments({});
    const unseenMessages = await Message.countDocuments({ isSeen: false });
    const withoutReminder = await Message.countDocuments({ 
      isSeen: false, 
      unseenReminderEmailSentAt: null 
    });
    const withReminder = await Message.countDocuments({ 
      isSeen: false, 
      unseenReminderEmailSentAt: { $ne: null } 
    });
    const withError = await Message.countDocuments({ 
      unseenReminderEmailLastError: { $ne: null } 
    });

    log(`Total Messages: ${totalMessages}`);
    log(`Unseen Messages: ${unseenMessages}`);
    log(`  - Pending reminder: ${withoutReminder}`, withoutReminder > 0 ? 'yellow' : 'green');
    log(`  - Reminder sent: ${withReminder}`, withReminder > 0 ? 'green' : 'blue');
    log(`  - With errors: ${withError}`, withError > 0 ? 'red' : 'green');

    // Show recent unseen messages
    log(`\nRecent Unseen Messages (last 5):`, 'bright');
    const recent = await Message.find({ isSeen: false })
      .sort({ timestamp: -1 })
      .limit(5)
      .select('_id senderId receiverId message messageType timestamp isSeen unseenReminderEmailSentAt unseenReminderEmailLastError')
      .lean();

    if (recent.length === 0) {
      log('  No unseen messages', 'blue');
    } else {
      for (const msg of recent) {
        log(`  • ${msg._id}`, 'yellow');
        log(`    From: ${msg.senderId} → To: ${msg.receiverId}`);
        log(`    Type: ${msg.messageType || 'text'}`);
        log(`    Time: ${msg.timestamp.toISOString()}`);
        log(`    Reminder sent: ${msg.unseenReminderEmailSentAt ? 'Yes' : 'No'}`);
        if (msg.unseenReminderEmailLastError) {
          log(`    Error: ${msg.unseenReminderEmailLastError}`, 'red');
        }
      }
    }

    // Show messages with errors
    if (withError > 0) {
      log(`\nMessages with Sending Errors:`, 'bright');
      const errored = await Message.find({ unseenReminderEmailLastError: { $ne: null } })
        .sort({ timestamp: -1 })
        .limit(10)
        .select('_id senderId receiverId unseenReminderEmailLastError')
        .lean();

      for (const msg of errored) {
        log(`  • ${msg._id}`, 'red');
        log(`    Error: ${msg.unseenReminderEmailLastError}`);
      }
    }

    await mongoose.connection.close();
  } catch (error) {
    log(`Error: ${error.message}`, 'red');
    process.exit(1);
  }
}

async function testEmail() {
  section('Email Sending Test');

  try {
    // Verify email provider is configured
    const hasSmtp = !!(process.env.SMTP_USER && process.env.SMTP_PASS);

    if (!hasSmtp) {
      log('SMTP is not configured!', 'red');
      log('\nSet SMTP_USER and SMTP_PASS (Gmail app password).', 'yellow');
      return;
    }

    // Get test email from environment or user
    const testEmail = process.env.TEST_EMAIL || process.argv[3];
    if (!testEmail || !testEmail.includes('@')) {
      log('Usage: node utils/testUnseenMessageReminder.js testEmail your-email@example.com', 'yellow');
      log('\nOr set TEST_EMAIL environment variable', 'yellow');
      return;
    }

    log(`Sending test email to: ${testEmail}`, 'bright');
    log('This may take a few seconds...\n');

    const result = await sendEmailNotification(
      testEmail,
      'Test: Unseen Message Reminder Email',
      'This is a test email from the Connect app unseen message reminder system.',
      'Connect',
      {
        html: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827; max-width: 560px; margin: 0 auto; padding: 24px;">
            <h2 style="margin: 0 0 12px; font-size: 22px;">Test Email Success</h2>
            <p style="margin: 0 0 16px;">This is a test email from the Connect app unseen message reminder system.</p>
            <div style="background: #f3f4f6; border-radius: 12px; padding: 16px; margin: 0 0 20px;">
              <div style="font-size: 13px; color: #6b7280; margin-bottom: 6px;">Test Details</div>
              <div style="font-size: 15px; color: #111827;">
                Sent: ${new Date().toISOString()}<br>
                Email Provider: smtp
              </div>
            </div>
            <p style="margin: 20px 0 0; font-size: 13px; color: #6b7280;">
              If you received this email, your email configuration is working correctly!
            </p>
          </div>
        `,
        throwOnError: true,
      }
    );

    log(`✓ Email sent successfully!`, 'green');
    log(`Provider: ${result.provider}`, 'green');
    log(`Message ID: ${result.messageId}`, 'green');
  } catch (error) {
    log(`✗ Failed to send email`, 'red');
    log(`Error: ${error.message}`, 'red');
    if (error.response?.data) {
      log(`Details: ${JSON.stringify(error.response.data)}`, 'red');
    }
    process.exit(1);
  }
}

async function main() {
  const test = process.argv[2] || 'checkConfig';

  try {
    switch (test) {
      case 'checkConfig':
        checkConfig();
        break;
      case 'checkMessages':
        await checkMessages();
        break;
      case 'testEmail':
        await testEmail();
        break;
      default:
        log(`Unknown test: ${test}`, 'red');
        log('\nAvailable tests:', 'yellow');
        log('  - checkConfig: Verify email provider and worker configuration');
        log('  - checkMessages: Show unseen messages status in database');
        log('  - testEmail: Send a test email to verify delivery');
        process.exit(1);
    }
  } catch (error) {
    log(`Fatal error: ${error.message}`, 'red');
    process.exit(1);
  }
}

main();
