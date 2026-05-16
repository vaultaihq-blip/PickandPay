import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  useColorScheme,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SuggestedTip, TipStatus, TipMode, Currency } from "@/types";
import { formatCurrency, getCurrencySymbol } from "@/utils/formatter";
import { Colors } from "@/constants/colors";

const MAIN_PERCENTAGES = [10, 15, 20] as const;

interface TipSelectorProps {
  suggestedTips: SuggestedTip[];
  currency: Currency;
  subtotal: number;
  currentTipStatus?: TipStatus;
  currentTipAmount?: number;
  currentTipMode?: TipMode;
  onSelect: (status: TipStatus, amount?: number, percentage?: number) => void;
  onTipModeChange?: (mode: TipMode) => void;
}

export function TipSelector({
  currency,
  subtotal,
  currentTipStatus,
  currentTipAmount,
  currentTipMode = "equal",
  onSelect,
  onTipModeChange,
}: TipSelectorProps) {
  const [inputMode, setInputMode] = useState<"choose" | "customPct" | "customAmt">("choose");
  const [customPct, setCustomPct] = useState("");
  const [customAmt, setCustomAmt] = useState("");
  const [modeSwitchMsg, setModeSwitchMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!modeSwitchMsg) return;
    const timer = setTimeout(() => setModeSwitchMsg(null), 2500);
    return () => clearTimeout(timer);
  }, [modeSwitchMsg]);

  const isDark = useColorScheme() === "dark";
  const textColor = isDark ? Colors.textPrimaryDark : Colors.textPrimaryLight;
  const mutedColor = isDark ? Colors.textMutedDark : Colors.textMutedLight;
  const cardColor = isDark ? Colors.cardDark : Colors.cardLight;
  const borderColor = isDark ? Colors.cardBorderDark : Colors.cardBorderLight;

  const currencySymbol = getCurrencySymbol(currency);

  const handleQuickTip = (pct: number) => {
    const amount = Math.round(subtotal * (pct / 100) * 100) / 100;
    onSelect("modified", amount, pct);
  };

  const handleNoTip = () => onSelect("removed", 0, 0);

  const handleCustomPctSubmit = () => {
    const pct = parseFloat(customPct);
    if (!isNaN(pct) && pct >= 0) {
      const amount = Math.round(subtotal * (pct / 100) * 100) / 100;
      onSelect("modified", amount, pct);
      setInputMode("choose");
      setCustomPct("");
    }
  };

  const handleCustomAmtSubmit = () => {
    const amount = parseFloat(customAmt.replace(",", "."));
    if (!isNaN(amount) && amount >= 0) {
      onSelect("modified", Math.round(amount * 100) / 100);
      setInputMode("choose");
      setCustomAmt("");
    }
  };

  const isNoTipSelected = currentTipStatus === "removed";
  const isPctSelected = (pct: number) => {
    if (currentTipStatus === "removed") return false;
    const expected = Math.round(subtotal * (pct / 100) * 100) / 100;
    return currentTipAmount === expected;
  };

  return (
    <View style={[styles.container, { borderColor }]}>
      {/* Header row with mode toggle */}
      <View style={styles.titleRow}>
        <Text style={[styles.title, { color: textColor }]}>Tip</Text>
        {onTipModeChange && (
          <View style={[styles.modeToggle, { borderColor }]}>
            <TouchableOpacity
              style={[styles.modeBtn, currentTipMode === "equal" && { backgroundColor: Colors.primary }]}
              onPress={() => {
                onTipModeChange("equal");
                setModeSwitchMsg("Equal mode — pick a tip below");
              }}
            >
              <Text style={[styles.modeBtnText, { color: currentTipMode === "equal" ? "#fff" : mutedColor }]}>
                Equal
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modeBtn, currentTipMode === "individual" && { backgroundColor: Colors.primary }]}
              onPress={() => {
                onTipModeChange("individual");
                setModeSwitchMsg("Each person picks their own tip during selection");
              }}
            >
              <Text style={[styles.modeBtnText, { color: currentTipMode === "individual" ? "#fff" : mutedColor }]}>
                Individual
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {modeSwitchMsg ? (
        <Text style={[styles.modeSwitchFeedback, { color: Colors.success }]}>✓ {modeSwitchMsg}</Text>
      ) : currentTipMode === "individual" ? (
        <Text style={[styles.modeHint, { color: mutedColor }]}>Each person picks their own tip during selection.</Text>
      ) : null}

      {currentTipMode === "equal" && (
        <>
          {/* Main tip cards: 10% | 15% | 20% | No Tip */}
          {inputMode === "choose" && (
            <>
              <View style={styles.mainRow}>
                {MAIN_PERCENTAGES.map((pct) => {
                  const amount = Math.round(subtotal * (pct / 100) * 100) / 100;
                  const selected = isPctSelected(pct);
                  return (
                    <TouchableOpacity
                      key={pct}
                      style={[
                        styles.tipCard,
                        { borderColor: selected ? Colors.primary : borderColor },
                        selected && styles.tipCardSelected,
                      ]}
                      onPress={() => handleQuickTip(pct)}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.tipCardPct, { color: selected ? Colors.primary : textColor }]}>
                        {pct}%
                      </Text>
                      <Text style={[styles.tipCardAmt, { color: selected ? Colors.primary : mutedColor }]}>
                        {formatCurrency(amount, currency)}
                      </Text>
                    </TouchableOpacity>
                  );
                })}

                {/* No Tip card */}
                <TouchableOpacity
                  style={[
                    styles.tipCard,
                    { borderColor: isNoTipSelected ? "#FF3B30" : borderColor },
                    isNoTipSelected && styles.tipCardNoTipSelected,
                  ]}
                  onPress={handleNoTip}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name="close-circle-outline"
                    size={20}
                    color={isNoTipSelected ? "#FF3B30" : mutedColor}
                  />
                  <Text style={[styles.tipCardPct, { color: isNoTipSelected ? "#FF3B30" : mutedColor, fontSize: 12 }]}>
                    No Tip
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Custom buttons */}
              <View style={styles.customBtnRow}>
                <TouchableOpacity
                  style={[styles.customBtn, { borderColor }]}
                  onPress={() => setInputMode("customPct")}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.customBtnText, { color: mutedColor }]}>Custom %</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.customBtn, { borderColor }]}
                  onPress={() => setInputMode("customAmt")}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.customBtnText, { color: mutedColor }]}>Custom {currencySymbol}</Text>
                </TouchableOpacity>
              </View>
            </>
          )}

          {/* Custom % input */}
          {inputMode === "customPct" && (
            <View style={styles.inputRow}>
              <TextInput
                style={[styles.inputField, { color: textColor, borderColor, backgroundColor: cardColor }]}
                value={customPct}
                onChangeText={setCustomPct}
                placeholder="e.g. 18"
                placeholderTextColor={mutedColor}
                keyboardType="decimal-pad"
                autoFocus
              />
              <Text style={[styles.inputUnit, { color: mutedColor }]}>%</Text>
              <TouchableOpacity style={styles.applyBtn} onPress={handleCustomPctSubmit}>
                <Text style={styles.applyBtnText}>Apply</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setInputMode("choose")}>
                <Text style={[styles.cancelText, { color: mutedColor }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Custom amount input */}
          {inputMode === "customAmt" && (
            <View style={styles.inputRow}>
              <Text style={[styles.inputUnit, { color: mutedColor }]}>{currencySymbol}</Text>
              <TextInput
                style={[styles.inputField, { color: textColor, borderColor, backgroundColor: cardColor }]}
                value={customAmt}
                onChangeText={setCustomAmt}
                placeholder="0.00"
                placeholderTextColor={mutedColor}
                keyboardType="decimal-pad"
                autoFocus
              />
              <TouchableOpacity style={styles.applyBtn} onPress={handleCustomAmtSubmit}>
                <Text style={styles.applyBtnText}>Apply</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setInputMode("choose")}>
                <Text style={[styles.cancelText, { color: mutedColor }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Current tip summary line */}
          {currentTipStatus && currentTipStatus !== "pending" && inputMode === "choose" && (
            <View style={styles.currentTipRow}>
              <Text style={[styles.currentTipText, { color: mutedColor }]}>
                {currentTipStatus === "removed"
                  ? "No tip added"
                  : `Tip: ${formatCurrency(currentTipAmount ?? 0, currency)}`}
              </Text>
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },

  // ── Header ──────────────────────────────────────────────────────────────────
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: {
    fontSize: 14,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  modeToggle: {
    flexDirection: "row",
    borderWidth: 1,
    borderRadius: 8,
    overflow: "hidden",
  },
  modeBtn: {
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  modeBtnText: {
    fontSize: 12,
    fontWeight: "600",
  },
  modeHint: {
    fontSize: 12,
    fontStyle: "italic",
  },
  modeSwitchFeedback: {
    fontSize: 12,
    fontStyle: "italic",
    fontWeight: "600",
  },

  // ── Main 4-card row ──────────────────────────────────────────────────────────
  mainRow: {
    flexDirection: "row",
    gap: 8,
  },
  tipCard: {
    flex: 1,
    borderWidth: 1.5,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  tipCardSelected: {
    backgroundColor: Colors.primary + "18",
  },
  tipCardNoTipSelected: {
    backgroundColor: "#FF3B3015",
  },
  tipCardPct: {
    fontSize: 15,
    fontWeight: "700",
  },
  tipCardAmt: {
    fontSize: 11,
    fontWeight: "500",
  },

  // ── Custom buttons row ────────────────────────────────────────────────────────
  customBtnRow: {
    flexDirection: "row",
    gap: 8,
  },
  customBtn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  customBtnText: {
    fontSize: 13,
    fontWeight: "600",
  },

  // ── Custom input row ─────────────────────────────────────────────────────────
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  inputField: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 16,
    width: 80,
    textAlign: "center",
  },
  inputUnit: {
    fontSize: 16,
    fontWeight: "600",
  },
  applyBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  applyBtnText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 14,
  },
  cancelText: {
    fontSize: 14,
  },

  // ── Current tip summary ───────────────────────────────────────────────────────
  currentTipRow: {
    alignItems: "flex-end",
  },
  currentTipText: {
    fontSize: 13,
    fontStyle: "italic",
  },
});
