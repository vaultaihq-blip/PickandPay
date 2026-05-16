export interface CreditPack {
  id: string;
  credits: number;
  price: number;
  currency: string;
  label: string;
  highlight?: string;
}

export const CREDIT_PACKS: CreditPack[] = [
  {
    id: "pack_1",
    credits: 1,
    price: 0.99,
    currency: "USD",
    label: "Starter",
    highlight: undefined,
  },
  {
    id: "pack_5",
    credits: 5,
    price: 3.99,
    currency: "USD",
    label: "Value",
    highlight: "Most Popular",
  },
  {
    id: "pack_15",
    credits: 15,
    price: 9.99,
    currency: "USD",
    label: "Pro",
    highlight: "Best Value",
  },
];

export const FREE_CREDITS_ON_SIGNUP = 3;
export const FREE_CREDITS_PER_REFERRAL = 1;
