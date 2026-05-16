import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  Modal,
  Platform,
  TouchableOpacity,
  StyleSheet,
  useColorScheme,
  Dimensions,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withDecay,
  withSequence,
  withTiming,
  withSpring,
  runOnJS,
  Easing,
} from "react-native-reanimated";
import { Svg, Path, G, Text as SvgText } from "react-native-svg";
import { SessionParticipant } from "@/types";
import { Colors } from "@/constants/colors";
import { formatCurrency } from "@/utils/formatter";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const WHEEL_SIZE = Math.min(SCREEN_WIDTH - 80, 300);
const RADIUS = WHEEL_SIZE / 2;
const MAX_SPINS = 3;

interface CentRouletteProps {
  visible: boolean;
  participants: SessionParticipant[];
  adjustmentAmount: number;
  currency: string;
  onAccept: (userId: string) => void;
  onClose: () => void;
  funMode?: boolean;
}

function buildSlicePath(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number
): string {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const x1 = cx + r * Math.cos(toRad(startAngle));
  const y1 = cy + r * Math.sin(toRad(startAngle));
  const x2 = cx + r * Math.cos(toRad(endAngle));
  const y2 = cy + r * Math.sin(toRad(endAngle));
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M${cx},${cy} L${x1},${y1} A${r},${r},0,${largeArc},1,${x2},${y2} Z`;
}

export function CentRoulette({
  visible,
  participants,
  adjustmentAmount,
  currency,
  onAccept,
  onClose,
  funMode = false,
}: CentRouletteProps) {
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<SessionParticipant | null>(null);
  const [spinsLeft, setSpinsLeft] = useState(MAX_SPINS);
  const rotation = useSharedValue(0);

  const isDark = useColorScheme() === "dark";
  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const bgColor = isDark ? Colors.cardDark : Colors.cardLight;
  const curr = currency as "EUR" | "USD" | "CAD" | "GBP";

  const sliceAngle = 360 / participants.length;

  const onSpinComplete = useCallback(
    (finalAngle: number) => {
      // Normalize to 0-360
      const normalized = ((finalAngle % 360) + 360) % 360;
      // The pointer is at top (270° in SVG coords)
      const pointerAngle = (270 - normalized + 360) % 360;
      const idx = Math.floor(pointerAngle / sliceAngle) % participants.length;
      setResult(participants[idx]);
      setSpinning(false);
    },
    [participants, sliceAngle]
  );

  const spin = () => {
    if (spinning || spinsLeft <= 0) return;
    setResult(null);
    setSpinning(true);
    setSpinsLeft((s) => s - 1);

    const extraSpins = 5 + Math.random() * 5;
    const finalAngle =
      rotation.value + extraSpins * 360 + Math.random() * 360;

    rotation.value = withTiming(
      finalAngle,
      { duration: 3000, easing: Easing.out(Easing.cubic) },
      (finished) => {
        if (finished) {
          runOnJS(onSpinComplete)(finalAngle);
        }
      }
    );
  };

  const animatedWheelStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  if (participants.length === 0) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.container, { backgroundColor: bgColor }]}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose}>
            <Text style={[styles.closeText, { color: mutedColor }]}>Cancel</Text>
          </TouchableOpacity>
          <Text style={[styles.title, { color: textColor }]}>
            {funMode ? "Who Pays First?" : "Cent Roulette"}
          </Text>
          <View style={{ width: 60 }} />
        </View>

        <Text style={[styles.subtitle, { color: mutedColor }]}>
          {funMode
            ? "Spin to decide who pays first!"
            : `Who gets the ${formatCurrency(adjustmentAmount, curr)} adjustment?`}
        </Text>

        {/* Pointer */}
        <View style={styles.pointerContainer}>
          <View style={[styles.pointer, { borderBottomColor: Colors.primary }]} />
        </View>

        {/* Wheel */}
        <Animated.View style={[styles.wheelContainer, animatedWheelStyle]}>
          <Svg width={WHEEL_SIZE} height={WHEEL_SIZE}>
            {participants.map((p, i) => {
              const start = i * sliceAngle;
              const end = start + sliceAngle;
              const midAngle = ((start + end) / 2) * (Math.PI / 180);
              const textR = RADIUS * 0.65;
              const tx = RADIUS + textR * Math.cos(midAngle);
              const ty = RADIUS + textR * Math.sin(midAngle);
              return (
                <G key={p.userId}>
                  <Path
                    d={buildSlicePath(RADIUS, RADIUS, RADIUS - 2, start, end)}
                    fill={p.profile.color}
                    stroke="#fff"
                    strokeWidth={2}
                  />
                  <SvgText
                    x={tx}
                    y={ty}
                    textAnchor="middle"
                    alignmentBaseline="middle"
                    fill="#fff"
                    fontSize={12}
                    fontWeight="bold"
                  >
                    {p.profile.name.split(" ")[0].slice(0, 6)}
                  </SvgText>
                </G>
              );
            })}
          </Svg>
        </Animated.View>

        {/* Result */}
        {result && (
          <View style={styles.resultContainer}>
            <Text style={[styles.resultLabel, { color: mutedColor }]}>
              Result:
            </Text>
            <Text style={[styles.resultName, { color: result.profile.color }]}>
              {result.profile.name}
            </Text>
            <Text style={[styles.resultDetail, { color: mutedColor }]}>
              {funMode ? "pays first!" : `gets the ${formatCurrency(adjustmentAmount, curr)} adjustment`}
            </Text>
          </View>
        )}

        {/* Buttons */}
        <View style={styles.actions}>
          {!result && !spinning && (
            <TouchableOpacity
              style={[
                styles.spinBtn,
                spinsLeft === 0 && styles.disabledBtn,
              ]}
              onPress={spin}
              disabled={spinsLeft === 0}
            >
              <Text style={styles.spinText}>
                Spin! ({spinsLeft} left)
              </Text>
            </TouchableOpacity>
          )}

          {spinning && (
            <Text style={[styles.spinningText, { color: mutedColor }]}>
              Spinning...
            </Text>
          )}

          {result && (
            <View style={styles.resultActions}>
              {spinsLeft > 0 && (
                <TouchableOpacity
                  style={[styles.secondaryBtn, { borderColor: mutedColor }]}
                  onPress={spin}
                >
                  <Text style={[styles.secondaryBtnText, { color: mutedColor }]}>
                    Spin Again ({spinsLeft})
                  </Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={styles.acceptBtn}
                onPress={() => funMode ? onClose() : onAccept(result.userId)}
              >
                <Text style={styles.acceptBtnText}>
                  {funMode
                    ? `Got it — ${result.profile.name} pays first!`
                    : `Accept — ${result.profile.name} pays`}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    paddingTop: 20,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  closeText: {
    fontSize: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: "700",
  },
  subtitle: {
    fontSize: 15,
    marginBottom: 16,
    textAlign: "center",
    paddingHorizontal: 40,
  },
  pointerContainer: {
    zIndex: 10,
    marginBottom: -12,
  },
  pointer: {
    width: 0,
    height: 0,
    borderLeftWidth: 12,
    borderRightWidth: 12,
    borderBottomWidth: 24,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
  },
  wheelContainer: {
    width: WHEEL_SIZE,
    height: WHEEL_SIZE,
    borderRadius: WHEEL_SIZE / 2,
    overflow: "hidden",
    elevation: 8,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
      },
      web: {
        boxShadow: "0px 4px 8px rgba(0, 0, 0, 0.3)",
      },
    }),
  },
  resultContainer: {
    alignItems: "center",
    marginTop: 24,
    gap: 4,
  },
  resultLabel: {
    fontSize: 14,
  },
  resultName: {
    fontSize: 28,
    fontWeight: "800",
  },
  resultDetail: {
    fontSize: 14,
  },
  actions: {
    position: "absolute",
    bottom: 40,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    gap: 12,
  },
  spinBtn: {
    backgroundColor: Colors.primary,
    paddingVertical: 18,
    borderRadius: 14,
    alignItems: "center",
  },
  disabledBtn: {
    opacity: 0.4,
  },
  spinText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
  },
  spinningText: {
    textAlign: "center",
    fontSize: 16,
  },
  resultActions: {
    gap: 10,
  },
  secondaryBtn: {
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    borderWidth: 1.5,
  },
  secondaryBtnText: {
    fontSize: 15,
    fontWeight: "600",
  },
  acceptBtn: {
    backgroundColor: Colors.success,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
  },
  acceptBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
});
