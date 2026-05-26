import type { AppSettings } from "../types";

const SETTINGS_KEY = "korean-class-subtitler-settings";

export const defaultSettings: AppSettings = {
  subtitleScale: 1,
  showKoreanInline: false,
  translationMode: "realtime-translate",
  textTranslationModel: "gpt-5.4-mini"
};

export async function loadSettings(): Promise<AppSettings> {
  const raw = window.localStorage.getItem(SETTINGS_KEY);
  if (!raw) {
    return defaultSettings;
  }

  try {
    const value = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...defaultSettings,
      subtitleScale: typeof value.subtitleScale === "number" ? value.subtitleScale : defaultSettings.subtitleScale,
      showKoreanInline:
        typeof value.showKoreanInline === "boolean" ? value.showKoreanInline : defaultSettings.showKoreanInline,
      translationMode: defaultSettings.translationMode,
      textTranslationModel:
        value.textTranslationModel === "gpt-5.4-mini" || value.textTranslationModel === "gpt-5.4-nano"
          ? value.textTranslationModel
          : defaultSettings.textTranslationModel
    };
  } catch {
    return defaultSettings;
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
