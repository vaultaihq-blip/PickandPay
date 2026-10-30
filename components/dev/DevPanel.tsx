import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  ScrollView,
  useColorScheme,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Colors } from "@/constants/colors";
import { useSessionStore } from "@/store/sessionStore";
import { useReceiptStore } from "@/store/receiptStore";
import { useAuthStore } from "@/store/authStore";
import { Session, SessionParticipant, UserProfile, ParsedReceipt } from "@/types";

// ── Mock participants ────────────────────────────────────────────────────────

const BASE = { billCredits: 0, referralCount: 0, isPro: false } as const;

const MOCK_USERS: UserProfile[] = [
  { ...BASE, id: "dev_alice",   name: "Alice",   color: "#FF6B6B" },
  { ...BASE, id: "dev_bob",     name: "Bob",     color: "#4ECDC4" },
  { ...BASE, id: "dev_charlie", name: "Charlie", color: "#A855F7" },
  { ...BASE, id: "dev_diana",   name: "Diana",   color: "#F97316" },
];

// ── Mock receipt (realistic restaurant bill) ─────────────────────────────────

function buildMockReceipt(): ParsedReceipt {
  const subtotal = 8.5 + 6.5 + 24.0 + 32.0 + 16.0 + 28.0 + 3.5 + 9.0;
  const service = parseFloat((subtotal * 0.1).toFixed(2));
  const computed = parseFloat((subtotal + service).toFixed(2));
  return {
    restaurant: "Dev Test Restaurant",
    date: new Date().toISOString().split("T")[0],
    currency: "EUR",
    categories: {
      starters: [
        { id: "dev_s1", name: "Bruschetta",       category: "starters", quantity: 1, unitPrice: 8.5,  totalPrice: 8.5,  type: "individual" },
        { id: "dev_s2", name: "Soup of the Day",  category: "starters", quantity: 2, unitPrice: 6.5,  totalPrice: 13.0, type: "quantity" },
      ],
      mains: [
        { id: "dev_m1", name: "Grilled Salmon",   category: "mains",    quantity: 1, unitPrice: 24.0, totalPrice: 24.0, type: "individual" },
        { id: "dev_m2", name: "Ribeye Steak",     category: "mains",    quantity: 1, unitPrice: 32.0, totalPrice: 32.0, type: "individual" },
        { id: "dev_m3", name: "Pasta Carbonara",  category: "mains",    quantity: 1, unitPrice: 16.0, totalPrice: 16.0, type: "individual" },
      ],
      drinks: [
        { id: "dev_d1", name: "House Wine (btl)", category: "drinks",   quantity: 1, unitPrice: 28.0, totalPrice: 28.0, type: "shareable" },
        { id: "dev_d2", name: "Sparkling Water",  category: "drinks",   quantity: 2, unitPrice: 3.5,  totalPrice: 7.0,  type: "quantity" },
      ],
      desserts: [
        { id: "dev_ds1", name: "Chocolate Fondant", category: "desserts", quantity: 2, unitPrice: 9.0, totalPrice: 18.0, type: "quantity" },
      ],
      others: [],
    },
    globalCosts: [
      {
        id: "dev_gc1",
        name: "Service Charge (10%)",
        amount: service,
        type: "service_charge",
        splitByAll: true,
        editable: true,
        status: "included",
      },
    ],
    suggestedTips: [
      { percentage: 10, amount: parseFloat((computed * 0.1).toFixed(2)) },
      { percentage: 15, amount: parseFloat((computed * 0.15).toFixed(2)) },
      { percentage: 20, amount: parseFloat((computed * 0.2).toFixed(2)) },
    ],
    selectedTip: 0,
    tipStatus: "pending",
    tipMode: "equal",
    validation: {
      receiptTotal: computed,
      computedTotal: computed,
      difference: 0,
      status: "ok",
    },
  };
}

// ── Component ────────────────────────────────────────────────────────────────

interface DevPanelProps {
  visible: boolean;
  onClose: () => void;
}

export function DevPanel({ visible, onClose }: DevPanelProps) {
  const isDark = useColorScheme() === "dark";
  const { profile } = useAuthStore();
  const { setSession } = useSessionStore();
  const { setReceipt } = useReceiptStore();

  const [selectedCount, setSelectedCount] = useState(2);

  const bg       = isDark ? Colors.cardDark       : "#fff";
  const text     = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const muted    = isDark ? Colors.textMutedDark   : Colors.textMutedLight;
  const border   = isDark ? Colors.cardBorderDark  : Colors.cardBorderLight;

  // ── Quick-start: build session + chosen mock participants ─────────────────

  const handleQuickStart = (withReceipt: boolean) => {
    const sessionId = `dev_session_${Date.now()}`;
    const creatorId = profile?.id ?? "dev_host";

    const hostParticipant: SessionParticipant = {
      userId: creatorId,
      profile: profile ?? {
        id: creatorId,
        name: "You (Dev)",
        color: Colors.primary,
        billCredits: 0,
        referralCount: 0,
        isPro: false,
      },
      selections: [],
      totalOwed: 0,
      paid: false,
      confirmedByCreator: true,
    };

    const mockParticipants: SessionParticipant[] = MOCK_USERS.slice(0, selectedCount).map((u) => ({
      userId: u.id,
      profile: u,
      selections: [],
      totalOwed: 0,
      paid: false,
      confirmedByCreator: true,
    }));

    const receipt = withReceipt ? buildMockReceipt() : undefined;

    const session: Session = {
      id: sessionId,
      creatorId,
      receiptId: sessionId,
      receipt,
      status: "draft",
      createdAt: new Date().toISOString(),
      confirmedBy: [creatorId],
      participants: [hostParticipant, ...mockParticipants],
    };

    setSession(session);
    if (withReceipt) {
      setReceipt(receipt!);
    }
    onClose();
    // With receipt → go straight to lobby to pick items; without → scan the
    // receipt first, as Start split does.
    router.push(withReceipt ? `/(app)/session-lobby/${sessionId}` : "/(app)/scan");
  };

  // ── Load mock receipt into current session ────────────────────────────────

  const handleLoadMockReceipt = () => {
    const receipt = buildMockReceipt();
    setReceipt(receipt);
    onClose();
    router.push("/(app)/review");
  };

  // ── Go to scan (credit-bypassed via guest flag) ───────────────────────────

  const handleGoScan = () => {
    onClose();
    router.push("/(app)/scan");
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.root, { backgroundColor: bg }]}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: border }]}>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Ionicons name="close" size={24} color={muted} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.headerIcon}>🧪</Text>
            <Text style={[styles.headerTitle, { color: text }]}>Developer Panel</Text>
          </View>
          <View style={{ width: 40 }} />
        </View>

        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>

          {/* ── Section: Quick Start ─────────────────────────────────────── */}
          <Text style={[styles.sectionLabel, { color: muted }]}>QUICK START SESSION</Text>

          <View style={[styles.card, { borderColor: border }]}>
            <Text style={[styles.cardDesc, { color: muted }]}>
              Participants to add (you + {selectedCount} mock users):
            </Text>
            <View style={styles.countRow}>
              {[1, 2, 3, 4].map((n) => (
                <TouchableOpacity
                  key={n}
                  style={[
                    styles.countBtn,
                    { borderColor: n === selectedCount ? Colors.primary : border },
                    n === selectedCount && { backgroundColor: Colors.primary + "22" },
                  ]}
                  onPress={() => setSelectedCount(n)}
                >
                  <Text style={[styles.countBtnText, { color: n === selectedCount ? Colors.primary : muted }]}>
                    +{n}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={styles.mockUsers}>
              {MOCK_USERS.slice(0, selectedCount).map((u) => (
                <View key={u.id} style={styles.mockUserChip}>
                  <View style={[styles.colorDot, { backgroundColor: u.color }]} />
                  <Text style={[styles.mockUserName, { color: text }]}>{u.name}</Text>
                </View>
              ))}
            </View>

            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: "#10B981" }]}
              onPress={() => handleQuickStart(false)}
              activeOpacity={0.85}
            >
              <Ionicons name="people-outline" size={18} color="#fff" />
              <Text style={styles.actionBtnText}>Start Empty Session</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: Colors.primary, marginTop: 8 }]}
              onPress={() => handleQuickStart(true)}
              activeOpacity={0.85}
            >
              <Ionicons name="document-text-outline" size={18} color="#fff" />
              <Text style={styles.actionBtnText}>Start + Mock Receipt</Text>
            </TouchableOpacity>
          </View>

          {/* ── Section: Receipt ─────────────────────────────────────────── */}
          <Text style={[styles.sectionLabel, { color: muted }]}>RECEIPT TOOLS</Text>

          <View style={[styles.card, { borderColor: border }]}>
            <Text style={[styles.cardDesc, { color: muted }]}>
              Load a hardcoded restaurant bill into the review screen. No API call needed.
            </Text>
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: "#6366F1" }]}
              onPress={handleLoadMockReceipt}
              activeOpacity={0.85}
            >
              <Ionicons name="receipt-outline" size={18} color="#fff" />
              <Text style={styles.actionBtnText}>Load Mock Receipt → Review</Text>
            </TouchableOpacity>
          </View>

          <View style={[styles.card, { borderColor: border }]}>
            <Text style={[styles.cardDesc, { color: muted }]}>
              Scan a real bill with the camera. Credits bypassed in dev mode.
            </Text>
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: "#F59E0B" }]}
              onPress={handleGoScan}
              activeOpacity={0.85}
            >
              <Ionicons name="scan-outline" size={18} color="#fff" />
              <Text style={styles.actionBtnText}>Scan Real Bill (no credits)</Text>
            </TouchableOpacity>
          </View>

          {/* ── Mock receipt preview ─────────────────────────────────────── */}
          <Text style={[styles.sectionLabel, { color: muted }]}>MOCK RECEIPT PREVIEW</Text>
          <View style={[styles.card, { borderColor: border }]}>
            {[
              ["Bruschetta", "€8.50"],
              ["Soup of the Day ×2", "€13.00"],
              ["Grilled Salmon", "€24.00"],
              ["Ribeye Steak", "€32.00"],
              ["Pasta Carbonara", "€16.00"],
              ["House Wine (btl)", "€28.00"],
              ["Sparkling Water ×2", "€7.00"],
              ["Chocolate Fondant ×2", "€18.00"],
            ].map(([name, price]) => (
              <View key={name} style={[styles.previewRow, { borderBottomColor: border }]}>
                <Text style={[styles.previewName, { color: text }]}>{name}</Text>
                <Text style={[styles.previewPrice, { color: muted }]}>{price}</Text>
              </View>
            ))}
            <View style={[styles.previewRow, { borderBottomColor: border }]}>
              <Text style={[styles.previewName, { color: Colors.primary, fontWeight: "700" }]}>Service (10%)</Text>
              <Text style={[styles.previewPrice, { color: Colors.primary }]}>€14.65</Text>
            </View>
            <View style={styles.previewRow}>
              <Text style={[styles.previewName, { color: text, fontWeight: "700" }]}>Total</Text>
              <Text style={[styles.previewPrice, { color: text, fontWeight: "700" }]}>€161.15</Text>
            </View>
          </View>

          <View style={{ height: 24 }} />
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  closeBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerCenter: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerIcon: { fontSize: 20 },
  headerTitle: { fontSize: 17, fontWeight: "700" },

  body: { paddingHorizontal: 20, paddingTop: 20, gap: 12 },

  sectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    marginBottom: -4,
    marginTop: 8,
  },

  card: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    gap: 12,
  },

  cardDesc: { fontSize: 13, lineHeight: 18 },

  countRow: { flexDirection: "row", gap: 8 },
  countBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: "center",
  },
  countBtnText: { fontSize: 14, fontWeight: "700" },

  mockUsers: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  mockUserChip: { flexDirection: "row", alignItems: "center", gap: 6 },
  colorDot: { width: 10, height: 10, borderRadius: 5 },
  mockUserName: { fontSize: 13, fontWeight: "500" },

  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    borderRadius: 12,
    gap: 8,
  },
  actionBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },

  previewRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  previewName: { fontSize: 13, flex: 1 },
  previewPrice: { fontSize: 13, fontWeight: "600" },
});
