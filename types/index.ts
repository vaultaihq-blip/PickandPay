// ─── Core Enums / Unions ──────────────────────────────────────────────────────

export type Currency = "EUR" | "USD" | "CAD" | "GBP" | "CNY";

export type ItemCategory =
  | "starters"
  | "mains"
  | "drinks"
  | "desserts"
  | "others";

export type ItemType =
  | "individual"
  | "quantity"
  | "shareable"
  | "combo"
  | "group";

export type GlobalCostType =
  | "tax"
  | "service_charge"
  | "mandatory_service"
  | "delivery"
  | "bag"
  | "plastic"
  | "other";

export type SessionStatus =
  | "draft"
  | "selecting"
  | "review"
  | "awaiting_payment"
  | "paid"
  | "closed";

export type TipStatus = "accepted" | "removed" | "modified" | "pending";
export type TipMode = "equal" | "individual";
export type TaxMode = "inclusive" | "exclusive";

// ─── Receipt Types ─────────────────────────────────────────────────────────────

export interface ReceiptItem {
  id: string;
  name: string;
  category: ItemCategory;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  type: ItemType;
  notes?: string[];
  components?: ReceiptItem[];
  addOns?: ReceiptItem[];
  participants?: string[];
  confidence?: number;
  warnings?: string[];
  /** User has confirmed this item is correct — set automatically on any edit,
   *  or toggled by hand with no edit at all. FIX 44. */
  reviewed?: boolean;
}

export interface GlobalCost {
  id: string;
  name: string;
  amount: number;
  type: GlobalCostType;
  splitByAll: true;
  editable: boolean;
  status?: "included" | "suggested" | "mandatory" | "manual";
}

export interface SuggestedTip {
  percentage: number;
  amount: number;
}

export interface MenuGroup {
  menuItem: ReceiptItem;
  components: ReceiptItem[];
}

export interface ParsedReceipt {
  restaurant: string;
  date?: string;
  currency: Currency;
  tax_mode?: TaxMode;
  printed_total?: number;
  ocr_passes?: number;
  peopleCountDetected?: number;
  categories: {
    starters: ReceiptItem[];
    mains: ReceiptItem[];
    drinks: ReceiptItem[];
    desserts: ReceiptItem[];
    others: ReceiptItem[];
  };
  globalCosts: GlobalCost[];
  suggestedTips: SuggestedTip[];
  tipStatus?: TipStatus;
  selectedTip?: number;
  tipPercentage?: number;
  tipMode?: TipMode;
  isSimpleMode?: boolean;
  needsMenuConfirmation?: boolean;
  suggestedMenuGroups?: MenuGroup[];
  validation: {
    receiptTotal: number;
    computedTotal: number;
    difference: number;
    status: "ok" | "warning" | "error";
  };
}

// ─── User / Profile Types ──────────────────────────────────────────────────────

export interface UserProfile {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  avatarUrl?: string;
  avatarIcon?: string;
  color: string;
  provider?: "google" | "apple" | "email" | "microsoft" | "facebook";
  billCredits: number;
  referredBy?: string;
  referralCount: number;
  isPro: boolean;
  proExpiresAt?: string;
}

// ─── Session Types ─────────────────────────────────────────────────────────────

export interface ItemSelection {
  itemId: string;
  quantity: number;
  isShared: boolean;
  sharedWith?: string[];
}

export interface SessionParticipant {
  userId: string;
  profile: UserProfile;
  selections: ItemSelection[];
  totalOwed: number;
  paid: boolean;
  confirmedByCreator: boolean;
  tipContribution?: number;
  coveredByUserId?: string;
}

export interface CentAdjustment {
  amount: number;
  assignedTo: string;
  method: "creator" | "highest" | "roulette";
}

export interface PaymentReminder {
  id: string;
  recipientId: string;
  sentAt: string;
  method: "push" | "email" | "whatsapp";
  sentBy: string;
}

export interface Session {
  id: string;
  creatorId: string;
  receiptId: string;
  receipt?: ParsedReceipt;
  participants: SessionParticipant[];
  status: SessionStatus;
  createdAt: string;
  closedAt?: string;
  centAdjustment?: CentAdjustment;
  reminders?: PaymentReminder[];
  confirmedBy?: string[];
}

// ─── UI / Navigation Types ─────────────────────────────────────────────────────

export interface DemoReceipt {
  id: string;
  label: string;
  restaurant: string;
  currency: Currency;
  total: number;
  receipt: ParsedReceipt;
}

export interface AvatarOption {
  id: string;
  emoji: string;
  label: string;
}

export interface SplitResult {
  userId: string;
  amount: number;
  itemBreakdown: Array<{
    itemId: string;
    itemName: string;
    amount: number;
    itemTotal: number;
    splitCount: number;
  }>;
  globalCostsShare: number;
  tipShare: number;
}
