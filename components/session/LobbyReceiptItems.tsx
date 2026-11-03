import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { TranslationKey } from "@/constants/translations";
import { Colors } from "@/constants/colors";
import { showDialog } from "@/lib/dialog";
import { groupItems, groupState, ItemGroup, GroupState } from "@/lib/units";
import { formatCurrency } from "@/utils/formatter";
import { PersonDots, DotPerson } from "@/components/selection/PersonDot";
import { ReceiptView, type ReceiptViewLine } from "@/components/receipt/ReceiptView/ReceiptView";
import type { ShareRequest } from "@/store/shareRequestsStore";
import type { ParsedReceipt, SessionParticipant } from "@/types";

// R12 + D (04-11-2026) — the lobby's expanded receipt, drawn with the shared
// ReceiptView (lobby mode, read only): a summary on top ("Faltam 3 itens por
// escolher" / "Todos os itens têm dono ✓"); the lines in their groups, red
// for units nobody holds ("1 de 2 Wisky Sour por escolher"), with the circles
// of who picked them and pending share requests ("à espera do Bruno"); the
// charges, tip and total at the end.

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
  total,
  t,
}: {
  receipt: ParsedReceipt;
  participants: SessionParticipant[];
  myId: string | undefined;
  requests: ShareRequest[];
  initials: Map<string, string>;
  /** The receipt's total, as the lobby shows it in its header. */
  total: number;
  t: (key: TranslationKey) => string;
}) {
  const { rows, missing } = receiptProgress(receipt, participants);
  const nameOf = (uid: string) => participants.find((p) => p.userId === uid)?.profile.name ?? "?";
  const money = (v: number) => formatCurrency(v, receipt.currency);

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

  const lines: ReceiptViewLine[] = rows.map((r) => {
    const { group, state } = r;
    const open = state.freeUnits > 0 && group.item.totalPrice > 0;
    const people = dots(r);
    const missingText = open
      ? group.units > 1
        ? t("lobby_items_units_missing").replace("{free}", String(state.freeUnits)).replace("{total}", String(group.units)).replace("{item}", group.item.name)
        : t("lobby_items_missing_one").replace("{item}", group.item.name)
      : undefined;
    return {
      key: group.lineIds[0],
      quantity: group.item.quantity,
      name: group.item.name,
      amount: group.item.totalPrice,
      category: group.item.category,
      photoBox: group.item.photoBox,
      state: open ? "red" : undefined,
      reason: missingText,
      sub: waiting(r) ?? undefined,
      right: (
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
      ),
    };
  });

  const itemsSum = Math.round(rows.reduce((s, r) => s + r.group.item.totalPrice, 0) * 100) / 100;
  const tip = receipt.selectedTip ?? 0;

  return (
    <View style={{ gap: 8 }}>
      {missing > 0 ? (
        <View style={[styles.summary, styles.summaryOpen]}>
          <Ionicons name="alert-circle" size={16} color={Colors.errorLight} />
          <Text style={[styles.summaryText, { color: Colors.errorLight }]}>
            {missing === 1 ? t("lobby_items_left_one") : t("lobby_items_left_many").replace("{n}", String(missing))}
          </Text>
        </View>
      ) : (
        <View style={[styles.summary, styles.summaryDone]}>
          <Text style={[styles.summaryText, { color: Colors.successLight }]}>{t("lobby_items_all_owned")}</Text>
        </View>
      )}
      <ReceiptView
        mode="lobby"
        lines={lines}
        formatMoney={money}
        summary={[
          { key: "items", label: t("mirror_items_sum"), value: money(itemsSum) },
          ...receipt.globalCosts.map((c) => ({ key: `cost_${c.id ?? c.name}`, label: `+ ${c.name}`, value: money(c.amount) })),
          ...(tip > 0 ? [{ key: "tip", label: `+ ${t("mirror_tip")}`, value: money(tip) }] : []),
          { key: "total", label: t("mirror_printed_total"), value: money(total), tone: "total" as const },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1 },
  summaryOpen: { backgroundColor: Colors.errorBg, borderColor: Colors.error },
  summaryDone: { backgroundColor: Colors.successBg, borderColor: Colors.success },
  summaryText: { fontSize: 14, fontWeight: "800" },
});
