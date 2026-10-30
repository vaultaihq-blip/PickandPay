import { create } from "zustand";
import { ParsedReceipt, ReceiptItem, GlobalCost, TipStatus, TipMode, ItemCategory, Currency } from "@/types";

interface ReceiptState {
  receipt: ParsedReceipt | null;
  rawImageUri: string | null;
  rawOcrText: string | null;
  pendingImageUri: string | null;
  pendingImageBase64: string | null;
  isProcessing: boolean;
  processingStep: string;
  error: string | null;

  // Actions
  setReceipt: (receipt: ParsedReceipt) => void;
  setRawImageUri: (uri: string | null) => void;
  setRawOcrText: (text: string | null) => void;
  setPendingImage: (uri: string, base64: string) => void;
  setProcessing: (isProcessing: boolean, step?: string) => void;
  setError: (error: string | null) => void;
  setRestaurantName: (name: string) => void;
  setCurrency: (currency: Currency) => void;
  addItem: (category: ItemCategory, item: ReceiptItem) => void;
  removeItem: (itemId: string) => void;
  updateItem: (category: string, itemId: string, updates: Partial<ReceiptItem>) => void;
  updateGlobalCost: (costId: string, updates: Partial<GlobalCost>) => void;
  setTip: (status: TipStatus, amount?: number, percentage?: number) => void;
  setTipMode: (mode: TipMode) => void;
  groupItems: (itemIds: string[]) => void;
  clearReceipt: () => void;
}

export const useReceiptStore = create<ReceiptState>((set, get) => ({
  receipt: null,
  rawImageUri: null,
  rawOcrText: null,
  pendingImageUri: null,
  pendingImageBase64: null,
  isProcessing: false,
  processingStep: "",
  error: null,

  setReceipt: (receipt) => set({ receipt, error: null }),

  setRawImageUri: (rawImageUri) => set({ rawImageUri }),

  setRawOcrText: (rawOcrText) => set({ rawOcrText }),

  setPendingImage: (uri, base64) => set({ pendingImageUri: uri, pendingImageBase64: base64 }),

  setProcessing: (isProcessing, step = "") =>
    set({ isProcessing, processingStep: step }),

  setError: (error) => set({ error }),

  setRestaurantName: (name) => {
    const receipt = get().receipt;
    if (!receipt) return;
    set({ receipt: { ...receipt, restaurant: name } });
  },

  setCurrency: (currency) => {
    const receipt = get().receipt;
    if (!receipt) return;
    set({ receipt: { ...receipt, currency } });
  },

  addItem: (category, item) => {
    const receipt = get().receipt;
    if (!receipt) return;
    const categories = { ...receipt.categories };
    categories[category] = [...categories[category], item];
    set({ receipt: { ...receipt, categories } });
  },

  removeItem: (itemId) => {
    const receipt = get().receipt;
    if (!receipt) return;
    const cats = Object.keys(receipt.categories) as ItemCategory[];
    const categories = { ...receipt.categories };
    for (const cat of cats) {
      categories[cat] = categories[cat].filter((i) => i.id !== itemId);
    }
    set({ receipt: { ...receipt, categories } });
  },

  updateItem: (category, itemId, updates) => {
    const receipt = get().receipt;
    if (!receipt) return;

    const categories = { ...receipt.categories };
    const categoryKey = category as keyof typeof categories;
    categories[categoryKey] = categories[categoryKey].map((item) =>
      item.id === itemId ? { ...item, ...updates } : item
    );
    set({ receipt: { ...receipt, categories } });
  },

  updateGlobalCost: (costId, updates) => {
    const receipt = get().receipt;
    if (!receipt) return;
    set({
      receipt: {
        ...receipt,
        globalCosts: receipt.globalCosts.map((cost) =>
          cost.id === costId ? { ...cost, ...updates } : cost
        ),
      },
    });
  },

  groupItems: (itemIds) => {
    const receipt = get().receipt;
    if (!receipt || itemIds.length < 2) return;

    const allCats = Object.keys(receipt.categories) as ItemCategory[];
    const found: ReceiptItem[] = [];
    let primaryCat: ItemCategory | null = null;

    for (const cat of allCats) {
      for (const item of receipt.categories[cat]) {
        if (itemIds.includes(item.id)) {
          found.push(item);
          if (primaryCat === null) primaryCat = cat;
        }
      }
    }

    if (found.length < 2 || primaryCat === null) return;

    const totalPrice = found.reduce((s, i) => s + i.totalPrice, 0);
    const totalQty = found.reduce((s, i) => s + i.quantity, 0);

    const grouped: ReceiptItem = {
      id: `group_${Date.now()}`,
      name: found[0].name,
      category: primaryCat,
      quantity: totalQty,
      unitPrice: totalQty > 0 ? totalPrice / totalQty : totalPrice,
      totalPrice,
      type: "group",
      components: found,
      warnings: [],
    };

    const idSet = new Set(itemIds);
    const categories = { ...receipt.categories };
    for (const cat of allCats) {
      categories[cat] = categories[cat].filter((i) => !idSet.has(i.id));
    }
    categories[primaryCat] = [...categories[primaryCat], grouped];

    set({ receipt: { ...receipt, categories } });
  },

  setTip: (status, amount, percentage) => {
    const receipt = get().receipt;
    if (!receipt) return;
    set({
      receipt: {
        ...receipt,
        tipStatus: status,
        selectedTip: amount,
        tipPercentage: status === "removed" ? 0 : (percentage ?? receipt.tipPercentage),
      },
    });
  },

  setTipMode: (mode) => {
    const receipt = get().receipt;
    if (!receipt) return;
    set({ receipt: { ...receipt, tipMode: mode } });
  },

  clearReceipt: () =>
    set({
      receipt: null,
      rawImageUri: null,
      rawOcrText: null,
      pendingImageUri: null,
      pendingImageBase64: null,
      isProcessing: false,
      processingStep: "",
      error: null,
    }),
}));
