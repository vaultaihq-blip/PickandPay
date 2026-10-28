import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Image,
  useColorScheme,
  Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import Svg, { Path, Rect } from "react-native-svg";
import {
  SocialAuthProvider,
  signInWithSocialProvider,
  signInWithEmail,
  signUpWithEmail,
} from "@/lib/supabase";
import { showDialog } from "@/lib/dialog";
import { useI18nStore } from "@/store/i18nStore";

const BG = "#000000";
const PRIMARY = "#6366F1";
const MUTED = "#8B8FA3";
const CARD = "rgba(20,22,28,0.92)";
const BORDER = "rgba(99,102,241,0.22)";

type AuthMode = "login" | "register";

// ── Brand SVG icons ──────────────────────────────────────────────────────────

function GoogleIcon({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <Path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <Path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
      <Path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </Svg>
  );
}

function MicrosoftIcon({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect x="1"    y="1"    width="10.5" height="10.5" fill="#F25022" rx="0.5" />
      <Rect x="12.5" y="1"    width="10.5" height="10.5" fill="#7FBA00" rx="0.5" />
      <Rect x="1"    y="12.5" width="10.5" height="10.5" fill="#00A4EF" rx="0.5" />
      <Rect x="12.5" y="12.5" width="10.5" height="10.5" fill="#FFB900" rx="0.5" />
    </Svg>
  );
}

type Provider = {
  id: SocialAuthProvider;
  label: string;
  renderIcon: (size: number) => React.ReactNode;
};

const ALL_PROVIDERS: Provider[] = [
  { id: "google",    label: "Google",    renderIcon: (s) => <GoogleIcon size={s} /> },
  { id: "apple",     label: "Apple",     renderIcon: (s) => <Ionicons name="logo-apple" size={s} color="#fff" /> },
  { id: "microsoft", label: "Microsoft", renderIcon: (s) => <MicrosoftIcon size={s} /> },
  { id: "facebook",  label: "Facebook",  renderIcon: (s) => <Ionicons name="logo-facebook" size={s} color="#1877F2" /> },
];

// Apple Sign-In only works on iOS
const PROVIDERS = ALL_PROVIDERS.filter(
  (p) => !(p.id === "apple" && Platform.OS === "android")
);

function getAuthErrorMessage(err: unknown) {
  const message = err instanceof Error ? err.message : "Login failed";
  const lower = message.toLowerCase();
  if (lower.includes("provider") || lower.includes("oauth") || lower.includes("unsupported")) {
    return `${message}\n\nConfirm this provider is enabled in Supabase Auth and its OAuth client is configured.`;
  }
  return message;
}

// ── Screen ───────────────────────────────────────────────────────────────────

export default function WelcomeScreen() {
  const [showEmail, setShowEmail] = useState(false);
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingProvider, setLoadingProvider] = useState<SocialAuthProvider | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const { t } = useI18nStore();

  const handleSocialLogin = async (provider: SocialAuthProvider) => {
    setLoading(true);
    setLoadingProvider(provider);
    try {
      const result = await signInWithSocialProvider(provider);
      if (result?.error) throw result.error;
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
      if (mode === "login") {
        const result = await signInWithEmail(email, password);
        if (result.error) {
          const msg = result.error.message ?? "";
          if (msg.toLowerCase().includes("invalid login credentials") || msg.toLowerCase().includes("invalid credentials")) {
            Alert.alert("Incorrect credentials", "Email or password is incorrect. Please try again.");
          } else {
            Alert.alert("Login failed", msg || "An error occurred.");
          }
          return;
        }
      } else {
        const result = await signUpWithEmail(email, password);
        if (result.error) {
          Alert.alert("Sign up failed", result.error.message || "An error occurred.");
          return;
        }
        if (result.data?.user && !result.data?.session) {
          // After the confirmation message: back to Log in, email kept for
          // when the link has been tapped, password cleared.
          const registered = email.trim();
          showDialog(
            "Check Your Email",
            `We sent a confirmation link to ${email}. Please check your inbox and tap the link to activate your account.`,
            [{ text: "OK", onPress: () => { setPassword(""); setShowPassword(false); setEmail(registered); setMode("login"); } }]
          );
          return;
        }
      }
    } catch (err) {
      Alert.alert("Error", err instanceof Error ? err.message : "Auth failed");
    } finally {
      setLoading(false);
    }
  };

  // ── Email form ─────────────────────────────────────────────────────────────
  if (showEmail) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar style="light" backgroundColor={BG} translucent={false} />
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <ScrollView
            contentContainerStyle={styles.emailScroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.emailTitle}>
              Pick<Text style={styles.emailAccent}>&</Text>Pay
            </Text>
            <Text style={styles.emailSubtitle}>Split Smart and Effortlessly.</Text>

            <View style={styles.modeToggle}>
              {(["login", "register"] as AuthMode[]).map((m) => (
                <TouchableOpacity
                  key={m}
                  style={[styles.modeBtn, mode === m && { backgroundColor: PRIMARY, borderRadius: 8 }]}
                  onPress={() => setMode(m)}
                >
                  <Text style={[styles.modeBtnText, { color: mode === m ? "#fff" : MUTED }]}>
                    {m === "login" ? "Log In" : "Sign Up"}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <TextInput
              style={styles.input}
              placeholder="Email"
              placeholderTextColor={MUTED}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
            />
            <View style={styles.passwordRow}>
              <TextInput
                style={styles.passwordInput}
                placeholder="Password"
                placeholderTextColor={MUTED}
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
              />
              <TouchableOpacity
                onPress={() => setShowPassword((v) => !v)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={20} color={MUTED} />
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

            {mode === "register" && (
              <Text style={styles.legalText}>
                {"Ao registares-te, concordas com os nossos "}
                <Text
                  style={styles.legalLink}
                  onPress={() => Linking.openURL("https://vaultaihq.org/terms")}
                >
                  Termos
                </Text>
                {" e "}
                <Text
                  style={styles.legalLink}
                  onPress={() => Linking.openURL("https://vaultaihq.org/privacy")}
                >
                  Política de Privacidade
                </Text>
              </Text>
            )}

            {mode === "login" && (
              <TouchableOpacity onPress={() => router.push("/(auth)/forgot-password")}>
                <Text style={[styles.link, { color: PRIMARY }]}>Esqueceste a password?</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => setShowEmail(false)}>
              <Text style={[styles.link, { color: MUTED }]}>← Voltar às opções</Text>
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // ── Main view ──────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" backgroundColor={BG} translucent={false} />

      {/* Hero container — fills all space from status bar to login buttons */}
      <View style={styles.heroContainer}>
        <Image
          source={require("@/assets/images/hero-illustration.png")}
          style={styles.heroImage}
          resizeMode="cover"
        />
      </View>

      {/* Login buttons — remaining space */}
      <View style={styles.loginSection}>
        <View style={styles.socialRow}>
          {PROVIDERS.map((p) => (
            <TouchableOpacity
              key={p.id}
              style={[styles.socialBtn, loading && loadingProvider !== p.id && { opacity: 0.45 }]}
              onPress={() => handleSocialLogin(p.id)}
              disabled={loading}
              activeOpacity={0.8}
            >
              {loadingProvider === p.id
                ? <Ionicons name="ellipsis-horizontal" size={20} color="#fff" />
                : p.renderIcon(22)}
              <Text style={styles.socialLabel}>{p.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.dividerRow}>
          <View style={styles.divider} />
          <Text style={styles.dividerText}>or</Text>
          <View style={styles.divider} />
        </View>

        <TouchableOpacity
          style={styles.emailBtn}
          onPress={() => setShowEmail(true)}
          disabled={loading}
          activeOpacity={0.85}
        >
          <Ionicons name="mail-outline" size={18} color="#fff" />
          <Text style={styles.emailBtnText}>{t("auth_continue_email")}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: BG,
  },

  // ── Hero area ─────────────────────────────────────────────────────────────────
  heroContainer: {
    flex: 1,
    backgroundColor: BG,
    overflow: "hidden",
  },
  heroImage: {
    width: "100%",
    height: "100%",
  },

  // ── Login section ────────────────────────────────────────────────────────────
  loginSection: {
    backgroundColor: BG,
    paddingHorizontal: 24,
    paddingTop: 0,
    paddingBottom: 12,
  },
  socialRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 10,
  },
  socialBtn: {
    flex: 1,
    aspectRatio: 1,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 8,
  },
  socialLabel: {
    fontSize: 9,
    color: "#C4C7D4",
    fontWeight: "500",
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 10,
  },
  divider: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  dividerText: {
    fontSize: 12,
    color: "rgba(255,255,255,0.3)",
    fontWeight: "500",
  },
  emailBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: PRIMARY,
    paddingVertical: 13,
    borderRadius: 14,
    gap: 8,
  },
  emailBtnText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
  },

  // ── Email form ────────────────────────────────────────────────────────────────
  emailScroll: {
    flexGrow: 1,
    paddingHorizontal: 28,
    paddingTop: 48,
    paddingBottom: 40,
    gap: 14,
  },
  emailTitle: {
    fontSize: 38,
    fontWeight: "800",
    color: "#F0F2FF",
    letterSpacing: -0.5,
    textAlign: "center",
  },
  emailAccent: {
    color: PRIMARY,
  },
  emailSubtitle: {
    fontSize: 14,
    color: MUTED,
    textAlign: "center",
    marginBottom: 8,
  },
  modeToggle: {
    flexDirection: "row",
    backgroundColor: "rgba(255,255,255,0.07)",
    borderRadius: 10,
    padding: 4,
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
    borderColor: "rgba(37,42,50,0.9)",
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 16,
    fontSize: 15,
    color: "#fff",
    backgroundColor: "rgba(21,24,29,0.95)",
  },
  passwordRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(37,42,50,0.9)",
    borderRadius: 12,
    paddingHorizontal: 16,
    backgroundColor: "rgba(21,24,29,0.95)",
  },
  passwordInput: {
    flex: 1,
    paddingVertical: 13,
    fontSize: 15,
    color: "#fff",
  },
  submitBtn: {
    backgroundColor: PRIMARY,
    paddingVertical: 15,
    borderRadius: 14,
    alignItems: "center",
    marginTop: 4,
  },
  submitBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  link: {
    textAlign: "center",
    fontSize: 14,
    fontWeight: "500",
  },
  legalText: {
    fontSize: 12,
    textAlign: "center",
    color: MUTED,
    lineHeight: 18,
  },
  legalLink: {
    fontSize: 12,
    color: PRIMARY,
    fontWeight: "500",
  },
});
