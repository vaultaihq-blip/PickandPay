// AV-1 (03-11-2026): values with no owner that are not prices — numbers with
// no decimals and a VAT breakdown under the total — are not listed and queue
// nothing. A value that may be a lost item still shows.
import { normalizeRawReceipt } from "../normalizer";
import { evaluateReceipt } from "../diagnostics";
import { meaningfulOrphans } from "../orphans";
import { assertEqual, assert, describe, it } from "./harness";

const receipt = (currency: string, printedTotal: number, orphans: { text: string; amount: number }[]) =>
  evaluateReceipt(
    normalizeRawReceipt({
      currency,
      items: [
        { name: "Moskow Mule", quantity: 2, unitPrice: 1100 },
        { name: "Art of Bosphorus", quantity: 1, unitPrice: 3900 },
      ],
      printedTotal,
      unresolvedLines: orphans.map((o, i) => ({ ...o, lineIndex: 10 + i })),
    })
  );

describe("values with no owner", () => {
  it("Oligark: 05, 16 and the VAT bases 659,02 + 6.040.08 are not shown", () => {
    const r = receipt("TRY", 6700, [
      { text: "05", amount: 5 },
      { text: "16", amount: 16 },
      { text: "659,02", amount: 659.02 },
      { text: "6.040.08", amount: 6040.08 },
    ]);
    assertEqual(meaningfulOrphans(r).length, 0);
  });

  it("a value with decimals that does not make the total still shows", () => {
    const r = receipt("EUR", 96.5, [{ text: "12,50", amount: 12.5 }]);
    assertEqual(meaningfulOrphans(r).length, 1);
  });

  it("three decimals still count as a value (34,502 may be a misread 34,50)", () => {
    const r = receipt("EUR", 96.5, [{ text: "34,502", amount: 34.5 }]);
    assertEqual(meaningfulOrphans(r).length, 1);
  });

  it("a line whose text has no digits is not 'without decimals'", () => {
    const r = receipt("USD", 109.28, [{ text: "Tax", amount: 9.29 }]);
    assertEqual(meaningfulOrphans(r).length, 1);
  });

  it("in a currency without decimals, a whole number is a value", () => {
    const r = receipt("JPY", 5000, [{ text: "1200", amount: 1200 }]);
    assertEqual(meaningfulOrphans(r).length, 1);
  });

  it("four values near the total by chance are not a VAT breakdown", () => {
    const r = receipt("INR", 5226, [
      { text: "15.19", amount: 15.19 },
      { text: "130.00", amount: 130 },
      { text: "280.00", amount: 280 },
      { text: "4797,48", amount: 4797.48 },
    ]);
    assert(meaningfulOrphans(r).length === 4, "all four still shown");
  });
});
