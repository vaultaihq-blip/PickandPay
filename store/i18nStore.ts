import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { translations, Language, TranslationKey } from "@/constants/translations";
import { setMoneyLanguage } from "@/utils/formatter";

const LANG_KEY = "app_language";

interface I18nState {
  language: Language;
  setLanguage: (lang: Language) => Promise<void>;
  t: (key: TranslationKey) => string;
  loadLanguage: () => Promise<void>;
}

export const useI18nStore = create<I18nState>((set, get) => ({
  language: "en",

  t: (key: TranslationKey) => {
    const lang = get().language;
    return translations[lang][key] ?? translations.en[key] ?? key;
  },

  setLanguage: async (lang: Language) => {
    setMoneyLanguage(lang); // amounts: "6.700,00 ₺" in pt, "₺6,700.00" in en
    set({ language: lang });
    await AsyncStorage.setItem(LANG_KEY, lang);
  },

  loadLanguage: async () => {
    const stored = await AsyncStorage.getItem(LANG_KEY);
    if (stored && stored in translations) {
      setMoneyLanguage(stored);
      set({ language: stored as Language });
    }
  },
}));
