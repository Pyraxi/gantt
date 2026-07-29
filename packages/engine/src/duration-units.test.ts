import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration } from './duration-units.js';

describe('parseDuration', () => {
  it('treats a bare number as days (back-compat)', () => {
    expect(parseDuration('5')).toBe(2400);
  });

  it('parses days', () => {
    expect(parseDuration('1d')).toBe(480);
  });

  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(60);
  });

  it('parses minutes with bare m (MS Project convention)', () => {
    expect(parseDuration('1m')).toBe(1);
  });

  it('parses weeks (5 working days)', () => {
    expect(parseDuration('1w')).toBe(2400);
  });

  it('parses months with mo (20 working days)', () => {
    expect(parseDuration('1mo')).toBe(9600);
  });

  it('parses decimals', () => {
    expect(parseDuration('1.5d')).toBe(720);
  });

  it('tolerates whitespace between value and unit', () => {
    expect(parseDuration('2 h')).toBe(120);
  });

  it('is case-insensitive', () => {
    expect(parseDuration('1D')).toBe(480);
  });

  it('returns null for non-numeric input', () => {
    expect(parseDuration('abc')).toBeNull();
  });

  it('returns null for negative durations', () => {
    expect(parseDuration('-1d')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseDuration('')).toBeNull();
  });

  it('returns null for an unknown unit', () => {
    expect(parseDuration('1y')).toBeNull();
  });

  it('honours a custom day length', () => {
    expect(parseDuration('1d', { day: 420, hour: 60, minute: 1, week: 2100, month: 8400 })).toBe(
      420,
    );
  });
});

describe('formatDuration', () => {
  it('formats whole days', () => {
    expect(formatDuration(480)).toBe('1d');
  });

  it('formats a whole number of hours when not a whole day', () => {
    expect(formatDuration(60)).toBe('1h');
  });

  it('formats minutes when not a whole hour', () => {
    expect(formatDuration(30)).toBe('30m');
  });

  it('prefers days for exact multiples (a week shows as days)', () => {
    expect(formatDuration(2400)).toBe('5d');
  });

  it('falls back to hours for 1.5 days', () => {
    expect(formatDuration(720)).toBe('12h');
  });

  it('formats zero as 0d (milestone)', () => {
    expect(formatDuration(0)).toBe('0d');
  });
});
