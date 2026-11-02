import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { TranslationKey } from "@/constants/translations";
import { showDialog } from "@/lib/dialog";
import { groupItems, groupState, ItemGroup, GroupState } from "@/lib/units";
import { formatCurrency } from "@/utils/formatter";
import { PersonDots, DotPerson } from "@/components/selection/PersonDot";
import type { ShareRequest } from "@/store/shareRequestsStore";
import type { ParsedReceipt, SessionParticipant } from "@/types";

// R12 — the lobby's expanded receipt shows what is still to pick: a summary
// on top ("Faltam 3 itens por escolher" / "Todos os itens têm dono ✓"), the
// items with units nobody holds first, highlighted like the mirror review
// (light red, "!") with "1 de 2 Wisky Sour por escolher", then the complete
// ones with the circles of who picked them; pending share requests next to
// their item ("à espera do Bruno").

const ORDER = ["starters", "mains", "drinks", "desserts", "others"] as const;

export interface ItemProgress {
  group: ItemGroup;
  state: GroupState;
}

/** Every item with who holds it; `missing` = units nobody holds. */
export function receiptProgress(receipt: ParsedReceipt, participants: SessionParticipant[]) {
  const people = participants.map((p) => ({ userId: p.userId, selections: p.selections }));
  const rows: ItemProgress[] = [];
  for (const cat of ORDER) {
    for (const group of groupItems(receipt.categories[cat] ?? [])) {
      rows.push({ group, state: groupState(group.lineIds, group.units, people, undefined) });
    }
  }
  const missing = rows.reduce((s, r) => s + (r.group.item.totalPrice > 0 ? r.state.freeUnits : 0), 0);
  return { rows, missing };
}

export function LobbyReceiptItems({
  receipt,
  participants,
  myId,
  requests,
  initials,
  t,
}: {
  receipt: ParsedReceipt;
  participants: SessionParticipant[];
  myId: string | undefined;
  requests: ShareRequest[];
  initials: Map<string, string>;
  t: (key: TranslationKey) => string;
}) {
  const { rows, missing } = receiptProgress(receipt, participants);
  const open = rows.filter((r) => r.state.freeUnits > 0 && r.group.item.totalPrice > 0);
  const done = rows.filter((r) => !(r.state.freeUnits > 0 && r.group.item.totalPrice > 0));
  const nameOf = (uid: string) => participants.find((p) => p.userId === uid)?.profile.name ?? "?";

  const dots = (r: ItemProgress): DotPerson[] => {
    const lineSet = new Set(r.group.lineIds);
    const out: DotPerson[] = [];
    const add = (uid: string, state: DotPerson["state"]) => {
      const p = participants.find((pp) => pp.userId === uid);
      if (!p || out.some((d) => d.userId === uid)) return;
      out.push({ userId: uid, name: p.profile.name, initials: initials.get(uid) ?? "?", color: p.profile.color, color2: p.profile.color2, isMe: uid === myId, state });
    };
    r.state.holders.forEach((h) => add(h.userId, "confirmed"));
    requests.forEach((q) => {
      if (q.status === "pending" && lineSet.has(q.item_id)) add(q.to_user, "pending");
    });
    return out;
  };

  const waiting = (r: ItemProgress) => {
    const lineSet = new Set(r.group.lineIds);
    const names = [...new Set(requests.filter((q) => q.status === "pending" && lineSet.has(q.item_id)).map((q) => nameOf(q.to_user)))];
    return names.length > 0 ? t("lobby_items_waiting").replace("{names}", names.join(", ")) : null;
  };

  const row = (r: ItemProgress, highlight: boolean) => {
    const people = dots(r);
    const wait = waiting(r);
    const { group, state } = r;
    const label = highlight
      ? group.units > 1
        ? t("lobby_items_units_missing")
            .replace("{free}", String(state.freeUnits))
            .replace("{total}", String(group.units))
            .replace("{item}", group.item.name)
        : t("lobby_items_missing_one").replace("{item}", group.item.name)
      : `${group.units > 1 ? `${group.units}× ` : ""}${group.item.name}`;
    return (
      <View key={group.lineIds[0]} style={[styles.row, highlight && styles.rowOpen]}>
        {highlight && (
          <View style={styles.bang}>
            <Text style={styles.bangText}>!</Text>
          </View>
        )}
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[styles.name, highlight && styles.nameOpen]} numberOfLines={2}>{label}</Text>
          {wait && <Text style={styles.wait}>{wait}</Text>}
        </View>
        <PersonDots
          people={people}
          youLabel={t("you_short")}
          onPress={() =>
            showDialog(
              group.item.name,
              people.map((p) => `${p.isMe ? `${p.name} (${t("you_short")})` : p.name}${p.state === "pending" ? ` — ${t("units_state_pending")}` : ""}`).join("\n")
            )
          }
        />
        <Text style={styles.price}>{formatCurrency(group.item.totalPrice, receipt.currency)}</Text>
      </View>
    );
  };

  return (
    <View style={{ gap: 6 }}>
      {missing > 0 ? (
        <View style={[styles.summary, styles.summaryOpen]}>
          <Ionicons name="alert-circle" size={16} color="#EF4444" />
          <Text style={[styles.summaryText, { color: "#FCA5A5" }]}>
            {missing === 1 ? t("lobby_items_left_one") : t("lobby_items_left_many").replace("{n}", String(missing))}
          </Text>
        </View>
      ) : (
        <View style={[styles.summary, styles.summaryDone]}>
          <Text style={[styles.summaryText, { color: "#22C55E" }]}>{t("lobby_items_all_owned")}</Text>
        </View>
      )}
      {open.map((r) => row(r, true))}
      {done.map((r) => row(r, false))}
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10 },
  summaryOpen: { backgroundColor: "rgba(239,68,68,0.12)" },
  summaryDone: { backgroundColor: "rgba(34,197,94,0.12)" },
  summaryText: { fontSize: 14, fontWeight: "800" },
  row: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 8 },
  rowOpen: { backgroundColor: "rgba(239,68,68,0.12)" },
  bang: { width: 20, height: 20, borderRadius: 10, backgroundColor: "#EF4444", alignItems: "center", justifyContent: "center" },
  bangText: { color: "#FFFFFF", fontSize: 13, fontWeight: "900" },
  name: { color: "#E5E7EB", fontSize: 14 },
  nameOpen: { color: "#FCA5A5", fontWeight: "700" },
  wait: { color: "#F59E0B", fontSize: 12 },
  price: { color: "#9CA3AF", fontSize: 13, minWidth: 64, textAlign: "right" },
});
