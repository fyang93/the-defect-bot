import type { AppConfig } from "bot/app/types";
import type { RequestAccessRole } from "bot/ai/prompt";
import type { PendingAuthorizationDraft } from "bot/ai/types";
import { persistState, rememberPendingAuthorization, consumePendingAllowedAuthorization, pruneExpiredPendingAuthorizations, reloadPendingAuthorizations } from "bot/app/state";
import { hasAccessLevel } from "bot/operations/access/control";
import { setStoredUserAccessLevel } from "bot/operations/access/roles";

export const PENDING_AUTH_ADMIN_ONLY_FACT = "Temporary authorization is admin-only.";

export async function storePendingAuthorizations(
  config: AppConfig,
  pendingAuthorizations: PendingAuthorizationDraft[],
  requesterUserId: number | undefined,
  accessRole: RequestAccessRole,
): Promise<{ created: string[]; clarifications: string[] }> {
  const created: string[] = [];
  const clarifications: string[] = [];
  if (pendingAuthorizations.length === 0) return { created, clarifications };
  if (!requesterUserId || !hasAccessLevel(accessRole, "admin")) {
    clarifications.push(PENDING_AUTH_ADMIN_ONLY_FACT);
    return { created, clarifications };
  }

  let changed = false;
  const createdAt = new Date().toISOString();
  for (const item of pendingAuthorizations) {
    const username = item.username.trim().replace(/^@+/, "").toLowerCase();
    const expiresAt = item.expiresAt.trim();
    const parsed = Date.parse(expiresAt);
    if (!username || !Number.isFinite(parsed) || parsed <= Date.now()) continue;
    const normalizedExpiresAt = new Date(parsed).toISOString();
    rememberPendingAuthorization({
      kind: "allowed",
      username,
      createdBy: requesterUserId,
      createdAt,
      expiresAt: normalizedExpiresAt,
    });
    changed = true;
    created.push(`已记录临时授权：@${username}，截止 ${normalizedExpiresAt}；对方需在此之前私聊 bot、在群里 @bot，或在群里回复 bot 的消息，系统才会自动授予 allowed 权限。`);
  }
  if (changed) await persistState(config.paths.stateFile);
  return { created, clarifications };
}

export async function grantPendingAllowedAccessIfMatched(config: AppConfig, user: { id?: number; username?: string } | null | undefined): Promise<{ granted: boolean; username?: string; changed?: boolean }> {
  const userId = typeof user?.id === "number" ? user.id : undefined;
  if (!userId) return { granted: false };
  await reloadPendingAuthorizations(config.paths.stateFile);
  const granted = consumePendingAllowedAuthorization(user?.username);
  if (!granted) return { granted: false };
  const changed = await setStoredUserAccessLevel(config, userId, "allowed", {
    username: user?.username,
    updatedBy: granted.createdBy,
  });
  await persistState(config.paths.stateFile);
  return { granted: true, username: granted.username, changed };
}

export async function pruneExpiredPendingAuthorizationsFromState(config: AppConfig): Promise<number> {
  const removed = pruneExpiredPendingAuthorizations();
  if (removed > 0) await persistState(config.paths.stateFile);
  return removed;
}
