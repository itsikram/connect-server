// Human-readable one-line preview of a chat message for notifications.
// Attachment-only messages used to produce empty / "Name: undefined" pushes.

const IMAGE_RE = /\.(png|jpe?g|gif|webp|heic|heif|bmp|svg)(\?|$)|\/image\/upload\//i;
const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv|avi|3gp)(\?|$)|\/video\/upload\//i;
const AUDIO_RE = /\.(mp3|wav|ogg|m4a|aac|opus)(\?|$)|\/audio\/|voice-/i;

function messagePreview(msg = {}) {
  const text = typeof msg.message === 'string' ? msg.message.trim() : '';
  const attachment = typeof msg.attachment === 'string' ? msg.attachment : '';

  if (msg.messageType === 'call') {
    if (text) return text;
    const label = msg.callType === 'video' ? 'video' : 'audio';
    return msg.callEvent === 'missed' ? `Missed ${label} call` : `${label === 'video' ? 'Video' : 'Audio'} call`;
  }
  if (msg.messageType === 'audio' || (attachment && AUDIO_RE.test(attachment))) {
    return text || '🎤 Voice message';
  }
  if (attachment) {
    // Cloudinary serves videos under /video/upload/, so check video first.
    const kind = VIDEO_RE.test(attachment) ? '🎥 Video' : IMAGE_RE.test(attachment) ? '📷 Photo' : '📎 Attachment';
    return text ? `${kind}: ${text}` : kind;
  }
  return text || 'New message';
}

// "First Last" from a populated profile, never "undefined undefined".
function senderDisplayName(profile) {
  if (!profile) return 'Someone';
  const first = profile.user?.firstName || '';
  const last = profile.user?.surname || '';
  const joined = `${first} ${last}`.trim();
  return joined || profile.fullName || profile.displayName || profile.username || 'Someone';
}

module.exports = { messagePreview, senderDisplayName };
