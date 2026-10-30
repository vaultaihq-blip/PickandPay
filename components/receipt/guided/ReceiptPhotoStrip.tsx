/**
 * FIX 46 — the receipt photo, present on every guided step so the user can
 * read the paper while correcting it. Compact by design: a small thumbnail
 * with a hint text, never a field-sized block, so it never competes with the
 * inputs below it for space on a small screen. Tapping it opens a full-screen
 * zoom, owned entirely by this component — no state to lift into the screen
 * that renders it, so every step gets this by adding one line.
 *
 * Reads receiptStore.rawImageUri, the same field review-receipt.tsx's own
 * (pre-existing) full list view already uses for its photo card and
 * full-screen modal — confirmed present and populated by receipt-preview.tsx
 * before this screen is ever reached.
 */
import React, { useState } from "react";
import { View, Text, Image, TouchableOpacity, Modal, useWindowDimensions, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useReceiptStore } from "@/store/receiptStore";
import { useGuidedTheme } from "./GuidedShell";

export function ReceiptPhotoStrip() {
  const rawImageUri = useReceiptStore((s) => s.rawImageUri);
  const [zoomed, setZoomed] = useState(false);
  const { mutedColor, cardColor, borderColor } = useGuidedTheme();
  const { width } = useWindowDimensions();

  if (!rawImageUri) return null;

  return (
    <>
      <TouchableOpacity
        style={[styles.strip, { backgroundColor: cardColor, borderColor }]}
        onPress={() => setZoomed(true)}
        activeOpacity={0.8}
      >
        <Image source={{ uri: rawImageUri }} style={styles.thumb} resizeMode="cover" />
        <Text style={[styles.hint, { color: mutedColor }]}>Toca para ampliar a foto</Text>
        <Ionicons name="expand-outline" size={16} color={mutedColor} />
      </TouchableOpacity>

      <Modal visible={zoomed} transparent animationType="fade" onRequestClose={() => setZoomed(false)}>
        <View style={styles.overlay}>
          <TouchableOpacity
            style={styles.close}
            onPress={() => setZoomed(false)}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Ionicons name="close-circle" size={36} color="#fff" />
          </TouchableOpacity>
          <Image source={{ uri: rawImageUri }} style={[styles.zoomed, { width }]} resizeMode="contain" />
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginHorizontal: 20,
    marginBottom: 4,
    borderRadius: 10,
    borderWidth: 1,
  },
  thumb: { width: 36, height: 36, borderRadius: 6 },
  hint: { flex: 1, fontSize: 12, fontWeight: "500" },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)", alignItems: "center", justifyContent: "center" },
  close: { position: "absolute", top: 56, right: 20, zIndex: 10 },
  zoomed: { flex: 1 },
});
