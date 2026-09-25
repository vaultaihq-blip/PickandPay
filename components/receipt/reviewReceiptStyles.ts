/**
 * Styles for the review-receipt correction screen.
 *
 * Moved out of the screen verbatim in FIX 45 so the orchestrator stays
 * readable once the guided flow landed on top of it. Nothing here changed:
 * the full item list looks exactly as it did before.
 */
import { StyleSheet } from "react-native";
import { Colors } from "@/constants/colors";

export const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  headerTitle: { fontSize: 17, fontWeight: "700" },
  scroll: { paddingHorizontal: 20, gap: 14 },

  restaurantCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  restaurantName: { fontSize: 15, fontWeight: "700" },
  restaurantDate: { fontSize: 12, marginTop: 2 },

  // ── Warning state (small discrepancy, can continue) ───────────────────────
  warningBox: {
    padding: 16,
    borderRadius: 14,
    backgroundColor: "#FFFBEB",
    borderWidth: 1.5,
    borderColor: "#FCD34D",
    gap: 8,
  },
  warningBoxHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  warningBoxTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#92400E",
    flex: 1,
  },
  warningBoxDesc: {
    fontSize: 13,
    color: "#78350F",
    lineHeight: 20,
  },
  warningBoxAmount: {
    fontWeight: "700",
  },
  warningBoxHint: {
    fontSize: 12,
    color: "#92400E",
    lineHeight: 18,
    fontStyle: "italic",
  },

  // ── Blocked state ──────────────────────────────────────────────────────────
  blockedBox: {
    padding: 16,
    borderRadius: 14,
    backgroundColor: "#FEF2F2",
    borderWidth: 1.5,
    borderColor: "#FCA5A5",
    gap: 10,
  },
  blockedHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  blockedTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#DC2626",
    flex: 1,
  },
  blockedDesc: {
    fontSize: 13,
    color: "#7F1D1D",
    lineHeight: 20,
  },
  blockedAmount: {
    fontWeight: "700",
  },
  fixSuggestions: {
    gap: 4,
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#FCA5A5",
  },
  fixSuggestionHead: {
    fontWeight: "700",
    paddingTop: 4,
  },
  fixSuggestionLine: {
    fontSize: 12,
    color: "#991B1B",
    lineHeight: 18,
  },

  // ── Errors / warnings ─────────────────────────────────────────────────────
  errorBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FCA5A5",
  },
  errorBannerTitle: { fontSize: 12, fontWeight: "700", color: "#EF4444" },
  errorBannerItem: { fontSize: 11, color: "#DC2626", lineHeight: 16 },
  errorBannerMore: { fontSize: 11, color: "#DC2626", fontStyle: "italic" },

  warningBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#FFFBEB",
    borderWidth: 1,
    borderColor: "#FCD34D",
  },
  warningBannerTitle: { fontSize: 12, fontWeight: "700", color: Colors.warning },
  warningBannerItem: { fontSize: 11, color: Colors.warning, lineHeight: 16 },

  evidenceBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#EEF2FF",
    borderWidth: 1,
    borderColor: "#C7D2FE",
  },
  evidenceBannerTitle: { fontSize: 12, fontWeight: "700", color: Colors.primary },
  evidenceIssueRow: { gap: 4 },
  evidenceIssueMessage: { fontSize: 11, color: "#3730A3", lineHeight: 16 },
  evidenceIssueSourceLine: { fontSize: 11, color: "#4338CA", fontStyle: "italic" },
  evidenceDismissBtn: { alignSelf: "flex-start", paddingVertical: 2 },
  evidenceDismissBtnText: {
    fontSize: 11,
    fontWeight: "600",
    color: Colors.primary,
    textDecorationLine: "underline",
  },
  evidenceMoreText: { fontSize: 11, color: Colors.primary, fontStyle: "italic" },

  sectionTitle: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginBottom: -4,
  },

  // ── Item cards ─────────────────────────────────────────────────────────────
  itemCard: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 10 },
  itemHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  itemHeaderActions: { flexDirection: "row", alignItems: "center", gap: 12 },
  itemIndex: { fontSize: 11, fontWeight: "600" },
  itemErrorRow: { flexDirection: "row", alignItems: "flex-start", gap: 5 },
  itemErrorText: { fontSize: 11, color: "#EF4444", flex: 1, lineHeight: 16 },
  nameInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14,
  },
  fieldRow: { flexDirection: "row", gap: 8 },
  fieldCol: { flex: 1, gap: 4 },
  fieldLabel: { fontSize: 10, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.3 },
  fieldInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    textAlign: "right",
  },
  fieldReadonly: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignItems: "flex-end",
  },
  fieldReadonlyText: { fontSize: 14, fontWeight: "700" },

  // ── Add item ───────────────────────────────────────────────────────────────
  addItemBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderStyle: "dashed",
  },
  addItemText: { color: Colors.primary, fontSize: 14, fontWeight: "600" },

  // ── Totals ─────────────────────────────────────────────────────────────────
  totalCard: { borderRadius: 14, borderWidth: 1.5, padding: 16, gap: 12 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  totalLabel: { fontSize: 14 },
  totalValue: { fontSize: 15, fontWeight: "700" },
  totalDivider: { height: StyleSheet.hairlineWidth },
  matchRow: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1 },
  matchText: { fontSize: 13, color: "#10B981", fontWeight: "600" },
  diffLabel: { fontSize: 14, fontWeight: "700", color: "#DC2626" },
  diffValue: { fontSize: 15, fontWeight: "800", color: "#DC2626" },

  // ── Bottom actions ─────────────────────────────────────────────────────────
  actions: {
    flexDirection: "row",
    gap: 10,
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  retryBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 15,
    borderRadius: 12,
    borderWidth: 1,
  },
  retryBtnText: { fontSize: 13, fontWeight: "600" },
  continueBtn: {
    flex: 2,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 15,
    borderRadius: 12,
    backgroundColor: Colors.primary,
  },
  continueBtnLocked: {
    backgroundColor: "#F3F4F6",
  },
  continueBtnWarning: {
    backgroundColor: Colors.warning,
  },
  continueBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  continueBtnTextLocked: { color: "#9CA3AF", fontSize: 14, fontWeight: "600" },
  lockedBtnInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },

  // ── Original receipt photo preview ─────────────────────────────────────────
  photoCard: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    height: 160,
  },
  photoThumb: {
    width: "100%",
    height: "100%",
  },
  photoOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 10,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  photoOverlayText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "600",
  },

  // ── Full-screen photo modal ────────────────────────────────────────────────
  photoModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.92)",
    alignItems: "center",
    justifyContent: "center",
  },
  photoModalClose: {
    position: "absolute",
    top: 56,
    right: 20,
    zIndex: 10,
  },
  photoModalImage: {
    flex: 1,
  },
});
