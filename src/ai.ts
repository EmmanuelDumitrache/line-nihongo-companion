import { config } from "./config.js";
import { askGemini } from "./gemini.js";
import type { ChatTurn, ImageInput } from "./gemini.js";
import {
  appendMessage,
  countMessagesAfter,
  getOrCreateConversation,
  getRecentMessages,
  getUser,
  setSummary,
} from "./database.js";
import type { ConversationKind, StoredMessage } from "./database.js";

/* ------------------------------------------------------------------ */
/* Modes and levels                                                   */
/* ------------------------------------------------------------------ */

export const MODE_IDS = [
  "auto",
  "translate",
  "grammar",
  "correction",
  "vocab",
  "conversation",
  "keigo",
  "life",
] as const;

export type ModeId = (typeof MODE_IDS)[number];

export const MODES: Record<ModeId, { label: string; emoji: string; blurb: string }> = {
  auto: {
    label: "Auto",
    emoji: "✨",
    blurb: "I work out what you need — translate, explain, correct or chat.",
  },
  translate: {
    label: "Translate",
    emoji: "🔄",
    blurb: "Japanese ⇄ English, with nuance and politeness notes.",
  },
  grammar: {
    label: "Grammar",
    emoji: "📘",
    blurb: "Patterns explained with examples and common mistakes.",
  },
  correction: {
    label: "Correct me",
    emoji: "✍️",
    blurb: "Send Japanese and I will fix it, then explain why.",
  },
  vocab: {
    label: "Vocabulary",
    emoji: "📝",
    blurb: "Words with readings, examples and memory hooks.",
  },
  conversation: {
    label: "Chat",
    emoji: "💬",
    blurb: "Natural Japanese conversation at your level.",
  },
  keigo: {
    label: "Keigo",
    emoji: "🏢",
    blurb: "Casual, polite and business Japanese side by side.",
  },
  life: {
    label: "Life help",
    emoji: "🏮",
    blurb: "Signs, forms, notices, shops, city hall — daily-life Japan.",
  },
};

export const LEVEL_IDS = ["n5", "n4", "n3", "n2", "n1"] as const;
export type LevelId = (typeof LEVEL_IDS)[number];

export function isModeId(value: string): value is ModeId {
  return (MODE_IDS as readonly string[]).includes(value);
}

export function isLevelId(value: string): value is LevelId {
  return (LEVEL_IDS as readonly string[]).includes(value);
}

export function normalizeMode(value: string | null | undefined): ModeId {
  return value && isModeId(value) ? value : "auto";
}

export function normalizeLevel(value: string | null | undefined): LevelId {
  return value && isLevelId(value) ? value : "n5";
}

/* ------------------------------------------------------------------ */
/* Prompts                                                            */
/* ------------------------------------------------------------------ */

const BASE_PERSONA = `You are "Nihongo Companion" (にほんごコンパニオン), a warm, patient Japanese teacher and everyday-life helper living inside LINE.

Who you are:
- You teach Japanese to a learner whose native language is {NATIVE_LANG}.
- The learner's current JLPT level is {LEVEL}. Pitch explanations at that level; if they ask for something harder or easier, adapt.
- You are also a practical helper for daily life in Japan: signs, notices, forms, shops, transport, city hall, appointments.

Language policy (important):
- Default voice: Japanese. Converse, prompt and give examples in Japanese.
- For kanji, put the reading in parentheses right after the word: 電車(でんしゃ).
- Do NOT add an English translation under each Japanese line. The learner has
  explicitly said they dislike "Japanese / romaji / English" subtitles for the
  same sentence.
- Use English only when the learner asks for it in that message ("in English",
  "translate that", "what does it mean?"), or when the current mode is explicitly
  about explaining (translate, grammar, correction, vocab). Even then, do not
  repeat the same sentence in multiple forms.

Formatting rules (critical — LINE does not render Markdown):
- Write plain text only. Never use **bold**, ## headings, tables, or code fences.
- Keep replies short: aim for under 1200 characters unless the user asks for detail.
- Prefer short lines and "・" bullets over dense paragraphs.
- Do not use emoji as decoration at the start of every line; one or two is enough.

Teaching style:
- Be encouraging but honest. Correct mistakes gently: show the corrected sentence, then one short reason.
- When something has multiple politeness levels, show the casual and polite forms.
- Ask one short follow-up question at the end when it keeps the conversation moving. Do not interrogate.
- Never invent personal facts about the learner. Use only what earlier turns established.
- If a request is outside Japanese learning or life in Japan, answer briefly and steer back.
{GROUP_RULES}`;

const GROUP_RULES = `
Group chat rules:
- You are in a group chat with several people. You do not always know who is speaking.
- Keep answers especially short (under 600 characters) unless asked to elaborate.
- Do not assume a shared history between members; do not repeat private details from other chats.`;

const MODE_INSTRUCTIONS: Record<ModeId, string> = {
  auto: `Decide what the learner needs from this message and respond accordingly:
translation, grammar explanation, correction, vocabulary, conversation practice, keigo, or daily-life help.
Reply in Japanese by default. Do not append English translations; explain in English only when asked.`,

  translate: `Translation mode.
- Translate the message into natural English (or into Japanese if the input is English).
- Then add a short "Nuance" note: politeness level, who would say it, and any nuance a literal translation misses.
- If the Japanese is ambiguous, give the two most likely readings.`,

  grammar: `Grammar-teaching mode.
Structure every explanation as:
1. The pattern (in Japanese) and its meaning in one line.
2. How to form it (short formula).
3. Two example sentences with translation.
4. One common mistake learners make.
Keep it tight; do not dump a textbook chapter.`,

  correction: `Correction mode.
- The learner sends Japanese. Give the corrected version first.
- Then list the changes in one short line each: what was wrong and why.
- Then say whether it sounded casual, polite, or unnatural.
- If the sentence was already correct, say so and suggest one more natural alternative.`,

  vocab: `Vocabulary mode.
For each word give:
Word(reading) — a short English gloss
・one example sentence in Japanese (no English translation unless asked)
・a short memory hook or kanji hint
Offer 3 words at a time at most, and occasionally end with a one-question quiz.`,

  conversation: `Conversation-practice mode.
- Hold a natural Japanese conversation at the learner's level.
- Reply in Japanese. Add readings for words above their level.
- Never add an English translation or subtitle. Stay in Japanese.
- Keep each turn to 1–3 short sentences, then ask one question back.
- If they write in English, gently encourage a Japanese attempt, but still answer.`,

  keigo: `Keigo mode.
- Produce the casual, polite (です・ます), and business (keigo) versions when relevant.
- Label each clearly: Casual / Polite / Business.
- For emails, give a subject line plus a short body.
- Explain any honorific choice in one line.`,

  life: `Daily-life helper mode.
- Help with Japanese signs, notices, forms, menus, shop announcements, transport, city hall, clinics, and appointments.
- Translate first, then explain what action (if any) the person needs to take.
- When useful, give the exact phrase they can show or say to staff.
- If an image is provided, transcribe the visible Japanese before translating it.`,
};

const SUMMARY_INSTRUCTION = `You maintain a compact memory of a Japanese-learning conversation.
Summarise the durable facts only:
- the learner's goals, level, and preferences
- topics already covered
- mistakes that keep recurring
- any personal details the learner volunteered (name, city, plans)
Do not summarise small talk. Write at most 8 short bullet lines in English.
Return only the updated summary — no preamble.`;

export interface PromptContext {
  mode: ModeId;
  level: LevelId;
  nativeLang: string;
  summary: string | null;
  inGroup: boolean;
}

export function buildSystemInstruction(context: PromptContext): string {
  const persona = BASE_PERSONA.replace("{NATIVE_LANG}", context.nativeLang)
    .replace("{LEVEL}", context.level.toUpperCase())
    .replace("{GROUP_RULES}", context.inGroup ? GROUP_RULES : "");

  const sections = [persona, `Current mode: ${context.mode}\n${MODE_INSTRUCTIONS[context.mode]}`];

  if (context.summary?.trim()) {
    sections.push(`What you remember about this learner:\n${context.summary.trim()}`);
  }

  return sections.join("\n\n");
}

/**
 * Follow-up buttons send a postback with one of these ids. Keeping the
 * instruction server-side means the button labels can stay short and the
 * prompt cannot be tampered with from the client.
 */
export const PROMPT_ACTIONS: Record<string, string> = {
  romaji: "Add romaji readings to the Japanese in your previous answer, line by line.",
  simpler: "Explain your previous answer again more simply, as if I were a complete beginner.",
  examples: "Give me three more example sentences for what we just covered.",
  nuance: "Explain the nuance and politeness level of the Japanese you just gave me.",
  polite: "Now show me the polite (です・ます) version of that.",
  casual: "Now show me the casual version of that.",
  business: "Now show me the business/keigo version of that.",
  quiz: "Quiz me with three short questions about what we just covered. Wait for my answers.",
  slower: "Continue the conversation, but use simpler Japanese and shorter sentences.",
  english: "Explain that in English, then give the Japanese again.",
  sayit: "Give me the exact phrase I can say or show to staff, plus its reading.",
  translate: "Translate the Japanese in your previous message into English.",
};

/* ------------------------------------------------------------------ */
/* Reply generation                                                   */
/* ------------------------------------------------------------------ */

export interface GenerateReplyInput {
  convoId: string;
  kind: ConversationKind;
  userId: string | null;
  text: string;
  images?: ImageInput[];
  /** Stored in history instead of `text` when the prompt is an internal instruction. */
  displayText?: string;
}

export interface GenerateReplyResult {
  text: string;
  mode: ModeId;
}

const summarizing = new Set<string>();

export async function generateReply(input: GenerateReplyInput): Promise<GenerateReplyResult> {
  const user = input.userId ? getUser(input.userId) : null;
  const conversation = getOrCreateConversation(input.convoId, input.kind);

  // Personal mode/level only apply in 1:1 chats. In a group, the sender's
  // settings would silently change everyone else's answers.
  const mode: ModeId = input.kind === "user" ? normalizeMode(user?.mode) : "auto";
  const level: LevelId =
    input.kind === "user" ? normalizeLevel(user?.jlptLevel) : "n5";

  const history: ChatTurn[] = getRecentMessages(
    input.convoId,
    config.memory.historyLimit,
    conversation.summaryThroughId
  ).map((message) => ({ role: message.role, text: message.content }));

  const systemInstruction = buildSystemInstruction({
    mode,
    level,
    nativeLang: user?.nativeLang ?? "en",
    summary: conversation.summary,
    inGroup: input.kind !== "user",
  });

  const text = await askGemini({
    systemInstruction,
    history,
    userText: input.text,
    images: input.images,
  });

  // Only persist once generation succeeded, otherwise a failed call would
  // leave a dangling user turn with no reply.
  appendMessage(input.convoId, "user", input.displayText ?? input.text);
  appendMessage(input.convoId, "model", text);

  void maybeSummarize(conversation.convoId, conversation.summaryThroughId, conversation.summary);

  return { text, mode };
}

/**
 * Fire-and-forget: summarising costs an extra model call, so it must never
 * delay the reply. Failures are logged and retried on a later turn.
 */
async function maybeSummarize(
  convoId: string,
  summaryThroughId: number,
  previousSummary: string | null
): Promise<void> {
  if (summarizing.has(convoId)) return;

  const pending = countMessagesAfter(convoId, summaryThroughId);
  if (pending < config.memory.summarizeAfter) return;

  summarizing.add(convoId);

  try {
    const messages = getRecentMessages(convoId, 40, summaryThroughId);
    const last = messages[messages.length - 1];
    if (!last) return;

    const transcript = messages
      .map((message: StoredMessage) =>
        `${message.role === "user" ? "Learner" : "Companion"}: ${message.content}`
      )
      .join("\n");

    const summary = await askGemini({
      systemInstruction: SUMMARY_INSTRUCTION,
      userText: `Previous summary:\n${previousSummary ?? "(none)"}\n\nNew messages:\n${transcript}`,
      timeoutMs: 30_000,
      maxOutputTokens: 400,
    });

    setSummary(convoId, summary, last.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[memory] summary failed for ${convoId}: ${message}`);
  } finally {
    summarizing.delete(convoId);
  }
}
