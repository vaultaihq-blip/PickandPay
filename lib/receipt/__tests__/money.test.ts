import {
  addMoney,
  coerceMoney,
  currencyExponent,
  moneyFromMajorNumber,
  moneyToDecimalString,
  moneyToMajorNumber,
  multiplyMoney,
  normalizeCurrencyCode,
  parseMoneyString,
  subtractMoney,
  sumMoney,
} from "../money";
import { assert, assertEqual, assertThrows, describe, it } from "./harness";

describe("money: parsing", () => {
  it("parses a plain dot decimal", () => {
    const money = parseMoneyString("23.75", "CAD");
    assertEqual(money?.minor, 2375);
  });

  it("parses a comma decimal (EUR style)", () => {
    const money = parseMoneyString("23,75", "EUR");
    assertEqual(money?.minor, 2375);
  });

  it("parses dot thousands with comma decimal", () => {
    const money = parseMoneyString("1.234,56", "EUR");
    assertEqual(money?.minor, 123456);
  });

  it("parses comma thousands with dot decimal", () => {
    const money = parseMoneyString("1,234.56", "USD");
    assertEqual(money?.minor, 123456);
  });

  it("treats a 3-digit group as thousands, not decimals", () => {
    const money = parseMoneyString("1,234", "USD");
    assertEqual(money?.minor, 123400);
  });

  it("parses space-separated thousands", () => {
    const money = parseMoneyString("1 234,56", "EUR");
    assertEqual(money?.minor, 123456);
  });

  it("strips currency symbols", () => {
    assertEqual(parseMoneyString("€23,75", "EUR")?.minor, 2375);
    assertEqual(parseMoneyString("$1,234.56", "USD")?.minor, 123456);
    assertEqual(parseMoneyString("C$48.00", "CAD")?.minor, 4800);
  });

  it("handles negatives and accounting parentheses", () => {
    assertEqual(parseMoneyString("-4.50", "USD")?.minor, -450);
    assertEqual(parseMoneyString("(4.50)", "USD")?.minor, -450);
  });

  it("handles zero-decimal currencies", () => {
    assertEqual(currencyExponent("JPY"), 0);
    assertEqual(parseMoneyString("1200", "JPY")?.minor, 1200);
    // A separator in JPY is a grouping mark, never a decimal point.
    assertEqual(parseMoneyString("1,200", "JPY")?.minor, 1200);
  });

  it("rejects malformed input rather than returning zero", () => {
    assertEqual(parseMoneyString("", "EUR"), null);
    assertEqual(parseMoneyString("abc", "EUR"), null);
    assertEqual(parseMoneyString("--", "EUR"), null);
  });

  it("rejects non-finite numbers", () => {
    assertEqual(coerceMoney(Number.NaN, "EUR"), null);
    assertEqual(coerceMoney(Number.POSITIVE_INFINITY, "EUR"), null);
    assertEqual(coerceMoney(null, "EUR"), null);
    assertEqual(coerceMoney(undefined, "EUR"), null);
  });

  it("coerces both numbers and strings", () => {
    assertEqual(coerceMoney(23.75, "CAD")?.minor, 2375);
    assertEqual(coerceMoney("23.75", "CAD")?.minor, 2375);
  });
});

describe("money: arithmetic", () => {
  it("adds without floating point drift", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE754; in minor units it is exact.
    const a = moneyFromMajorNumber(0.1, "EUR");
    const b = moneyFromMajorNumber(0.2, "EUR");
    assertEqual(addMoney(a, b).minor, 30);
  });

  it("sums a long list exactly", () => {
    const values = Array.from({ length: 100 }, () =>
      moneyFromMajorNumber(0.07, "EUR")
    );
    assertEqual(sumMoney(values, "EUR").minor, 700);
  });

  it("subtracts to an exact delta", () => {
    const printed = moneyFromMajorNumber(374.25, "CAD");
    const calculated = moneyFromMajorNumber(366.0, "CAD");
    assertEqual(subtractMoney(printed, calculated).minor, 825);
  });

  it("multiplies by integer quantity", () => {
    const unit = moneyFromMajorNumber(23.75, "CAD");
    assertEqual(multiplyMoney(unit, 2).minor, 4750);
  });

  it("refuses fractional quantities", () => {
    const unit = moneyFromMajorNumber(10, "EUR");
    assertThrows(() => multiplyMoney(unit, 1.5));
  });

  it("refuses cross-currency arithmetic", () => {
    const eur = moneyFromMajorNumber(10, "EUR");
    const usd = moneyFromMajorNumber(10, "USD");
    assertThrows(() => addMoney(eur, usd));
  });
});

describe("money: currency codes", () => {
  it("normalizes ISO codes and symbols", () => {
    assertEqual(normalizeCurrencyCode("cad"), "CAD");
    assertEqual(normalizeCurrencyCode("€"), "EUR");
    assertEqual(normalizeCurrencyCode("C$"), "CAD");
    assertEqual(normalizeCurrencyCode("¥"), "JPY");
  });

  it("refuses to guess an ambiguous bare dollar sign", () => {
    // USD vs CAD cannot be told apart from "$" alone; guessing silently
    // corrupts every amount, so this must stay unresolved.
    assertEqual(normalizeCurrencyCode("$"), null);
  });

  it("returns null for unknown input", () => {
    assertEqual(normalizeCurrencyCode(""), null);
    assertEqual(normalizeCurrencyCode("XYZ"), null);
    assertEqual(normalizeCurrencyCode(undefined), null);
  });
});

describe("money: presentation", () => {
  it("renders decimal strings", () => {
    assertEqual(moneyToDecimalString({ minor: 37425, currency: "CAD" }), "374.25");
    assertEqual(moneyToDecimalString({ minor: -825, currency: "CAD" }), "-8.25");
    assertEqual(moneyToDecimalString({ minor: 5, currency: "EUR" }), "0.05");
    assertEqual(moneyToDecimalString({ minor: 1200, currency: "JPY" }), "1200");
  });

  it("round-trips through major units", () => {
    const money = moneyFromMajorNumber(499.03, "CAD");
    assert(Math.abs(moneyToMajorNumber(money) - 499.03) < 1e-9, "round trip");
  });
});
