import { useEffect, useRef, useState } from "react";
import { Stack, router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useColorScheme, Platform, View } from "react-native";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { useAuthStore } from "@/store/authStore";
import { useI18nStore } from "@/store/i18nStore";
import { handleDeepLink } from "@/lib/deeplink";
import { initRevenueCat } from "@/lib/revenuecat";
import { supabase, isAuthCallbackUrl } from "@/lib/supabase";
import "../global.css";

export const ONBOARDING_KEY = "@pickandpay:onboardingComplete";

async function registerPushToken(userId: string) {
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "default",
        importance: Notifications.AndroidImportance.MAX,
      });
    }
    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;
    if (existing !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== "granted") return;
    const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
    const tokenData = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    const token = tokenData.data;
    await supabase
      .from("user_push_tokens")
      .upsert({ user_id: userId, token, updated_at: new Date().toISOString() }, { onConflict: "token" });
  } catch {}
}

if (Platform.OS !== "web") {
  SplashScreen.preventAutoHideAsync();
}

export default function RootLayout() {
  const { initialize, processReferral } = useAuthStore();
  const { loadLanguage } = useI18nStore();
  const [isReady, setIsReady] = useState(false);
  const colorScheme = useColorScheme();
  const pendingRef = useRef<string | null>(null);
  const initialRoute = useRef<string | null>(null);

  useEffect(() => {
    initApp();
  }, []);

  async function initApp() {
    // Initialize Zustand store: loads profile, sets up internal auth state listener
    try { await initialize(); } catch {}
    try { await loadLanguage(); } catch {}

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (__DEV__) console.log("[root] Session:", session?.user?.id ?? "none");

      const seenOnboarding = await AsyncStorage.getItem(ONBOARDING_KEY);

      if (!session?.user) {
        if (__DEV__) console.log("[root] No user → welcome");
        initialRoute.current = "/(auth)/welcome";
      } else {
        try {
          await initRevenueCat(session.user.id);
        } catch (error) {
          console.error("[root] RevenueCat init error:", error);
        }
        registerPushToken(session.user.id);
        initialRoute.current = seenOnboarding ? "/(app)" : "/onboarding";
      }
    } catch (err) {
      console.error("[root] Init error:", err);
      initialRoute.current = "/(auth)/welcome";
    }

    if (Platform.OS !== "web") SplashScreen.hideAsync();
    setIsReady(true);
  }

  // Fire initial navigation once the Stack has mounted
  useEffect(() => {
    if (!isReady || !initialRoute.current) return;
    router.replace(initialRoute.current as any);
    initialRoute.current = null;
  }, [isReady]);

  // Handle sign-in and sign-out after app is ready
  useEffect(() => {
    if (!isReady) return;

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (__DEV__) console.log("[root] Auth event:", event);

        if (event === "PASSWORD_RECOVERY") {
          setTimeout(() => router.replace("/(auth)/reset-password"), 0);
          return;
        }

        if (event === "SIGNED_IN" && session?.user) {
          setTimeout(async () => {
            try {
              await initRevenueCat(session.user.id);
            } catch (error) {
              console.error("[root] RevenueCat auth init error:", error);
            }
            registerPushToken(session.user.id);
            const seenOnboarding = await AsyncStorage.getItem(ONBOARDING_KEY);
            router.replace(seenOnboarding ? "/(app)" : "/onboarding");
          }, 0);
        } else if (event === "SIGNED_OUT") {
          setTimeout(() => {
            router.replace("/(auth)/welcome");
          }, 0);
        }
      }
    );

    return () => subscription.unsubscribe();
  }, [isReady]);

  // Deep link listener
  useEffect(() => {
    const handleURL = (url: string) => {
      // Must call maybeCompleteAuthSession before processing the URL so that
      // the Chrome Custom Tab (Android OAuth) closes and openAuthSessionAsync resolves.
      if (isAuthCallbackUrl(url)) {
        WebBrowser.maybeCompleteAuthSession();
      }
      handleDeepLink(url, (ref) => { pendingRef.current = ref; });
    };
    Linking.getInitialURL().then((url) => { if (url) handleURL(url); });
    const sub = Linking.addEventListener("url", (e) => handleURL(e.url));
    return () => sub.remove();
  }, []);

  // Process pending referral once ready
  useEffect(() => {
    if (isReady && pendingRef.current) {
      processReferral(pendingRef.current);
      pendingRef.current = null;
    }
  }, [isReady, processReferral]);

  // On web: show dark background during init (no splash screen to cover it).
  // On native: return null — the splash screen keeps the screen covered.
  if (!isReady) {
    if (Platform.OS === "web") {
      return <View style={{ flex: 1, backgroundColor: "#0B0D10" }} />;
    }
    return null;
  }

  return (
    <>
      <StatusBar style={colorScheme === "dark" ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="onboarding" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(app)" />
      </Stack>
    </>
  );
}
