import type { Context } from "grammy";
import type { AppConfig } from "bot/app/types";
import { state } from "bot/app/state";
import { tForUser } from "bot/app/i18n";
import {
  buildProviderKeyboard,
  buildProviderModelKeyboard,
  MODEL_CALLBACK_PREFIX,
  modelsForProvider,
  providersFromModels,
  resolveDisplayedModel,
} from "./menu";

export type ModelCallbackDependencies = {
  config: AppConfig;
  listModels: () => Promise<{ defaults: Record<string, string>; models: string[] }>;
  currentModelLabel: () => string;
  persistState: () => Promise<void>;
  interruptActiveTask: (reason: string) => Promise<void>;
  editMessageTextFormattedSafe: (ctx: Context, chatId: number, messageId: number, text: string, options?: { reply_markup?: unknown }) => Promise<void>;
};

function callbackMessageRef(ctx: Context): { chatId: number; messageId: number } | null {
  const chatId = ctx.chat?.id;
  const messageId = ctx.callbackQuery?.message?.message_id;
  return chatId && messageId ? { chatId, messageId } : null;
}

export async function handleModelCallback(ctx: Context, deps: ModelCallbackDependencies): Promise<boolean> {
  const data = ctx.callbackQuery?.data || "";
  if (!data.startsWith(MODEL_CALLBACK_PREFIX)) return false;

  const { config } = deps;
  const rest = data.slice(MODEL_CALLBACK_PREFIX.length);
  const backLabel = tForUser(config, ctx.from?.id, "ui_back");

  try {
    const { defaults, models } = await deps.listModels();
    const activeModel = state.model || resolveDisplayedModel(state.model, defaults, deps.currentModelLabel());

    if (rest.startsWith("providers:")) {
      const providers = providersFromModels(models);
      if (providers.length === 1) {
        const provider = providers[0];
        if (ctx.chat && ctx.callbackQuery?.message?.message_id) {
          await deps.editMessageTextFormattedSafe(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, tForUser(config, ctx.from?.id, "choose_model_under_provider", { provider }), {
            reply_markup: buildProviderModelKeyboard(provider, models, activeModel, config.telegram.menuPageSize, backLabel, 0),
          });
        }
        await ctx.answerCallbackQuery();
        return true;
      }
      const page = Number(rest.split(":", 2)[1] || 0);
      const callbackMessage = callbackMessageRef(ctx);
      if (callbackMessage) {
        await deps.editMessageTextFormattedSafe(ctx, callbackMessage.chatId, callbackMessage.messageId, tForUser(config, ctx.from?.id, "choose_provider"), {
          reply_markup: buildProviderKeyboard(models, activeModel, config.telegram.menuPageSize, backLabel, page),
        });
      }
      await ctx.answerCallbackQuery();
      return true;
    }

    if (rest.startsWith("provider:")) {
      const [, provider, pageRaw] = rest.split(":", 3);
      const providerModels = modelsForProvider(models, provider || "");
      if (providerModels.length === 0) {
        await ctx.answerCallbackQuery({ text: tForUser(config, ctx.from?.id, "model_unavailable"), show_alert: true });
        return true;
      }
      if (ctx.chat && ctx.callbackQuery?.message?.message_id) {
        await deps.editMessageTextFormattedSafe(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, tForUser(config, ctx.from?.id, "choose_model_under_provider", { provider }), {
          reply_markup: buildProviderModelKeyboard(provider, models, activeModel, config.telegram.menuPageSize, backLabel, Number(pageRaw || 0)),
        });
      }
      await ctx.answerCallbackQuery();
      return true;
    }

    if (rest.startsWith("models:")) {
      const [, provider, pageRaw] = rest.split(":", 3);
      const callbackMessage = callbackMessageRef(ctx);
      if (callbackMessage) {
        await deps.editMessageTextFormattedSafe(ctx, callbackMessage.chatId, callbackMessage.messageId, tForUser(config, ctx.from?.id, "choose_model_under_provider", { provider }), {
          reply_markup: buildProviderModelKeyboard(provider || "", models, activeModel, config.telegram.menuPageSize, backLabel, Number(pageRaw || 0)),
        });
      }
      await ctx.answerCallbackQuery();
      return true;
    }

    if (!rest.startsWith("set:")) {
      await ctx.answerCallbackQuery();
      return true;
    }

    const model = rest.slice(4);
    if (!models.includes(model)) {
      await ctx.answerCallbackQuery({ text: tForUser(config, ctx.from?.id, "model_unavailable"), show_alert: true });
      return true;
    }

    await deps.interruptActiveTask(`model callback switch to ${model}`);
    state.model = model;
    await deps.persistState();
    await ctx.answerCallbackQuery();

    const callbackMessage = callbackMessageRef(ctx);
    if (callbackMessage) {
      const provider = model.split("/", 1)[0];
      await deps.editMessageTextFormattedSafe(ctx, callbackMessage.chatId, callbackMessage.messageId, tForUser(config, ctx.from?.id, "choose_model_under_provider", { provider }), {
        reply_markup: buildProviderModelKeyboard(provider, models, state.model || model, config.telegram.menuPageSize, backLabel, 0),
      });
    }
    return true;
  } catch (error) {
    await ctx.answerCallbackQuery({ text: error instanceof Error ? error.message : String(error), show_alert: true });
    return true;
  }
}
