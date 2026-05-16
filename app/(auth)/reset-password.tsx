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
import { supabase } from "@/lib/supabase";

export default function ResetPasswordScreen() {
  const isDark = useColorScheme() === "dark";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;
  const bgColor = isDark ? Colors.bgDark : Colors.bgLight;

  const handleReset = async () => {
    if (password.length < 6) {
      Alert.alert("Password inválida", "A password deve ter pelo menos 6 caracteres.");
      return;
    }
    if (password !== confirm) {
      Alert.alert("As passwords não coincidem", "Confirma que escreveste a mesma password nos dois campos.");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setDone(true);
    } catch (err) {
      Alert.alert("Erro", err instanceof Error ? err.message : "Falha ao atualizar password. Tenta de novo.");
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
        <View style={styles.center}>
          <View style={[styles.iconWrap, { backgroundColor: "#22C55E22" }]}>
            <Ionicons name="checkmark-circle-outline" size={52} color="#22C55E" />
          </View>
          <Text style={[styles.title, { color: textColor }]}>Password atualizada!</Text>
          <Text style={[styles.sub, { color: mutedColor }]}>
            A tua nova password foi guardada com sucesso. Podes iniciar sessão normalmente.
          </Text>
          <TouchableOpacity style={styles.btn} onPress={() => router.replace("/(app)")}>
            <Text style={styles.btnText}>Ir para a app →</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: bgColor }]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.content}>
          <View style={[styles.iconWrap, { backgroundColor: Colors.primary + "22" }]}>
            <Ionicons name="key-outline" size={52} color={Colors.primary} />
          </View>
          <Text style={[styles.title, { color: textColor }]}>Nova password</Text>
          <Text style={[styles.sub, { color: mutedColor }]}>
            Escolhe uma nova password segura para a tua conta.
          </Text>

          {/* Password field */}
          <View style={[styles.pwWrap, { borderColor, backgroundColor: cardColor }]}>
            <TextInput
              style={[styles.pwInput, { color: textColor }]}
              placeholder="Nova password"
              placeholderTextColor={mutedColor}
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPw}
              autoFocus
            />
            <TouchableOpacity onPress={() => setShowPw((v) => !v)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name={showPw ? "eye-off-outline" : "eye-outline"} size={20} color={mutedColor} />
            </TouchableOpacity>
          </View>

          {/* Confirm field */}
          <TextInput
            style={[styles.input, { color: textColor, borderColor, backgroundColor: cardColor }]}
            placeholder="Confirmar password"
            placeholderTextColor={mutedColor}
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry={!showPw}
          />

          <TouchableOpacity
            style={[styles.btn, loading && { opacity: 0.6 }]}
            onPress={handleReset}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.btnText}>Guardar nova password</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  content: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: 60,
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
  pwWrap: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    marginTop: 8,
  },
  pwInput: {
    flex: 1,
    paddingVertical: 14,
    fontSize: 16,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    fontSize: 16,
  },
  btn: {
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
    marginTop: 8,
  },
  btnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
});
