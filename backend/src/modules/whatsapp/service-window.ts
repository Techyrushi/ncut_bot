export const WHATSAPP_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function parseWhatsAppTimestamp(value: string | number): Date {
  const timestamp = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new Error('Incoming WhatsApp message has an invalid timestamp');
  }
  const milliseconds = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) throw new Error('Incoming WhatsApp message has an invalid timestamp');
  return date;
}

export function isServiceWindowOpen(lastInboundMessageAt: Date | string | null | undefined, now = Date.now()): boolean {
  if (!lastInboundMessageAt) return false;
  const timestamp = lastInboundMessageAt instanceof Date
    ? lastInboundMessageAt.getTime()
    : new Date(lastInboundMessageAt).getTime();
  const age = now - timestamp;
  return Number.isFinite(timestamp) && age >= 0 && age < WHATSAPP_SERVICE_WINDOW_MS;
}

export function serviceWindowQuery(now = Date.now()): { lastInboundMessageAt: { $gt: Date; $lte: Date } } {
  return {
    lastInboundMessageAt: {
      $gt: new Date(now - WHATSAPP_SERVICE_WINDOW_MS),
      $lte: new Date(now),
    },
  };
}
