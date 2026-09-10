/**
 * Identifiers.
 *
 * `id` is opaque and unique; `displayId` is what an operator reads out on site
 * and writes on a form, so it is short, sortable and derived from the capture
 * time.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U

function randomSuffix(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

export function createId(prefix: string, at: Date = new Date()): string {
  return `${prefix}-${at.getTime().toString(36).toUpperCase()}-${randomSuffix(6)}`;
}

/** e.g. FV-260910-1423-7QK */
export function createDisplayId(prefix = 'FV', at: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${String(at.getFullYear()).slice(2)}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}`;
  return `${prefix}-${date}-${time}-${randomSuffix(3)}`;
}
