import { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { router } from "expo-router";
import Svg, { Circle } from "react-native-svg";
import { useSessionStore } from "@/store/sessionStore";
import { Colors } from "@/constants/colors";
import { useI18nStore } from "@/store/i18nStore";

const SIZE = 140;
const STROKE = 10;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export default function LoadingScreen() {
  const [progress, setProgress] = useState(0);
  const { currentSession } = useSessionStore();
  const { t, language } = useI18nStore();
  void language;

  useEffect(() => {
    const sessionId = currentSession?.id;

    const interval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval);
          setTimeout(() => {
            router.replace(
              sessionId ? `/(app)/dashboard/${sessionId}` : "/(app)"
            );
          }, 300);
          return 100;
        }
        return prev + 2;
      });
    }, 40);

    return () => clearInterval(interval);
  }, []);

  const strokeDashoffset = CIRCUMFERENCE * (1 - progress / 100);

  return (
    <View style={styles.container}>
      <View style={styles.spinnerWrapper}>
        <Svg width={SIZE} height={SIZE} style={styles.svg}>
          {/* Track ring */}
          <Circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            stroke="#2A2A2A"
            strokeWidth={STROKE}
            fill="none"
          />
          {/* Progress arc */}
          <Circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            stroke={Colors.primary}
            strokeWidth={STROKE}
            fill="none"
            strokeDasharray={`${CIRCUMFERENCE}`}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          />
        </Svg>
        <View style={styles.percentOverlay}>
          <Text style={styles.percentage}>{progress}%</Text>
        </View>
      </View>

      <Text style={styles.title}>Pick<Text style={{ color: Colors.primary }}>&</Text>Pay</Text>
      <Text style={styles.text}>{t("loading_group_bill")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0A0A0F",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  spinnerWrapper: {
    width: SIZE,
    height: SIZE,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  svg: {
    position: "absolute",
  },
  percentOverlay: {
    alignItems: "center",
    justifyContent: "center",
  },
  percentage: {
    fontSize: 28,
    fontWeight: "800",
    color: Colors.primary,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
    color: "#FFFFFF",
    letterSpacing: -0.5,
  },
  text: {
    fontSize: 15,
    color: "#9CA3AF",
  },
});
