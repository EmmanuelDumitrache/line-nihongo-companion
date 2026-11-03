import type { messagingApi } from "@line/bot-sdk";
import {
  LEVEL_IDS,
  MODES,
  MODE_IDS,
  PROMPT_ACTIONS,
  isLevelId,
  isModeId,
  normalizeMode,
} from "./ai.js";
import type { ModeId } from "./ai.js";
import {
  addReminder,
  clearConversation,
  countMessages,
  deleteReminder,
  getOrCreateConversation,
  getUser,
  listPendingReminders,
  updateUser,
} from "./database.js";
import type { ConversationKind } from "./database.js";
import { formatJst, parseReminderRequest } from "./reminders.js";

/* ------------------------------------------------------------------ */
/* Context and outcome types                                          */
/* ------------------------------------------------------------------ */

export interface CommandContext {
  userId: string | null;
  convoId: string;
  kind: ConversationKind;
  /** userId, groupId or roomId — where a push notification would go. */
  targetId: string;
}

export type CommandOutcome =
  | { handled: false }
  | { handled: true; messages: messagingApi.Message[] };

export type PostbackOutcome =
  | { kind: "reply"; messages: messagingApi.Message[] }
  | { kind: "prompt"; prompt: string; displayText: string }
  | { kind: "ignored" };

/* ------------------------------------------------------------------ */
/* Small message builders                                             */
/* ------------------------------------------------------------------ */

function postbackAction(label: string, data: string): messagingApi.Action {
  return { type: "postback", label, data };
}

export function quickReplyItem(label: string, data: string): messagingApi.QuickReplyItem {
  // LINE limits: label ≤ 20 chars, postback data ≤ 300 chars.
  return { type: "action", action: postbackAction(label, data) };
}

function textMessage(text: string, quickReply?: messagingApi.QuickReply): messagingApi.Message {
  return quickReply ? { type: "text", text, quickReply } : { type: "text", text };
}

function modeQuickReply(): messagingApi.QuickReply {
  return { items: MODE_IDS.map((id) => quickReplyItem(MODES[id].label, `action=mode&value=${id}`)) };
}

export function levelPickerQuickReply(): messagingApi.QuickReply {
  return {
    items: LEVEL_IDS.map((id) =>
      quickReplyItem(`JLPT ${id.toUpperCase()}`, `action=level&value=${id}`)
    ),
  };
}

export function mainMenuQuickReply(): messagingApi.QuickReply {
  return {
    items: [
      quickReplyItem("Translate", "action=mode&value=translate"),
      quickReplyItem("Grammar", "action=mode&value=grammar"),
      quickReplyItem("Chat", "action=mode&value=conversation"),
      quickReplyItem("Vocabulary", "action=mode&value=vocab"),
      quickReplyItem("More", "action=help"),
    ],
  };
}

const FOLLOW_UPS: Record<ModeId, Array<[label: string, id: string]>> = {
  auto: [
    ["Romaji", "romaji"],
    ["Examples", "examples"],
    ["Simpler", "simpler"],
  ],
  translate: [
    ["Romaji", "romaji"],
    ["Nuance", "nuance"],
    ["My reply?", "sayit"],
  ],
  grammar: [
    ["Examples", "examples"],
    ["Quiz me", "quiz"],
    ["Simpler", "simpler"],
  ],
  correction: [
    ["Why?", "nuance"],
    ["More natural", "casual"],
    ["Polite ver.", "polite"],
  ],
  vocab: [
    ["Examples", "examples"],
    ["Quiz me", "quiz"],
    ["More words", "simpler"],
  ],
  conversation: [
    ["Romaji", "romaji"],
    ["Slower", "slower"],
    ["English", "english"],
  ],
  keigo: [
    ["Casual ver.", "casual"],
    ["Polite ver.", "polite"],
    ["Email", "business"],
  ],
  life: [
    ["Say it for me", "sayit"],
    ["Romaji", "romaji"],
    ["Simpler", "simpler"],
  ],
};

export function followUpQuickReply(mode: ModeId): messagingApi.QuickReply {
  const items = FOLLOW_UPS[mode].map(([label, id]) =>
    quickReplyItem(label, `action=prompt&value=${id}`)
  );
  // Always leave a path back to the main menu.
  items.push(quickReplyItem("Menu", "action=help"));
  return { items };
}

/* ------------------------------------------------------------------ */
/* Static text                                                        */
/* ------------------------------------------------------------------ */

const HELP_TEXT = `にほんごコンパニオン — Japanese study + daily life helper

What I can do:
・Translate Japanese ⇄ English, with nuance
・Explain grammar with examples
・Correct your Japanese and explain why
・Teach vocabulary and quiz you
・Practise natural conversation
・Draft casual / polite / business Japanese
・Read signs, notices and forms from photos

Buttons below switch modes. You can also type:
/mode grammar — change mode
/level n4 — set your JLPT level
/progress — see what we have covered
/clear — forget this conversation
/reminders — see your reminders
/delete 2 — cancel reminder 2
/id — show my LINE ID

Reminders: type "remind me in 30 minutes to..." or "明日の8時に...リマインドして".
Photos: send a picture of a sign, menu or form.`;

const GROUP_INTRO = `はじめまして！Nihongo Companion です。

I can help this group with Japanese:
・@mention me to translate, explain or correct Japanese
・Send a photo of a sign or menu (in 1-on-1 chat) and I will read it
・Type /help to see commands

I only reply when mentioned here, so I will not interrupt your conversation.`;

/* ------------------------------------------------------------------ */
/* Postbacks                                                          */
/* ------------------------------------------------------------------ */

export function parsePostback(data: string): { action: string; params: URLSearchParams } {
  const params = new URLSearchParams(data);
  return { action: params.get("action") ?? "", params };
}

export function handlePostback(data: string, context: CommandContext): PostbackOutcome {
  const { action, params } = parsePostback(data);

  switch (action) {
    case "mode": {
      const value = params.get("value") ?? "";
      if (!isModeId(value)) return { kind: "ignored" };
      if (!context.userId) {
        return { kind: "reply", messages: [textMessage("I cannot save settings in this chat.")] };
      }
      updateUser(context.userId, { mode: value });
      return {
        kind: "reply",
        messages: [
          textMessage(
            `${MODES[value].emoji} Mode: ${MODES[value].label}\n${MODES[value].blurb}`,
            mainMenuQuickReply()
          ),
        ],
      };
    }

    case "level": {
      const value = params.get("value") ?? "";
      if (!isLevelId(value)) return { kind: "ignored" };
      if (!context.userId) {
        return { kind: "reply", messages: [textMessage("I cannot save settings in this chat.")] };
      }
      updateUser(context.userId, { jlptLevel: value });
      return {
        kind: "reply",
        messages: [
          textMessage(
            `📊 JLPT level set to ${value.toUpperCase()}. I will aim explanations there.`,
            levelPickerQuickReply()
          ),
        ],
      };
    }

    case "prompt": {
      const value = params.get("value") ?? "";
      const prompt = PROMPT_ACTIONS[value];
      if (!prompt) return { kind: "ignored" };
      return { kind: "prompt", prompt, displayText: `[Follow-up: ${value}]` };
    }

    case "reminder": {
      const op = params.get("op") ?? "";
      const id = Number(params.get("id") ?? "");
      if (op !== "delete" || !Number.isInteger(id)) {
        return { kind: "ignored" };
      }
      if (!context.userId) {
        return {
          kind: "reply",
          messages: [
            textMessage(
              "Reminder controls only work in a 1-on-1 chat with me — tap the button there.",
              mainMenuQuickReply()
            ),
          ],
        };
      }
      const deleted = deleteReminder(id, context.userId);
      return {
        kind: "reply",
        messages: [
          textMessage(
            deleted ? `🗑️ Reminder ${id} cancelled.` : `I could not find reminder ${id}.`,
            mainMenuQuickReply()
          ),
        ],
      };
    }

    case "help":
      return { kind: "reply", messages: [textMessage(HELP_TEXT, mainMenuQuickReply())] };

    case "menu":
      return { kind: "reply", messages: [menuMessages()] };

    default:
      return { kind: "ignored" };
  }
}

/* ------------------------------------------------------------------ */
/* Text commands                                                      */
/* ------------------------------------------------------------------ */

function menuMessages(): messagingApi.Message {
  return textMessage(
    "What would you like to do?",
    mainMenuQuickReply()
  );
}

function requirementUser(context: CommandContext): string | null {
  if (context.userId) return null;
  return "I cannot save settings in this chat.";
}

export function executeTextCommand(raw: string, context: CommandContext): CommandOutcome {
  const text = raw.trim();
  if (!text) return { handled: false };

  const lower = text.toLowerCase();

  if (lower === "/start" || lower === "/help" || lower === "help" || text === "ヘルプ") {
    return { handled: true, messages: [textMessage(HELP_TEXT, mainMenuQuickReply())] };
  }

  if (lower === "/menu" || lower === "menu" || text === "メニュー") {
    return { handled: true, messages: [menuMessages()] };
  }

  if (lower === "/mode" || lower === "mode" || text === "/モード") {
    return {
      handled: true,
      messages: [
        textMessage(
          "Choose a mode. Your choice is saved for next time.",
          modeQuickReply()
        ),
      ],
    };
  }

  const modeMatch = lower.match(/^\/mode\s+([a-z]+)$/);
  if (modeMatch) {
    const value = modeMatch[1];
    if (!isModeId(value)) {
      return {
        handled: true,
        messages: [
          textMessage(
            `Unknown mode "${value}". Available: ${MODE_IDS.join(", ")}.`,
            modeQuickReply()
          ),
        ],
      };
    }
    const missingUser = requirementUser(context);
    if (missingUser) return { handled: true, messages: [textMessage(missingUser)] };
    updateUser(context.userId as string, { mode: value });
    return {
      handled: true,
      messages: [
        textMessage(
          `${MODES[value].emoji} Mode: ${MODES[value].label}\n${MODES[value].blurb}`,
          followUpQuickReply(value)
        ),
      ],
    };
  }

  if (lower === "/level" || lower === "level") {
    return {
      handled: true,
      messages: [textMessage("What is your JLPT level?", levelPickerQuickReply())],
    };
  }

  const levelMatch = lower.match(/^\/level\s+([a-z0-9]+)$/);
  if (levelMatch) {
    const value = levelMatch[1];
    if (!isLevelId(value)) {
      return {
        handled: true,
        messages: [
          textMessage(`Pick one of: ${LEVEL_IDS.map((l) => l.toUpperCase()).join(", ")}.`, levelPickerQuickReply()),
        ],
      };
    }
    const missingUser = requirementUser(context);
    if (missingUser) return { handled: true, messages: [textMessage(missingUser)] };
    updateUser(context.userId as string, { jlptLevel: value });
    return {
      handled: true,
      messages: [
        textMessage(
          `📊 JLPT level set to ${value.toUpperCase()}. I will aim explanations there.`,
          mainMenuQuickReply()
        ),
      ],
    };
  }

  if (lower === "/clear" || lower === "/reset" || lower === "clear") {
    clearConversation(context.convoId);
    return {
      handled: true,
      messages: [
        textMessage(
          "🧹 Memory cleared for this chat. We start fresh — your profile and reminders are untouched.",
          mainMenuQuickReply()
        ),
      ],
    };
  }

  if (lower === "/reminders" || lower === "reminders") {
    return { handled: true, messages: [renderReminderList(context)] };
  }

  if (lower === "/progress" || lower === "progress") {
    return { handled: true, messages: [renderProgress(context)] };
  }

  const deleteMatch = lower.match(/^\/(?:delete|del|cancel)\s+(\d+)$/);
  if (deleteMatch) {
    const id = Number(deleteMatch[1]);
    const deleted = context.userId ? deleteReminder(id, context.userId) : false;
    return {
      handled: true,
      messages: [
        textMessage(
          deleted ? `🗑️ Reminder ${id} cancelled.` : `I could not find reminder ${id} in this chat.`,
          mainMenuQuickReply()
        ),
      ],
    };
  }

  if (lower === "/id") {
    if (context.kind !== "user") {
      return {
        handled: true,
        messages: [textMessage("LINE IDs are only shown in 1-on-1 chats, for privacy.")],
      };
    }
    return {
      handled: true,
      messages: [
        textMessage(
          `Your LINE user ID:\n${context.userId ?? "unavailable"}\n\nKeep this private.`,
          mainMenuQuickReply()
        ),
      ],
    };
  }

  // Anything that looks like a reminder request is handled before Gemini.
  const reminder = parseReminderRequest(text);
  if (reminder) {
    if (!context.userId) {
      return {
        handled: true,
        messages: [textMessage("I can only set reminders for an identified user.")],
      };
    }

    const saved = addReminder({
      userId: context.userId,
      targetId: context.targetId,
      targetKind: context.kind,
      text: reminder.text,
      dueAt: reminder.at,
    });

    const guessNote = reminder.guessed
      ? "\n(I assumed 09:00 — tell me a time if that is wrong.)"
      : "";

    return {
      handled: true,
      messages: [
        textMessage(
          `⏰ Reminder #${saved.id} set for ${formatJst(saved.dueAt)} JST\n・${saved.text}${guessNote}`,
          removeReminderQuickReply(saved.id)
        ),
      ],
    };
  }

  return { handled: false };
}

function removeReminderQuickReply(id: number): messagingApi.QuickReply {
  return {
    items: [
      quickReplyItem("Cancel reminder", `action=reminder&op=delete&id=${id}`),
      quickReplyItem("Reminders", "action=help"),
    ],
  };
}

function renderProgress(context: CommandContext): messagingApi.Message {
  // Progress is personal; in a group the conversation is shared, so there is
  // no single learner to report on.
  if (!context.userId || context.kind !== "user") {
    return textMessage(
      "Learning progress is tracked in 1-on-1 chats only.",
      mainMenuQuickReply()
    );
  }

  const user = getUser(context.userId);
  const conversation = getOrCreateConversation(context.convoId, context.kind);
  const total = countMessages(context.convoId);

  const lines = [
    "📈 Your progress",
    `JLPT level: ${(user?.jlptLevel ?? "n5").toUpperCase()}`,
    `Mode: ${MODES[normalizeMode(user?.mode)].label}`,
    `Messages exchanged: ${total}`,
  ];

  if (conversation.summary?.trim()) {
    lines.push("", "What we have covered:", conversation.summary.trim());
  } else {
    lines.push(
      "",
      "Once we have chatted a little, I will summarise what we covered here."
    );
  }

  return textMessage(lines.join("\n"), mainMenuQuickReply());
}

function renderReminderList(context: CommandContext): messagingApi.Message {
  if (!context.userId) {
    return textMessage("Reminders are only available for an identified user.");
  }

  const reminders = listPendingReminders(context.userId);
  if (reminders.length === 0) {
    return textMessage(
      "You have no upcoming reminders.\n\nTry: remind me in 30 minutes to stretch",
      mainMenuQuickReply()
    );
  }

  const lines = reminders.map(
    (reminder) => `#${reminder.id}  ${formatJst(reminder.dueAt)} JST\n   ${reminder.text}`
  );

  return textMessage(
    `⏰ Your reminders\n\n${lines.join("\n\n")}\n\nCancel one with /delete <id>.`,
    {
      items: reminders
        .slice(0, 5)
        .map((reminder) =>
          quickReplyItem(
            `Cancel #${reminder.id}`,
            `action=reminder&op=delete&id=${reminder.id}`
          )
        ),
    }
  );
}

/* ------------------------------------------------------------------ */

export const GROUP_INTRODUCTION = GROUP_INTRO;
