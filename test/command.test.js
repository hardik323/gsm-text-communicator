'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseLocationCommand } = require('../src/telegram/command');

describe('parseLocationCommand', () => {
  it('accepts a plain number', () => {
    assert.deepEqual(parseLocationCommand('/location 9876543210'), { ok: true, number: '9876543210' });
  });

  it('accepts +, spaces, dashes and brackets', () => {
    assert.deepEqual(parseLocationCommand('/location +91 98765-43210'), { ok: true, number: '+919876543210' });
    assert.deepEqual(parseLocationCommand('/location (98765) 432.10'), { ok: true, number: '9876543210' });
  });

  it('accepts a /command@botname suffix', () => {
    assert.deepEqual(parseLocationCommand('/location@geo_bot 9876543210'), { ok: true, number: '9876543210' });
  });

  it('trims surrounding whitespace', () => {
    assert.deepEqual(parseLocationCommand('   /location   9876543210  '), { ok: true, number: '9876543210' });
  });

  it('rejects a missing number with a distinct reason', () => {
    assert.equal(parseLocationCommand('/location').reason, 'missing-number');
    assert.equal(parseLocationCommand('/location   ').reason, 'missing-number');
  });

  it('rejects non-numeric input', () => {
    assert.equal(parseLocationCommand('/location abc').reason, 'invalid-number');
    assert.equal(parseLocationCommand('/location 9876abc210').reason, 'invalid-number');
  });

  it('enforces the digit limits', () => {
    assert.equal(parseLocationCommand('/location 123').reason, 'invalid-number');
    assert.equal(parseLocationCommand('/location 9876543210123456').reason, 'invalid-number');
  });

  it('rejects other commands and plain text', () => {
    assert.equal(parseLocationCommand('/start').reason, 'unknown-command');
    assert.equal(parseLocationCommand('/locationx 9876543210').reason, 'unknown-command');
    assert.equal(parseLocationCommand('/locations 9876543210').reason, 'unknown-command');
    assert.equal(parseLocationCommand('hello').reason, 'unknown-command');
  });

  it('rejects non-text messages such as photos', () => {
    assert.equal(parseLocationCommand(undefined).reason, 'not-text');
    assert.equal(parseLocationCommand(null).reason, 'not-text');
    assert.equal(parseLocationCommand(42).reason, 'not-text');
  });

  it('honours caller-supplied digit limits', () => {
    assert.equal(parseLocationCommand('/location 1234567', { minDigits: 10 }).reason, 'invalid-number');
    assert.deepEqual(parseLocationCommand('/location 1234567', { minDigits: 5 }), { ok: true, number: '1234567' });
    assert.equal(parseLocationCommand('/location 123456789', { maxDigits: 8 }).reason, 'invalid-number');
  });
});
