import React from "react";
import Svg, { Circle, Path } from "react-native-svg";
import { Colors } from "@/constants/colors";
import type { GroupKind } from "./groups";

// D.3 — inline SVG icons for the receipt's groups, in the app's muted text
// colour: a plate (Comidas), a glass (Bebidas), a neutral dot (Outros).
export function GroupIcon({ kind, size = 18, color = Colors.textMutedDark }: { kind: GroupKind; size?: number; color?: string }) {
  if (kind === "food") {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round">
        <Circle cx={12} cy={13} r={7} />
        <Circle cx={12} cy={13} r={3.5} />
        <Path d="M3 4v5M5 4v5M4 9v11M20 4c-1.5 1-2 3-2 5h2v11" />
      </Svg>
    );
  }
  if (kind === "drinks") {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M6 3h12l-1.5 7a4.5 4.5 0 0 1-9 0L6 3z" />
        <Path d="M12 14.5V20M8.5 21h7" />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8}>
      <Circle cx={12} cy={12} r={8} />
      <Circle cx={12} cy={12} r={1.5} fill={color} />
    </Svg>
  );
}
