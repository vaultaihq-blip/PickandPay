import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  useColorScheme,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Colors } from "@/constants/colors";
import { getAuthRedirectUrl, supabase } from "@/lib/supabase";

export default function ForgotPasswordScreen() {
  const isDark = useColorScheme() === "dark";
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;

  const handleSend = async () => {
    if (!email.trim()) {
      Alert.alert("Email obrigatório", "Introduz o teu endereço de email.");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: getAuthRedirectUrl(),
      });
      if (error) throw error;
      setSent(true);
    } catch (err) {
      Alert.alert("Erro", err instanceof Error ? err.message : "Falha ao enviar email. Tenta de novo.");
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
        <View style={styles.center}>
          <View style={[styles.iconWrap, { backgroundColor: Colors.primary + "22" }]}>
            <Ionicons name="mail-open-outline" size={52} color={Colors.primary} />
          </View>
          <Text style={[styles.title, { color: textColor }]}>Email enviado!</Text>
          <Text style={[styles.sub, { color: mutedColor }]}>
            Enviámos um link de recuperação para{"\n"}
            <Text style={{ color: textColor, fontWeight: "700" }}>{email}</Text>
            {"\n\n"}Abre o email e clica no link para redefinires a tua password.
          </Text>
          <TouchableOpacity style={styles.btn} onPress={() => router.replace("/(auth)/welcome")}>
            <Text style={styles.btnText}>Voltar ao login</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        {/* Back */}
        <TouchableOpacity style={styles.back} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={22} color={textColor} />
          <Text style={[styles.backText, { color: textColor }]}>Voltar</Text>
        </TouchableOpacity>

        <View style={styles.content}>
          <View style={[styles.iconWrap, { backgroundColor: Colors.primary + "22" }]}>
            <Ionicons name="lock-open-outline" size={52} color={Colors.primary} />
          </View>
          <Text style={[styles.title, { color: textColor }]}>Esqueceste a password?</Text>
          <Text style={[styles.sub, { color: mutedColor }]}>
            Introduz o teu email e enviamos um link para criares uma nova password.
          </Text>

          <TextInput
            style={[styles.input, { color: textColor, borderColor, backgroundColor: cardColor }]}
            placeholder="Email"
            placeholderTextColor={mutedColor}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            autoFocus
          />

          <TouchableOpacity
            style={[styles.btn, loading && { opacity: 0.6 }]}
            onPress={handleSend}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.btnText}>Enviar link de recuperação</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  back: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
  },
  backText: { fontSize: 16, fontWeight: "600" },
  content: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: 32,
    gap: 16,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    gap: 16,
  },
  iconWrap: {
    width: 96,
    height: 96,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  title: {
    fontSize: 26,
    fontWeight: "800",
    textAlign: "center",
  },
  sub: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    fontSize: 16,
    marginTop: 8,
  },
  btn: {
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
    marginTop: 4,
  },
  btnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
});
