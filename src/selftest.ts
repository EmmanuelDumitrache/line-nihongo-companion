import "dotenv/config";
import {
  addReminder,
  appendMessage,
  clearConversation,
  closeDatabase,
  countMessages,
  countMessagesAfter,
  deleteReminder,
  getOrCreateConversation,
  getRecentMessages,
  getUser,
  initDatabase,
  listPendingReminders,
  registerWebhookEvent,
  setSummary,
  updateUser,
  upsertUser,
} from "./database.js";
import { formatJst, parseReminderRequest, parseTimeExpression, toJstParts } from "./reminders.js";
import { splitText, stripMentions } from "./text.js";
import { executeTextCommand } from "./commands.js";
import type { CommandContext } from "./commands.js";

let checks = 0;
let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (condition) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(name, actual === expected, `expected ${String(expected)}, got ${String(actual)}`);
}

// 2026-11-03 09:00 JST (Tuesday)
const NOW = Date.parse("2026-11-03T00:00:00Z");

/* ------------------------------------------------------------------ */
console.log("\nJST helpers");
/* ------------------------------------------------------------------ */

const jst = toJstParts(NOW);
eq("JST hour", jst.hour, 9);
eq("JST day", jst.day, 3);
check("formatJst produces a readable date", formatJst(NOW).includes("09:00"), formatJst(NOW));

/* ------------------------------------------------------------------ */
console.log("\nReminder parsing");
/* ------------------------------------------------------------------ */

const in10 = parseReminderRequest("remind me in 10 minutes to stretch", NOW);
check("in 10 minutes parses", in10 !== null);
eq("task is clean", in10?.text, "stretch");
eq("due time is +10m", in10?.at, NOW + 10 * 60_000);

const dentist = parseReminderRequest("remind me to call the dentist in 2 hours", NOW);
eq("task-first ordering", dentist?.text, "call the dentist");
eq("due time is +2h", dentist?.at, NOW + 2 * 60 * 60_000);

const medicine = parseReminderRequest("remind me at 8pm to take medicine", NOW);
eq("8pm task", medicine?.text, "take medicine");
eq("8pm resolves to today 20:00 JST", medicine?.at, NOW + 11 * 60 * 60_000);

const tomorrow = parseReminderRequest("remind me tomorrow to renew my visa", NOW);
eq("tomorrow task", tomorrow?.text, "renew my visa");
eq("tomorrow defaults to 09:00 JST", tomorrow?.at, NOW + 24 * 60 * 60_000);
check("tomorrow is marked as a guess", tomorrow?.guessed === true);

const japanese = parseReminderRequest("明日の8時に歯医者に行くのをリマインドして", NOW);
eq("Japanese task", japanese?.text, "歯医者に行く");
eq("Japanese time", japanese?.at, NOW + 23 * 60 * 60_000);

check(
  "duration-only reminder has no task",
  parseReminderRequest("10分後にリマインドして", NOW) === null
);
check("reminder without a time is not consumed", parseReminderRequest("remind me to buy milk", NOW) === null);
check("plain text is not a reminder", parseReminderRequest("hello there", NOW) === null);

const ninety = parseTimeExpression("in 90 minutes", NOW);
eq("90 minutes", ninety?.at, NOW + 90 * 60_000);

const clock = parseTimeExpression("at 20:30", NOW);
eq("20:30 today", clock?.at, NOW + 11.5 * 60 * 60_000);

const tomorrowNine = parseTimeExpression("tomorrow at 9", NOW);
eq("ambiguous hour resolves to morning", tomorrowNine?.at, NOW + 24 * 60 * 60_000);

/* ------------------------------------------------------------------ */
console.log("\nText splitting and mentions");
/* ------------------------------------------------------------------ */

eq("short text is one chunk", splitText("hello").length, 1);

const long = splitText("x".repeat(30_000));
eq("long text is capped at 5 messages", long.length, 5);
check("every chunk fits LINE's limit", long.every((chunk) => chunk.length <= 4_500));
check("truncation is disclosed", long[4].includes("truncated"));

const mention = {
  mentionees: [{ type: "user", index: 0, length: 5, isSelf: true }],
} as Parameters<typeof stripMentions>[1];
eq("mention prefix is removed", stripMentions("@Bot hello", mention), "hello");
eq("no mention means unchanged", stripMentions("hello", undefined), "hello");

/* ------------------------------------------------------------------ */
console.log("\nDatabase");
/* ------------------------------------------------------------------ */

initDatabase(":memory:");

const created = upsertUser("u1", "Manny");
eq("user created", created.userId, "u1");
eq("default mode", created.mode, "auto");

updateUser("u1", { mode: "grammar", jlptLevel: "n4" });
const updated = getUser("u1");
eq("mode persisted", updated?.mode, "grammar");
eq("level persisted", updated?.jlptLevel, "n4");

getOrCreateConversation("u1", "user");
appendMessage("u1", "user", "こんにちは");
appendMessage("u1", "model", "こんにちは！");
eq("history length", getRecentMessages("u1", 10).length, 2);
eq("message count", countMessagesAfter("u1", 0), 2);
eq("total message count", countMessages("u1"), 2);

const context: CommandContext = {
  userId: "u1",
  convoId: "u1",
  kind: "user",
  targetId: "u1",
};

const progress = executeTextCommand("/progress", context);
check("progress command is handled", progress.handled === true);
if (progress.handled) {
  check("progress renders a text message", progress.messages[0]?.type === "text");
}

const modeCommand = executeTextCommand("/mode grammar", context);
check("mode command is handled", modeCommand.handled === true);
eq("mode command persists", getUser("u1")?.mode, "grammar");

setSummary("u1", "Learner is a beginner.", 2);
eq("summary persisted", getOrCreateConversation("u1", "user").summary, "Learner is a beginner.");

clearConversation("u1");
eq("clear removes messages", getRecentMessages("u1", 10).length, 0);
eq("clear removes summary", getOrCreateConversation("u1", "user").summary, null);

const reminder = addReminder({
  userId: "u1",
  targetId: "u1",
  targetKind: "user",
  text: "stretch",
  dueAt: Date.now() + 60_000,
});

eq("pending reminder listed", listPendingReminders("u1").length, 1);
eq("deletion is scoped by user", deleteReminder(reminder.id, "u2"), false);
eq("owner can delete", deleteReminder(reminder.id, "u1"), true);
eq("list is empty after deletion", listPendingReminders("u1").length, 0);

eq("first webhook delivery is new", registerWebhookEvent("evt-1"), true);
eq("duplicate delivery is ignored", registerWebhookEvent("evt-1"), false);

closeDatabase();

/* ------------------------------------------------------------------ */

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
