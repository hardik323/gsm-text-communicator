'use strict';

/** Every message the bot sends. Kept together so wording changes happen in one place. */

const { StatusName } = require('./status');

const HOW_TO = [
  '<b>Send it like this</b>',
  '<code>/location {mobile number}</code>',
  '',
  'For example:',
  '<code>/location 9876543210</code>',
].join('\n');

const HINTS = {
  'missing-number': 'You forgot to add the mobile number.',
  'invalid-number': "That doesn't look like a mobile number.",
  'not-text': 'Send the command as a text message.',
  'unknown-command': 'That is not a command I understand.',
};

function acceptedText(number) {
  return [
    '✅ <b>Command accepted</b>',
    '',
    `Please wait a few minutes while we process the location of <code>${number}</code>.`,
    'The result will arrive in this chat automatically, so there is no need to send it again.',
  ].join('\n');
}

function wrongText(reason) {
  return ['🚫 <b>Wrong command</b>', '', HINTS[reason] || HINTS['unknown-command'], '', HOW_TO].join('\n');
}

/** Friendly: "will be" verbiage is derived from the status, so a repeat after it fails is a fresh request. */
const PROGRESS_LABELS = {
  1: 'just created',
  2: 'requested from the carrier',
  5: 'looking up the location',
};

function timeAgo(date) {
  const s = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `about ${Math.round(s / 60)} min ago`;
  if (s < 86400) return `about ${Math.round(s / 3600)} h ago`;
  return `about ${Math.round(s / 86400)} d ago`;
}

function duplicateText(number, status, createdAt) {
  const label = PROGRESS_LABELS[status] || (StatusName[status] || 'in progress').toLowerCase();
  return [
    '⏳ <b>Already in progress</b>',
    '',
    `We already have a request for <code>${number}</code> — it's currently ${label} and it started ${timeAgo(createdAt)}.`,
    '',
    'No need to send it again; the result will arrive in this chat automatically.',
  ].join('\n');
}

function failedText() {
  return [
    '⚠️ <b>Could not save your request</b>',
    '',
    'Something went wrong on our side, so the request was not queued.',
    'Please try again in a moment.',
  ].join('\n');
}

function blockedText(blockMs) {
  const minutes = Math.round(blockMs / 60000);
  return [
    '⛔ <b>Blocked for a while</b>',
    '',
    `Too many wrong commands in a row, so I will ignore you for the next <b>${minutes} ${minutes === 1 ? 'minute' : 'minutes'}</b>.`,
    '',
    HOW_TO,
  ].join('\n');
}

module.exports = { HOW_TO, HINTS, acceptedText, wrongText, duplicateText, failedText, blockedText, timeAgo };
