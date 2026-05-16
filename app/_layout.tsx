import { useEffect, useRef, useState } from "react";
import { Stack, router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useColorScheme } from "react-native";
import * as Linking from "expo-linking";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuthStore } from "@/store/authStore";
import { handleDeepLink } from "@/lib/deeplink";
import { supabase } from "@/lib/supabase";
import "../global.css";

export const ONBOARDING_KEY = "@splitmate:onboardingComplete";
export const DEV_MODE_KEY = "@splitmate:developerMode";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const { initialize, processReferral } = useAuthStore();
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

    try {
      const { data: { session } } = await supabase.auth.getSession();
      console.log("[root] Session:", session?.user?.id ?? "none");

      const devMode = await AsyncStorage.getItem(DEV_MODE_KEY);
      const seenOnboarding = await AsyncStorage.getItem(ONBOARDING_KEY);

      if (devMode === "true") {
        initialRoute.current = "/(app)";
      } else if (!session?.user) {
        console.log("[root] No user → welcome");
        initialRoute.current = "/(auth)/welcome";
      } else {
        initialRoute.current = seenOnboarding ? "/(app)" : "/onboarding";
      }
    } catch (err) {
      console.error("[root] Init error:", err);
      initialRoute.current = "/(auth)/welcome";
    }

    SplashScreen.hideAsync();
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
        console.log("[root] Auth event:", event);

        if (event === "PASSWORD_RECOVERY") {
          setTimeout(() => router.replace("/(auth)/reset-password"), 0);
          return;
        }

        if (event === "SIGNED_IN" && session?.user) {
          setTimeout(async () => {
            const seenOnboarding = await AsyncStorage.getItem(ONBOARDING_KEY);
            router.replace(seenOnboarding ? "/(app)" : "/onboarding");
          }, 0);
        } else if (event === "SIGNED_OUT") {
          setTimeout(async () => {
            await AsyncStorage.removeItem(DEV_MODE_KEY);
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

  // Return null while initialising — splash screen stays visible, no flash of wrong screen
  if (!isReady) return null;

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
