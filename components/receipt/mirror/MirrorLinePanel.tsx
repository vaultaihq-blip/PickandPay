import React, { useEffect, useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Colors } from "@/constants/colors";
import { StepperButton } from "@/components/ui/StepperButton";
import { useI18nStore } from "@/store/i18nStore";
import { categoryForGroup, groupKindOf, type GroupKind } from "@/components/receipt/ReceiptView/groups";
import { GroupIcon } from "@/components/receipt/ReceiptView/GroupIcon";

// R10 — the correction panel (bottom sheet) for one line of the mirror: the
// crop of the photo where the line is (the parser's per-line position),
// name, quantity − / + (48×48, C3), unit price, the line total worked out,
// Apagar / Guardar. Guardar confirms the line (green).
export type PanelLine = {
  ids: string[];
  name: string;
  quantity: number;
  unitPrice: number;
  photoBox?: readonly [number, number, number, number];
  /** D.3: the line's category (starters, mains, drinks, desserts, others). */
  category?: string;
};

type Props = {
  line: PanelLine | null;
  photoUri: string | null;
  formatMoney: (v: number) => string;
  onSave: (ids: string[], v: { name: string; quantity: number; unitPrice: number; category?: string }) => void;
  onDelete: (ids: string[]) => void;
  onClose: () => void;
};

const parseAmount = (raw: string) => {
  const n = parseFloat(raw.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};

/** The band of the photo where the line is, scaled to `width`. */
function PhotoCrop({ uri, box, width }: { uri: string; box: readonly [number, number, number, number]; width: number }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    Image.getSize(uri, (w, h) => setSize({ w, h }), () => setSize(null));
  }, [uri]);
  if (!size) return null;
  const x0 = Math.max(0, box[0] - 0.02), x1 = Math.min(1, box[2] + 0.02);
  const y0 = Math.max(0, box[1] - 0.012), y1 = Math.min(1, box[3] + 0.012);
  const scale = width / ((x1 - x0) * size.w);
  return (
    <View style={[styles.crop, { width, height: Math.max(28, (y1 - y0) * size.h * scale) }]}>
      <Image
        source={{ uri }}
        style={{ position: "absolute", width: size.w * scale, height: size.h * scale, left: -x0 * size.w * scale, top: -y0 * size.h * scale }}
        resizeMode="stretch"
      />
    </View>
  );
}

export function MirrorLinePanel({ line, photoUri, formatMoney, onSave, onDelete, onClose }: Props) {
  const { t } = useI18nStore();
  const [name, setName] = useState("");
  const [qty, setQty] = useState(1);
  const [unitText, setUnitText] = useState("");
  const [cropWidth, setCropWidth] = useState(0);
  const [group, setGroup] = useState<GroupKind>("food");

  useEffect(() => {
    if (!line) return;
    setName(line.name);
    setQty(line.quantity);
    setUnitText(line.unitPrice > 0 ? line.unitPrice.toFixed(2) : "");
    setGroup(groupKindOf(line.category));
  }, [line]);

  const unit = parseAmount(unitText);
  const canSave = name.trim().length > 0 && unit !== null;

  return (
    <Modal visible={line !== null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t("cancel")} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.sheetWrap}>
        <View style={styles.sheet} onLayout={(e) => setCropWidth(e.nativeEvent.layout.width - 32)}>
          <View style={styles.grabber} />
          {line?.photoBox && photoUri && cropWidth > 0 ? (
            <PhotoCrop uri={photoUri} box={line.photoBox} width={cropWidth} />
          ) : null}

          <Text style={styles.label}>{t("mirror_panel_name")}</Text>
          <TextInput value={name} onChangeText={setName} style={styles.input} placeholder={t("mirror_panel_name")} placeholderTextColor={Colors.textMutedDark} />

          {/* D.3: the group, in the same panel */}
          <Text style={styles.label}>{t("mirror_panel_group")}</Text>
          <View style={styles.groupRow}>
            {(["food", "drinks", "others"] as GroupKind[]).map((k) => (
              <TouchableOpacity
                key={k}
                onPress={() => setGroup(k)}
                style={[styles.groupBtn, group === k && styles.groupBtnOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: group === k }}
              >
                <GroupIcon kind={k} color={group === k ? Colors.textPrimaryDark : Colors.textMutedDark} />
                <Text style={[styles.groupText, group === k && { color: Colors.textPrimaryDark }]}>
                  {t(k === "food" ? "receipt_group_pick_food" : k === "drinks" ? "receipt_group_pick_drinks" : "receipt_group_pick_others")}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>{t("mirror_panel_qty")}</Text>
              <View style={styles.qtyRow}>
                <StepperButton label="−" onPress={() => setQty((q) => Math.max(1, q - 1))} disabled={qty <= 1} color={Colors.primary} mutedColor={Colors.textMutedDark} accessibilityLabel="−1" />
                <Text style={styles.qty}>{qty}</Text>
                <StepperButton label="+" onPress={() => setQty((q) => q + 1)} color={Colors.primary} mutedColor={Colors.textMutedDark} accessibilityLabel="+1" />
              </View>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>{t("mirror_panel_unit")}</Text>
              <TextInput value={unitText} onChangeText={setUnitText} keyboardType="decimal-pad" style={[styles.input, styles.amount]} placeholder="0,00" placeholderTextColor={Colors.textMutedDark} />
            </View>
          </View>

          <View style={styles.totalRow}>
            <Text style={styles.label}>{t("mirror_panel_total")}</Text>
            <Text style={styles.total}>{unit === null ? "—" : formatMoney(Math.round(qty * unit * 100) / 100)}</Text>
          </View>

          <View style={styles.actions}>
            <TouchableOpacity style={styles.deleteBtn} onPress={() => line && onDelete(line.ids)} accessibilityRole="button">
              <Text style={styles.deleteText}>{t("mirror_delete")}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.saveBtn, !canSave && { opacity: 0.45 }]}
              disabled={!canSave}
              onPress={() => line && unit !== null && onSave(line.ids, { name: name.trim(), quantity: qty, unitPrice: unit, category: categoryForGroup(group, line.category) })}
              accessibilityRole="button"
            >
              <Text style={styles.saveText}>{t("mirror_save")}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: Colors.overlay },
  sheetWrap: { position: "absolute", left: 0, right: 0, bottom: 0 },
  sheet: { backgroundColor: Colors.surfaceDark, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderWidth: 1, borderColor: Colors.cardBorderDark, padding: 16, paddingBottom: 28, gap: 8 },
  grabber: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.cardBorderDark, marginBottom: 6 },
  crop: { overflow: "hidden", borderRadius: 8, borderWidth: 1, borderColor: Colors.cardBorderDark, backgroundColor: Colors.cardDark, marginBottom: 4 },
  label: { fontSize: 12, color: Colors.textSecondaryDark, fontWeight: "600" },
  input: { borderWidth: 1, borderColor: Colors.cardBorderDark, backgroundColor: Colors.cardDark, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: Colors.textPrimaryDark },
  amount: { textAlign: "right" },
  groupRow: { flexDirection: "row", gap: 8 },
  groupBtn: { flex: 1, minHeight: 48, borderRadius: 10, borderWidth: 1, borderColor: Colors.cardBorderDark, backgroundColor: Colors.cardDark, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 6 },
  groupBtnOn: { borderColor: Colors.primary, backgroundColor: Colors.primaryTintDark },
  groupText: { color: Colors.textMutedDark, fontWeight: "600", fontSize: 14 },
  row: { flexDirection: "row", gap: 12, alignItems: "flex-end" },
  qtyRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48 },
  qty: { fontSize: 18, fontWeight: "800", minWidth: 24, textAlign: "center", color: Colors.textPrimaryDark },
  totalRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6 },
  total: { fontSize: 18, fontWeight: "800", color: Colors.textPrimaryDark },
  actions: { flexDirection: "row", gap: 12, marginTop: 6 },
  deleteBtn: { flex: 1, minHeight: 48, borderRadius: 12, borderWidth: 1.5, borderColor: Colors.error, alignItems: "center", justifyContent: "center" },
  deleteText: { color: Colors.errorLight, fontWeight: "700", fontSize: 15 },
  saveBtn: { flex: 2, minHeight: 48, borderRadius: 12, backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center" },
  saveText: { color: Colors.white, fontWeight: "700", fontSize: 15 },
});
