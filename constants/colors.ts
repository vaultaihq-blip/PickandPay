// ─── User Color Palette ────────────────────────────────────────────────────────
// 8 accessible, visually distinct colors for participants

export const USER_COLORS = [
  "#FF6B6B", // Coral
  "#2DD4BF", // Teal
  "#A78BFA", // Purple
  "#FB923C", // Orange
  "#3B82F6", // Blue
  "#22C55E", // Green
  "#EC4899", // Pink
  "#FBBF24", // Yellow
  "#06B6D4", // Cyan
  "#84CC16", // Lime
  "#F43F5E", // Rose
  "#8B5CF6", // Violet
  "#14B8A6", // Emerald teal
  "#F97316", // Deep orange
  "#0EA5E9", // Sky
  "#D946EF", // Fuchsia
] as const;

export type UserColor = (typeof USER_COLORS)[number];

export function getColorForIndex(index: number): string {
  return USER_COLORS[index % USER_COLORS.length];
}

function sessionSeed(sessionId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < sessionId.length; i++) {
    hash ^= sessionId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function shuffledSessionColors(sessionId: string): string[] {
  const colors = [...USER_COLORS];
  let seed = sessionSeed(sessionId);
  for (let i = colors.length - 1; i > 0; i--) {
    seed = Math.imul(seed ^ (seed >>> 15), 2246822507) >>> 0;
    const j = seed % (i + 1);
    [colors[i], colors[j]] = [colors[j], colors[i]];
  }
  return colors;
}

export function getSessionParticipantColor(sessionId: string, index: number): string {
  const colors = shuffledSessionColors(sessionId);
  return colors[index % colors.length];
}

export function applySessionParticipantColors<
  T extends { profile: { color: string } }
>(sessionId: string, participants: T[]): T[] {
  return participants.map((participant, index) => ({
    ...participant,
    profile: {
      ...participant.profile,
      color: getSessionParticipantColor(sessionId, index),
    },
  }));
}

/** Deterministic color per userId — consistent across all devices in a session */
export function getColorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}

// ─── App Theme Colors ──────────────────────────────────────────────────────────

export const Colors = {
  // Brand
  primary: "#6366F1",
  primaryDark: "#4F46E5",
  primaryLight: "#818CF8",
  primarySoft: "#EEF2FF",
  primaryTintDark: "#1B1D3A",

  // Backgrounds
  bgDark: "#0B0D10",
  bgLight: "#F6F7F9",
  surfaceDark: "#111419",
  surfaceLight: "#FFFFFF",

  // Cards
  cardDark: "#15181D",
  cardLight: "#FFFFFF",
  cardBorderDark: "#252A32",
  cardBorderLight: "#E3E7EE",

  // Text
  textPrimaryDark: "#F8FAFC",
  textPrimaryLight: "#111827",
  textSecondaryDark: "#B7C0CC",
  textSecondaryLight: "#5F6876",
  textMutedDark: "#7D8794",
  textMutedLight: "#8A94A3",

  // Semantic
  success: "#22C55E",
  successBg: "#0B2A1A",
  warning: "#F59E0B",
  warningBg: "#332207",
  error: "#EF4444",
  errorBg: "#331112",

  // Category icons
  starters: "#F97316",
  mains: "#EF4444",
  drinks: "#3B82F6",
  desserts: "#EC4899",
  others: "#8B5CF6",

  // Misc
  transparent: "transparent",
  overlay: "rgba(0,0,0,0.64)",
  white: "#FFFFFF",
  black: "#000000",
} as const;

// ─── Dark Mode Helper ──────────────────────────────────────────────────────────

export function getThemeColors(isDark: boolean) {
  return {
    background: isDark ? Colors.bgDark : Colors.bgLight,
    surface: isDark ? Colors.surfaceDark : Colors.surfaceLight,
    card: isDark ? Colors.cardDark : Colors.cardLight,
    cardBorder: isDark ? Colors.cardBorderDark : Colors.cardBorderLight,
    textPrimary: isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight,
    textSecondary: isDark
      ? Colors.textSecondaryDark
      : Colors.textSecondaryLight,
    textMuted: isDark ? Colors.textMutedDark : Colors.textMutedLight,
  };
}
