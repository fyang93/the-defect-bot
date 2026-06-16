import { logger } from "bot/app/logger";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTransientTelegramNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Network request .* failed|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|TLS|timeout/i.test(message);
}

export async function sendTelegramWithRetry<T>(
  operation: () => Promise<T>,
  label: string,
  options?: { attempts?: number; delaysMs?: number[] },
): Promise<T> {
  const attempts = Math.max(1, options?.attempts ?? 3);
  const delaysMs = options?.delaysMs ?? [300, 1000];
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientTelegramNetworkError(error) || attempt >= attempts) break;
      const delay = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 300;
      await logger.warn(`telegram ${label} transient failure attempt=${attempt}/${attempts}; retrying in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(delay);
    }
  }
  throw lastError;
}
