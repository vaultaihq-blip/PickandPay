import React, { useEffect, useState } from "react";
import { Modal, View, Text, Pressable, ScrollView, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { PersonDot, DotPerson } from "@/components/selection/PersonDot";
import { Colors } from "@/constants/colors";
import type { TranslationKey } from "@/constants/translations";

// R12 — "Partilhar": the people in the lobby (not me); several can be picked.
// Whoever is already on the item is marked: vivid when confirmed, faded when
// a request is waiting; they cannot be picked again.

export function ShareWithModal({
  visible,
  itemName,
  people,
  busy,
  t,
  onClose,
  onSend,
}: {
  visible: boolean;
  itemName: string;
  people: DotPerson[];
  busy: boolean;
  t: (key: TranslationKey) => string;
  onClose: () => void;
  onSend: (userIds: string[]) => void;
}) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (visible) setChosen(new Set());
  }, [visible]);

  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{t("share_with_title").replace("{item}", itemName)}</Text>
          <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ gap: 4 }}>
            {people.map((p) => {
              const onItem = p.state === "confirmed" || p.state === "pending";
              const picked = chosen.has(p.userId);
              return (
                <Pressable
                  key={p.userId}
                  onPress={onItem ? undefined : () => toggle(p.userId)}
                  style={[styles.row, picked && styles.rowPicked]}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: picked || onItem, disabled: onItem }}
                >
                  <PersonDot person={p} size={30} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name} numberOfLines={1}>{p.name}</Text>
                    {onItem && (
                      <Text style={styles.state}>
                        {p.state === "confirmed" ? t("share_state_confirmed") : t("share_state_pending")}
                      </Text>
                    )}
                  </View>
                  <Ionicons
                    name={picked || onItem ? "checkbox" : "square-outline"}
                    size={24}
                    color={onItem ? (p.state === "confirmed" ? Colors.primary : "#6B7280") : picked ? Colors.primary : "#9CA3AF"}
                  />
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={styles.actions}>
            <Pressable onPress={onClose} style={[styles.btn, styles.btnGhost]}>
              <Text style={styles.btnGhostText}>{t("cancel")}</Text>
            </Pressable>
            <Pressable
              onPress={() => (chosen.size > 0 && !busy ? onSend([...chosen]) : undefined)}
              style={[styles.btn, styles.btnPrimary, (chosen.size === 0 || busy) && { opacity: 0.4 }]}
            >
              <Text style={styles.btnPrimaryText}>{t("share_with_send")}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: 20 },
  card: { backgroundColor: "#15181D", borderRadius: 16, padding: 18, gap: 12, borderWidth: 1, borderColor: "#252A32" },
  title: { color: "#F9FAFB", fontSize: 17, fontWeight: "800" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52, paddingHorizontal: 8, borderRadius: 10 },
  rowPicked: { backgroundColor: "rgba(99,102,241,0.12)" },
  name: { color: "#F9FAFB", fontSize: 15, fontWeight: "600" },
  state: { color: "#9CA3AF", fontSize: 12 },
  actions: { flexDirection: "row", gap: 10, justifyContent: "flex-end" },
  btn: { minHeight: 48, paddingHorizontal: 18, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  btnGhost: { backgroundColor: "transparent" },
  btnGhostText: { color: "#D1D5DB", fontSize: 15, fontWeight: "700" },
  btnPrimary: { backgroundColor: Colors.primary },
  btnPrimaryText: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
});
