import React, { useEffect } from "react";
import { View, Text, Modal, StyleSheet, TouchableOpacity, Image } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { SessionParticipant } from "@/types";
import { Avatar } from "@/components/ui/Avatar";
import { Colors } from "@/constants/colors";
import { useI18nStore } from "@/store/i18nStore";

const coinImg = require("@/assets/images/token.png");

const CARD = "#15181D";
const BORDER = "#252A32";
const TEXT = "#F8FAFC";
const MUTED = "#6B7280";

interface CountdownModalProps {
  visible: boolean;
  countdown: number | null;
  participants: SessionParticipant[];
  currency?: string;
  onCancel?: () => void;
  /** Label of the cancel button: the host cancels, a participant asks (R5). */
  cancelLabel?: string;
  /** R5 — the countdown is paused by a cancel request; this line says why. */
  pausedText?: string | null;
  /** R5 — shown to the host while a request waits for their decision. */
  decision?: { onAccept: () => void; onDecline: () => void; busy?: boolean } | null;
}

function LoadingBar({ index, color }: { index: number; color: string }) {
  const progress = useSharedValue(0.12);

  useEffect(() => {
    const stagger = index * 140;
    progress.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1100 + stagger, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.12, { duration: 1100 + stagger, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      false
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const animStyle = useAnimatedStyle(() => ({
    width: `${progress.value * 100}%` as any,
  }));

  return (
    <View style={styles.barTrack}>
      <Animated.View style={[styles.barFill, animStyle, { backgroundColor: color }]} />
    </View>
  );
}

export function CountdownModal({
  visible,
  countdown,
  participants,
  onCancel,
  cancelLabel,
  pausedText,
  decision,
}: CountdownModalProps) {
  const { t, language } = useI18nStore();
  void language;
  const paused = !!pausedText;
  const showCreditDeduction = !paused && countdown !== null && countdown <= 1;

  if (!visible || countdown === null) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.title}>{t("countdown_title")}</Text>
          <Text style={styles.subtitle}>{t("countdown_subtitle")}</Text>

          {/* Countdown number */}
          <View style={styles.timerWrap}>
            <Text style={[styles.timerNum, { color: paused ? MUTED : Colors.primary }]}>{countdown}</Text>
            <Text style={styles.timerLabel}>{paused ? t("countdown_paused") : t("countdown_seconds")}</Text>
          </View>

          {/* Participants with colored loading bars */}
          <View style={styles.participants}>
            {participants.map((p, index) => {
              const barColor = p.profile.color ?? Colors.primary;
              return (
                <View key={p.userId} style={styles.participantRow}>
                  <Avatar
                    name={p.profile.name}
                    avatarIcon={p.profile.avatarIcon}
                    avatarUrl={p.profile.avatarUrl}
                    color={p.profile.color}
                    size={36}
                  />
                  <View style={styles.participantInfo}>
                    <View style={styles.nameRow}>
                      <Text style={styles.participantName} numberOfLines={1}>
                        {p.profile.name}
                      </Text>
                      {showCreditDeduction && (
                        <View style={styles.creditDeductRow}>
                          <Text style={styles.creditDeduct}>-1</Text>
                          <Image source={coinImg} style={styles.coinSmall} />
                        </View>
                      )}
                    </View>
                    <LoadingBar index={index} color={barColor} />
                  </View>
                </View>
              );
            })}
          </View>

          {/* Footer */}
          <View style={styles.footerRow}>
            <Image source={coinImg} style={styles.coinFooter} />
            <Text style={styles.footer}>{t("countdown_credit_deducted")}</Text>
          </View>

          {paused && <Text style={styles.pausedText}>{pausedText}</Text>}

          {decision ? (
            <View style={styles.decisionRow}>
              <TouchableOpacity
                style={[styles.cancelBtn, styles.decisionBtn, decision.busy && { opacity: 0.5 }]}
                onPress={decision.onDecline}
                disabled={decision.busy}
                activeOpacity={0.8}
              >
                <Text style={styles.cancelBtnText}>{t("countdown_decline")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.cancelBtn, styles.decisionBtn, styles.acceptBtn, decision.busy && { opacity: 0.5 }]}
                onPress={decision.onAccept}
                disabled={decision.busy}
                activeOpacity={0.8}
              >
                <Text style={[styles.cancelBtnText, styles.acceptBtnText]}>{t("countdown_accept")}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            onCancel && !paused && (
              <TouchableOpacity style={styles.cancelBtn} onPress={onCancel} activeOpacity={0.8}>
                <Text style={styles.cancelBtnText}>{cancelLabel ?? t("countdown_cancel")}</Text>
              </TouchableOpacity>
            )
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.88)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  card: {
    width: "100%",
    borderRadius: 24,
    backgroundColor: CARD,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: BORDER,
    padding: 24,
    gap: 18,
  },
  title: {
    fontSize: 20,
    fontWeight: "800",
    textAlign: "center",
    color: TEXT,
  },
  subtitle: {
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
    color: MUTED,
    marginTop: -10,
  },
  timerWrap: {
    alignItems: "center",
    gap: 2,
  },
  timerNum: {
    fontSize: 72,
    fontWeight: "900",
    lineHeight: 76,
  },
  timerLabel: {
    fontSize: 14,
    fontWeight: "500",
    color: MUTED,
  },
  participants: {
    gap: 14,
  },
  participantRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  participantInfo: {
    flex: 1,
    gap: 6,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  participantName: {
    fontSize: 14,
    fontWeight: "600",
    color: TEXT,
    flex: 1,
  },
  creditDeductRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  creditDeduct: {
    fontSize: 12,
    fontWeight: "700",
    color: "#EF4444",
  },
  coinSmall: {
    width: 14,
    height: 14,
  },
  // Bars styled like the Payment Screen bar chart
  barTrack: {
    height: 36,
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  barFill: {
    height: "100%",
    borderRadius: 8,
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  coinFooter: {
    width: 16,
    height: 16,
  },
  footer: {
    fontSize: 12,
    textAlign: "center",
    color: MUTED,
  },
  cancelBtn: {
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: -4,
  },
  cancelBtnText: {
    fontSize: 14,
    fontWeight: "600",
    color: MUTED,
  },
  pausedText: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    color: TEXT,
  },
  decisionRow: {
    flexDirection: "row",
    gap: 10,
  },
  decisionBtn: {
    flex: 1,
  },
  acceptBtn: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  acceptBtnText: {
    color: "#fff",
  },
});
