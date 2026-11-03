import { GoogleGenAI } from "@google/genai";
import type { Content, Part } from "@google/genai";
import { config } from "./config.js";

export interface ChatTurn {
  role: "user" | "model";
  text: string;
}

export interface ImageInput {
  mimeType: string;
  data: Buffer;
}

export interface AskGeminiOptions {
  systemInstruction: string;
  history?: ChatTurn[];
  userText: string;
  images?: ImageInput[];
  timeoutMs?: number;
  maxOutputTokens?: number;
}

let client: GoogleGenAI | null = null;

/** Lazy so importing this module never throws when no key is configured. */
function getClient(): GoogleGenAI {
  if (!config.gemini.apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  client ??= new GoogleGenAI({ apiKey: config.gemini.apiKey });
  return client;
}

const RETRYABLE_ERROR =
  /UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded|\b(429|503)\b/i;

/**
 * Retry only capacity/rate-limit failures. Timeouts are excluded on purpose:
 * retrying them would consume the LINE reply-token window twice.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof Error && /timed out/i.test(error.message)) return false;
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 429 || status === 503) return true;
  const message = error instanceof Error ? error.message : String(error);
  return RETRYABLE_ERROR.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One Gemini round-trip. The caller must supply the persona/mode instructions:
 * this module deliberately knows nothing about Japanese teaching.
 *
 * The AbortController matters: a hung request would otherwise outlive LINE's
 * ~60s reply-token window and turn into a guaranteed failed reply. Transient
 * 503/429 responses are retried inside the same total budget.
 */
export async function askGemini(options: AskGeminiOptions): Promise<string> {
  const {
    systemInstruction,
    history = [],
    userText,
    images = [],
    timeoutMs = config.gemini.timeoutMs,
    maxOutputTokens = 2_048,
  } = options;

  const contents: Content[] = history.map((turn) => ({
    role: turn.role,
    parts: [{ text: turn.text }],
  }));

  const parts: Part[] = [];
  if (userText.trim()) {
    parts.push({ text: userText });
  }
  for (const image of images) {
    parts.push({
      inlineData: {
        mimeType: image.mimeType,
        data: image.data.toString("base64"),
      },
    });
  }

  if (parts.length === 0) {
    throw new Error("askGemini called with no text and no images");
  }
  contents.push({ role: "user", parts });

  const startedAt = Date.now();
  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
    const timer = setTimeout(() => controller.abort(), remaining);

    try {
      const response = await getClient().models.generateContent({
        model: config.gemini.model,
        contents,
        config: {
          systemInstruction,
          abortSignal: controller.signal,
          temperature: 0.7,
          maxOutputTokens,
        },
      });

      const text = response.text?.trim();
      if (!text) throw new Error("Gemini returned an empty response");
      return text;
    } catch (error) {
      lastError = controller.signal.aborted
        ? new Error(`Gemini request timed out after ${timeoutMs}ms`)
        : error;

      if (attempt >= maxAttempts || !isRetryable(lastError)) throw lastError;

      // 503 spikes usually clear in seconds. Stay inside the configured budget
      // so the LINE reply token does not expire while we wait.
      const backoffMs = 600 * attempt;
      if (Date.now() - startedAt + backoffMs >= timeoutMs) throw lastError;

      console.warn(
        `[gemini] attempt ${attempt} failed (${describe(lastError)}); retrying in ${backoffMs}ms`
      );
      await delay(backoffMs);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}
