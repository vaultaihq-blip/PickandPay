import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  useColorScheme,
  Alert,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { CREDIT_PACKS, CreditPack } from "@/constants/packs";
import { useAuthStore } from "@/store/authStore";

export default function PaywallScreen() {
  const isDark = useColorScheme() === "dark";
  const { profile, addCredits } = useAuthStore();
  const [selected, setSelected] = useState<string>("pack_5");
  const [purchasing, setPurchasing] = useState(false);

  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;

  const selectedPack = CREDIT_PACKS.find((p) => p.id === selected)!;

  const handlePurchase = async () => {
    setPurchasing(true);
    // Mock purchase — in production, integrate with RevenueCat / Stripe
    await new Promise((r) => setTimeout(r, 800));
    addCredits(selectedPack.credits);
    setPurchasing(false);
    Alert.alert(
      "Credits Added!",
      `${selectedPack.credits} scan credit${selectedPack.credits > 1 ? "s" : ""} added to your account.`,
      [{ text: "Done", onPress: () => router.back() }]
    );
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Ionicons name="close" size={26} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: textColor }]}>Get Scan Credits</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Hero */}
        <View style={styles.hero}>
          <View style={[styles.heroIcon, { backgroundColor: Colors.primary + "22" }]}>
            <Ionicons name="sparkles" size={40} color={Colors.primary} />
          </View>
          <Text style={[styles.heroTitle, { color: textColor }]}>AI Receipt Scanning</Text>
          <Text style={[styles.heroSub, { color: mutedColor }]}>
            Each scan uses 1 credit. Scan receipts instantly with AI — no manual entry needed.
          </Text>
        </View>

        {/* Current balance */}
        <View style={[styles.balanceRow, { backgroundColor: cardColor, borderColor }]}>
          <Ionicons name="wallet-outline" size={20} color={Colors.primary} />
          <Text style={[styles.balanceText, { color: textColor }]}>
            Current balance:{" "}
            <Text style={{ color: Colors.primary, fontWeight: "700" }}>
              {profile?.billCredits ?? 0} credit{(profile?.billCredits ?? 0) !== 1 ? "s" : ""}
            </Text>
          </Text>
        </View>

        {/* Packs */}
        <Text style={[styles.sectionLabel, { color: mutedColor }]}>CHOOSE A PACK</Text>
        {CREDIT_PACKS.map((pack) => (
          <PackCard
            key={pack.id}
            pack={pack}
            isSelected={selected === pack.id}
            onSelect={() => setSelected(pack.id)}
            textColor={textColor}
            mutedColor={mutedColor}
            borderColor={borderColor}
            cardColor={cardColor}
          />
        ))}

        {/* Features */}
        <View style={styles.features}>
          {FEATURES.map((f) => (
            <View key={f} style={styles.featureRow}>
              <Ionicons name="checkmark-circle" size={18} color={Colors.success} />
              <Text style={[styles.featureText, { color: mutedColor }]}>{f}</Text>
            </View>
          ))}
        </View>
      </ScrollView>

      {/* Buy button */}
      <View style={[styles.footer, { borderColor }]}>
        <TouchableOpacity
          style={[styles.buyBtn, purchasing && { opacity: 0.6 }]}
          onPress={handlePurchase}
          disabled={purchasing}
          activeOpacity={0.85}
        >
          <Text style={styles.buyBtnText}>
            {purchasing
              ? "Processing..."
              : `Buy ${selectedPack.credits} Credit${selectedPack.credits > 1 ? "s" : ""} — $${selectedPack.price.toFixed(2)}`}
          </Text>
        </TouchableOpacity>
        <Text style={[styles.footerNote, { color: mutedColor }]}>
          Credits never expire · Secure payment
        </Text>
      </View>
    </SafeAreaView>
  );
}

function PackCard({
  pack,
  isSelected,
  onSelect,
  textColor,
  mutedColor,
  borderColor,
  cardColor,
}: {
  pack: CreditPack;
  isSelected: boolean;
  onSelect: () => void;
  textColor: string;
  mutedColor: string;
  borderColor: string;
  cardColor: string;
}) {
  return (
    <TouchableOpacity
      style={[
        styles.packCard,
        { backgroundColor: cardColor, borderColor: isSelected ? Colors.primary : borderColor },
        isSelected && styles.packCardSelected,
      ]}
      onPress={onSelect}
      activeOpacity={0.8}
    >
      {pack.highlight && (
        <View style={styles.packBadge}>
          <Text style={styles.packBadgeText}>{pack.highlight}</Text>
        </View>
      )}
      <View style={styles.packLeft}>
        <Text style={[styles.packCredits, { color: textColor }]}>
          {pack.credits} {pack.credits === 1 ? "Credit" : "Credits"}
        </Text>
        <Text style={[styles.packLabel, { color: mutedColor }]}>{pack.label}</Text>
      </View>
      <View style={styles.packRight}>
        <Text style={[styles.packPrice, { color: Colors.primary }]}>${pack.price.toFixed(2)}</Text>
        <Text style={[styles.packPer, { color: mutedColor }]}>
          ${(pack.price / pack.credits).toFixed(2)}/scan
        </Text>
      </View>
      <View style={[styles.packRadio, isSelected && styles.packRadioSelected]}>
        {isSelected && <View style={styles.packRadioInner} />}
      </View>
    </TouchableOpacity>
  );
}

const FEATURES = [
  "Instant AI-powered receipt parsing",
  "Works with any restaurant receipt",
  "Supports 4 currencies",
  "Credits never expire",
];

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
    paddingHorizontal: 20,
    paddingBottom: 20,
    gap: 12,
  },
  hero: {
    alignItems: "center",
    paddingVertical: 20,
    gap: 10,
  },
  heroIcon: {
    width: 80,
    height: 80,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  heroTitle: {
    fontSize: 24,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  heroSub: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
    paddingHorizontal: 16,
  },
  balanceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  balanceText: {
    fontSize: 14,
    fontWeight: "500",
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    marginTop: 4,
  },
  packCard: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 14,
    borderWidth: 2,
    paddingHorizontal: 16,
    paddingVertical: 16,
    position: "relative",
    overflow: "hidden",
  },
  packCardSelected: {
    borderWidth: 2,
  },
  packBadge: {
    position: "absolute",
    top: 0,
    right: 0,
    backgroundColor: Colors.primary,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderBottomLeftRadius: 10,
  },
  packBadgeText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
  },
  packLeft: {
    flex: 1,
    gap: 2,
  },
  packCredits: {
    fontSize: 17,
    fontWeight: "700",
  },
  packLabel: {
    fontSize: 13,
  },
  packRight: {
    alignItems: "flex-end",
    gap: 2,
    marginRight: 14,
  },
  packPrice: {
    fontSize: 18,
    fontWeight: "800",
  },
  packPer: {
    fontSize: 12,
  },
  packRadio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: "#9CA3AF",
    alignItems: "center",
    justifyContent: "center",
  },
  packRadioSelected: {
    borderColor: Colors.primary,
  },
  packRadioInner: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: Colors.primary,
  },
  features: {
    gap: 10,
    paddingVertical: 8,
  },
  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  featureText: {
    fontSize: 14,
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  buyBtn: {
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
  },
  buyBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  footerNote: {
    fontSize: 12,
    textAlign: "center",
  },
});
