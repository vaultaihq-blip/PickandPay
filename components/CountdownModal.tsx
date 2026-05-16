import React, { useEffect } from "react";
import { View, Text, Modal, StyleSheet, TouchableOpacity, useColorScheme } from "react-native";
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

interface CountdownModalProps {
  visible: boolean;
  countdown: number | null;
  participants: SessionParticipant[];
  currency?: string; // kept for API compatibility, not displayed (privacy)
  onCancel?: () => void;
}

function LoadingBar({ index }: { index: number }) {
  const progress = useSharedValue(0.1);

  useEffect(() => {
    // Stagger each bar so they animate independently
    const delay = index * 150;
    progress.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 1500 + delay, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.1, { duration: 1500 + delay, easing: Easing.inOut(Easing.ease) })
      ),
      -1,
      false
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const animStyle = useAnimatedStyle(() => ({
    width: `${progress.value * 100}%`,
  }));

  return (
    <View style={styles.loadingTrack}>
      <Animated.View style={[styles.loadingFill, animStyle]} />
    </View>
  );
}

export function CountdownModal({
  visible,
  countdown,
  participants,
  onCancel,
}: CountdownModalProps) {
  const isDark = useColorScheme() === "dark";
  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;

  const showCreditDeduction = countdown !== null && countdown <= 2;

  if (!visible || countdown === null) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent>
      <View style={styles.overlay}>
        <View style={[styles.card, { backgroundColor: cardColor }]}>
          <Text style={[styles.title, { color: textColor }]}>Calculating Your Split</Text>
          <Text style={[styles.subtitle, { color: mutedColor }]}>
            Processing everyone's selections...
          </Text>

          {/* Countdown */}
          <View style={styles.timerWrap}>
            <Text style={[styles.timerNum, { color: Colors.primary }]}>{countdown}</Text>
            <Text style={[styles.timerLabel, { color: mutedColor }]}>seconds</Text>
          </View>

          {/* Participants */}
          <View style={styles.participants}>
            {participants.map((p, index) => (
              <View key={p.userId} style={styles.participantRow}>
                <Avatar
                  name={p.profile.name}
                  avatarIcon={p.profile.avatarIcon}
                  avatarUrl={p.profile.avatarUrl}
                  color={p.profile.color}
                  size={40}
                />
                <View style={styles.participantInfo}>
                  <View style={styles.nameRow}>
                    <Text style={[styles.participantName, { color: textColor }]} numberOfLines={1}>
                      {p.profile.name}
                    </Text>
                    {showCreditDeduction && (
                      <Text style={styles.creditDeduct}>-1 🪙</Text>
                    )}
                  </View>
                  <View style={styles.creditsRow}>
                    <Text style={[styles.creditsText, { color: mutedColor }]}>
                      {p.profile.billCredits} credit{p.profile.billCredits !== 1 ? "s" : ""}
                    </Text>
                  </View>
                  <LoadingBar index={index} />
                </View>
              </View>
            ))}
          </View>

          <Text style={[styles.footer, { color: mutedColor }]}>
            💳 1 bill credit will be deducted from your account
          </Text>

          {onCancel && (
            <TouchableOpacity
              style={[styles.cancelBtn, { borderColor: mutedColor + "55" }]}
              onPress={onCancel}
              activeOpacity={0.8}
            >
              <Text style={[styles.cancelBtnText, { color: mutedColor }]}>Cancel Countdown</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.82)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  card: {
    width: "100%",
    borderRadius: 24,
    padding: 24,
    gap: 16,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 20,
    elevation: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: "800",
    textAlign: "center",
  },
  subtitle: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
    marginTop: -8,
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
    fontSize: 16,
    fontWeight: "500",
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
    gap: 4,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  participantName: {
    fontSize: 15,
    fontWeight: "600",
    flexShrink: 1,
  },
  creditDeduct: {
    fontSize: 13,
    fontWeight: "700",
    color: "#EF4444",
  },
  creditsRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  creditsText: {
    fontSize: 12,
    fontWeight: "500",
  },
  loadingTrack: {
    height: 5,
    borderRadius: 3,
    overflow: "hidden",
    backgroundColor: "rgba(128,128,128,0.18)",
    marginTop: 2,
  },
  loadingFill: {
    height: "100%",
    backgroundColor: Colors.primary,
    borderRadius: 3,
  },
  footer: {
    fontSize: 13,
    textAlign: "center",
    lineHeight: 18,
  },
  cancelBtn: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
  },
  cancelBtnText: {
    fontSize: 14,
    fontWeight: "600",
  },
});
