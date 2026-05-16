import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  useColorScheme,
  Alert,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Colors } from "@/constants/colors";
import { useAuthStore } from "@/store/authStore";
import {
  SocialAuthProvider,
  signInWithSocialProvider,
  signInWithEmail,
  signUpWithEmail,
} from "@/lib/supabase";
import { ONBOARDING_KEY, DEV_MODE_KEY } from "../_layout";

type AuthMode = "login" | "register";

const SOCIAL_PROVIDERS = [
  { id: "google", label: "Continue with Google", icon: "logo-google", color: "#4285F4" },
  { id: "apple", label: "Continue with Apple", icon: "logo-apple", color: "#000000" },
  { id: "microsoft", label: "Continue with Microsoft", icon: "logo-windows", color: "#0078D4" },
  { id: "facebook", label: "Continue with Facebook", icon: "logo-facebook", color: "#1877F2" },
] satisfies Array<{
  id: SocialAuthProvider;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
}>;

function getAuthErrorMessage(err: unknown) {
  const message = err instanceof Error ? err.message : "Login failed";
  const lower = message.toLowerCase();
  if (
    lower.includes("provider") ||
    lower.includes("oauth") ||
    lower.includes("unsupported")
  ) {
    return `${message}\n\nConfirm this provider is enabled in Supabase Auth and its OAuth client is configured.`;
  }
  return message;
}

export default function WelcomeScreen() {
  const isDark = useColorScheme() === "dark";
  const { setGuest } = useAuthStore();

  const [showEmail, setShowEmail] = useState(false);
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingProvider, setLoadingProvider] = useState<SocialAuthProvider | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;

  const handleSocialLogin = async (provider: SocialAuthProvider) => {
    setLoading(true);
    setLoadingProvider(provider);
    try {
      // Real user — ensure dev flag is cleared so onboarding fires normally
      await AsyncStorage.removeItem(DEV_MODE_KEY);

      const result = await signInWithSocialProvider(provider);
      if (result?.error) throw result.error;
      // Supabase opens browser; session handled via deeplink callback.
      // Onboarding check runs in _layout.tsx when user state updates.
    } catch (err) {
      Alert.alert("Login failed", getAuthErrorMessage(err));
    } finally {
      setLoading(false);
      setLoadingProvider(null);
    }
  };

  const handleEmailAuth = async () => {
    if (!email || !password) {
      Alert.alert("Missing fields", "Please enter email and password.");
      return;
    }
    setLoading(true);
    try {
      await AsyncStorage.removeItem(DEV_MODE_KEY);

      if (mode === "login") {
        console.log("[login] Attempting:", email);
        const result = await signInWithEmail(email, password);
        if (result.error) {
          const msg = result.error.message ?? "";
          if (
            msg.toLowerCase().includes("invalid login credentials") ||
            msg.toLowerCase().includes("invalid credentials")
          ) {
            Alert.alert(
              "Incorrect credentials",
              "Email or password is incorrect. Please try again or create a new account."
            );
          } else {
            Alert.alert("Login failed", msg || "An error occurred. Please try again.");
          }
          return;
        }
        console.log("[login] Success:", result.data?.user?.id);
      } else {
        const result = await signUpWithEmail(email, password);
        if (result.error) {
          Alert.alert("Sign up failed", result.error.message || "An error occurred. Please try again.");
          return;
        }
        if (result.data?.user && !result.data?.session) {
          Alert.alert(
            "Check Your Email",
            `We sent a confirmation link to ${email}. Click it to activate your account.`
          );
          return;
        }
      }
      // Navigation is handled by the post-auth effect in _layout.tsx.
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Auth failed");
    } finally {
      setLoading(false);
    }
  };

  const handleGuest = async () => {
    // Demo mode — skip onboarding entirely
    await AsyncStorage.setItem(DEV_MODE_KEY, "true");
    await AsyncStorage.setItem(ONBOARDING_KEY, "true");
    setGuest(true);
    // Guest auth never triggers the auth listener, so we navigate directly.
    router.replace("/(app)");
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          {/* Logo */}
          <View style={styles.logoSection}>
            <View style={styles.logoMark}>
              <Text style={styles.logoEmoji}>🧾</Text>
            </View>
            <Text style={[styles.appName, { color: textColor }]}>Pick&Pay</Text>
            <Text style={[styles.tagline, { color: mutedColor }]}>
              Smart bill splitting.{"\n"}Pay only what you consumed.
            </Text>
          </View>

          {/* Social login */}
          {!showEmail && (
            <View style={styles.providers}>
              {SOCIAL_PROVIDERS.map((p) => (
                <TouchableOpacity
                  key={p.id}
                  style={[
                    styles.socialBtn,
                    { backgroundColor: cardColor, borderColor },
                    loading && loadingProvider !== p.id && { opacity: 0.45 },
                  ]}
                  onPress={() => handleSocialLogin(p.id)}
                  disabled={loading}
                  activeOpacity={0.8}
                >
                  <Ionicons
                    name={p.icon as keyof typeof Ionicons.glyphMap}
                    size={20}
                    color={isDark ? "#fff" : p.color}
                  />
                  <Text style={[styles.socialBtnText, { color: textColor }]}>
                    {loadingProvider === p.id ? "..." : p.label}
                  </Text>
                </TouchableOpacity>
              ))}

              <TouchableOpacity
                style={[
                  styles.socialBtn,
                  { backgroundColor: cardColor, borderColor },
                ]}
                onPress={() => setShowEmail(true)}
                disabled={loading}
                activeOpacity={0.8}
              >
                <Ionicons
                  name="mail-outline"
                  size={20}
                  color={isDark ? "#fff" : "#374151"}
                />
                <Text style={[styles.socialBtnText, { color: textColor }]}>
                  Continue with Email
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Email form */}
          {showEmail && (
            <View style={styles.emailForm}>
              <View style={styles.modeToggle}>
                {(["login", "register"] as AuthMode[]).map((m) => (
                  <TouchableOpacity
                    key={m}
                    style={[
                      styles.modeBtn,
                      mode === m && {
                        backgroundColor: Colors.primary,
                        borderRadius: 8,
                      },
                    ]}
                    onPress={() => setMode(m)}
                  >
                    <Text
                      style={[
                        styles.modeBtnText,
                        {
                          color: mode === m ? "#fff" : mutedColor,
                        },
                      ]}
                    >
                      {m === "login" ? "Log In" : "Sign Up"}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <TextInput
                style={[
                  styles.input,
                  {
                    color: textColor,
                    borderColor,
                    backgroundColor: cardColor,
                  },
                ]}
                placeholder="Email"
                placeholderTextColor={mutedColor}
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                keyboardType="email-address"
                autoComplete="email"
              />
              <View
                style={[
                  styles.passwordContainer,
                  { borderColor, backgroundColor: cardColor },
                ]}
              >
                <TextInput
                  style={[styles.passwordInput, { color: textColor }]}
                  placeholder="Password"
                  placeholderTextColor={mutedColor}
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPassword}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                />
                <TouchableOpacity
                  style={styles.eyeBtn}
                  onPress={() => setShowPassword((v) => !v)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons
                    name={showPassword ? "eye-off-outline" : "eye-outline"}
                    size={20}
                    color={mutedColor}
                  />
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={[styles.submitBtn, loading && { opacity: 0.6 }]}
                onPress={handleEmailAuth}
                disabled={loading}
              >
                <Text style={styles.submitBtnText}>
                  {loading ? "..." : mode === "login" ? "Log In" : "Create Account"}
                </Text>
              </TouchableOpacity>

              {mode === "login" && (
                <TouchableOpacity onPress={() => router.push("/(auth)/forgot-password")}>
                  <Text style={[styles.forgotText, { color: Colors.primary }]}>
                    Esqueceste a password?
                  </Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity onPress={() => setShowEmail(false)}>
                <Text style={[styles.backText, { color: mutedColor }]}>
                  ← Back to options
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Divider */}
          <View style={styles.dividerRow}>
            <View style={[styles.divider, { backgroundColor: borderColor }]} />
            <Text style={[styles.dividerText, { color: mutedColor }]}>or</Text>
            <View style={[styles.divider, { backgroundColor: borderColor }]} />
          </View>

          {/* Guest */}
          <TouchableOpacity
            style={[styles.guestBtn, { borderColor }]}
            onPress={handleGuest}
            activeOpacity={0.7}
          >
            <Text style={[styles.guestText, { color: mutedColor }]}>
              Try demo mode →
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  logoSection: {
    alignItems: "center",
    paddingTop: 60,
    paddingBottom: 48,
    gap: 12,
  },
  logoMark: {
    width: 80,
    height: 80,
    borderRadius: 20,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  logoEmoji: {
    fontSize: 40,
  },
  appName: {
    fontSize: 34,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  tagline: {
    fontSize: 16,
    textAlign: "center",
    lineHeight: 24,
  },
  providers: {
    gap: 12,
  },
  socialBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 15,
    paddingHorizontal: 20,
    borderRadius: 14,
    borderWidth: 1,
    gap: 14,
  },
  socialBtnText: {
    fontSize: 15,
    fontWeight: "600",
  },
  emailForm: {
    gap: 12,
  },
  modeToggle: {
    flexDirection: "row",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 10,
    padding: 4,
    marginBottom: 4,
  },
  modeBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
  },
  modeBtnText: {
    fontSize: 14,
    fontWeight: "600",
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    fontSize: 16,
  },
  passwordContainer: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
  },
  passwordInput: {
    flex: 1,
    paddingVertical: 14,
    fontSize: 16,
  },
  eyeBtn: {
    paddingLeft: 8,
  },
  submitBtn: {
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
    marginTop: 4,
  },
  submitBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  forgotText: {
    textAlign: "center",
    fontSize: 14,
    fontWeight: "600",
    marginTop: 2,
  },
  backText: {
    textAlign: "center",
    fontSize: 14,
    marginTop: 4,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 24,
    gap: 12,
  },
  divider: {
    flex: 1,
    height: 1,
  },
  dividerText: {
    fontSize: 13,
  },
  guestBtn: {
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    borderWidth: 1,
  },
  guestText: {
    fontSize: 15,
    fontWeight: "600",
  },
});
