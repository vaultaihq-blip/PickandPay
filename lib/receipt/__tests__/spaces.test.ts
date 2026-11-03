// 03-11-2026 (owner): "Çerez & Meyva   1     600,00" was read as 1600. A space
// groups thousands only as ONE space before exactly 3 digits — the same rule
// in parseMoneyString and in the price check as in the parser (ledger.ts).
import { isSpaceGroupedNumber, parseMoneyString } from "../money";
import { amountsOnLine } from "../evidence";
import { assert, assertEqual, describe, it } from "./harness";

describe("numbers with spaces: one rule", () => {
  it("one space before exactly 3 digits is a thousands mark", () => {
    assertEqual(parseMoneyString("1 100,00", "EUR")?.minor, 110000);
    assertEqual(parseMoneyString("12 345 678.90", "EUR")?.minor, 1234567890);
    assertEqual(parseMoneyString("6 700,00", "TRY")?.minor, 670000);
  });

  it("more than one space, or not 3 digits after it, is never one number", () => {
    assertEqual(parseMoneyString("1     600,00", "TRY"), null);
    assertEqual(parseMoneyString("1  600,00", "TRY"), null);
    assertEqual(parseMoneyString("1 60,00", "EUR"), null);
    assert(!isSpaceGroupedNumber("1  600,00"), "two spaces");
  });

  it("a sign followed by a space is still one amount", () => {
    assertEqual(parseMoneyString("- 4,50", "EUR")?.minor, -450);
  });

  it("the price check reads 1 and 600, never 1600, on the Oligark line", () => {
    const values = amountsOnLine("Çerez & Meyva          1     600,00", "TRY");
    assert(values.includes(60000), "600,00 is on the line");
    assert(!values.includes(160000), "1600 is never made up");
  });

  it("the price check still joins a real 1 100,00", () => {
    assert(amountsOnLine("TOTAL 1 100,00", "EUR").includes(110000), "1 100,00 is 1100");
  });
});
