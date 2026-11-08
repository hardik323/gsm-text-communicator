'use strict';

const { config } = require('../config');

/**
 * Turn a Telegram message into a /location command.
 *
 * Accepts `/location 9876543210`, `/location@your_bot 9876543210`,
 * and human formatting such as `+91 98765-43210`.
 *
 * @param {unknown} input
 * @param {{minDigits?: number, maxDigits?: number}} [limits]
 * @returns {{ok: true, number: string} | {ok: false, reason: string}}
 */
function parseLocationCommand(
  input,
  { minDigits = config.numbers.minDigits, maxDigits = config.numbers.maxDigits } = {},
) {
  if (typeof input !== 'string') return { ok: false, reason: 'not-text' };

  const text = input.trim();
  const match = text.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!match || match[1].toLowerCase() !== 'location') return { ok: false, reason: 'unknown-command' };

  const raw = (match[2] || '').trim();
  if (!raw) return { ok: false, reason: 'missing-number' };
  if (!/^\+?[0-9\s\-().]+$/.test(raw)) return { ok: false, reason: 'invalid-number' };

  const digits = raw.replace(/\D/g, '');
  if (digits.length < minDigits || digits.length > maxDigits) return { ok: false, reason: 'invalid-number' };

  return { ok: true, number: `${raw.startsWith('+') ? '+' : ''}${digits}` };
}

module.exports = { parseLocationCommand };
