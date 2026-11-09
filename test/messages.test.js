'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { HOW_TO, acceptedText, wrongText, duplicateText, failedText, blockedText } = require('../src/constants/messages');

describe('messages', () => {
  it('states the command format exactly once in HOW_TO', () => {
    assert.match(HOW_TO, /\/location \{mobile number\}/);
    assert.match(HOW_TO, /\/location 9876543210/);
  });

  it('acknowledges with the requested number', () => {
    const text = acceptedText('+919876543210');
    assert.match(text, /Command accepted/);
    assert.match(text, /wait a few minutes/i);
    assert.match(text, /\+919876543210/);
  });

  it('always tells the user the correct command, whatever went wrong', () => {
    for (const reason of ['missing-number', 'invalid-number', 'not-text', 'unknown-command', 'something-else']) {
      const text = wrongText(reason);
      assert.match(text, /Wrong command/, `reason ${reason}`);
      assert.match(text, /\/location \{mobile number\}/, `reason ${reason}`);
    }
  });

  it('adds a specific hint per reason', () => {
    assert.match(wrongText('missing-number'), /forgot to add the mobile number/i);
    assert.match(wrongText('invalid-number'), /doesn't look like a mobile number/i);
    assert.match(wrongText('not-text'), /as a text message/i);
    assert.match(wrongText('unknown-command'), /not a command I understand/i);
  });

  it('falls back to the generic hint for an unknown reason', () => {
    assert.match(wrongText('brand-new-reason'), /not a command I understand/i);
  });

  it('explains the block in whole minutes and repeats the command', () => {
    assert.match(blockedText(60 * 1000), /next <b>1 minute<\/b>/);
    assert.match(blockedText(2 * 60 * 1000), /next <b>2 minutes<\/b>/);
    assert.match(blockedText(120 * 1000), /\/location \{mobile number\}/);
  });

  it('tells a repeat caller that the request is already in progress', () => {
    const text = duplicateText('+919876543210', 1, new Date());
    assert.match(text, /Already in progress/);
    assert.match(text, /\+919876543210/);
    assert.match(text, /just created/);
    assert.match(text, /just now/);
    assert.match(text, /No need to send it again/);
  });

  it('describes later open statuses in plain words', () => {
    assert.match(duplicateText('1', 2, new Date()), /requested from the carrier/);
    assert.match(duplicateText('1', 5, new Date()), /looking up the location/);
  });

  it('tells the user when the request could not be stored', () => {
    assert.match(failedText(), /Could not save your request/i);
    assert.match(failedText(), /try again/i);
  });
});
