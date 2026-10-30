import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useI18nStore } from "@/store/i18nStore";

const THEME = {
  background: "#0A0A0F",
  border: "#252A32",
  primary: "#5B68F4",
  secondary: "#8B8FA3",
};

export type NavTab = "home" | "history" | "credits" | "profile";

export function BottomNavBar({
  activeTab,
  onCenterPress,
}: {
  activeTab: NavTab;
  onCenterPress?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { t, language } = useI18nStore();
  void language;

  return (
    <View style={[styles.bottomNav, { paddingBottom: Math.max(insets.bottom, 16) }]}>
      <TouchableOpacity
        style={styles.navItem}
        onPress={() => router.replace("/(app)")}
        activeOpacity={0.8}
      >
        <Ionicons
          name={activeTab === "home" ? "home" : "home-outline"}
          size={25}
          color={activeTab === "home" ? THEME.primary : THEME.secondary}
        />
        <Text style={[styles.navLabel, activeTab === "home" && styles.navLabelActive]}>{t("nav_home")}</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.navItem}
        onPress={() => router.replace("/(app)/history")}
        activeOpacity={0.8}
      >
        <Ionicons
          name={activeTab === "history" ? "time" : "time-outline"}
          size={25}
          color={activeTab === "history" ? THEME.primary : THEME.secondary}
        />
        <Text style={[styles.navLabel, activeTab === "history" && styles.navLabelActive]}>
          {t("nav_history")}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.navCenterButton}
        onPress={onCenterPress ?? (() => router.replace("/(app)"))}
        activeOpacity={0.85}
      >
        <Ionicons name="add" size={36} color="#fff" />
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.navItem}
        onPress={() => router.replace("/(app)/paywall")}
        activeOpacity={0.8}
      >
        <Ionicons
          name={activeTab === "credits" ? "wallet" : "wallet-outline"}
          size={25}
          color={activeTab === "credits" ? THEME.primary : THEME.secondary}
        />
        <Text style={[styles.navLabel, activeTab === "credits" && styles.navLabelActive]}>
          {t("nav_credits")}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.navItem}
        onPress={() => router.replace("/(app)/profile")}
        activeOpacity={0.8}
      >
        <Ionicons
          name={activeTab === "profile" ? "person" : "person-outline"}
          size={25}
          color={activeTab === "profile" ? THEME.primary : THEME.secondary}
        />
        <Text style={[styles.navLabel, activeTab === "profile" && styles.navLabelActive]}>
          {t("nav_profile")}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  bottomNav: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: THEME.border,
    backgroundColor: THEME.background,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingHorizontal: 8,
  },
  navItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 6,
    gap: 4,
  },
  navLabel: {
    color: THEME.secondary,
    fontSize: 11,
    fontWeight: "500",
  },
  navLabelActive: {
    color: THEME.primary,
  },
  navCenterButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: THEME.primary,
    alignItems: "center",
    justifyContent: "center",
    marginTop: -28,
    shadowColor: THEME.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
});
