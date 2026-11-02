import { Currency, Session, SplitResult } from "@/types";

// ─── Currency Formatting ───────────────────────────────────────────────────────

const CURRENCY_SYMBOLS: Record<Currency, string> = {
  EUR: "€",
  USD: "$",
  CAD: "C$",
  GBP: "£",
  CNY: "¥",
};

export function getCurrencySymbol(currency: Currency): string {
  return CURRENCY_SYMBOLS[currency] ?? currency;
}

export function formatCurrency(amount: number, currency: Currency): string {
  const symbol = getCurrencySymbol(currency);
  const formatted = amount.toFixed(2);
  // USD and CAD: symbol before ($61.40 / C$61.40)
  // EUR and GBP: symbol after (61.40€ / 61.40£)
  return currency === "USD" || currency === "CAD" || currency === "CNY"
    ? `${symbol}${formatted}`
    : `${formatted}${symbol}`;
}

export function formatCurrencyParts(
  amount: number,
  currency: Currency
): { symbol: string; whole: string; decimal: string } {
  const symbol = getCurrencySymbol(currency);
  const [whole, decimal] = amount.toFixed(2).split(".");
  return { symbol, whole, decimal };
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
