import "dotenv/config";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Central configuration. Everything tunable lives here so the rest of the
 * code never reads process.env directly (DB_PATH being read in one place
 * matters for the self-test, which points it at an in-memory database).
 */
export const config = {
  line: {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "",
    channelSecret: process.env.LINE_CHANNEL_SECRET ?? "",
    /** LINE rejects text messages longer than 5000 chars; leave headroom. */
    maxTextLength: 4_500,
    /** LINE accepts at most 5 messages per reply/push call. */
    maxMessagesPerSend: 5,
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? "",
    model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
    /** Must stay well under LINE's ~60s reply-token lifetime. */
    timeoutMs: num("GEMINI_TIMEOUT_MS", 40_000),
  },
  server: {
    port: num("PORT", 3000),
  },
  dbPath: process.env.DB_PATH ?? "data/nihongo.db",
  /**
   * Japan has observed no DST since 1951, so a fixed UTC+9 offset is exact
   * for every date this bot will ever handle. Do not copy this shortcut for
   * other timezones.
   */
  jstOffsetMinutes: 9 * 60,
  memory: {
    /** How many past turns to feed back into the prompt. */
    historyLimit: num("MEMORY_HISTORY_LIMIT", 12),
    /** Summarise once this many messages have accumulated since the last summary. */
    summarizeAfter: num("MEMORY_SUMMARIZE_AFTER", 24),
    summaryMaxChars: 4_000,
  },
  limits: {
    /** Images larger than this are rejected before being sent to Gemini. */
    maxImageBytes: 8 * 1024 * 1024,
    /** Failed reminder deliveries before we stop retrying. */
    maxReminderAttempts: 3,
  },
} as const;

export function assertLineCredentials(): void {
  if (!config.line.channelAccessToken || !config.line.channelSecret) {
    console.warn(
      "⚠️ LINE credentials missing. Set LINE_CHANNEL_ACCESS_TOKEN and LINE_CHANNEL_SECRET in .env"
    );
  }
}
