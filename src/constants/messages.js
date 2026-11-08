'use strict';

/** Every message the bot sends. Kept together so wording changes happen in one place. */

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

module.exports = { HOW_TO, HINTS, acceptedText, wrongText, failedText, blockedText };
