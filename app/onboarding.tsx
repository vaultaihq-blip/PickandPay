import React, { useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  useColorScheme,
  FlatList,
  Dimensions,
  Animated,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Colors } from "@/constants/colors";
import { ONBOARDING_KEY } from "./_layout";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

interface Slide {
  id: string;
  isCta?: boolean;
  // standard slide fields
  icon?: string;
  iconBg?: string;
  title?: string;
  subtitle?: string;
  bullets?: string[];
}

const SLIDES: Slide[] = [
  {
    id: "1",
    icon: "people-outline",
    iconBg: "#6366F1",
    title: "Welcome to Pick&Pay",
    subtitle: "The smartest way to split restaurant bills fairly — every time.",
  },
  {
    id: "2",
    icon: "qr-code-outline",
    iconBg: "#F59E0B",
    title: "Create Your Session",
    subtitle:
      "Share your QR code. Friends join on their phone before you even scan the bill.",
    bullets: [
      "Everyone joins the session first",
      "Real-time updates as people join",
      "No manual name entry needed",
    ],
  },
  {
    id: "3",
    icon: "scan-outline",
    iconBg: "#3B82F6",
    title: "Scan Any Receipt",
    subtitle:
      "Point your camera at the bill. AI reads every item in seconds — even messy handwriting.",
    bullets: [
      "Works with any restaurant receipt",
      "AI extracts all items & prices automatically",
      "Full image sent — no cropping needed",
    ],
  },
  {
    id: "4",
    icon: "checkmark-done-outline",
    iconBg: "#10B981",
    title: "Review & Accept",
    subtitle:
      "Everyone reviews the bill, picks a tip, and accepts before moving on.",
    bullets: [
      "Choose tip: No tip / 10% / 15% / 20%",
      "All acceptances visible in real-time",
      "No one gets surprised at the end",
    ],
  },
  {
    id: "5",
    icon: "list-outline",
    iconBg: "#A855F7",
    title: "Pick What You Had",
    subtitle:
      "Each person taps their own items. Shared dishes split automatically between whoever ordered them.",
    bullets: [
      "Individual & shared item support",
      "See who's done in real-time",
      "Fair to the last cent",
    ],
  },
  {
    id: "6",
    isCta: true,
  },
];

export default function OnboardingScreen() {
  const isDark = useColorScheme() === "dark";
  const [currentIndex, setCurrentIndex] = useState(0);
  const flatListRef = useRef<FlatList>(null);
  const scrollX = useRef(new Animated.Value(0)).current;

  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;

  const handleDone = async () => {
    await AsyncStorage.setItem(ONBOARDING_KEY, "true");
    router.replace("/(app)");
  };

  const handleNext = () => {
    if (currentIndex < SLIDES.length - 1) {
      flatListRef.current?.scrollToIndex({ index: currentIndex + 1, animated: true });
    } else {
      handleDone();
    }
  };

  const handleSkip = async () => {
    await AsyncStorage.setItem(ONBOARDING_KEY, "true");
    router.replace("/(app)");
  };

  const isLastSlide = currentIndex === SLIDES.length - 1;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
      {/* Skip button */}
      <View style={styles.topRow}>
        <View style={{ flex: 1 }} />
        {!isLastSlide && (
          <TouchableOpacity
            onPress={handleSkip}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={[styles.skipText, { color: mutedColor }]}>Skip</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Slides */}
      <Animated.FlatList
        ref={flatListRef}
        data={SLIDES}
        keyExtractor={(item) => item.id}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        bounces={false}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { x: scrollX } } }],
          { useNativeDriver: false }
        )}
        onMomentumScrollEnd={(e) => {
          const idx = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
          setCurrentIndex(idx);
        }}
        renderItem={({ item }) =>
          item.isCta ? (
            <CtaSlide
              textColor={textColor}
              mutedColor={mutedColor}
              onGetStarted={handleDone}
            />
          ) : (
            <SlideItem slide={item} textColor={textColor} mutedColor={mutedColor} />
          )
        }
      />

      {/* Dots */}
      <View style={styles.dotsRow}>
        {SLIDES.map((_, idx) => {
          const inputRange = [
            (idx - 1) * SCREEN_WIDTH,
            idx * SCREEN_WIDTH,
            (idx + 1) * SCREEN_WIDTH,
          ];
          const dotWidth = scrollX.interpolate({
            inputRange,
            outputRange: [8, 24, 8],
            extrapolate: "clamp",
          });
          const opacity = scrollX.interpolate({
            inputRange,
            outputRange: [0.4, 1, 0.4],
            extrapolate: "clamp",
          });
          return (
            <Animated.View
              key={idx}
              style={[
                styles.dot,
                { width: dotWidth, opacity, backgroundColor: Colors.primary },
              ]}
            />
          );
        })}
      </View>

      {/* Next / Get Started footer (hidden on CTA slide — CTA has its own buttons) */}
      {!isLastSlide && (
        <View style={styles.footer}>
          <TouchableOpacity style={styles.nextBtn} onPress={handleNext} activeOpacity={0.85}>
            <Text style={styles.nextBtnText}>Next</Text>
            <Ionicons name="arrow-forward" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

// ── Standard slide ────────────────────────────────────────────────────────────

function SlideItem({
  slide,
  textColor,
  mutedColor,
}: {
  slide: Slide;
  textColor: string;
  mutedColor: string;
}) {
  const hasBullets = slide.bullets && slide.bullets.length > 0;
  return (
    <View style={[styles.slide, { width: SCREEN_WIDTH }]}>
      <View style={[styles.slideIcon, { backgroundColor: (slide.iconBg ?? "#6366F1") + "22" }]}>
        <View style={[styles.slideIconInner, { backgroundColor: slide.iconBg ?? "#6366F1" }]}>
          <Ionicons name={(slide.icon ?? "star-outline") as any} size={44} color="#fff" />
        </View>
      </View>
      <Text style={[styles.slideTitle, hasBullets && styles.slideTitleSm, { color: textColor }]}>
        {slide.title}
      </Text>
      <Text
        style={[styles.slideSubtitle, hasBullets && styles.slideSubtitleSm, { color: mutedColor }]}
      >
        {slide.subtitle}
      </Text>
      {hasBullets && (
        <View style={styles.bulletList}>
          {slide.bullets!.map((b, i) => (
            <View key={i} style={styles.bulletRow}>
              <Text style={[styles.bulletDot, { color: slide.iconBg ?? Colors.primary }]}>•</Text>
              <Text style={[styles.bulletText, { color: mutedColor }]}>{b}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

// ── CTA slide (slide 6) ───────────────────────────────────────────────────────

function CtaSlide({
  textColor,
  mutedColor,
  onGetStarted,
}: {
  textColor: string;
  mutedColor: string;
  onGetStarted: () => void;
}) {
  return (
    <View style={[styles.slide, styles.ctaSlide, { width: SCREEN_WIDTH }]}>
      <Text style={[styles.ctaTitle, { color: textColor }]}>Ready to Split Smart?</Text>

      <Text style={styles.heroText}>Start your first 3 splits for FREE!</Text>

      {/* Pricing box */}
      <View style={styles.pricingBox}>
        <Text style={[styles.priceTitle, { color: textColor }]}>Then unlock unlimited scans:</Text>
        <Text style={styles.price}>Just €0.10 per bill</Text>
        <Text style={[styles.priceDetail, { color: mutedColor }]}>(20 bills = €1.99)</Text>
      </View>

      {/* Comparison */}
      <View style={styles.comparison}>
        <Text style={[styles.comparisonTitle, { color: textColor }]}>Think about it:</Text>

        <View style={styles.comparisonRow}>
          <Text style={styles.withoutLabel}>Without Pick&Pay:</Text>
          <Text style={[styles.comparisonDetail, { color: mutedColor }]}>
            Awkward conversations, wrong calculations, someone always overpays €5–10...
          </Text>
        </View>

        <View style={[styles.comparisonRow, styles.comparisonRowLast]}>
          <Text style={styles.withLabel}>With Pick&Pay:</Text>
          <Text style={[styles.comparisonDetail, { color: mutedColor }]}>
            Fair splits in 30 seconds for €0.10
          </Text>
        </View>
      </View>

      <Text style={[styles.question, { color: mutedColor }]}>
        Is avoiding the awkwardness worth less than €0.10?
      </Text>

      {/* Secondary link — above primary CTA */}
      <Pressable onPress={onGetStarted} hitSlop={{ top: 8, bottom: 8, left: 16, right: 16 }}>
        <Text style={styles.plansLink}>See All Plans →</Text>
      </Pressable>

      {/* Primary CTA */}
      <TouchableOpacity style={styles.primaryBtn} onPress={onGetStarted} activeOpacity={0.85}>
        <Text style={styles.primaryBtnText}>Get Started Free</Text>
        <Ionicons name="arrow-forward" size={20} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1 },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 4,
  },
  skipText: { fontSize: 15, fontWeight: "600" },

  // Standard slide
  slide: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 36,
    gap: 20,
  },
  slideIcon: {
    width: 140,
    height: 140,
    borderRadius: 40,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  slideIconInner: {
    width: 100,
    height: 100,
    borderRadius: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  slideTitle: {
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.5,
    textAlign: "center",
  },
  slideTitleSm: { fontSize: 24 },
  slideSubtitle: {
    fontSize: 16,
    lineHeight: 24,
    textAlign: "center",
  },
  slideSubtitleSm: { fontSize: 14, lineHeight: 20 },
  bulletList: { alignSelf: "stretch", gap: 10, marginTop: 4 },
  bulletRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  bulletDot: { fontSize: 16, lineHeight: 20, fontWeight: "700" },
  bulletText: { fontSize: 13, lineHeight: 20, flex: 1 },

  // Dots
  dotsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 20,
  },
  dot: { height: 8, borderRadius: 4 },

  // Footer (non-CTA slides)
  footer: { paddingHorizontal: 24, paddingBottom: 32 },
  nextBtn: {
    backgroundColor: Colors.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 16,
    borderRadius: 16,
  },
  nextBtnText: { color: "#fff", fontSize: 17, fontWeight: "700" },

  // CTA slide
  ctaSlide: {
    justifyContent: "center",
    paddingHorizontal: 28,
    gap: 16,
  },
  ctaTitle: {
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: -0.5,
    textAlign: "center",
  },
  heroText: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.primary,
    textAlign: "center",
  },
  pricingBox: {
    backgroundColor: Colors.primary + "18",
    borderWidth: 1,
    borderColor: Colors.primary + "55",
    borderRadius: 14,
    paddingHorizontal: 20,
    paddingVertical: 14,
    alignItems: "center",
    gap: 4,
    alignSelf: "stretch",
  },
  priceTitle: { fontSize: 13, fontWeight: "600" },
  price: { fontSize: 22, fontWeight: "800", color: Colors.primary },
  priceDetail: { fontSize: 12 },
  comparison: {
    alignSelf: "stretch",
    gap: 10,
  },
  comparisonTitle: {
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 2,
  },
  comparisonRow: {
    backgroundColor: "#EF444415",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 4,
  },
  comparisonRowLast: {
    backgroundColor: "#22C55E15",
  },
  withoutLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: "#EF4444",
  },
  withLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: "#22C55E",
  },
  comparisonDetail: { fontSize: 12, lineHeight: 17 },
  question: {
    fontSize: 13,
    textAlign: "center",
    fontStyle: "italic",
    lineHeight: 19,
  },
  primaryBtn: {
    backgroundColor: Colors.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 16,
    borderRadius: 16,
    alignSelf: "stretch",
    marginTop: 4,
  },
  primaryBtnText: { color: "#fff", fontSize: 17, fontWeight: "700" },
  plansLink: {
    fontSize: 14,
    fontWeight: "600",
    color: Colors.primary,
    textAlign: "center",
  },
});
