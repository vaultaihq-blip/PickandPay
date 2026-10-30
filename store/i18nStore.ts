import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { translations, Language, TranslationKey } from "@/constants/translations";

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
    set({ language: lang });
    await AsyncStorage.setItem(LANG_KEY, lang);
  },

  loadLanguage: async () => {
    const stored = await AsyncStorage.getItem(LANG_KEY);
    if (stored && stored in translations) {
      set({ language: stored as Language });
    }
  },
}));
