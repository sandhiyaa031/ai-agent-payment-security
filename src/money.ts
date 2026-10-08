/** All amounts are integer US cents; decimal strings only appear at the edges. */
export type Cents = number;

const DECIMAL = /^\d+(\.\d{1,2})?$/;

/** Parses "12", "12.3" or "12.34" into cents. Throws on anything else. */
export function toCents(value: string): Cents {
  const trimmed = value.trim();
  if (!DECIMAL.test(trimmed)) {
    throw new Error(`Not a valid dollar amount: "${value}"`);
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** Formats cents as the "12.34" string PayPal expects. */
export function toDecimal(cents: Cents): string {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`Not a valid cent amount: ${cents}`);
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function usd(cents: Cents): string {
  return `$${toDecimal(cents)}`;
}
