/**
 * Live integration check for the AI layer: persona, mode, history persistence.
 * Makes two real Gemini calls with a throwaway database.
 *
 *   DB_PATH=/tmp/nihongo-ai.db npx tsx scripts/smoke-ai.ts
 */
import { closeDatabase, getRecentMessages, initDatabase, updateUser, upsertUser } from "../src/database.js";
import { generateReply } from "../src/ai.js";

const dbPath = process.env.DB_PATH ?? "/tmp/nihongo-ai-smoke.db";
initDatabase(dbPath);

const userId = "U_AI_SMOKE";
upsertUser(userId, "Smoke Tester");
updateUser(userId, { mode: "correction", jlptLevel: "n4" });

const first = await generateReply({
  convoId: userId,
  kind: "user",
  userId,
  text: "私は昨日に寿司を食べました。 Correct this.",
});
console.log("--- reply 1 ---");
console.log(first.text);

const afterFirst = getRecentMessages(userId, 10);
console.log(`\nstored messages after turn 1: ${afterFirst.length} (${afterFirst.map((m) => m.role).join(", ")})`);

const second = await generateReply({
  convoId: userId,
  kind: "user",
  userId,
  text: "Why is に wrong there?",
});
console.log("\n--- reply 2 (should reference the correction) ---");
console.log(second.text);

const afterSecond = getRecentMessages(userId, 10);
console.log(`\nstored messages after turn 2: ${afterSecond.length}`);
closeDatabase();
