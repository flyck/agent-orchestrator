import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { clockTs, formatTs, relativeTs } from './time';

describe('formatTs', () => {
  test('valid epoch ms → ISO-ish UTC string', () => {
    // 2026-05-07T13:14:15Z
    const ms = Date.UTC(2026, 4, 7, 13, 14, 15);
    expect(formatTs(ms)).toBe('2026-05-07 13:14:15 UTC');
  });

  test('non-finite or non-positive → em dash', () => {
    expect(formatTs(0)).toBe('—');
    expect(formatTs(-1)).toBe('—');
    expect(formatTs(NaN)).toBe('—');
    expect(formatTs(Infinity)).toBe('—');
  });
});

describe('clockTs', () => {
  test('renders local HH:MM:SS', () => {
    // Use a known local time. Build via Date so the string reflects
    // the host's timezone — test asserts shape, not exact value.
    const out = clockTs(Date.now());
    expect(out).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test('non-finite → em dash', () => {
    expect(clockTs(0)).toBe('—');
    expect(clockTs(NaN)).toBe('—');
  });
});

describe('relativeTs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('< 60s → seconds ago', () => {
    expect(relativeTs(Date.now() - 5000)).toBe('5s ago');
    expect(relativeTs(Date.now() - 30_000)).toBe('30s ago');
  });

  test('< 1h → minutes ago', () => {
    expect(relativeTs(Date.now() - 5 * 60_000)).toBe('5m ago');
    expect(relativeTs(Date.now() - 59 * 60_000)).toBe('59m ago');
  });

  test('< 1d → hours ago', () => {
    expect(relativeTs(Date.now() - 2 * 3_600_000)).toBe('2h ago');
    expect(relativeTs(Date.now() - 23 * 3_600_000)).toBe('23h ago');
  });

  test('>= 1d → days ago', () => {
    expect(relativeTs(Date.now() - 2 * 86_400_000)).toBe('2d ago');
    expect(relativeTs(Date.now() - 30 * 86_400_000)).toBe('30d ago');
  });

  test('future timestamps clamp to 0s', () => {
    // diff is Math.max(0, now - ms), so future ms still reads as
    // "0s ago" rather than negative.
    expect(relativeTs(Date.now() + 10_000)).toBe('0s ago');
  });

  test('non-finite or non-positive → em dash', () => {
    expect(relativeTs(0)).toBe('—');
    expect(relativeTs(-1)).toBe('—');
    expect(relativeTs(NaN)).toBe('—');
  });
});
