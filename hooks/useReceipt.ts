import { useCallback } from "react";
import { useReceiptStore } from "@/store/receiptStore";
import { useCanonicalReceiptStore } from "@/store/canonicalReceiptStore";
import { supabase } from "@/lib/supabase";
import { ParsedReceipt } from "@/types";
import { normalizeReceipt } from "@/utils/parser";
import {
  type CanonicalReceipt,
  type RawReceiptPayload,
  evaluateReceipt,
  normalizeRawReceipt,
  toParsedReceipt,
} from "@/lib/receipt";

/**
 * User-facing copy for the error codes the parse-receipt function returns.
 * Provider errors and internal diagnostics are never shown to end users.
 */
const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  MISSING_IMAGE: "No image was received. Please take the photo again.",
  NOT_CONFIGURED:
    "Receipt scanning is temporarily unavailable. Please try again later.",
  RATE_LIMITED: "Too many scans right now. Please wait a moment and try again.",
  PROVIDER_ERROR:
    "We couldn't reach the scanning service. Please check your connection and try again.",
  UNREADABLE_RECEIPT:
    "We couldn't read this receipt. Try again with better lighting, or enter the items manually.",
  INTERNAL_ERROR: "Something went wrong while reading the receipt. Please try again.",
};

function messageForError(code: unknown): string {
  if (typeof code === "string" && code in ERROR_MESSAGES) {
    return ERROR_MESSAGES[code];
  }
  return ERROR_MESSAGES.INTERNAL_ERROR;
}

interface ParseReceiptResponse {
  schemaVersion?: number;
  receipt?: RawReceiptPayload;
  error?: string;
}

export interface ProcessImageResult {
  legacy: ParsedReceipt;
  canonical: CanonicalReceipt | null;
}

export function useReceipt() {
  const {
    receipt,
    rawImageUri,
    isProcessing,
    processingStep,
    error,
    setReceipt,
    setRawImageUri,
    setProcessing,
    setError,
    updateItem,
    updateGlobalCost,
    setTip,
    clearReceipt,
  } = useReceiptStore();

  const setCanonical = useCanonicalReceiptStore((state) => state.setReceipt);

  const processImage = useCallback(
    async (
      base64Image: string,
      imageUri: string
    ): Promise<ProcessImageResult | null> => {
      setProcessing(true, "Uploading image...");
      setRawImageUri(imageUri);
      setError(null);

      try {
        setProcessing(true, "Reading receipt...");

        const { data, error: invokeError } = await supabase.functions.invoke(
          "parse-receipt",
          { body: { image: base64Image } }
        );

        if (invokeError) throw invokeError;

        const response = data as ParseReceiptResponse | null;
        if (response === null) throw new Error("EMPTY_RESPONSE");
        if (response.error !== undefined) {
          setError(messageForError(response.error));
          setProcessing(false);
          return null;
        }

        setProcessing(true, "Checking the totals...");

        // Structural schema (v2): reconcile and diagnose before showing anything.
        if (response.schemaVersion === 2 && response.receipt !== undefined) {
          const canonical = evaluateReceipt(
            normalizeRawReceipt(response.receipt)
          );
          const legacy = toParsedReceipt(canonical);

          setCanonical(canonical);
          setReceipt(legacy);
          setProcessing(false);
          return { legacy, canonical };
        }

        // Legacy category-based payload — kept so an older deployed function
        // keeps working while the new one rolls out.
        const legacy = normalizeReceipt(data as Partial<ParsedReceipt>);
        setCanonical(null);
        setReceipt(legacy);
        setProcessing(false);
        return { legacy, canonical: null };
      } catch (err) {
        // Surface a friendly message; keep the technical detail in the console
        // for development builds only.
        if (__DEV__) console.error("[useReceipt] processImage failed:", err);
        setError(ERROR_MESSAGES.INTERNAL_ERROR);
        setProcessing(false);
        return null;
      }
    },
    [setProcessing, setRawImageUri, setError, setReceipt, setCanonical]
  );

  return {
    receipt,
    rawImageUri,
    isProcessing,
    processingStep,
    error,
    processImage,
    updateItem,
    updateGlobalCost,
    setTip,
    clearReceipt,
  };
}
