export interface CreditPack {
  id: string;
  credits: number; // -1 = unlimited
  price: number;
  currency: string;
  label: string;
  highlight?: string;
  icon?: string;
  idealFor?: string;
  isSubscription?: boolean;
  comingSoon?: boolean;
}

export const CREDIT_PACKS: CreditPack[] = [
  {
    id: "pack_value",
    credits: 15,
    price: 4.99,
    currency: "EUR",
    label: "Value Pack",
    highlight: "Most Popular",
    icon: "⭐",
    idealFor: "Regular users",
  },
  {
    id: "pack_pro",
    credits: 50,
    price: 9.99,
    currency: "EUR",
    label: "Pro Pack",
    highlight: "Best Value",
    icon: "💎",
    idealFor: "Power users",
  },
  {
    id: "pack_unlimited",
    credits: -1,
    price: 4.99,
    currency: "EUR",
    label: "Plus Monthly",
    icon: "♾️",
    idealFor: "Heavy users — 30 scans/month",
    isSubscription: true,
    comingSoon: true,
  },
];

export const FREE_CREDITS_ON_SIGNUP = 1;
export const FREE_CREDITS_PER_REFERRAL = 1;
