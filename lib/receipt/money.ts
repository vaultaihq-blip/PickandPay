/**
 * receiptMoney — deterministic monetary arithmetic in integer minor units.
 *
 * All reconciliation math in the receipt pipeline MUST go through this module.
 * Floating point arithmetic on currency amounts is not permitted anywhere in
 * the parsing / reconciliation / diagnostics path.
 */

// ─── Currency metadata ────────────────────────────────────────────────────────

/**
 * ISO 4217 codes the app knows (currency point, 02-11-2026: it knew 12, and
 * a Turkish receipt read as TRY was shown in EUR). A code outside this list
 * is not trusted: the review asks the host which currency it is.
 */
export const SUPPORTED_CURRENCIES = [
  "EUR",
  "USD",
  "CAD",
  "GBP",
  "JPY",
  "CHF",
  "AUD",
  "HKD",
  "SGD",
  "CNY",
  "BRL",
  "MXN",
  "TRY",
  "INR",
  "KRW",
  "THB",
  "VND",
  "IDR",
  "MYR",
  "PHP",
  "TWD",
  "NZD",
  "ZAR",
  "AED",
  "SAR",
  "QAR",
  "ILS",
  "EGP",
  "MAD",
  "SEK",
  "NOK",
  "DKK",
  "ISK",
  "PLN",
  "CZK",
  "HUF",
  "RON",
  "BGN",
  "RSD",
  "UAH",
  "GEL",
  "ARS",
  "CLP",
  "COP",
  "PEN",
  "UYU",
] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

/** Currencies with no minor unit (1 major unit == 1 minor unit). */
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "JPY",
  "KRW",
  "VND",
  "CLP",
  "ISK",
  "XAF",
  "XOF",
]);

/** Number of decimal places a currency uses. */
export function currencyExponent(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

/** How many minor units make one major unit (100 for EUR, 1 for JPY). */
export function minorUnitScale(currency: string): number {
  return currencyExponent(currency) === 0 ? 1 : 100;
}

export function isSupportedCurrency(value: string): value is CurrencyCode {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(
    value.toUpperCase()
  );
}

/**
 * Coerce an arbitrary string into a supported ISO code.
 * Returns null when the value cannot be trusted — callers must decide the
 * fallback explicitly rather than silently defaulting to EUR.
 */
export function normalizeCurrencyCode(
  raw: string | null | undefined
): CurrencyCode | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toUpperCase();
  if (trimmed.length === 0) return null;
  if (isSupportedCurrency(trimmed)) return trimmed;

  // Common symbol / alias mapping. Deliberately conservative: ambiguous
  // symbols such as a bare "$" are NOT resolved here, because guessing
  // between USD and CAD silently corrupts every amount on the receipt.
  const aliases: Record<string, CurrencyCode> = {
    "€": "EUR",
    EURO: "EUR",
    EUROS: "EUR",
    "£": "GBP",
    STERLING: "GBP",
    "¥": "JPY",
    YEN: "JPY",
    "US$": "USD",
    USD$: "USD",
    "C$": "CAD",
    CA$: "CAD",
    CAD$: "CAD",
    "A$": "AUD",
    "HK$": "HKD",
    "S$": "SGD",
    "R$": "BRL",
    "₺": "TRY",
    TL: "TRY",
    YTL: "TRY",
    "₹": "INR",
    "₩": "KRW",
    "฿": "THB",
    "₪": "ILS",
    "ZŁ": "PLN",
    "KČ": "CZK",
    FT: "HUF",
  };
  return aliases[trimmed] ?? null;
}

// ─── Money value ──────────────────────────────────────────────────────────────

/**
 * An exact monetary amount held as integer minor units.
 * Construct only through the helpers below so the integer invariant holds.
 */
export interface Money {
  /** Integer. Negative values are allowed (discounts, deltas). */
  readonly minor: number;
  readonly currency: CurrencyCode;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

function assertSafeInteger(value: number, context: string): void {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`${context}: value is not finite (${value})`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${context}: value is not a safe integer (${value})`);
  }
}

export function moneyFromMinor(
  minor: number,
  currency: CurrencyCode
): Money {
  assertSafeInteger(minor, "moneyFromMinor");
  return { minor, currency };
}

export function zeroMoney(currency: CurrencyCode): Money {
  return { minor: 0, currency };
}

/**
 * Convert a numeric major-unit amount (e.g. 23.75) into exact minor units.
 * Rejects NaN / Infinity and values large enough to lose precision.
 */
export function moneyFromMajorNumber(
  amount: number,
  currency: CurrencyCode
): Money {
  if (!Number.isFinite(amount)) {
    throw new MoneyError(`moneyFromMajorNumber: non-finite amount (${amount})`);
  }
  const scale = minorUnitScale(currency);
  // Round half away from zero, mirroring how printed receipts round.
  const scaled = amount * scale;
  const minor =
    scaled < 0 ? -Math.round(Math.abs(scaled)) : Math.round(scaled);
  assertSafeInteger(minor, "moneyFromMajorNumber");
  return { minor, currency };
}

/**
 * Parse a monetary string as printed on a receipt.
 *
 * Handles: "1.234,56"  "1,234.56"  "23.75"  "23,75"  "€23,75"  "$1,234.56"
 *          "(4.50)" and "-4.50" as negatives, "1 234,56" with space separators.
 *
 * Returns null when the input cannot be parsed unambiguously — callers must
 * treat null as "unreadable", never as zero.
 */
export function parseMoneyString(
  raw: string,
  currency: CurrencyCode
): Money | null {
  if (typeof raw !== "string") return null;

  let text = raw.trim();
  if (text.length === 0) return null;

  // Parenthesised accounting negatives: (4.50)
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }

  // Strip currency symbols, ISO codes and whitespace used as grouping.
  text = text.replace(/[A-Za-z$€£¥₩₹]/g, "").trim();
  text = text.replace(/[\s\u00A0\u202F']/g, "");

  if (text.startsWith("-")) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }

  if (text.length === 0) return null;
  if (!/^[0-9.,]+$/.test(text)) return null;

  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");

  let integerPart: string;
  let fractionPart: string;

  if (lastDot === -1 && lastComma === -1) {
    integerPart = text;
    fractionPart = "";
  } else {
    // The right-most separator is the decimal separator *if* it is followed
    // by 1-2 digits; otherwise every separator is a thousands separator.
    const sepIndex = Math.max(lastDot, lastComma);
    const tail = text.slice(sepIndex + 1);
    const isDecimalSeparator =
      tail.length > 0 && tail.length <= 2 && /^[0-9]+$/.test(tail);

    if (isDecimalSeparator) {
      integerPart = text.slice(0, sepIndex);
      fractionPart = tail;
    } else {
      integerPart = text;
      fractionPart = "";
    }
  }

  // Remaining separators inside the integer part must be grouping marks.
  integerPart = integerPart.replace(/[.,]/g, "");
  if (integerPart.length === 0) integerPart = "0";
  if (!/^[0-9]+$/.test(integerPart)) return null;
  if (fractionPart.length > 0 && !/^[0-9]+$/.test(fractionPart)) return null;

  const exponent = currencyExponent(currency);
  let minorString: string;

  if (exponent === 0) {
    // Zero-decimal currency: a fractional part is a parsing artefact.
    // "1.234" in JPY means 1234, not 1.234.
    minorString = integerPart + fractionPart;
  } else {
    const padded = (fractionPart + "00").slice(0, exponent);
    minorString = integerPart + padded;
  }

  const parsed = Number(minorString);
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) return null;

  return { minor: negative ? -parsed : parsed, currency };
}

/**
 * Accept whatever the model returned for an amount (number or string) and
 * produce exact minor units, or null when unusable.
 */
export function coerceMoney(
  value: unknown,
  currency: CurrencyCode
): Money | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    try {
      return moneyFromMajorNumber(value, currency);
    } catch {
      return null;
    }
  }
  if (typeof value === "string") return parseMoneyString(value, currency);
  return null;
}

// ─── Arithmetic ───────────────────────────────────────────────────────────────

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(
      `currency mismatch: ${a.currency} vs ${b.currency}`
    );
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return moneyFromMinor(a.minor + b.minor, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return moneyFromMinor(a.minor - b.minor, a.currency);
}

export function sumMoney(values: readonly Money[], currency: CurrencyCode): Money {
  let total = 0;
  for (const value of values) {
    if (value.currency !== currency) {
      throw new MoneyError(
        `currency mismatch in sum: ${value.currency} vs ${currency}`
      );
    }
    total += value.minor;
  }
  assertSafeInteger(total, "sumMoney");
  return { minor: total, currency };
}

/** Multiply by an integer quantity. Quantities are never fractional. */
export function multiplyMoney(a: Money, quantity: number): Money {
  if (!Number.isInteger(quantity)) {
    throw new MoneyError(`multiplyMoney: quantity must be an integer (${quantity})`);
  }
  return moneyFromMinor(a.minor * quantity, a.currency);
}

export function negateMoney(a: Money): Money {
  return moneyFromMinor(-a.minor, a.currency);
}

export function absMoney(a: Money): Money {
  return moneyFromMinor(Math.abs(a.minor), a.currency);
}

export function isZeroMoney(a: Money): boolean {
  return a.minor === 0;
}

export function moneyEquals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}

/** Compare magnitudes: -1, 0, or 1. */
export function compareMoney(a: Money, b: Money): number {
  assertSameCurrency(a, b);
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  return 0;
}

// ─── Presentation ─────────────────────────────────────────────────────────────

/** Major-unit number, for display and for persisting to existing schemas. */
export function moneyToMajorNumber(a: Money): number {
  return a.minor / minorUnitScale(a.currency);
}

/** Plain decimal string without a currency symbol, e.g. "374.25" / "499". */
export function moneyToDecimalString(a: Money): string {
  const exponent = currencyExponent(a.currency);
  const negative = a.minor < 0;
  const digits = Math.abs(a.minor).toString();

  if (exponent === 0) return `${negative ? "-" : ""}${digits}`;

  const padded = digits.padStart(exponent + 1, "0");
  const integerPart = padded.slice(0, padded.length - exponent);
  const fractionPart = padded.slice(padded.length - exponent);
  return `${negative ? "-" : ""}${integerPart}.${fractionPart}`;
}
