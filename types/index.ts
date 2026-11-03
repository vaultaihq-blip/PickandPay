import type { CurrencyCode } from "@/lib/receipt/money";

// ─── Core Enums / Unions ──────────────────────────────────────────────────────

// The receipt's own currency (ISO 4217), any the app knows — never narrowed
// to a few and replaced by EUR (currency point, 02-11-2026).
export type Currency = CurrencyCode;

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
  /** R10 — the line's place on the photo, [x0, y0, x1, y1] in 0–1 (from the parser). */
  photoBox?: readonly [number, number, number, number];
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
  /** R2 — "proportional" splits by what each person picked (the charge or
   *  discount with no line of its own); absent means equal, as before. */
  split?: "equal" | "proportional";
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
  // The parser gave no currency the app knows: the review asks the host, and
  // the receipt is not accepted until it is answered. Cleared on answer.
  currencyAssumed?: boolean;
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
  // R4b — in a session, the right half of a two-colour circle (color is the left).
  color2?: string;
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
  /** R12 — set by the server: for each unit held, how many people hold it. */
  unitSplits?: number[];
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
  /** session_participants.created_at — R4 list order (set by the session store). */
  joinedAt?: string;
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
  // Who is host now (sessions.host_id) — R6 can move it after finalize.
  creatorId: string;
  // Who created the session (sessions.original_host_id): keeps green (R4).
  originalHostId?: string;
  receiptId: string;
  receipt?: ParsedReceipt;
  participants: SessionParticipant[];
  status: SessionStatus;
  createdAt: string;
  closedAt?: string;
  centAdjustment?: CentAdjustment;
  // Frozen by the server (finalize_session) when the split moves to
  // awaiting_payment: exactly the people the bill is divided between (R1).
  splitUserIds?: string[];
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
    /** People sharing the same units ("÷N"); 1 when not shared. */
    splitCount: number;
    /** Units this person picked of a multi-unit item, when not shared ("2 × 1.100,00"). */
    units?: number;
    unitPrice?: number;
    /** R12 — the others holding the same units ("partilhado com <nome>"). */
    sharedWith?: string[];
  }>;
  globalCostsShare: number;
  /** R2 — this person's part of each charge, by name (a discount is negative). */
  costBreakdown?: Array<{ costId: string; name: string; amount: number }>;
  tipShare: number;
}
