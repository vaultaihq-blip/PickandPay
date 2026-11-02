import React, { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { router } from "expo-router";
import { showDialog } from "@/lib/dialog";
import { writeErrorMessage } from "@/lib/checkedWrite";
import { leaveGoneSession, readSessionState } from "@/lib/sessionGone";
import { isOfflineSessionId } from "@/constants/dev";
import { useI18nStore } from "@/store/i18nStore";

// D.7 — what a session screen shows when it has no session to show (the app
// was restarted on it, or the session ended or never existed). It asks the
// server why and goes home with the right notice; if the session is still
// open it goes home too (or `onOpen`), where the rejoin notice offers it.
// The "home" button is always there: no screen is left without a way out.
type Props = {
  label: string;
  sessionId?: string;
  textColor: string;
  accentColor: string;
  onOpen?: () => void;
};

export function SessionMissing({ label, sessionId, textColor, accentColor, onOpen }: Props) {
  const { t } = useI18nStore();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      if (!sessionId) {
        leaveGoneSession(label, "none", "not_found", t);
        return;
      }
      if (isOfflineSessionId(sessionId)) {
        if (onOpen) onOpen();
        else router.replace("/(app)");
        return;
      }
      try {
        const state = await readSessionState(label, sessionId);
        if (!alive) return;
        if (state !== "open") {
          leaveGoneSession(label, sessionId, state, t);
          return;
        }
        console.log(`[session-gone] ${label}: ${sessionId} is open but not loaded here — ${onOpen ? "back" : "home"}`);
        if (onOpen) onOpen();
        else router.replace("/(app)");
      } catch (err) {
        if (!alive) return;
        setChecking(false);
        showDialog(t("error"), writeErrorMessage(err, t));
      }
    };
    void run();
    return () => { alive = false; };
  }, [label, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={styles.box}>
      {checking ? (
        <ActivityIndicator color={accentColor} />
      ) : (
        <Text style={[styles.text, { color: textColor }]}>{t("session_gone_unknown_msg")}</Text>
      )}
      <TouchableOpacity
        style={[styles.btn, { borderColor: accentColor }]}
        onPress={() => router.replace("/(app)")}
        accessibilityRole="button"
      >
        <Text style={[styles.btnText, { color: accentColor }]}>{t("dashboard_go_home_btn")}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24, gap: 16 },
  text: { fontSize: 16, textAlign: "center" },
  btn: { borderWidth: 1.5, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 10 },
  btnText: { fontSize: 15, fontWeight: "700" },
});
