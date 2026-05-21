import { resolveUser } from "bot/operations/context/store";
import { state } from "./state";
import type { AppConfig } from "./types";

export type Locale = "zh-CN" | "en";

type Dictionary = {
  localeTag: string;
  strings: Record<string, string>;
};

const dictionaries: Record<Locale, Dictionary> = {
  "zh-CN": {
    localeTag: "zh-CN",
    strings: {
      choose_model: "请选择模型：",
      choose_provider: "请选择模型供应商：",
      choose_model_under_provider: "请选择 {provider} 的模型：",
      model_unavailable: "模型已不可用",
      ui_back: "返回",
      new_session: "已创建新会话：{sessionId}",
      command_new: "新建会话",
      command_model: "查看或切换模型",
      command_help: "查看帮助",
    },
  },
  en: {
    localeTag: "en-US",
    strings: {
      choose_model: "Choose a model:",
      choose_provider: "Choose a model provider:",
      choose_model_under_provider: "Choose a model from {provider}:",
      model_unavailable: "Model is unavailable",
      ui_back: "Back",
      new_session: "Created a new session: {sessionId}",
      command_new: "Create a new session",
      command_model: "View or switch model",
      command_help: "Get help",
    },
  },
};

export function formatTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => String(values[key] ?? `{${key}}`));
}

export function getDictionary(config: AppConfig): Dictionary {
  return dictionaries[config.bot.language];
}

export function t(config: AppConfig, key: string, values: Record<string, string | number> = {}): string {
  const dict = getDictionary(config);
  return formatTemplate(dict.strings[key] || key, values);
}

export function tForLocale(locale: Locale, key: string, values: Record<string, string | number> = {}): string {
  const dict = dictionaries[locale];
  return formatTemplate(dict.strings[key] || key, values);
}

export function localeFromTelegramLanguageCode(languageCode: string | undefined, fallback: Locale): Locale {
  const normalized = languageCode?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "zh" || normalized.startsWith("zh-") || normalized.startsWith("zh_")) return "zh-CN";
  return "en";
}

export function userLocale(config: AppConfig, userId: number | undefined): Locale {
  if (!userId) return config.bot.language;
  const key = String(userId);
  const canonicalLanguageCode = resolveUser(config.paths.repoRoot, userId)?.languageCode;
  const runtimeLanguageCode = state.telegramUserCache[key]?.languageCode;
  return localeFromTelegramLanguageCode(canonicalLanguageCode || runtimeLanguageCode, config.bot.language);
}

export function tForUser(config: AppConfig, userId: number | undefined, key: string, values: Record<string, string | number> = {}): string {
  return tForLocale(userLocale(config, userId), key, values);
}

export function uiLocaleTag(config: AppConfig): string {
  return getDictionary(config).localeTag;
}
