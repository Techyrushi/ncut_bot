import {
  isServiceWindowOpen,
  parseWhatsAppTimestamp,
  serviceWindowQuery,
  WHATSAPP_SERVICE_WINDOW_MS,
} from '../src/modules/whatsapp/service-window';

describe('WhatsApp service window', () => {
  const now = Date.UTC(2026, 10, 25, 12, 0, 0);

  it.each([
    [15, true],
    [23, true],
    [24, false],
    [25, false],
  ])('is %i hours after the latest inbound message open: %s', (hours, expected) => {
    const lastInboundAt = new Date(now - Number(hours) * 60 * 60 * 1000);
    expect(isServiceWindowOpen(lastInboundAt, now)).toBe(expected);
  });

  it('uses the exact 24-hour boundary and excludes future inbound timestamps', () => {
    expect(isServiceWindowOpen(new Date(now - WHATSAPP_SERVICE_WINDOW_MS), now)).toBe(false);
    expect(isServiceWindowOpen(new Date(now + 1), now)).toBe(false);
    expect(serviceWindowQuery(now).lastInboundMessageAt).toEqual({
      $gt: new Date(now - WHATSAPP_SERVICE_WINDOW_MS),
      $lte: new Date(now),
    });
  });

  it('normalizes Unix seconds and milliseconds to the same UTC instant', () => {
    const epochSeconds = 1_795_608_000;
    expect(parseWhatsAppTimestamp(String(epochSeconds)).toISOString()).toBe('2026-11-25T12:00:00.000Z');
    expect(parseWhatsAppTimestamp(epochSeconds * 1000).toISOString()).toBe('2026-11-25T12:00:00.000Z');
  });

  it('formats the UTC instant in Asia/Kolkata without changing the stored timestamp', () => {
    const instant = parseWhatsAppTimestamp('1795608000');
    const display = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(instant);
    expect(instant.toISOString()).toBe('2026-11-25T12:00:00.000Z');
    expect(display).toContain('5:30 pm');
  });
});
