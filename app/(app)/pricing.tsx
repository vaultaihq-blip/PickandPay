import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  InteractionManager,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { getOfferings, purchasePackage, restorePurchases } from "@/lib/revenuecat";
import type { PurchasesPackage } from "react-native-purchases";
import { useAuthStore } from "@/store/authStore";
import { BottomNavBar } from "@/components/ui/BottomNavBar";


type PackageDisplay = {
  id: string;
  name: string;
  description: string;
  badge: string;
  credits: string;
  priceString: string;
  accent: string;
  pkg?: PurchasesPackage;
};

const FALLBACK_PACKAGES: PackageDisplay[] = [
  {
    id: "value_pack",
    name: "Value Pack",
    description: "15 bill credits for everyday use",
    badge: "Most Popular",
    credits: "15 bills",
    priceString: "—",
    accent: Colors.primary,
  },
  {
    id: "pro_pack",
    name: "Pro Pack",
    description: "50 bill credits for frequent splits",
    badge: "Best Value",
    credits: "50 bills",
    priceString: "—",
    accent: Colors.success,
  },
];

function packageToDisplay(pkg: PurchasesPackage): PackageDisplay {
  const id = `${pkg.identifier} ${pkg.product.identifier}`.toLowerCase();
  if (id.includes("pro_pack") || id.includes("50")) {
    return {
      id: pkg.identifier,
      name: "Pro Pack",
      description: "50 bill credits for frequent splits",
      badge: "Best Value",
      credits: "50 bills",
      priceString: pkg.product.priceString,
      accent: Colors.success,
      pkg,
    };
  }
  return {
    id: pkg.identifier,
    name: "Value Pack",
    description: "15 bill credits for everyday use",
    badge: "Most Popular",
    credits: "15 bills",
    priceString: pkg.product.priceString,
    accent: Colors.primary,
    pkg,
  };
}

export default function PricingScreen() {
  const insets = useSafeAreaInsets();
  const { user, profile, loadProfile } = useAuthStore();
  const [packages, setPackages] = useState<PurchasesPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  const displayPackages = useMemo<PackageDisplay[]>(() => {
    if (packages.length === 0) return FALLBACK_PACKAGES;
    return [...packages]
      .map(packageToDisplay)
      .sort((a, b) => a.credits.localeCompare(b.credits));
  }, [packages]);

  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      void loadPackages();
    });
    return () => task.cancel();
  }, []);

  async function refreshProfile() {
    if (user?.id) await loadProfile(user.id);
  }

  async function loadPackages() {
    try {
      setLoading(true);
      const offering = await getOfferings();
      setPackages(offering?.availablePackages ?? []);
    } catch (error) {
      console.error("[Pricing] Load failed:", error);
      Alert.alert("Error", "Could not load pricing.");
    } finally {
      setLoading(false);
    }
  }

  async function handlePurchase(display: PackageDisplay) {
    if (!display.pkg) {
      Alert.alert(
        "Not available",
        "Purchases are only available when the app is installed from the Play Store or App Store."
      );
      return;
    }
    try {
      setPurchasing(display.id);
      const result = await purchasePackage(display.pkg);

      if (result.success) {
        await refreshProfile();
        Alert.alert(
          "Success",
          result.creditsAdded
            ? `${result.creditsAdded} bill credits have been added to your account.`
            : "Credits have been added to your account.",
          [{ text: "OK", onPress: () => router.back() }]
        );
      } else if (!result.cancelled) {
        Alert.alert("Purchase failed", result.error || "Could not complete purchase. Please try again.");
      }
    } catch (error) {
      console.error("[Pricing] Purchase error:", error);
      Alert.alert("Error", "Something went wrong. Please try again.");
    } finally {
      setPurchasing(null);
    }
  }

  async function handleRestore() {
    try {
      setRestoring(true);
      const result = await restorePurchases();
      if (result.success) {
        Alert.alert(
          "Restore complete",
          "Your purchase history has been verified. Credit balance is not affected — used credits remain consumed."
        );
      } else {
        Alert.alert("Nothing to restore", "No previous purchases were found for this account.");
      }
    } catch (error) {
      console.error("[Pricing] Restore error:", error);
      Alert.alert("Error", "Could not restore purchases.");
    } finally {
      setRestoring(false);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.loadingText}>Loading packages...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.headerBtn}>
          <Ionicons name="arrow-back" color="#F9FAFB" size={24} />
        </Pressable>
        <Text style={styles.headerTitle}>Choose Your Plan</Text>
        <View style={styles.headerBtn} />
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: 120 + insets.bottom }]}>
        <Text style={styles.subtitle}>Start with 1 free bill, no credit card required</Text>

        <View style={styles.balanceCard}>
          <Ionicons name="receipt-outline" size={24} color={Colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.balanceTitle}>Current balance</Text>
            <Text style={styles.balanceText}>
              {profile?.billCredits ?? 0} {(profile?.billCredits ?? 0) === 1 ? "bill" : "bills"} available
            </Text>
          </View>
        </View>

        <View style={styles.freeBanner}>
          <Ionicons name="gift-outline" size={28} color={Colors.primary} />
          <View style={styles.freeBannerContent}>
            <Text style={styles.freeBannerTitle}>1 Free Bill to Try</Text>
            <Text style={styles.freeBannerText}>No credit card required</Text>
          </View>
        </View>

        {Platform.OS === "web" && (
          <View style={styles.webBanner}>
            <Ionicons name="phone-portrait-outline" size={20} color="#F59E0B" />
            <View style={{ flex: 1 }}>
              <Text style={styles.webBannerTitle}>Purchases require the app</Text>
              <Text style={styles.webBannerText}>
                Download Pick&amp;Pay for iOS or Android to buy credit packs.
              </Text>
              <View style={styles.webBannerButtons}>
                <Pressable
                  style={styles.webStoreBtn}
                  onPress={() => Linking.openURL("https://apps.apple.com/app/pickandpay")}
                >
                  <Ionicons name="logo-apple" size={14} color="#fff" />
                  <Text style={styles.webStoreBtnText}>App Store</Text>
                </Pressable>
                <Pressable
                  style={styles.webStoreBtn}
                  onPress={() => Linking.openURL("https://play.google.com/store/apps/details?id=com.pickandpay.app")}
                >
                  <Ionicons name="logo-google-playstore" size={14} color="#fff" />
                  <Text style={styles.webStoreBtnText}>Play Store</Text>
                </Pressable>
              </View>
            </View>
          </View>
        )}

        {packages.length === 0 && !loading && (
          <View style={styles.storeNotice}>
            <Ionicons name="information-circle-outline" size={16} color="#9CA3AF" />
            <Text style={styles.storeNoticeText}>
              Live prices load from the store. Purchases require the Play Store or App Store version.
            </Text>
          </View>
        )}

        <View style={styles.packages}>
          {displayPackages.map((display) => {
            const isPurchasing = purchasing === display.id;
            const isPopular = display.badge === "Most Popular";
            const isFallback = !display.pkg;

            return (
              <View
                key={display.id}
                style={[
                  styles.packageCard,
                  { borderColor: isPopular ? Colors.primary : "#252A32" },
                ]}
              >
                <View style={[styles.badge, { backgroundColor: display.accent }]}>
                  <Text style={styles.badgeText}>{display.badge}</Text>
                </View>

                <View style={styles.packageHeader}>
                  <View>
                    <Text style={styles.packageName}>{display.name}</Text>
                    <Text style={styles.packageDescription}>{display.description}</Text>
                  </View>
                  <Text style={[styles.creditCount, { color: display.accent }]}>{display.credits}</Text>
                </View>

                <View style={styles.packagePricing}>
                  <Text style={[styles.packagePrice, isFallback && { color: "#555" }]}>
                    {display.priceString}
                  </Text>
                </View>

                <Pressable
                  style={[
                    styles.packageButton,
                    { backgroundColor: isFallback ? "#2A2D3A" : display.accent },
                    isPurchasing && styles.packageButtonDisabled,
                  ]}
                  onPress={() => handlePurchase(display)}
                  disabled={!!purchasing || restoring}
                >
                  {isPurchasing ? (
                    <ActivityIndicator size="small" color="#FFF" />
                  ) : (
                    <Text style={[styles.packageButtonText, isFallback && { color: "#9CA3AF" }]}>
                      {isFallback ? "Available on Store" : "Purchase"}
                    </Text>
                  )}
                </Pressable>
              </View>
            );
          })}
        </View>

        <Pressable
          onPress={handleRestore}
          style={styles.restoreButton}
          disabled={restoring || !!purchasing}
        >
          {restoring ? (
            <ActivityIndicator size="small" color={Colors.primary} />
          ) : (
            <Text style={styles.restoreButtonText}>Restore Purchases</Text>
          )}
        </Pressable>

        <Text style={styles.footerText}>Credits never expire and work across all features.</Text>
      </ScrollView>

      <BottomNavBar activeTab="credits" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#0B0D10" },
  centered: { flex: 1, justifyContent: "center", alignItems: "center" },
  loadingText: { marginTop: 12, fontSize: 14, color: "#9CA3AF" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  headerBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: { fontSize: 18, fontWeight: "700", color: "#F9FAFB" },
  content: { paddingHorizontal: 20, gap: 18 },
  subtitle: {
    fontSize: 15,
    color: "#9CA3AF",
    textAlign: "center",
    lineHeight: 21,
  },
  balanceCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#15181D",
    padding: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#252A32",
  },
  balanceTitle: { fontSize: 13, color: "#9CA3AF", fontWeight: "600" },
  balanceText: { fontSize: 16, color: "#F9FAFB", fontWeight: "800", marginTop: 2 },
  freeBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#15181D",
    padding: 16,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: Colors.primary,
    gap: 12,
  },
  freeBannerContent: { flex: 1 },
  freeBannerTitle: { fontSize: 16, fontWeight: "700", color: Colors.primary },
  freeBannerText: { fontSize: 14, color: "#9CA3AF", marginTop: 2 },
  packages: { gap: 18 },
  packageCard: {
    backgroundColor: "#15181D",
    borderRadius: 16,
    padding: 22,
    borderWidth: 2,
    position: "relative",
  },
  badge: {
    position: "absolute",
    top: -12,
    alignSelf: "center",
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 12,
  },
  badgeText: { color: "#FFF", fontSize: 12, fontWeight: "700" },
  packageHeader: {
    marginTop: 8,
    marginBottom: 16,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
  },
  packageName: { fontSize: 20, fontWeight: "800", color: "#F9FAFB", marginBottom: 4 },
  packageDescription: { fontSize: 14, color: "#9CA3AF", maxWidth: 190 },
  creditCount: { fontSize: 14, fontWeight: "800", marginTop: 3 },
  packagePricing: {
    alignItems: "center",
    marginBottom: 18,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: "#252A32",
  },
  packagePrice: { fontSize: 38, fontWeight: "900", color: "#F9FAFB" },
  packageButton: {
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    minHeight: 48,
    justifyContent: "center",
  },
  packageButtonDisabled: { opacity: 0.55 },
  packageButtonText: { color: "#FFF", fontSize: 16, fontWeight: "700" },
  restoreButton: { paddingVertical: 12, alignItems: "center", minHeight: 44 },
  restoreButtonText: { fontSize: 14, color: Colors.primary, fontWeight: "700" },
  footerText: {
    fontSize: 13,
    color: "#9CA3AF",
    textAlign: "center",
    lineHeight: 18,
  },
  storeNotice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "#15181D",
    borderRadius: 10,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#252A32",
  },
  storeNoticeText: {
    flex: 1,
    fontSize: 12,
    color: "#9CA3AF",
    lineHeight: 17,
  },
  webBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    backgroundColor: "#1C1A0F",
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#F59E0B44",
  },
  webBannerTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#F59E0B",
    marginBottom: 4,
  },
  webBannerText: {
    fontSize: 13,
    color: "#9CA3AF",
    lineHeight: 18,
    marginBottom: 10,
  },
  webBannerButtons: {
    flexDirection: "row",
    gap: 8,
  },
  webStoreBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#252A32",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  webStoreBtnText: {
    color: "#F9FAFB",
    fontSize: 12,
    fontWeight: "600",
  },
});

