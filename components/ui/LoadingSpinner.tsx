import React, { useEffect } from "react";
import { View, Text, StyleSheet, useColorScheme } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { Colors } from "@/constants/colors";

interface LoadingSpinnerProps {
  size?: number;
  color?: string;
  label?: string;
  fullScreen?: boolean;
}

export function LoadingSpinner({
  size = 32,
  color = Colors.primary,
  label,
  fullScreen = false,
}: LoadingSpinnerProps) {
  const rotation = useSharedValue(0);
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";

  useEffect(() => {
    rotation.value = withRepeat(
      withTiming(360, { duration: 800, easing: Easing.linear }),
      -1
    );
  }, [rotation]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  const content = (
    <View style={styles.container}>
      <Animated.View style={[animatedStyle]}>
        <View
          style={[
            styles.spinner,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              borderColor: color + "33",
              borderTopColor: color,
              borderWidth: size / 10,
            },
          ]}
        />
      </Animated.View>
      {label && (
        <Text
          style={[
            styles.label,
            { color: isDark ? Colors.textSecondaryDark : Colors.textSecondaryLight },
          ]}
        >
          {label}
        </Text>
      )}
    </View>
  );

  if (fullScreen) {
    return (
      <View
        style={[
          styles.fullScreen,
          { backgroundColor: isDark ? Colors.bgDark : Colors.bgLight },
        ]}
      >
        {content}
      </View>
    );
  }

  return content;
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  spinner: {
    borderStyle: "solid",
  },
  label: {
    fontSize: 14,
    fontWeight: "500",
  },
  fullScreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
