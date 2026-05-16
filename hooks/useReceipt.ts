import { useCallback } from "react";
import { useReceiptStore } from "@/store/receiptStore";
import { supabase } from "@/lib/supabase";
import { ParsedReceipt } from "@/types";
import { normalizeReceipt } from "@/utils/parser";

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

  // Real Supabase Edge Function integration path (for when OCR backend is live)
  const processImage = useCallback(
    async (base64Image: string, imageUri: string) => {
      setProcessing(true, "Uploading image...");
      setRawImageUri(imageUri);
      setError(null);

      try {
        setProcessing(true, "Analyzing receipt with AI...");

        const { data, error } = await supabase.functions.invoke("parse-receipt", {
          body: { image: base64Image },
        });

        if (error) throw error;

        setProcessing(true, "Organizing items...");
        await new Promise((resolve) => setTimeout(resolve, 500));

        const normalized = normalizeReceipt(data as Partial<ParsedReceipt>);
        setReceipt(normalized);
        setProcessing(false);
        return normalized;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to process receipt");
        setProcessing(false);
        return null;
      }
    },
    [setProcessing, setRawImageUri, setError, setReceipt]
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
