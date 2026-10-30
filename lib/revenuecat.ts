import { Platform } from "react-native";
import Purchases, {
  CustomerInfo,
  LOG_LEVEL,
  PurchasesOffering,
  PurchasesPackage,
} from "react-native-purchases";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/store/authStore";

const API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_API_KEY;

let configuredUserId: string | null = null;

function isRevenueCatSupported() {
  return Platform.OS === "ios" || Platform.OS === "android";
}

async function getCurrentUserId() {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export async function initRevenueCat(userId: string) {
  if (!isRevenueCatSupported()) {
    if (__DEV__) console.log("[RevenueCat] Skipping init on unsupported platform:", Platform.OS);
    return;
  }

  if (!API_KEY || API_KEY.startsWith("test_")) {
    console.warn("[RevenueCat] No production key — purchases disabled.");
    return;
  }

  if (configuredUserId === userId && (await Purchases.isConfigured())) return;

  if (__DEV__) console.log("[RevenueCat] Initializing for user:", userId);

  if (__DEV__) {
    await Purchases.setLogLevel(LOG_LEVEL.DEBUG);
  }

  Purchases.configure({
    apiKey: API_KEY,
    appUserID: userId,
  });
  configuredUserId = userId;
  // Credits are never written from the client: purchases reach the balance
  // only through the RevenueCat webhook (grant-credits-from-purchase).

  if (__DEV__) console.log("[RevenueCat] Initialized successfully");
}

export async function getOfferings(): Promise<PurchasesOffering | null> {
  if (!isRevenueCatSupported()) {
    console.warn("[RevenueCat] Offerings unavailable on platform:", Platform.OS);
    return null;
  }

  try {
    const offerings = await Purchases.getOfferings();
    if (!offerings.current) {
      console.warn("[RevenueCat] No current offering found");
      return null;
    }
    return offerings.current;
  } catch (error) {
    console.error("[RevenueCat] Failed to fetch offerings:", error);
    return null;
  }
}

export async function purchasePackage(pkg: PurchasesPackage) {
  try {
    if (__DEV__) console.log("[RevenueCat] Starting purchase:", pkg.identifier);
    const { customerInfo } = await Purchases.purchasePackage(pkg);

    const userId = await getCurrentUserId();
    if (!userId) throw new Error("No authenticated user found.");

    // Credits are now granted server-side via the RevenueCat webhook → grant-credits-from-purchase Edge Function.
    // Reload the profile so the UI reflects the updated balance once the webhook has fired.
    await useAuthStore.getState().loadProfile(userId);

    if (__DEV__) console.log("[RevenueCat] Purchase successful");
    return { success: true, customerInfo, creditsAdded: 0 };
  } catch (error: unknown) {
    const purchaseError = error as { message?: string; userCancelled?: boolean };
    if (purchaseError.userCancelled) {
      if (__DEV__) console.log("[RevenueCat] User cancelled purchase");
      return { success: false, cancelled: true };
    }

    console.error("[RevenueCat] Purchase failed:", error);
    return {
      success: false,
      error: purchaseError.message || "Purchase failed",
    };
  }
}

export async function restorePurchases() {
  try {
    if (__DEV__) console.log("[RevenueCat] Restoring purchases...");
    const customerInfo = await Purchases.restorePurchases();
    // Credits are consumable and tracked in Supabase — restoring does not refill used credits.
    // This call only syncs RevenueCat entitlement state (relevant for future subscriptions).
    if (__DEV__) console.log("[RevenueCat] Restore successful");
    return { success: true, customerInfo };
  } catch (error) {
    console.error("[RevenueCat] Restore failed:", error);
    return { success: false };
  }
}

export async function getCustomerInfo(): Promise<CustomerInfo | null> {
  try {
    return await Purchases.getCustomerInfo();
  } catch (error) {
    console.error("[RevenueCat] Failed to get customer info:", error);
    return null;
  }
}
