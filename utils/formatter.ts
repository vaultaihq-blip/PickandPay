import { Currency, Session, SplitResult } from "@/types";
import { currencyExponent } from "@/lib/receipt/money";

// ─── Currency Formatting ───────────────────────────────────────────────────────
//
// Currency point (02-11-2026): every screen shows the receipt's own currency
// (₺ for a Turkish receipt, never € by default), with that currency's
// decimals and the separators of the app's language: "6.700,00 ₺" in
// Portuguese, "₺6,700.00" in English. The payment screen showed "6700.00€".

const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: "€",
  USD: "$",
  CAD: "C$",
  GBP: "£",
  CNY: "¥",
  JPY: "¥",
  AUD: "A$",
  NZD: "NZ$",
  HKD: "HK$",
  SGD: "S$",
  TWD: "NT$",
  BRL: "R$",
  MXN: "MX$",
  TRY: "₺",
  INR: "₹",
  KRW: "₩",
  THB: "฿",
  VND: "₫",
  PHP: "₱",
  ILS: "₪",
  UAH: "₴",
  GEL: "₾",
  PLN: "zł",
  CZK: "Kč",
  HUF: "Ft",
  SEK: "kr",
  NOK: "kr",
  DKK: "kr",
  ISK: "kr",
  ZAR: "R",
};

// The rest show their ISO code ("CHF 12.50", "12,50 CHF").
export function getCurrencySymbol(currency: Currency): string {
  return CURRENCY_SYMBOLS[currency] ?? currency;
}

// The app's language decides the separators; set by the i18n store.
// A no-break space: "6.700,00 ₺" never wraps between the number and the sign.
const NBSP = "\u00A0";
type MoneyStyle = { group: string; decimal: string; symbolFirst: boolean };
const STYLE_BY_LANGUAGE: Record<string, MoneyStyle> = {
  en: { group: ",", decimal: ".", symbolFirst: true },
  zh: { group: ",", decimal: ".", symbolFirst: true },
  pt: { group: ".", decimal: ",", symbolFirst: false },
  es: { group: ".", decimal: ",", symbolFirst: false },
  fr: { group: NBSP, decimal: ",", symbolFirst: false },
};
let moneyStyle: MoneyStyle = STYLE_BY_LANGUAGE.en;

export function setMoneyLanguage(language: string): void {
  moneyStyle = STYLE_BY_LANGUAGE[language] ?? STYLE_BY_LANGUAGE.en;
}

// Currencies with no minor unit (JPY, KRW, …) show no decimals.
function decimalsFor(currency: Currency): number {
  return currencyExponent(currency);
}

// "6700" → "6.700" with the language's group mark.
function groupThousands(whole: string, group: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
}

export function formatCurrencyParts(
  amount: number,
  currency: Currency
): { symbol: string; whole: string; decimal: string } {
  const symbol = getCurrencySymbol(currency);
  const [whole, decimal = ""] = Math.abs(amount).toFixed(decimalsFor(currency)).split(".");
  return { symbol, whole: (amount < 0 ? "-" : "") + groupThousands(whole, moneyStyle.group), decimal };
}

export function formatCurrency(amount: number, currency: Currency): string {
  const { symbol, whole, decimal } = formatCurrencyParts(Math.abs(amount), currency);
  const number = decimal ? `${whole}${moneyStyle.decimal}${decimal}` : whole;
  const minus = amount < 0 && Number(whole.replace(/\D/g, "") + decimal) > 0 ? "-" : "";
  // A code (CHF) needs a space next to the number; a sign ($, €) only after it.
  if (moneyStyle.symbolFirst) return minus + (/^[A-Z]{3}$/.test(symbol) ? `${symbol} ${number}` : `${symbol}${number}`);
  return `${minus}${number}${NBSP}${symbol}`;
}

// ─── Date Formatting ───────────────────────────────────────────────────────────

export function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

export function formatDateShort(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
    });
  } catch {
    return dateStr;
  }
}

export function formatRelativeTime(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return formatDateShort(dateStr);
  } catch {
    return dateStr;
  }
}

// ─── Number Formatting ─────────────────────────────────────────────────────────

export function formatQuantity(qty: number): string {
  if (Number.isInteger(qty)) return qty.toString();
  return qty.toFixed(1);
}

export function formatPercentage(value: number): string {
  return `${value}%`;
}

// ─── Share Summary ─────────────────────────────────────────────────────────────

export function generateShareSummary(
  session: Session,
  splitResults?: Map<string, SplitResult>
): string {
  const { receipt, participants } = session;
  if (!receipt) {
    return "Pick&Pay - No receipt available.";
  }
  const curr = receipt.currency;

  const receiptTotal = receipt.validation?.receiptTotal ?? 0;
  const tipTotal =
    receipt.tipMode === "individual"
      ? participants.reduce((s, p) => s + (p.tipContribution ?? 0), 0)
      : (receipt.selectedTip ?? 0);
  const grandTotal = receiptTotal + tipTotal;

  const allPaid = participants.every((p) => p.paid);

  const lines: string[] = [`🧾 Pick&Pay — ${receipt.restaurant}`];
  if (receipt.date) lines.push(`📅 ${formatDate(receipt.date)}`);
  lines.push("");

  // Always show the full Receipt + Tip = Total line
  lines.push(
    `💰 Receipt: ${formatCurrency(receiptTotal, curr)} + Tip: ${formatCurrency(tipTotal, curr)} = Total: ${formatCurrency(grandTotal, curr)} ✓`
  );
  lines.push("");

  for (const p of participants) {
    const result = splitResults?.get(p.userId);
    const mark = p.paid ? "✅" : "❌";
    lines.push(`👥 ${p.profile.name} ${mark} — ${formatCurrency(p.totalOwed, curr)}`);

    if (result && result.itemBreakdown.length > 0) {
      for (const entry of result.itemBreakdown) {
        // R12 — the people sharing the same units, by name
        const sharedNames = (entry.sharedWith ?? [])
          .map((uid) => participants.find((pp) => pp.userId === uid)?.profile.name)
          .filter(Boolean);
        const splitNote =
          sharedNames.length > 0
            ? ` (shared with ${sharedNames.join(", ")})`
            : entry.splitCount > 1
            ? ` (÷${entry.splitCount})`
            : (entry.units ?? 1) > 1 && entry.unitPrice !== undefined
              ? ` (${entry.units} × ${formatCurrency(entry.unitPrice, curr)})`
              : "";
        lines.push(
          `   • ${entry.itemName}${splitNote}: ${formatCurrency(entry.amount, curr)}`
        );
      }
      if (result.globalCostsShare !== 0 || result.tipShare > 0) {
        lines.push("   ——");
        // R2 — each charge under its own name; a discount shows as a minus.
        if (result.costBreakdown?.length) {
          for (const c of result.costBreakdown) {
            lines.push(`   ${c.name}: ${c.amount < 0 ? "−" : "+"}${formatCurrency(Math.abs(c.amount), curr)}`);
          }
        } else if (result.globalCostsShare > 0) {
          lines.push(`   Tax & fees: +${formatCurrency(result.globalCostsShare, curr)}`);
        }
        if (result.tipShare > 0) {
          const tipLabel = receipt.tipMode === "individual" ? "Your tip" : "Tip";
          lines.push(`   ${tipLabel}: +${formatCurrency(result.tipShare, curr)}`);
        }
      }
      lines.push("   ──────────");
    }
    const paidLabel = p.paid ? "(Paid)" : "(Unpaid)";
    lines.push(`${mark} Total: ${formatCurrency(p.totalOwed, curr)} ${paidLabel}`);
    lines.push("");
  }

  if (allPaid) lines.push("All paid and settled! 🎉");
  lines.push("Legend: ✅ Paid | ❌ Unpaid");
  lines.push("");
  lines.push("Sent via Pick&Pay 📱");
  lines.push("");
  lines.push("Download our app:");
  if (process.env.EXPO_PUBLIC_APP_STORE_ID) {
    lines.push(`🍎 iOS: https://apps.apple.com/app/pickandpay/id${process.env.EXPO_PUBLIC_APP_STORE_ID}`);
  }
  lines.push("🤖 Android: https://play.google.com/store/apps/details?id=com.pickandpay.app");
  return lines.join("\n");
}
