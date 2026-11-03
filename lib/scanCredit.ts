import { useEffect } from "react";
import { router, useNavigation } from "expo-router";
import { showDialog } from "@/lib/dialog";
import { useI18nStore } from "@/store/i18nStore";

// C1 (owner, 03-11-2026, point 3) — after a scan that was read (and paid
// for: Vision, GPT and the credit), going back towards the photo / gallery /
// manual screen asks first: "Esta fatura já foi lida e o crédito foi usado.
// Se voltares atrás, perdes esse crédito." — Continuar com esta fatura /
// Fazer novo scan. Every way back counts: the screen's own button, the
// Android back button and gesture, from the guided review or the normal one.
// "Enter manually" spends no credit, so it asks nothing.

let scanCharged = false;

/** A scan was read and charged (true), or there is no paid reading on hand (false). */
export function markScanCharged(on: boolean): void {
  scanCharged = on;
}

export function isScanCharged(): boolean {
  return scanCharged;
}

const BACK_ACTIONS = new Set(["GO_BACK", "POP", "POP_TO_TOP"]);

/** On a screen that shows a paid reading: catch every way back. */
export function useScanCreditGuard(label: string, enabled: boolean): void {
  const navigation = useNavigation();
  useEffect(() => {
    if (!enabled) return;
    return navigation.addListener("beforeRemove", (e) => {
      if (!scanCharged || !BACK_ACTIONS.has(e.data.action.type)) return;
      e.preventDefault();
      const t = useI18nStore.getState().t;
      console.log(`[scan-credit] ${label}: back after a paid scan — asking first`);
      showDialog(t("scan_credit_back_title"), t("scan_credit_back_msg"), [
        { text: t("scan_credit_keep"), style: "cancel" },
        {
          text: t("scan_credit_new_scan"),
          style: "destructive",
          onPress: () => {
            console.log(`[scan-credit] ${label}: new scan — this reading and its credit are given up`);
            scanCharged = false;
            router.dismissTo("/(app)/scan");
          },
        },
      ]);
    });
  }, [enabled, label, navigation]);
}
