import { AvatarOption } from "@/types";

export const AVATAR_OPTIONS: AvatarOption[] = [
  { id: "pizza", emoji: "🍕", label: "Pizza" },
  { id: "burger", emoji: "🍔", label: "Burger" },
  { id: "noodles", emoji: "🍜", label: "Noodles" },
  { id: "sushi", emoji: "🍣", label: "Sushi" },
  { id: "salad", emoji: "🥗", label: "Salad" },
  { id: "party", emoji: "🎉", label: "Party" },
  { id: "star", emoji: "⭐", label: "Star" },
  { id: "sparkle", emoji: "🌟", label: "Sparkle" },
  { id: "fox", emoji: "🦊", label: "Fox" },
  { id: "panda", emoji: "🐼", label: "Panda" },
  { id: "guitar", emoji: "🎸", label: "Guitar" },
  { id: "rocket", emoji: "🚀", label: "Rocket" },
];

export function getAvatarById(id: string): AvatarOption | undefined {
  return AVATAR_OPTIONS.find((a) => a.id === id);
}

export function getAvatarEmoji(id: string): string {
  return getAvatarById(id)?.emoji ?? "👤";
}
