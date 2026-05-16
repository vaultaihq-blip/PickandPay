import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  ScrollView,
  StyleSheet,
  useColorScheme,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SessionParticipant, ReceiptItem } from "@/types";
import { Avatar } from "@/components/ui/Avatar";
import { Colors } from "@/constants/colors";
import { formatCurrency } from "@/utils/formatter";

interface SharedItemModalProps {
  visible: boolean;
  item: ReceiptItem | null;
  participants: SessionParticipant[];
  currentUserId: string;
  initialSharedWith: string[];
  currency: string;
  onConfirm: (sharedWith: string[]) => void;
  onClose: () => void;
}

export function SharedItemModal({
  visible,
  item,
  participants,
  currentUserId,
  initialSharedWith,
  currency,
  onConfirm,
  onClose,
}: SharedItemModalProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    new Set(initialSharedWith.length > 0 ? initialSharedWith : [currentUserId])
  );
  const isDark = useColorScheme() === "dark";
  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const bgColor = isDark ? Colors.cardDark : Colors.cardLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;

  const curr = currency as "EUR" | "USD" | "CAD" | "GBP";
  const perPersonAmount = item
    ? item.totalPrice / Math.max(selectedIds.size, 1)
    : 0;

  const toggleParticipant = (userId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId) && next.size > 1) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.container, { backgroundColor: bgColor }]}>
        {/* Header */}
        <View style={[styles.header, { borderColor }]}>
          <TouchableOpacity onPress={onClose}>
            <Ionicons name="close" size={24} color={textColor} />
          </TouchableOpacity>
          <Text style={[styles.title, { color: textColor }]}>
            Who shares this?
          </Text>
          <View style={{ width: 24 }} />
        </View>

        {/* Item info */}
        {item && (
          <View style={[styles.itemInfo, { borderColor }]}>
            <Text style={[styles.itemName, { color: textColor }]}>
              {item.name}
            </Text>
            <Text style={[styles.itemTotal, { color: mutedColor }]}>
              Total: {formatCurrency(item.totalPrice, curr)}
            </Text>
          </View>
        )}

        {/* Participants */}
        <ScrollView style={styles.list}>
          {participants.map((participant) => {
            const isSelected = selectedIds.has(participant.userId);
            const isCurrentUser = participant.userId === currentUserId;
            return (
              <TouchableOpacity
                key={participant.userId}
                style={[
                  styles.participantRow,
                  { borderColor },
                  isSelected && {
                    backgroundColor: participant.profile.color + "18",
                  },
                ]}
                onPress={() => toggleParticipant(participant.userId)}
                activeOpacity={0.7}
              >
                <Avatar
                  name={participant.profile.name}
                  avatarIcon={participant.profile.avatarIcon}
                  avatarUrl={participant.profile.avatarUrl}
                  color={participant.profile.color}
                  size={36}
                />
                <Text style={[styles.participantName, { color: textColor }]}>
                  {participant.profile.name}
                  {isCurrentUser ? " (you)" : ""}
                </Text>
                <View
                  style={[
                    styles.checkbox,
                    {
                      borderColor: isSelected
                        ? participant.profile.color
                        : mutedColor,
                      backgroundColor: isSelected
                        ? participant.profile.color
                        : "transparent",
                    },
                  ]}
                >
                  {isSelected && (
                    <Ionicons name="checkmark" size={14} color="#fff" />
                  )}
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {/* Per-person amount */}
        <View style={[styles.footer, { borderColor }]}>
          <Text style={[styles.perPersonLabel, { color: mutedColor }]}>
            Each person pays:
          </Text>
          <Text style={[styles.perPersonAmount, { color: Colors.primary }]}>
            {formatCurrency(perPersonAmount, curr)}
          </Text>
          <TouchableOpacity
            style={[
              styles.confirmBtn,
              { backgroundColor: Colors.primary },
            ]}
            onPress={() => onConfirm(Array.from(selectedIds))}
          >
            <Text style={styles.confirmBtnText}>
              Split between {selectedIds.size}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontSize: 17,
    fontWeight: "600",
  },
  itemInfo: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  itemName: {
    fontSize: 16,
    fontWeight: "600",
  },
  itemTotal: {
    fontSize: 14,
  },
  list: {
    flex: 1,
  },
  participantRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  participantName: {
    flex: 1,
    fontSize: 15,
    fontWeight: "500",
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  footer: {
    padding: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  perPersonLabel: {
    fontSize: 14,
  },
  perPersonAmount: {
    fontSize: 28,
    fontWeight: "700",
  },
  confirmBtn: {
    padding: 16,
    borderRadius: 14,
    alignItems: "center",
  },
  confirmBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
});
