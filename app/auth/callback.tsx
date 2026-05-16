import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, useColorScheme, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import * as Linking from "expo-linking";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Colors } from "@/constants/colors";
import { ONBOARDING_KEY } from "@/app/_layout";
import { completeAuthSessionFromUrl, supabase } from "@/lib/supabase";

export default function AuthCallbackScreen() {
  const isDark = useColorScheme() === "dark";
  const params = useLocalSearchParams();
  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;

  useEffect(() => {
    let mounted = true;

    async function completeAuth() {
      const initialUrl = await Linking.getInitialURL();
      const currentUrl =
        initialUrl ??
        (typeof window !== "undefined" ? window.location.href : null);

      if (currentUrl) {
        await completeAuthSessionFromUrl(currentUrl);
      } else if (typeof params.code === "string") {
        await supabase.auth.exchangeCodeForSession(params.code);
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!mounted) return;

      if (session?.user) {
        const seenOnboarding = await AsyncStorage.getItem(ONBOARDING_KEY);
        router.replace(seenOnboarding ? "/(app)" : "/onboarding");
      } else {
        router.replace("/(auth)/welcome");
      }
    }

    completeAuth().catch((err) => {
      console.error("[auth/callback] Failed to complete auth:", err);
      if (mounted) router.replace("/(auth)/welcome");
    });

    return () => {
      mounted = false;
    };
  }, [params.code]);

  return (
    <View style={[styles.container, { backgroundColor: bgColor }]}>
      <ActivityIndicator color={Colors.primary} />
      <Text style={[styles.text, { color: textColor }]}>Signing you in...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  text: {
    fontSize: 15,
    fontWeight: "600",
  },
});
