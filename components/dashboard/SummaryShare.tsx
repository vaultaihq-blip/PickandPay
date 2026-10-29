import React from "react";
import { TouchableOpacity, Text, StyleSheet, Share } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Session, SplitResult } from "@/types";
import { Colors } from "@/constants/colors";
import { generateShareSummary } from "@/utils/formatter";
import { showDialog } from "@/lib/dialog";

interface SummaryShareProps {
  session: Session;
  splitResults?: Map<string, SplitResult>;
}

export function SummaryShare({ session, splitResults }: SummaryShareProps) {
  const getSummaryText = (): string | null => {
    try {
      return generateShareSummary(session, splitResults);
    } catch (err) {
      console.error("[SummaryShare] generateShareSummary failed:", err);
      return null;
    }
  };

  const handleShare = async () => {
    const text = getSummaryText();
    if (!text) {
      showDialog("Error", "Could not generate summary. Please try again.");
      return;
    }
    try {
      await Share.share({ message: text });
    } catch (err) {
      console.error("[SummaryShare] share failed:", err);
    }
  };

  return (
    <TouchableOpacity style={[styles.btn, styles.shareBtn]} onPress={handleShare}>
      <Ionicons name="share-outline" size={18} color="#fff" />
      <Text style={styles.shareText}>Share Summary</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    borderRadius: 12,
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 10,
  },
  shareBtn: {
    backgroundColor: Colors.primary,
  },
  shareText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 15,
  },
});
