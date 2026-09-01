import { useI18nStore } from "@/store/i18nStore";
import { TranslationKey } from "@/constants/translations";

export function useT() {
  const { t, language, setLanguage } = useI18nStore();
  return { t, language, setLanguage };
}
