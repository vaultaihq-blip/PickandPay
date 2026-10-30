import React, { useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  Dimensions,
  Animated,
  Image,
  ImageSourcePropType,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ONBOARDING_KEY } from "./_layout";

const { width: W } = Dimensions.get("window");
const BG = "#000000";
const PRIMARY = "#6366F1";
const CARD_BG = "#111118";
const BORDER = "#1E2028";
const MUTED = "#8B8FA3";
const GREEN = "#22C55E";

const SLIDE_IDS = ["1", "2", "3", "4", "cta"] as const;

// ─── Shared helpers ───────────────────────────────────────────────────────────

function ReceiptRow({
  label,
  price,
  checked,
}: {
  label: string;
  price: string;
  checked?: boolean;
}) {
  const isChecked = checked === true;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 4, gap: 8 }}>
      {checked !== undefined && (
        <View
          style={{
            width: 16, height: 16, borderRadius: 3,
            backgroundColor: isChecked ? PRIMARY : "transparent",
            borderWidth: 1.5, borderColor: isChecked ? PRIMARY : "#3A3D4A",
            alignItems: "center", justifyContent: "center",
          }}
        >
          {isChecked && <Ionicons name="checkmark" size={10} color="#fff" />}
        </View>
      )}
      <Text style={{ flex: 1, color: isChecked ? "#fff" : MUTED, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: isChecked ? "#fff" : MUTED, fontSize: 12, fontWeight: "600" }}>{price}</Text>
    </View>
  );
}

const FACE_IMAGES: ImageSourcePropType[] = [
  require("@/assets/images/face1.png"),
  require("@/assets/images/face2.png"),
  require("@/assets/images/face3.png"),
  require("@/assets/images/face4.png"),
  require("@/assets/images/face5.png"),
];

function AvatarCircle({ faceIndex, size = 34 }: { faceIndex: number; size?: number }) {
  return (
    <View
      style={{
        width: size, height: size, borderRadius: size / 2,
        overflow: "hidden",
        borderWidth: 2, borderColor: CARD_BG,
      }}
    >
      <Image
        source={FACE_IMAGES[faceIndex % FACE_IMAGES.length]}
        style={{ width: size, height: size }}
        resizeMode="cover"
      />
    </View>
  );
}

// ─── Slide visuals ────────────────────────────────────────────────────────────

const SCALLOP_D = 14;
const SCALLOP_N = Math.floor((W - 56) / SCALLOP_D); // card width = W - 2×28 padding

function ScallopedBottom() {
  return (
    <View
      style={{
        backgroundColor: CARD_BG,
        flexDirection: "row",
        height: SCALLOP_D / 2,
        overflow: "hidden",
        borderLeftWidth: 1,
        borderRightWidth: 1,
        borderBottomWidth: 1,
        borderColor: BORDER,
        borderBottomLeftRadius: 8,
        borderBottomRightRadius: 8,
      }}
    >
      {Array.from({ length: SCALLOP_N + 1 }).map((_, i) => (
        <View
          key={i}
          style={{
            flex: 1,
            height: SCALLOP_D,
            borderTopLeftRadius: SCALLOP_D / 2,
            borderTopRightRadius: SCALLOP_D / 2,
            backgroundColor: BG,
            alignSelf: "flex-end",
          }}
        />
      ))}
    </View>
  );
}

function Visual1() {
  const AVT = 57;
  return (
    <View style={{ position: "relative", marginTop: AVT / 2 }}>
      {/* Top-left avatar — straddles top-left corner of card */}
      <View style={{ position: "absolute", top: -(AVT / 2), left: 12, zIndex: 2 }}>
        <AvatarCircle faceIndex={1} size={AVT} />
      </View>
      {/* Top-right avatar — straddles top-right corner of card */}
      <View style={{ position: "absolute", top: -(AVT / 2), right: 12, zIndex: 2 }}>
        <AvatarCircle faceIndex={0} size={AVT} />
      </View>

      {/* Receipt body — no bottom radius, no bottom border (scallop adds it) */}
      <View style={[styles.card, {
        borderBottomLeftRadius: 0, borderBottomRightRadius: 0,
        borderBottomWidth: 0, paddingTop: 36,
      }]}>
        <Text style={styles.cardRestaurant}>THE ROOFTOP</Text>
        <ReceiptRow label="2x Cocktails" price="24.00€" />
        <ReceiptRow label="1x Burger" price="18.00€" />
        <ReceiptRow label="1x Pasta" price="16.00€" />
        <ReceiptRow label="1x Water" price="4.00€" />
        <ReceiptRow label="1x Dessert" price="8.00€" />
        <View style={styles.totalRow}>
          <Text style={{ color: "#fff", fontWeight: "700" }}>Total</Text>
          <Text style={{ color: "#fff", fontWeight: "700" }}>70.00€</Text>
        </View>
        <View style={styles.warningBox}>
          <Text style={{ fontSize: 18 }}>😢</Text>
          <Text style={{ color: "#EF4444", fontSize: 12, flex: 1 }}>
            You pay more than you should.
          </Text>
        </View>
      </View>

      <ScallopedBottom />
    </View>
  );
}

function Visual2() {
  return (
    <View style={{ position: "relative", marginTop: 30 }}>
      {/* Top-left avatar — indicates this is the user's personal bill */}
      <View style={{ position: "absolute", top: -30, left: 8, zIndex: 2 }}>
        <AvatarCircle faceIndex={0} size={60} />
      </View>
      <View style={[styles.card, { paddingTop: 28 }]}>
      <Text style={styles.cardTitle}>Casa Verde</Text>
      <Text style={styles.cardSubtitle}>Lisbon, Portugal</Text>
      <ReceiptRow label="2x Cocktails" price="24.00€" checked={false} />
      <ReceiptRow label="1x Burger" price="18.00€" checked={true} />
      <ReceiptRow label="1x Pasta" price="16.00€" checked={false} />
      <ReceiptRow label="1x Water" price="4.00€" checked={true} />
      <ReceiptRow label="1x Dessert" price="8.00€" checked={false} />
      <View style={[styles.totalRow, { marginBottom: 10 }]}>
        <Text style={{ color: MUTED, fontSize: 12 }}>Total</Text>
        <Text style={{ color: MUTED, fontSize: 12 }}>70.00€</Text>
      </View>
      <View style={styles.fairTotalBox}>
        <Ionicons name="receipt-outline" size={20} color={PRIMARY} />
        <View>
          <Text style={{ color: MUTED, fontSize: 11 }}>Your fair total</Text>
          <Text style={{ color: "#fff", fontWeight: "800", fontSize: 20 }}>22.00€</Text>
        </View>
      </View>
    </View>
    </View>
  );
}

function Visual3() {
  return (
    <View style={styles.card}>
      {/* Live badge */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: 10 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: GREEN }} />
        <Text style={{ color: GREEN, fontSize: 12, fontWeight: "700" }}>Live session · 4 people</Text>
      </View>

      {/* Avatars + QR layout */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 14, marginBottom: 8 }}>
        <AvatarCircle faceIndex={2} size={72} />

        <View style={styles.qrBox}>
          <Ionicons name="qr-code" size={76} color="#000" />
        </View>

        <AvatarCircle faceIndex={3} size={72} />
      </View>

      {/* Bottom avatar centered */}
      <View style={{ alignItems: "center", marginBottom: 8 }}>
        <AvatarCircle faceIndex={4} size={72} />
      </View>

      <Text style={{ color: MUTED, fontSize: 12, textAlign: "center", marginBottom: 10 }}>
        Scan to join
      </Text>

      <View style={styles.liveEvent}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: GREEN }} />
        <Text style={{ color: GREEN, fontSize: 12, flex: 1 }}>Joana selected 2 items</Text>
        <Text style={{ color: MUTED, fontSize: 11 }}>2s ago</Text>
      </View>
    </View>
  );
}

function Visual4() {
  return (
    <View style={{ gap: 10 }}>
      <View style={styles.card}>
        <Text style={{ color: MUTED, fontSize: 11 }}>Your last trip</Text>
        <Text style={{ color: "#fff", fontWeight: "700", fontSize: 15, marginBottom: 4 }}>Casa Verde</Text>
        <Text style={{ color: MUTED, fontSize: 11 }}>Everyone paid (equal split)</Text>
        <Text style={{ color: "#fff", fontWeight: "800", fontSize: 22 }}>28.00€</Text>
      </View>
      <View style={[styles.card, { borderColor: GREEN + "33" }]}>
        <Text style={{ color: MUTED, fontSize: 11 }}>Your fair total</Text>
        <Text style={{ color: GREEN, fontWeight: "800", fontSize: 22, marginBottom: 4 }}>16.40€</Text>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ color: GREEN, fontSize: 13, fontWeight: "600" }}>You saved</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={{ color: GREEN, fontWeight: "800", fontSize: 16 }}>11.60€</Text>
            <View style={{ backgroundColor: GREEN, borderRadius: 10, padding: 3 }}>
              <Ionicons name="arrow-up" size={12} color="#fff" />
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

// ─── Content slide ────────────────────────────────────────────────────────────

const SLIDE_TEXT = {
  "1": {
    before: "Stop paying for\n",
    accent: "other people's orders.",
    after: "",
    subtitle: "Restaurant bills are rarely split fairly.",
  },
  "2": {
    before: "Pay only for what you ",
    accent: "actually",
    after: " ordered.",
    subtitle: "Scan the receipt, pick your items, and we do the rest.",
  },
  "3": {
    before: "Split in ",
    accent: "real time",
    after: "\nwith your friends.",
    subtitle: "Everyone selects together. Everyone sees everything.",
  },
  "4": {
    before: "Fair splitting\n",
    accent: "saves you money.",
    after: "",
    subtitle: "Thousands of users are already saving.",
  },
} as const;

const VISUALS: Record<string, React.ReactNode> = {
  "1": <Visual1 />,
  "2": <Visual2 />,
  "3": <Visual3 />,
  "4": <Visual4 />,
};

function ContentSlide({ id }: { id: string }) {
  const txt = SLIDE_TEXT[id as keyof typeof SLIDE_TEXT];
  return (
    <View style={[styles.slide, { width: W }]}>
      <Text style={styles.title}>
        {txt.before}
        <Text style={{ color: PRIMARY }}>{txt.accent}</Text>
        {txt.after}
      </Text>
      <Text style={styles.subtitle}>{txt.subtitle}</Text>
      <View style={{ marginTop: 8, alignSelf: "stretch" }}>{VISUALS[id]}</View>
    </View>
  );
}

// ─── CTA slide ────────────────────────────────────────────────────────────────

const FEATURES = [
  { icon: "shield-checkmark-outline", label: "100% Fair" },
  { icon: "flash-outline", label: "Real-time" },
  { icon: "lock-closed-outline", label: "Secure" },
  { icon: "happy-outline", label: "Easy to use" },
] as const;

function CtaSlide({ onStart }: { onStart: () => void }) {
  return (
    <View style={[styles.slide, styles.ctaSlide, { width: W }]}>
      <Image
        source={require("@/assets/images/icon.png")}
        style={styles.appIcon}
      />
      <Text style={styles.ctaTitle}>
        Time to split{"\n"}
        <Text style={{ color: PRIMARY }}>smarter.</Text>
      </Text>
      <Text style={styles.ctaSubtitle}>
        Join Pick&Pay and never overpay again.
      </Text>
      <View style={styles.featureRow}>
        {FEATURES.map((f) => (
          <View key={f.label} style={styles.featureBadge}>
            <Ionicons name={f.icon as any} size={13} color={PRIMARY} />
            <Text style={styles.featureLabel}>{f.label}</Text>
          </View>
        ))}
      </View>
      <TouchableOpacity style={styles.ctaBtn} onPress={onStart} activeOpacity={0.85}>
        <Text style={styles.ctaBtnText}>Get Started</Text>
        <Ionicons name="arrow-forward" size={20} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function OnboardingScreen() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const flatListRef = useRef<FlatList>(null);
  const scrollX = useRef(new Animated.Value(0)).current;
  const isLast = currentIndex === SLIDE_IDS.length - 1;

  const handleDone = async () => {
    await AsyncStorage.setItem(ONBOARDING_KEY, "true");
    router.replace("/(app)");
  };

  const handleNext = () => {
    if (currentIndex < SLIDE_IDS.length - 1) {
      flatListRef.current?.scrollToIndex({ index: currentIndex + 1, animated: true });
    } else {
      handleDone();
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" backgroundColor={BG} translucent={false} />

      {!isLast && (
        <TouchableOpacity style={styles.skipBtn} onPress={handleDone}>
          <Text style={styles.skipText}>Skip</Text>
        </TouchableOpacity>
      )}

      <Animated.FlatList
        ref={flatListRef}
        data={SLIDE_IDS}
        keyExtractor={(id) => id}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        bounces={false}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { x: scrollX } } }],
          { useNativeDriver: false }
        )}
        onMomentumScrollEnd={(e) => {
          setCurrentIndex(Math.round(e.nativeEvent.contentOffset.x / W));
        }}
        renderItem={({ item }) =>
          item === "cta" ? (
            <CtaSlide onStart={handleDone} />
          ) : (
            <ContentSlide id={item} />
          )
        }
      />

      <View style={styles.dotsRow}>
        {SLIDE_IDS.map((_, i) => {
          const inputRange = [(i - 1) * W, i * W, (i + 1) * W];
          const dotWidth = scrollX.interpolate({ inputRange, outputRange: [8, 24, 8], extrapolate: "clamp" });
          const opacity = scrollX.interpolate({ inputRange, outputRange: [0.4, 1, 0.4], extrapolate: "clamp" });
          return (
            <Animated.View
              key={i}
              style={[styles.dot, { width: dotWidth, opacity, backgroundColor: PRIMARY }]}
            />
          );
        })}
      </View>

      {!isLast && (
        <TouchableOpacity style={styles.nextBtn} onPress={handleNext} activeOpacity={0.85}>
          <Text style={styles.nextBtnText}>Next</Text>
          <Ionicons name="arrow-forward" size={20} color="#fff" />
        </TouchableOpacity>
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: BG },

  skipBtn: { position: "absolute", top: 60, right: 24, zIndex: 10 },
  skipText: { color: MUTED, fontSize: 15, fontWeight: "600" },

  slide: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: 48,
    paddingBottom: 8,
    justifyContent: "center",
    gap: 14,
  },
  title: {
    fontSize: 30,
    fontWeight: "800",
    color: "#fff",
    letterSpacing: -0.5,
    lineHeight: 36,
  },
  subtitle: { fontSize: 15, color: MUTED, lineHeight: 22 },

  card: {
    backgroundColor: CARD_BG,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: BORDER,
  },
  cardRestaurant: {
    color: "#fff", fontWeight: "700", textAlign: "center",
    marginBottom: 8, letterSpacing: 1, fontSize: 11,
  },
  cardTitle: { color: "#fff", fontWeight: "700", textAlign: "center", marginBottom: 2, fontSize: 13 },
  cardSubtitle: { color: MUTED, fontSize: 11, textAlign: "center", marginBottom: 8 },
  totalRow: {
    borderTopWidth: 1, borderColor: BORDER,
    marginTop: 6, paddingTop: 6,
    flexDirection: "row", justifyContent: "space-between",
  },
  warningBox: {
    marginTop: 10, flexDirection: "row", alignItems: "center",
    gap: 8, backgroundColor: "#1A0A0A", borderRadius: 8, padding: 8,
  },
  fairTotalBox: {
    backgroundColor: PRIMARY + "18", borderRadius: 8, padding: 10,
    flexDirection: "row", alignItems: "center", gap: 10,
  },
  qrBox: {
    alignSelf: "center", width: 100, height: 100,
    backgroundColor: "#fff", borderRadius: 8,
    alignItems: "center", justifyContent: "center", marginBottom: 8,
  },
  liveEvent: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "#0D1A12", borderRadius: 8, padding: 8,
  },

  dotsRow: {
    flexDirection: "row", alignItems: "center",
    justifyContent: "center", gap: 6, paddingVertical: 14,
  },
  dot: { height: 8, borderRadius: 4 },

  nextBtn: {
    marginHorizontal: 24, marginBottom: 28,
    backgroundColor: PRIMARY, borderRadius: 16,
    paddingVertical: 16, flexDirection: "row",
    alignItems: "center", justifyContent: "center", gap: 10,
  },
  nextBtnText: { color: "#fff", fontSize: 17, fontWeight: "700" },

  ctaSlide: { alignItems: "center", justifyContent: "center", paddingTop: 0 },
  appIcon: { width: 96, height: 96, borderRadius: 22 },
  ctaTitle: {
    fontSize: 32, fontWeight: "800", color: "#fff",
    textAlign: "center", letterSpacing: -0.5, lineHeight: 40,
  },
  ctaSubtitle: { fontSize: 15, color: MUTED, textAlign: "center", lineHeight: 22 },
  featureRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, justifyContent: "center" },
  featureBadge: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: CARD_BG, borderRadius: 20,
    paddingHorizontal: 12, paddingVertical: 7,
    borderWidth: 1, borderColor: BORDER,
  },
  featureLabel: { color: "#C4C7D4", fontSize: 12, fontWeight: "600" },
  ctaBtn: {
    backgroundColor: PRIMARY, borderRadius: 16,
    paddingVertical: 16, alignSelf: "stretch",
    alignItems: "center", flexDirection: "row",
    justifyContent: "center", gap: 8, marginTop: 6,
  },
  ctaBtnText: { color: "#fff", fontSize: 17, fontWeight: "700" },
});
