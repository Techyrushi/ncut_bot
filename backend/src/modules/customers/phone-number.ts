export function normalizePhoneNumber(raw: string): string | undefined {
  let digits = raw.trim().replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10) digits = `91${digits}`;
  else if (digits.length === 11 && digits.startsWith('0')) digits = `91${digits.slice(1)}`;
  if (digits.length < 11 || digits.length > 15 || digits.startsWith('0')) return undefined;
  return digits;
}

export function phoneNumberCandidates(phoneNumber: string): string[] {
  const candidates = new Set([phoneNumber, `+${phoneNumber}`]);
  if (phoneNumber.startsWith('91')) {
    const localNumber = phoneNumber.slice(2);
    candidates.add(localNumber);
    candidates.add(`+${localNumber}`);
    candidates.add(`0${localNumber}`);
  }
  return [...candidates];
}
