// ─── User Color Palette ────────────────────────────────────────────────────────
// 8 accessible, visually distinct colors for participants

export const USER_COLORS = [
  "#FF6B6B", // Coral
  "#4ECDC4", // Teal
  "#A855F7", // Purple
  "#F97316", // Orange
  "#3B82F6", // Blue
  "#22C55E", // Green
  "#EC4899", // Pink
  "#EAB308", // Yellow
] as const;

export type UserColor = (typeof USER_COLORS)[number];

export function getColorForIndex(index: number): string {
  return USER_COLORS[index % USER_COLORS.length];
}

// ─── App Theme Colors ──────────────────────────────────────────────────────────

export const Colors = {
  // Brand
  primary: "#6366F1",
  primaryDark: "#4F46E5",
  primaryLight: "#818CF8",

  // Backgrounds
  bgDark: "#0F0F0F",
  bgLight: "#F8F8F8",

  // Cards
  cardDark: "#1A1A1A",
  cardLight: "#FFFFFF",
  cardBorderDark: "#2A2A2A",
  cardBorderLight: "#E5E7EB",

  // Text
  textPrimaryDark: "#FFFFFF",
  textPrimaryLight: "#111111",
  textSecondaryDark: "#9CA3AF",
  textSecondaryLight: "#6B7280",
  textMutedDark: "#4B5563",
  textMutedLight: "#9CA3AF",

  // Semantic
  success: "#22C55E",
  successBg: "#052E16",
  warning: "#F59E0B",
  warningBg: "#451A03",
  error: "#EF4444",
  errorBg: "#450A0A",

  // Category icons
  starters: "#F97316",
  mains: "#EF4444",
  drinks: "#3B82F6",
  desserts: "#EC4899",
  others: "#8B5CF6",

  // Misc
  transparent: "transparent",
  overlay: "rgba(0,0,0,0.6)",
  white: "#FFFFFF",
  black: "#000000",
} as const;

// ─── Dark Mode Helper ──────────────────────────────────────────────────────────

export function getThemeColors(isDark: boolean) {
  return {
    background: isDark ? Colors.bgDark : Colors.bgLight,
    card: isDark ? Colors.cardDark : Colors.cardLight,
    cardBorder: isDark ? Colors.cardBorderDark : Colors.cardBorderLight,
    textPrimary: isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight,
    textSecondary: isDark
      ? Colors.textSecondaryDark
      : Colors.textSecondaryLight,
    textMuted: isDark ? Colors.textMutedDark : Colors.textMutedLight,
  };
}
