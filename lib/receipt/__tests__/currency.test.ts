// Currency point (02-11-2026): a Turkish receipt read as TRY was shown in EUR
// (the app knew 12 currencies, the legacy receipt only 4), and the payment
// screen showed "6700.00€". The receipt keeps its own currency everywhere,
// an unknown one is flagged for the host, and amounts follow the language.
import { evaluateReceipt } from "../diagnostics";
import { normalizeRawReceipt, type RawReceiptPayload } from "../normalizer";
import { toParsedReceipt } from "../adapter";
import { normalizeCurrencyCode } from "../money";
import { normalizeReceipt } from "@/utils/parser";
import { formatCurrency, setMoneyLanguage } from "@/utils/formatter";
import { assert, assertEqual, describe, it } from "./harness";

const oligark = (currency: unknown): RawReceiptPayload => ({
  merchant: "OLIGARK ISTANBUL",
  currency,
  items: [
    { name: "Moskow Mule", quantity: 2, unitPrice: 1100 },
    { name: "Wisky Sour", quantity: 2, unitPrice: 1100 },
  ],
  printedTotal: 4400,
});

// The same path as utils/analyzeReceipt.ts for a schemaVersion 2 answer.
const bridge = (raw: RawReceiptPayload) => {
  const legacy = toParsedReceipt(evaluateReceipt(normalizeRawReceipt(raw)));
  return normalizeReceipt({ ...legacy, printed_total: 4400 });
};

describe("currency: the receipt keeps its own currency", () => {
  it("TRY from the parser stays TRY (it became EUR)", () => {
    const r = bridge(oligark("TRY"));
    assertEqual(r.currency, "TRY");
    assert(!r.currencyAssumed, "a known currency is not flagged");
  });

  it("the ₺ sign and TL are read as TRY", () => {
    assertEqual(normalizeCurrencyCode("₺"), "TRY");
    assertEqual(normalizeCurrencyCode("tl"), "TRY");
  });

  it("an unknown or missing currency is flagged for the host, not silently EUR", () => {
    for (const raw of ["XYZ", "", undefined]) {
      const r = bridge(oligark(raw));
      assert(r.currencyAssumed === true, `flagged for ${JSON.stringify(raw)}`);
    }
  });

  it("the amounts do not change with the currency", () => {
    const tr = bridge(oligark("TRY"));
    const eur = bridge(oligark("EUR"));
    assertEqual(tr.validation.computedTotal, eur.validation.computedTotal);
    assertEqual(tr.validation.computedTotal, 4400);
  });
});

describe("currency: one money format, in the app's language", () => {
  it("Portuguese: 6.700,00 ₺ (the payment screen showed 6700.00€)", () => {
    setMoneyLanguage("pt");
    assertEqual(formatCurrency(6700, "TRY"), "6.700,00 ₺");
    assertEqual(formatCurrency(61.4, "EUR"), "61,40 €");
    assertEqual(formatCurrency(1234567.5, "EUR"), "1.234.567,50 €");
  });

  it("English: ₺6,700.00, and a code where there is no sign", () => {
    setMoneyLanguage("en");
    assertEqual(formatCurrency(6700, "TRY"), "₺6,700.00");
    assertEqual(formatCurrency(12.5, "CHF"), "CHF 12.50");
  });

  it("currencies without cents show none, and a minus stays in front", () => {
    setMoneyLanguage("en");
    assertEqual(formatCurrency(1500, "JPY"), "¥1,500");
    assertEqual(formatCurrency(-5, "EUR"), "-€5.00");
    setMoneyLanguage("pt");
    assertEqual(formatCurrency(-5, "EUR"), "-5,00 €");
  });
});
