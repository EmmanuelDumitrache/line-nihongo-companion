import { LineBotClient, middleware } from "@line/bot-sdk";
import type { messagingApi, webhook } from "@line/bot-sdk";
import type { Request, Response } from "express";
import { assertLineCredentials, config } from "./config.js";
import { generateReply } from "./ai.js";
import type { ImageInput } from "./gemini.js";
import {
  GROUP_INTRODUCTION,
  executeTextCommand,
  followUpQuickReply,
  handlePostback,
  levelPickerQuickReply,
  mainMenuQuickReply,
} from "./commands.js";
import type { CommandContext, PostbackOutcome } from "./commands.js";
import {
  clearConversation,
  getUser,
  markUserUnfollowed,
  registerWebhookEvent,
  upsertUser,
} from "./database.js";
import type { ConversationKind } from "./database.js";
import { isBotMentioned, splitText, stripMentions } from "./text.js";

assertLineCredentials();

/* ------------------------------------------------------------------ */
/* LINE client + middleware                                           */
/* ------------------------------------------------------------------ */

export const lineClient = LineBotClient.fromChannelAccessToken({
  channelAccessToken: config.line.channelAccessToken,
});

export const lineMiddleware = middleware({ channelSecret: config.line.channelSecret });

/* ------------------------------------------------------------------ */
/* Origin resolution                                                  */
/* ------------------------------------------------------------------ */

interface Origin {
  convoId: string;
  kind: ConversationKind;
  userId: string | null;
  /** Where push messages go: userId, groupId or roomId. */
  targetId: string;
  /** Set to null once consumed — reply tokens are single-use. */
  replyToken: string | null;
}

function getReplyToken(event: webhook.Event): string | null {
  if ("replyToken" in event && typeof event.replyToken === "string") {
    return event.replyToken;
  }
  return null;
}

function resolveOrigin(event: webhook.Event): Origin | null {
  const source = event.source;
  if (!source) return null;

  const replyToken = getReplyToken(event);

  switch (source.type) {
    case "user":
      if (!source.userId) return null;
      return {
        convoId: source.userId,
        kind: "user",
        userId: source.userId,
        targetId: source.userId,
        replyToken,
      };
    case "group":
      return {
        convoId: source.groupId,
        kind: "group",
        userId: source.userId ?? null,
        targetId: source.groupId,
        replyToken,
      };
    case "room":
      return {
        convoId: source.roomId,
        kind: "room",
        userId: source.userId ?? null,
        targetId: source.roomId,
        replyToken,
      };
    default:
      return null;
  }
}

function commandContext(origin: Origin): CommandContext {
  return {
    userId: origin.userId,
    convoId: origin.convoId,
    kind: origin.kind,
    targetId: origin.targetId,
  };
}

/* ------------------------------------------------------------------ */
/* Webhook entry point                                                */
/* ------------------------------------------------------------------ */

/**
 * Always 200 immediately: LINE retries any delivery that is slow or non-2xx,
 * and a Gemini call can take tens of seconds. Processing happens after the
 * response; the per-event try/catch keeps one failure from killing the batch.
 */
export function handleWebhook(req: Request, res: Response): void {
  const { events = [] } = req.body as webhook.CallbackRequest;

  res.status(200).json({ ok: true });

  for (const event of events) {
    void processEvent(event).catch((error) => {
      console.error("[webhook] event failed:", describeError(error));
    });
  }
}

async function processEvent(event: webhook.Event): Promise<void> {
  const eventId = (event as { webhookEventId?: string }).webhookEventId;
  if (eventId && !registerWebhookEvent(eventId)) {
    console.log(`[webhook] duplicate delivery ignored: ${eventId}`);
    return;
  }

  switch (event.type) {
    case "message":
      await handleMessageEvent(event);
      return;
    case "postback":
      await handlePostbackEvent(event);
      return;
    case "follow":
      await handleFollowEvent(event);
      return;
    case "unfollow": {
      const origin = resolveOrigin(event);
      if (origin?.userId) markUserUnfollowed(origin.userId);
      return;
    }
    case "join":
      await handleJoinEvent(event);
      return;
    case "leave":
      await handleLeaveEvent(event);
      return;
    default:
      return;
  }
}

/* ------------------------------------------------------------------ */
/* Message events                                                     */
/* ------------------------------------------------------------------ */

async function handleMessageEvent(event: webhook.MessageEvent): Promise<void> {
  const origin = resolveOrigin(event);
  if (!origin) return;

  if (event.message.type === "text") {
    await handleTextMessage(event, origin);
    return;
  }

  if (event.message.type === "image") {
    await handleImageMessage(event, origin);
    return;
  }

  // Stickers, files, audio and video are ignored on purpose.
}

async function handleTextMessage(
  event: webhook.MessageEvent,
  origin: Origin
): Promise<void> {
  const message = event.message;
  if (message.type !== "text") return;

  const mentioned = isBotMentioned(message.mention);
  const text = stripMentions(message.text, message.mention);

  // In groups and multi-person chats, stay quiet unless addressed. This is
  // the difference between a helpful bot and an unbearable one.
  if (origin.kind !== "user" && !mentioned && !text.startsWith("/")) {
    return;
  }

  await ensureUser(origin);

  if (!text) {
    await sendText(
      origin,
      "I saw the mention but no message. Ask me anything about Japanese 🙂",
      mainMenuQuickReply()
    );
    return;
  }

  const context = commandContext(origin);

  try {
    const command = executeTextCommand(text, context);
    if (command.handled) {
      await send(origin, command.messages);
      return;
    }
  } catch (error) {
    console.error("[commands] failed:", describeError(error));
  }

  await respondWithAi(origin, { text });
}

async function handleImageMessage(
  event: webhook.MessageEvent,
  origin: Origin
): Promise<void> {
  // Images carry no mention metadata, so in groups we cannot tell whether the
  // bot was addressed. Stay quiet rather than replying to every photo.
  if (origin.kind !== "user") return;

  await ensureUser(origin);

  void showLoading(origin);

  try {
    const image = await downloadImage(event.message.id);
    await respondWithAi(
      origin,
      {
        text: "The user sent a photo with no caption. Read any Japanese text in it, translate it, and explain what it means and what action (if any) the user should take. If there is no Japanese text, describe what is relevant for daily life in Japan.",
        displayText: "[Photo]",
        images: [image],
      }
    );
  } catch (error) {
    console.error("[image] failed:", describeError(error));
    await sendText(
      origin,
      "ごめんね、その画像を読めませんでした。\nSorry — I could not read that image. Try a clearer photo, or send it again.",
      mainMenuQuickReply()
    );
  }
}

/* ------------------------------------------------------------------ */
/* Postback / lifecycle events                                        */
/* ------------------------------------------------------------------ */

async function handlePostbackEvent(event: webhook.PostbackEvent): Promise<void> {
  const origin = resolveOrigin(event);
  if (!origin) return;

  await ensureUser(origin);

  const outcome: PostbackOutcome = handlePostback(event.postback.data, commandContext(origin));

  if (outcome.kind === "reply") {
    await send(origin, outcome.messages);
    return;
  }

  if (outcome.kind === "prompt") {
    void showLoading(origin);
    await respondWithAi(origin, {
      text: outcome.prompt,
      displayText: outcome.displayText,
    });
  }
}

async function handleFollowEvent(event: webhook.FollowEvent): Promise<void> {
  const origin = resolveOrigin(event);
  if (!origin) return;

  await ensureUser(origin);

  await send(origin, [
    {
      type: "text",
      text: `ようこそ！Nihongo Companion です 🇯🇵\n\nI can help you with Japanese every day:\n・translate and explain nuance\n・correct your sentences\n・teach grammar and vocabulary\n・practise conversation\n・read signs, menus and forms from photos\n\nFirst, what is your Japanese level?`,
      quickReply: levelPickerQuickReply(),
    },
    {
      type: "text",
      text: "You can change mode any time with the buttons below, or type /help.",
      quickReply: mainMenuQuickReply(),
    },
  ]);
}

async function handleJoinEvent(event: webhook.JoinEvent): Promise<void> {
  const origin = resolveOrigin(event);
  if (!origin) return;

  // The bot was added to a group; the group intro is the only message it
  // sends unprompted.
  await sendText(origin, GROUP_INTRODUCTION);
}

async function handleLeaveEvent(event: webhook.LeaveEvent): Promise<void> {
  const origin = resolveOrigin(event);
  if (!origin) return;

  console.log(`[group] left ${origin.kind} ${origin.convoId}; clearing stored messages`);
  // Privacy default: do not keep group history after the bot is removed.
  clearConversation(origin.convoId);
}

/* ------------------------------------------------------------------ */
/* AI + sending                                                       */
/* ------------------------------------------------------------------ */

async function respondWithAi(
  origin: Origin,
  input: { text: string; displayText?: string; images?: ImageInput[] }
): Promise<void> {
  void showLoading(origin);

  try {
    const result = await generateReply({
      convoId: origin.convoId,
      kind: origin.kind,
      userId: origin.userId,
      text: input.text,
      displayText: input.displayText,
      images: input.images,
    });

    await sendText(origin, result.text, followUpQuickReply(result.mode));
  } catch (error) {
    console.error("[ai] generation failed:", describeError(error));
    await sendText(
      origin,
      "ごめんね、いま答えを作れませんでした。\nSorry — I could not answer that one. Please try again in a moment.",
      mainMenuQuickReply()
    );
  }
}

/**
 * LINE has no message editing and no token streaming. The best available
 * "working on it" signal is the official loading animation, which exists for
 * 1-on-1 chats only.
 */
async function showLoading(origin: Origin, seconds = 60): Promise<void> {
  if (origin.kind !== "user" || !origin.userId) return;
  try {
    await lineClient.showLoadingAnimation({
      chatId: origin.userId,
      loadingSeconds: seconds,
    });
  } catch {
    // Not fatal: unsupported region/chat types simply skip the animation.
  }
}

async function sendText(
  origin: Origin,
  text: string,
  quickReply?: messagingApi.QuickReply
): Promise<void> {
  const chunks = splitText(text);
  if (chunks.length === 0) return;

  const messages: messagingApi.Message[] = chunks.map((chunk, index) => {
    const isLast = index === chunks.length - 1;
    if (isLast && quickReply) {
      return { type: "text", text: chunk, quickReply };
    }
    return { type: "text", text: chunk };
  });

  await send(origin, messages);
}

async function send(origin: Origin, messages: messagingApi.Message[]): Promise<void> {
  if (messages.length === 0) return;
  const capped = messages.slice(0, config.line.maxMessagesPerSend);

  if (origin.replyToken) {
    const token = origin.replyToken;
    // Single use: never retry with the same token, even if the call fails.
    origin.replyToken = null;

    try {
      await lineClient.replyMessage({ replyToken: token, messages: capped });
      return;
    } catch (error) {
      console.warn(`[line] reply failed, falling back to push: ${describeError(error)}`);
    }
  }

  try {
    await lineClient.pushMessage({ to: origin.targetId, messages: capped });
  } catch (error) {
    console.error(`[line] push failed: ${describeError(error)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Users, mentions, images                                            */
/* ------------------------------------------------------------------ */

async function ensureUser(origin: Origin): Promise<void> {
  if (!origin.userId) return;

  const existing = getUser(origin.userId);
  if (existing) {
    upsertUser(origin.userId);
    return;
  }

  let displayName: string | null = null;
  if (origin.kind === "user") {
    try {
      const profile = await lineClient.getProfile(origin.userId);
      displayName = profile.displayName ?? null;
    } catch {
      // Profile lookup fails for non-friends; not fatal.
    }
  }

  upsertUser(origin.userId, displayName);
}

async function downloadImage(messageId: string): Promise<ImageInput> {
  const stream = await lineClient.getMessageContent(messageId);

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > config.limits.maxImageBytes) {
      throw new Error(
        `Image exceeds ${config.limits.maxImageBytes} bytes (message ${messageId})`
      );
    }
    chunks.push(buffer);
  }

  const data = Buffer.concat(chunks);
  if (data.length === 0) throw new Error("Empty image payload");

  return { mimeType: sniffImageMime(data), data };
}

function sniffImageMime(buffer: Buffer): string {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e) {
    return "image/png";
  }
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return "image/jpeg";
  }
  if (
    buffer.length > 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  throw new Error("Unsupported image format (expected JPEG, PNG or WebP)");
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
