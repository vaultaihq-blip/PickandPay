import AsyncStorage from "@react-native-async-storage/async-storage";
import { Linking, Platform } from "react-native";
import { showDialog } from "@/lib/dialog";

const BILLS_CLOSED_KEY = "@pickandpay:billsClosedCount";
const LAST_PROMPT_KEY = "@pickandpay:lastReviewPromptDate";
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

const ANDROID_URL =
  "https://play.google.com/store/apps/details?id=com.pickandpay.app";

/**
 * The App Store listing doesn't exist yet. Returns undefined until
 * EXPO_PUBLIC_APP_STORE_ID is set (post-approval), so callers never build a
 * link to a store page that 404s.
 */
function getIosReviewUrl(): string | undefined {
  const appStoreId = process.env.EXPO_PUBLIC_APP_STORE_ID;
  if (!appStoreId) return undefined;
  return `https://apps.apple.com/app/pickandpay/id${appStoreId}?action=write-review`;
}

async function openStore() {
  try {
    // Uses expo-store-review if installed; graceful fallback otherwise
    // Run: npx expo install expo-store-review
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const StoreReview = require("expo-store-review");
    if (await StoreReview.isAvailableAsync()) {
      await StoreReview.requestReview();
      return;
    }
  } catch {
    // package not installed — fall through to Linking
  }
  const url = Platform.select({ ios: getIosReviewUrl(), default: ANDROID_URL });
  if (!url) return; // iOS: no App Store ID configured yet — nothing to open
  const canOpen = await Linking.canOpenURL(url);
  if (canOpen) await Linking.openURL(url);
}

export async function maybeShowReviewPrompt() {
  try {
    const pairs = await AsyncStorage.multiGet([BILLS_CLOSED_KEY, LAST_PROMPT_KEY]);
    const count = parseInt(pairs[0][1] ?? "0", 10) + 1;
    const lastPrompt = parseInt(pairs[1][1] ?? "0", 10);

    await AsyncStorage.setItem(BILLS_CLOSED_KEY, String(count));

    const shouldAsk =
      (count === 1 || count % 5 === 0) &&
      Date.now() - lastPrompt > THIRTY_DAYS;

    if (!shouldAsk) return;

    await AsyncStorage.setItem(LAST_PROMPT_KEY, String(Date.now()));

    showDialog(
      "🎉 Bill Closed!",
      "Loved using Pick&Pay?\n\nA quick review helps us improve and helps others find the app.",
      [
        { text: "Not Now", style: "cancel" },
        {
          text: "Remind Me Later",
          onPress: () =>
            AsyncStorage.setItem(
              LAST_PROMPT_KEY,
              String(Date.now() - THIRTY_DAYS + SEVEN_DAYS)
            ),
        },
        { text: "⭐ Rate Pick&Pay", onPress: openStore },
      ]
    );
  } catch (err) {
    console.error("[Review] Error:", err);
  }
}
