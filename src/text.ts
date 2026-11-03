import type { webhook } from "@line/bot-sdk";
import { config } from "./config.js";

/**
 * Splits a reply into LINE-sized text messages.
 * LINE limits: 5000 chars per text message, 5 messages per send call.
 */
export function splitText(text: string, max = config.line.maxTextLength): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];

  const chunks: string[] = [];
  let rest = clean;

  while (rest.length > 0 && chunks.length < config.line.maxMessagesPerSend) {
    if (rest.length <= max) {
      chunks.push(rest);
      break;
    }

    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.6) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.6) cut = max;

    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }

  if (rest.length > 0) {
    const lastIndex = chunks.length - 1;
    const note = "\n…(message truncated — ask me to continue)";
    chunks[lastIndex] = chunks[lastIndex].slice(0, max - note.length) + note;
  }

  return chunks;
}

/**
 * Removes "@bot" from the text. LINE gives UTF-16 indices, which match JS
 * string slicing exactly. Apply right-to-left so earlier indices stay valid.
 */
export function stripMentions(text: string, mention: webhook.Mention | undefined): string {
  if (!mention?.mentionees?.length) return text.trim();

  let result = text;
  const ranges = mention.mentionees
    .filter((m) => Number.isInteger(m.index) && Number.isInteger(m.length))
    .map((m) => ({ start: m.index, end: m.index + m.length }))
    .sort((a, b) => b.start - a.start);

  for (const range of ranges) {
    if (range.start < 0 || range.end > result.length) continue;
    result = result.slice(0, range.start) + result.slice(range.end);
  }

  return result.replace(/\s{2,}/g, " ").trim();
}

export function isBotMentioned(mention: webhook.Mention | undefined): boolean {
  if (!mention?.mentionees) return false;
  return mention.mentionees.some((m) => m.type === "user" && m.isSelf === true);
}
