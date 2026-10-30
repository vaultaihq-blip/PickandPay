import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Modal,
  StyleSheet,
  useColorScheme,
  Animated,
  Easing,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { useSessionStore } from "@/store/sessionStore";
import { useAuthStore } from "@/store/authStore";
import { Avatar } from "@/components/ui/Avatar";
import { Card } from "@/components/ui/Card";
import { formatCurrency } from "@/utils/formatter";
import { supabase } from "@/lib/supabase";
import type { TipMode } from "@/types";
import { useI18nStore } from "@/store/i18nStore";
import { TranslationKey } from "@/constants/translations";

const QUICK_TIP_PCTS = [0, 10, 15, 20] as const;
const ORDERED_CATS = ["starters", "mains", "drinks", "desserts", "others"] as const;
const CAT_LABEL_KEYS: Record<string, TranslationKey> = {
  starters: "lobby_cat_starters",
  mains: "lobby_cat_mains",
  drinks: "lobby_cat_drinks",
  desserts: "lobby_cat_desserts",
  others: "lobby_cat_others",
};

export default function ReviewAcceptScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const isDark = useColorScheme() === "dark";
  const { currentSession, recalculateSplit } = useSessionStore();
  const { profile } = useAuthStore();
  const { t, language } = useI18nStore();
  void language;

  const session = currentSession;
  const receipt = session?.receipt;
  const participants = session?.participants ?? [];

  // ── Tip state ────────────────────────────────────────────────────────────────
  const [tipPct, setTipPct] = useState<number>(() => receipt?.tipPercentage ?? 0);
  const [tipMode, setLocalTipMode] = useState<TipMode>(() => receipt?.tipMode ?? "equal");

  const subtotal = receipt
    ? Object.values(receipt.categories).flat().reduce((s, i) => s + i.totalPrice, 0)
    : 0;
  const globalCostsTotal = (receipt?.globalCosts ?? []).reduce((s, c) => s + c.amount, 0);
  const tipAmount = tipPct === 0 ? 0 : Math.round(subtotal * (tipPct / 100) * 100) / 100;
  const totalWithTip = subtotal + globalCostsTotal + tipAmount;

  // ── Acceptance state ─────────────────────────────────────────────────────────
  const [acceptances, setAcceptances] = useState<Record<string, boolean>>({});
  const [showCountdown, setShowCountdown] = useState(false);
  const [countdown, setCountdown] = useState(5);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const currentUserId = profile?.id ?? "";
  const hasCurrentUserAccepted = !!acceptances[currentUserId];
  const allAccepted =
    participants.length > 0 && participants.every((p) => !!acceptances[p.userId]);

  const isOfflineSession = !sessionId || String(sessionId).startsWith("session_");

  const handleForceAcceptAll = () => {
    recalculateSplit();
    router.push(`/(app)/dashboard/${sessionId}`);
  };

  // ── Theme ────────────────────────────────────────────────────────────────────
  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;

  // ── Supabase broadcast channel ───────────────────────────────────────────────
  useEffect(() => {
    const isOffline = !sessionId || String(sessionId).startsWith("session_");
    if (isOffline) return;

    const ch = supabase
      .channel(`review-accept:${sessionId}`, { config: { private: true } })
      .on("broadcast", { event: "accept" }, ({ payload }) => {
        setAcceptances((prev) => ({ ...prev, [payload.userId as string]: true }));
      })
      .on("broadcast", { event: "reset" }, () => {
        setAcceptances({});
        setShowCountdown(false);
        setCountdown(5);
      })
      .on("broadcast", { event: "tip_change" }, ({ payload }) => {
        setTipPct(payload.tipPct as number);
        setLocalTipMode(payload.tipMode as TipMode);
        setAcceptances({});
        setShowCountdown(false);
        setCountdown(5);
      })
      .subscribe();

    channelRef.current = ch;
    return () => {
      supabase.removeChannel(ch);
    };
  }, [sessionId]);

  // ── Start countdown when all accept ─────────────────────────────────────────
  useEffect(() => {
    if (allAccepted && !showCountdown) {
      setShowCountdown(true);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start();
    }
  }, [allAccepted]);

  // ── Countdown tick + number pulse animation ──────────────────────────────────
  useEffect(() => {
    if (!showCountdown) return;
    if (countdown === 0) {
      handleProceed();
      return;
    }
    // Pulse the countdown number
    Animated.sequence([
      Animated.timing(scaleAnim, {
        toValue: 1.3,
        duration: 100,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(scaleAnim, {
        toValue: 1,
        duration: 400,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start();

    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown, showCountdown]);

  // ── Handlers ─────────────────────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    setAcceptances({});
    setShowCountdown(false);
    setCountdown(5);
    fadeAnim.setValue(0);
    channelRef.current?.send({ type: "broadcast", event: "reset", payload: {} });
  }, [fadeAnim]);

  const handleAccept = () => {
    if (!currentUserId) return;
    setAcceptances((prev) => ({ ...prev, [currentUserId]: true }));
    channelRef.current?.send({
      type: "broadcast",
      event: "accept",
      payload: { userId: currentUserId },
    });
  };

  const handleTipSelect = (pct: number) => {
    setTipPct(pct);
    handleReset();
    channelRef.current?.send({
      type: "broadcast",
      event: "tip_change",
      payload: { tipPct: pct, tipMode },
    });
  };

  const handleTipModeToggle = () => {
    const next: TipMode = tipMode === "equal" ? "individual" : "equal";
    setLocalTipMode(next);
    handleReset();
    channelRef.current?.send({
      type: "broadcast",
      event: "tip_change",
      payload: { tipPct, tipMode: next },
    });
  };

  const handleProceed = () => {
    // No credit here any more: the server spends it once, at finalize (R1).
    router.push(`/(app)/selection/${sessionId}`);
  };

  // ── Guard ────────────────────────────────────────────────────────────────────
  if (!session || !receipt) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: mutedColor }]}>{t("review_no_session")}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const curr = receipt.currency;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="arrow-back" size={24} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: textColor }]}>{t("review_title")}</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Receipt summary ─────────────────────────────────────────────── */}
        <Card style={styles.card} padding={0}>
          <View style={[styles.restaurantRow, { borderColor }]}>
            <Ionicons name="restaurant-outline" size={15} color={mutedColor} />
            <Text style={[styles.restaurantName, { color: textColor }]} numberOfLines={1}>
              {receipt.restaurant}
            </Text>
            <Text style={[styles.restaurantDate, { color: mutedColor }]}>
              {receipt.date ?? ""}
            </Text>
          </View>

          {ORDERED_CATS.map((cat) => {
            const items = receipt.categories[cat];
            if (items.length === 0) return null;
            return (
              <View key={cat}>
                <Text style={[styles.catLabel, { color: mutedColor }]}>
                  {t(CAT_LABEL_KEYS[cat]).toUpperCase()}
                </Text>
                {items.map((item) => (
                  <View key={item.id} style={[styles.itemRow, { borderColor }]}>
                    <Text style={[styles.itemName, { color: textColor }]} numberOfLines={1}>
                      {item.quantity > 1 ? `${item.quantity}× ` : ""}
                      {item.name}
                    </Text>
                    <Text style={[styles.itemPrice, { color: mutedColor }]}>
                      {formatCurrency(item.totalPrice, curr)}
                    </Text>
                  </View>
                ))}
              </View>
            );
          })}

          <View style={[styles.subtotalRow, { borderColor }]}>
            <Text style={[styles.subtotalLabel, { color: mutedColor }]}>{t("review_subtotal")}</Text>
            <Text style={[styles.subtotalAmount, { color: mutedColor }]}>
              {formatCurrency(subtotal, curr)}
            </Text>
          </View>
        </Card>

        {/* ── Tip selector ────────────────────────────────────────────────── */}
        <Card style={styles.card} padding={0}>
          <View style={styles.tipHeader}>
            <Text style={[styles.sectionLabel, { color: mutedColor }]}>{t("review_tip_section")}</Text>
            <TouchableOpacity
              style={[styles.modeToggle, { borderColor }]}
              onPress={handleTipModeToggle}
              activeOpacity={0.8}
            >
              <View
                style={[
                  styles.modeOption,
                  tipMode === "equal" && { backgroundColor: Colors.primary },
                ]}
              >
                <Text
                  style={[
                    styles.modeOptionText,
                    { color: tipMode === "equal" ? "#fff" : mutedColor },
                  ]}
                >
                  {t("review_equal")}
                </Text>
              </View>
              <View
                style={[
                  styles.modeOption,
                  tipMode === "individual" && { backgroundColor: Colors.primary },
                ]}
              >
                <Text
                  style={[
                    styles.modeOptionText,
                    { color: tipMode === "individual" ? "#fff" : mutedColor },
                  ]}
                >
                  {t("review_individual")}
                </Text>
              </View>
            </TouchableOpacity>
          </View>

          <View style={styles.tipChips}>
            {QUICK_TIP_PCTS.map((pct) => {
              const isSelected = tipPct === pct;
              const accentColor = pct === 0 ? "#EF4444" : Colors.primary;
              return (
                <TouchableOpacity
                  key={pct}
                  style={[
                    styles.tipChip,
                    { borderColor: isSelected ? accentColor : borderColor },
                    isSelected && { backgroundColor: accentColor + "1A" },
                  ]}
                  onPress={() => handleTipSelect(pct)}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      styles.tipChipPct,
                      { color: isSelected ? accentColor : textColor },
                    ]}
                  >
                    {pct === 0 ? t("review_no_tip") : `${pct}%`}
                  </Text>
                  {pct > 0 && (
                    <Text
                      style={[
                        styles.tipChipAmt,
                        { color: isSelected ? accentColor : mutedColor },
                      ]}
                    >
                      {formatCurrency(
                        Math.round(subtotal * (pct / 100) * 100) / 100,
                        curr
                      )}
                    </Text>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={[styles.totalRow, { borderColor }]}>
            <Text style={[styles.totalLabel, { color: textColor, fontWeight: "700" }]}>
              {t("review_total")} {tipPct > 0 ? `(+${tipPct}% ${t("review_tip_pct_suffix")})` : ""}
            </Text>
            <Text style={[styles.totalAmount, { color: Colors.primary }]}>
              {formatCurrency(totalWithTip, curr)}
            </Text>
          </View>
        </Card>

        {/* ── Acceptance tracker ──────────────────────────────────────────── */}
        <Card style={styles.card} padding={0}>
          <Text style={[styles.sectionLabel, { color: mutedColor, paddingHorizontal: 16, paddingTop: 14 }]}>
            {t("review_acceptance_status")} ({Object.values(acceptances).filter(Boolean).length}/{participants.length})
          </Text>
          {participants.map((p, idx) => {
            const accepted = !!acceptances[p.userId];
            const isLast = idx === participants.length - 1;
            return (
              <View key={p.userId}>
                <View style={styles.acceptRow}>
                  <Avatar
                    name={p.profile.name}
                    avatarIcon={p.profile.avatarIcon}
                    avatarUrl={p.profile.avatarUrl}
                    color={p.profile.color} color2={p.profile.color2}
                    size={36}
                  />
                  <View style={styles.acceptNameCol}>
                    <Text style={[styles.acceptName, { color: textColor }]} numberOfLines={1}>
                      {p.profile.name}
                    </Text>
                    {p.userId === session.creatorId && (
                      <Text style={[styles.hostLabel, { color: mutedColor }]}>{t("session_host_badge")}</Text>
                    )}
                  </View>
                  {accepted ? (
                    <View style={styles.acceptedBadge}>
                      <Ionicons name="checkmark-circle" size={18} color="#10B981" />
                      <Text style={styles.acceptedBadgeText}>{t("review_accepted")}</Text>
                    </View>
                  ) : (
                    <View style={[styles.waitingBadge, { borderColor }]}>
                      <Ionicons name="time-outline" size={14} color={mutedColor} />
                      <Text style={[styles.waitingBadgeText, { color: mutedColor }]}>{t("review_waiting_badge")}</Text>
                    </View>
                  )}
                </View>
                {!isLast && (
                  <View style={[styles.rowDivider, { backgroundColor: borderColor }]} />
                )}
              </View>
            );
          })}
        </Card>

        {/* ── Actions ─────────────────────────────────────────────────────── */}
        {!hasCurrentUserAccepted ? (
          <TouchableOpacity
            style={styles.acceptBtn}
            onPress={handleAccept}
            activeOpacity={0.85}
          >
            <Ionicons name="checkmark-circle-outline" size={22} color="#fff" />
            <Text style={styles.acceptBtnText}>{t("review_accept")}</Text>
          </TouchableOpacity>
        ) : (
          <View style={[styles.acceptedBox, { borderColor: "#10B981" }]}>
            <Ionicons name="checkmark-circle" size={20} color="#10B981" />
            <Text style={styles.acceptedBoxText}>
              {t("review_accepted_waiting")}
            </Text>
          </View>
        )}

        {isOfflineSession && !allAccepted && (
          <TouchableOpacity
            style={styles.forceAcceptBtn}
            onPress={handleForceAcceptAll}
            activeOpacity={0.85}
          >
            <Ionicons name="flash" size={16} color="#fff" />
            <Text style={styles.forceAcceptBtnText}>
              🧪 Force Accept All (Dev)
            </Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={[
            styles.resetBtn,
            { borderColor },
            showCountdown && styles.resetBtnDisabled,
          ]}
          onPress={handleReset}
          disabled={showCountdown}
          activeOpacity={0.7}
        >
          <Ionicons name="refresh-outline" size={16} color={mutedColor} />
          <Text style={[styles.resetBtnText, { color: mutedColor }]}>
            {t("review_reset")}
          </Text>
        </TouchableOpacity>
      </ScrollView>

      {/* ── Countdown modal ─────────────────────────────────────────────────── */}
      <Modal transparent animationType="none" visible={showCountdown}>
        <Animated.View style={[styles.modalOverlay, { opacity: fadeAnim }]}>
          <View style={[styles.modalCard, { backgroundColor: cardColor }]}>
            <Text style={[styles.modalTitle, { color: textColor }]}>
              {t("review_everyones_in")}
            </Text>
            <Text style={[styles.modalSub, { color: mutedColor }]}>
              {t("review_proceeding")}
            </Text>

            <Animated.View
              style={[styles.countdownCircle, { transform: [{ scale: scaleAnim }] }]}
            >
              <Text style={styles.countdownNumber}>{countdown}</Text>
            </Animated.View>

            {/* Credit deduction list */}
            <Text style={[styles.creditListTitle, { color: mutedColor }]}>
              {t("review_credits_used")}
            </Text>
            <View style={[styles.creditList, { borderColor }]}>
              {participants.map((p, idx) => {
                const isLast = idx === participants.length - 1;
                return (
                  <View key={p.userId}>
                    <View style={styles.creditRow}>
                      <Avatar
                        name={p.profile.name}
                        avatarIcon={p.profile.avatarIcon}
                        avatarUrl={p.profile.avatarUrl}
                        color={p.profile.color} color2={p.profile.color2}
                        size={28}
                      />
                      <Text
                        style={[styles.creditRowName, { color: textColor }]}
                        numberOfLines={1}
                      >
                        {p.profile.name}
                      </Text>
                      {p.profile.isPro ? (
                        <View style={styles.proBadge}>
                          <Text style={styles.proBadgeText}>{t("review_pro_free")}</Text>
                        </View>
                      ) : (
                        <View style={styles.deductBadge}>
                          <Ionicons name="ellipse" size={11} color="#F59E0B" />
                          <Text style={styles.deductBadgeText}>-1</Text>
                        </View>
                      )}
                    </View>
                    {!isLast && (
                      <View style={[styles.rowDivider, { backgroundColor: borderColor }]} />
                    )}
                  </View>
                );
              })}
            </View>

            <TouchableOpacity
              style={[styles.cancelBtn, { borderColor }]}
              onPress={handleReset}
            >
              <Text style={[styles.cancelBtnText, { color: mutedColor }]}>{t("cancel")}</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  headerTitle: { fontSize: 17, fontWeight: "700" },

  scroll: {
    paddingHorizontal: 16,
    paddingBottom: 40,
    gap: 14,
    paddingTop: 8,
  },

  // ── Receipt card ──────────────────────────────────────────────────────────────
  card: { overflow: "hidden" },

  restaurantRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  restaurantName: { flex: 1, fontSize: 15, fontWeight: "700" },
  restaurantDate: { fontSize: 12 },

  catLabel: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  itemName: { flex: 1, fontSize: 14, fontWeight: "500" },
  itemPrice: { fontSize: 13, fontWeight: "600", minWidth: 54, textAlign: "right" },

  subtotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  subtotalLabel: { fontSize: 13 },
  subtotalAmount: { fontSize: 13, fontWeight: "600" },

  // ── Tip ───────────────────────────────────────────────────────────────────────
  tipHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
  modeToggle: {
    flexDirection: "row",
    borderWidth: 1,
    borderRadius: 8,
    overflow: "hidden",
  },
  modeOption: {
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  modeOptionText: { fontSize: 12, fontWeight: "600" },

  tipChips: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  tipChip: {
    flex: 1,
    borderWidth: 1.5,
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: 10,
    gap: 2,
  },
  tipChipPct: { fontSize: 13, fontWeight: "700" },
  tipChipAmt: { fontSize: 10 },

  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  totalLabel: { fontSize: 14 },
  totalAmount: { fontSize: 18, fontWeight: "800" },

  // ── Acceptance tracker ────────────────────────────────────────────────────────
  acceptRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  acceptNameCol: { flex: 1, gap: 1 },
  acceptName: { fontSize: 14, fontWeight: "600" },
  hostLabel: { fontSize: 11 },

  acceptedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#10B98118",
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
  },
  acceptedBadgeText: { color: "#10B981", fontSize: 12, fontWeight: "700" },

  waitingBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
  },
  waitingBadgeText: { fontSize: 12 },

  rowDivider: { height: StyleSheet.hairlineWidth, marginLeft: 60 },

  // ── Action buttons ────────────────────────────────────────────────────────────
  acceptBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#10B981",
    paddingVertical: 17,
    borderRadius: 16,
    gap: 10,
  },
  acceptBtnText: { color: "#fff", fontSize: 17, fontWeight: "800" },

  acceptedBox: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 15,
    borderRadius: 14,
    borderWidth: 1.5,
    backgroundColor: "#10B98110",
  },
  acceptedBoxText: { color: "#10B981", fontSize: 14, fontWeight: "600" },

  forceAcceptBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#EF4444",
    paddingVertical: 14,
    borderRadius: 12,
  },
  forceAcceptBtnText: { color: "#fff", fontSize: 14, fontWeight: "700" },

  resetBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1,
  },
  resetBtnDisabled: { opacity: 0.3 },
  resetBtnText: { fontSize: 13, fontWeight: "600" },

  // ── Empty state ───────────────────────────────────────────────────────────────
  empty: { flex: 1, alignItems: "center", justifyContent: "center" },
  emptyText: { fontSize: 16 },

  // ── Countdown modal ───────────────────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    borderRadius: 24,
    padding: 24,
    width: "100%",
    maxWidth: 360,
    gap: 14,
    alignItems: "center",
  },
  modalTitle: { fontSize: 22, fontWeight: "800", textAlign: "center" },
  modalSub: { fontSize: 14, textAlign: "center" },

  countdownCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 4,
  },
  countdownNumber: {
    color: "#fff",
    fontSize: 40,
    fontWeight: "900",
    lineHeight: 48,
  },

  creditListTitle: { fontSize: 11, fontWeight: "600", letterSpacing: 0.4, alignSelf: "flex-start" },
  creditList: {
    alignSelf: "stretch",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    overflow: "hidden",
  },
  creditRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  creditRowName: { flex: 1, fontSize: 14, fontWeight: "500" },

  proBadge: {
    backgroundColor: "#F59E0B22",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  proBadgeText: { color: "#F59E0B", fontSize: 11, fontWeight: "700" },

  deductBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.primary + "22",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  deductBadgeText: { color: Colors.primary, fontSize: 12, fontWeight: "700" },

  cancelBtn: {
    alignSelf: "stretch",
    alignItems: "center",
    paddingVertical: 13,
    borderRadius: 12,
    borderWidth: 1,
  },
  cancelBtnText: { fontSize: 14, fontWeight: "600" },
});
