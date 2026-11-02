// False warnings point (approved 01-11-2026): the price check compared by
// substring, so "1.100,00" did not contain "1100.00" and a line printing only
// the line total (3 × 1,75 = 5,25) did not contain 1,75. It now compares by
// value; a real misread must still warn.
import { normalizeRawReceipt } from "../normalizer";
import { amountsOnLine, checkPriceEvidence } from "../evidence";
import { assert, assertEqual, describe, it } from "./harness";

const warnings = (currency: string, name: string, quantity: number, unitPrice: number, lineText: string) =>
  checkPriceEvidence(
    normalizeRawReceipt({
      currency,
      items: [{ name, quantity, unitPrice, sourceEvidence: { lineIndex: 0, lineText } }],
    })
  ).length;

describe("price evidence: compared by value", () => {
  it("Oligark: 1.100,00 is the 1100 read (5 false warnings before)", () => {
    assertEqual(warnings("TRY", "Moskow Mule", 2, 1100, "2 Moskow Mule 1.100,00 2.200,00"), 0);
  });

  it("a line with only the line total: 3 Uni SAFATA DE PAO 5,25 for 1,75 each", () => {
    assertEqual(warnings("EUR", "Safata de pao", 3, 1.75, "3 Uni SAFATA DE PAO 5,25"), 0);
  });

  it("dot or comma decimals both match", () => {
    assertEqual(warnings("EUR", "Bica", 1, 0.9, "1 BICA 0.90"), 0);
    assertEqual(warnings("EUR", "Bica", 1, 0.9, "1 BICA 0,90"), 0);
  });

  it("a space is a thousands mark only before a group of three digits", () => {
    assert(amountsOnLine("1 100,00", "TRY").includes(110000), "1 100,00 is 1100");
    const v = amountsOnLine("1 1.100,00", "TRY");
    assert(v.includes(110000), "1 1.100,00 has 1100");
    assert(!v.includes(1110000), "1 1.100,00 is not 11100");
  });

  it("a real misread still warns: 23,57 read for 23,75 printed", () => {
    assertEqual(warnings("EUR", "Pad Thai", 1, 23.57, "1 PAD THAI 23,75"), 1);
  });

  it("a unit price that matches neither the unit nor the line total still warns", () => {
    assertEqual(warnings("EUR", "Safata de pao", 3, 1.8, "3 Uni SAFATA DE PAO 5,25"), 1);
  });
});
