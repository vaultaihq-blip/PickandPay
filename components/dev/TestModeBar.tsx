import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  useColorScheme,
  Modal,
  TextInput,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Colors } from "@/constants/colors";
import { useSessionStore } from "@/store/sessionStore";
import { SessionParticipant, UserProfile } from "@/types";

// ── Constants ────────────────────────────────────────────────────────────────

const PALETTE = [
  "#FF6B6B", "#4ECDC4", "#A855F7", "#F97316",
  "#3B82F6", "#22C55E", "#EC4899", "#EAB308",
  "#06B6D4", "#84CC16",
];

const DEFAULT_NAMES = [
  "Alice", "Bob", "Charlie", "Diana", "Eve",
  "Frank", "Grace", "Henry", "Iris", "Jack",
];

const FAKE_ID_PREFIX = "test_";

function buildProfile(name: string, index: number): UserProfile {
  const safeName = name.trim() || DEFAULT_NAMES[index] || `User ${index + 1}`;
  return {
    id: `${FAKE_ID_PREFIX}${index}_${safeName.toLowerCase().replace(/\s+/g, "_")}`,
    name: safeName,
    color: PALETTE[index % PALETTE.length],
    billCredits: 0,
    referralCount: 0,
    isPro: false,
  };
}

const isFake = (id: string) => id.startsWith(FAKE_ID_PREFIX);

// ── Props ────────────────────────────────────────────────────────────────────

interface Props {
  onActiveUserChange: (profile: UserProfile | null) => void;
  sessionId: string;
  hasReceipt: boolean;
}

// ── Component ────────────────────────────────────────────────────────────────

export function TestModeBar({ onActiveUserChange, sessionId, hasReceipt }: Props) {
  const isDark = useColorScheme() === "dark";

  const [modalVisible, setModalVisible] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [count, setCount] = useState(2);
  const [names, setNames] = useState<string[]>([...DEFAULT_NAMES]);
  const [activeParticipants, setActiveParticipants] = useState<UserProfile[]>([]);
  const [activeUserId, setActiveUserId] = useState<string | null>(null);

  const { currentSession, setSession, recalculateSplit } = useSessionStore();

  const textColor   = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor  = isDark ? Colors.textMutedDark   : Colors.textMutedLight;
  const borderColor = isDark ? Colors.cardBorderDark  : Colors.cardBorderLight;
  const bgColor     = isDark ? Colors.cardDark        : Colors.cardLight;
  const inputBg     = isDark ? "#111" : "#F5F5F5";

  // ── Actions ──────────────────────────────────────────────────────────────

  const handleAdd = () => {
    if (!currentSession) {
      Alert.alert("No session", "Start a session first from the home screen.");
      return;
    }
    const chosen = Array.from({ length: count }, (_, i) => buildProfile(names[i] ?? "", i));
    const existingIds = new Set(currentSession.participants.map((p) => p.userId));
    const newParticipants: SessionParticipant[] = chosen
      .filter((u) => !existingIds.has(u.id))
      .map((u) => ({
        userId: u.id,
        profile: u,
        selections: [],
        totalOwed: 0,
        paid: false,
        confirmedByCreator: true,
      }));

    setSession({ ...currentSession, participants: [...currentSession.participants, ...newParticipants] });
    setActiveParticipants(chosen);
    setActiveUserId(chosen[0].id);
    onActiveUserChange(chosen[0]);
    setIsActive(true);
    setModalVisible(false);
  };

  const deactivate = () => {
    if (!currentSession) return;
    setSession({ ...currentSession, participants: currentSession.participants.filter((p) => !isFake(p.userId)) });
    setIsActive(false);
    setActiveUserId(null);
    setActiveParticipants([]);
    onActiveUserChange(null);
  };

  const removeParticipant = (userId: string) => {
    if (!currentSession) return;
    const next = activeParticipants.filter((u) => u.id !== userId);
    setActiveParticipants(next);
    setSession({ ...currentSession, participants: currentSession.participants.filter((p) => p.userId !== userId) });
    if (activeUserId === userId) {
      const fallback = next[0] ?? null;
      setActiveUserId(fallback?.id ?? null);
      onActiveUserChange(fallback);
    }
    if (next.length === 0) {
      setIsActive(false);
      onActiveUserChange(null);
    }
  };

  const switchTo = (user: UserProfile) => {
    setActiveUserId(user.id);
    onActiveUserChange(user);
  };

  const handleGoToLobby = () => {
    router.push(`/(app)/session-lobby/${sessionId}`);
  };

  const updateName = (index: number, value: string) => {
    setNames((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  // ── Modal (shared between inactive + active edit) ─────────────────────────

  const pickerModal = (
    <Modal
      visible={modalVisible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => setModalVisible(false)}
    >
      <View style={[styles.modalRoot, { backgroundColor: bgColor }]}>
        {/* Header */}
        <View style={[styles.modalHeader, { borderBottomColor: borderColor }]}>
          <TouchableOpacity onPress={() => setModalVisible(false)} style={styles.modalCloseBtn}>
            <Ionicons name="close" size={24} color={mutedColor} />
          </TouchableOpacity>
          <Text style={[styles.modalTitle, { color: textColor }]}>Dev Participants</Text>
          <View style={{ width: 40 }} />
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.modalBody}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Count selector */}
          <Text style={[styles.fieldLabel, { color: mutedColor }]}>How many participants?</Text>
          <View style={styles.countRow}>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <TouchableOpacity
                key={n}
                onPress={() => setCount(n)}
                style={[
                  styles.countBtn,
                  { borderColor: n === count ? Colors.primary : borderColor },
                  n === count && { backgroundColor: Colors.primary },
                ]}
              >
                <Text style={[styles.countBtnText, { color: n === count ? "#fff" : mutedColor }]}>
                  {n}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Name fields */}
          <Text style={[styles.fieldLabel, { color: mutedColor, marginTop: 20 }]}>Names:</Text>
          {Array.from({ length: count }).map((_, i) => (
            <View key={i} style={styles.nameRow}>
              <View style={[styles.colorDot, { backgroundColor: PALETTE[i % PALETTE.length] }]} />
              <TextInput
                style={[styles.nameInput, { color: textColor, backgroundColor: inputBg, borderColor }]}
                value={names[i] ?? ""}
                onChangeText={(v) => updateName(i, v)}
                placeholder={DEFAULT_NAMES[i] ?? `User ${i + 1}`}
                placeholderTextColor={mutedColor}
                autoCapitalize="words"
                returnKeyType="next"
              />
            </View>
          ))}

          <View style={{ height: 20 }} />
        </ScrollView>

        {/* Footer */}
        <View style={[styles.modalFooter, { borderTopColor: borderColor }]}>
          <TouchableOpacity style={styles.addBtn} onPress={handleAdd} activeOpacity={0.85}>
            <Ionicons name="people" size={18} color="#fff" />
            <Text style={styles.addBtnText}>
              Add {count} participant{count !== 1 ? "s" : ""} →
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );

  // ── Inactive ──────────────────────────────────────────────────────────────

  if (!isActive) {
    return (
      <View>
        <TouchableOpacity
          style={[styles.trigger, { borderColor }]}
          onPress={() => setModalVisible(true)}
          activeOpacity={0.7}
        >
          <Text style={styles.triggerIcon}>🧪</Text>
          <Text style={[styles.triggerLabel, { color: mutedColor }]}>Add Dev Participants</Text>
        </TouchableOpacity>
        {pickerModal}
      </View>
    );
  }

  // ── Active ────────────────────────────────────────────────────────────────

  return (
    <View style={styles.bar}>
      {/* Header */}
      <View style={styles.barHeader}>
        <View style={styles.barLeft}>
          <Text style={styles.barIcon}>🧪</Text>
          <Text style={styles.barLabel}>DEV MODE</Text>
        </View>
        <View style={styles.barRight}>
          <TouchableOpacity onPress={() => setModalVisible(true)} style={styles.iconBtn}>
            <Ionicons name="add-circle-outline" size={20} color={Colors.warning} />
          </TouchableOpacity>
          <TouchableOpacity onPress={deactivate} style={styles.iconBtn}>
            <Ionicons name="close-circle" size={20} color={Colors.warning} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Act-as chips */}
      <Text style={styles.actLabel}>Act as:</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
      >
        {activeParticipants.map((u) => {
          const selected = u.id === activeUserId;
          return (
            <View key={u.id} style={styles.chipWrap}>
              <TouchableOpacity
                style={[styles.chip, { borderColor: u.color }, selected && { backgroundColor: u.color }]}
                onPress={() => switchTo(u)}
                activeOpacity={0.75}
              >
                <Text style={[styles.chipText, selected && styles.chipTextActive]}>
                  {u.name}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.chipRemove, { backgroundColor: u.color + "33" }]}
                onPress={() => removeParticipant(u.id)}
                hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
              >
                <Ionicons name="close" size={11} color={u.color} />
              </TouchableOpacity>
            </View>
          );
        })}
      </ScrollView>

      {/* Per-user select shortcuts */}
      {hasReceipt && (
        <View style={styles.selectRow}>
          {activeParticipants.map((u) => (
            <TouchableOpacity
              key={u.id}
              style={[styles.selectShortcut, { borderColor: u.color + "66" }]}
              onPress={() => router.push(`/(app)/selection/${sessionId}?userId=${u.id}&returnTo=lobby`)}
              activeOpacity={0.8}
            >
              <View style={[styles.selectDot, { backgroundColor: u.color }]} />
              <Text style={[styles.selectShortcutText, { color: u.color }]} numberOfLines={1}>
                {u.name}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Go to Lobby */}
      <TouchableOpacity
        style={styles.forceBtn}
        onPress={handleGoToLobby}
        activeOpacity={0.85}
      >
        <Ionicons name="people-outline" size={15} color="#fff" />
        <Text style={styles.forceBtnText}>Go to Lobby →</Text>
      </TouchableOpacity>

      <Text style={styles.hint}>
        {currentSession ? `${currentSession.participants.length} participants total` : ""}
      </Text>

      {pickerModal}
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "dashed",
    marginTop: 4,
  },
  triggerIcon: { fontSize: 16 },
  triggerLabel: { fontSize: 13, fontWeight: "500" },

  // Modal
  modalRoot: { flex: 1 },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalCloseBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  modalTitle: { fontSize: 17, fontWeight: "700" },
  modalBody: { paddingHorizontal: 20, paddingTop: 20 },
  modalFooter: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 40,
  },

  fieldLabel: { fontSize: 13, fontWeight: "600", marginBottom: 10 },

  countRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  countBtn: {
    width: 44,
    height: 44,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  countBtnText: { fontSize: 15, fontWeight: "700" },

  nameRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 },
  colorDot: { width: 12, height: 12, borderRadius: 6, flexShrink: 0 },
  nameInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },

  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.primary,
    paddingVertical: 16,
    borderRadius: 14,
    gap: 8,
  },
  addBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },

  // Active bar
  bar: {
    backgroundColor: Colors.warningBg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.warning,
    padding: 14,
    gap: 10,
    marginTop: 4,
  },
  barHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  barLeft: { flexDirection: "row", alignItems: "center", gap: 6 },
  barRight: { flexDirection: "row", alignItems: "center", gap: 4 },
  barIcon: { fontSize: 14 },
  barLabel: { color: Colors.warning, fontSize: 11, fontWeight: "700", letterSpacing: 0.8 },
  iconBtn: { padding: 4 },

  actLabel: { color: Colors.warning, fontSize: 12, fontWeight: "600" },
  chipRow: { flexDirection: "row", gap: 8, paddingVertical: 2 },
  chipWrap: { flexDirection: "row", alignItems: "center", gap: 3 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  chipText: { color: Colors.warning, fontSize: 13, fontWeight: "600" },
  chipTextActive: { color: "#fff" },
  chipRemove: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },

  selectRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  selectShortcut: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  selectDot: { width: 8, height: 8, borderRadius: 4 },
  selectShortcutText: { fontSize: 12, fontWeight: "600", maxWidth: 70 },

  forceBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#EF4444",
    paddingVertical: 11,
    borderRadius: 10,
  },
  forceBtnOff: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.warning + "44",
  },
  forceBtnText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  forceBtnOffText: { color: Colors.warning + "66", fontSize: 13, fontWeight: "600" },

  hint: { color: Colors.warning + "66", fontSize: 11 },
});
