import "dotenv/config";
import { askGemini } from "./gemini.js";

async function main(): Promise<void> {
  const answer = await askGemini({
    systemInstruction:
      "You are a concise Japanese teacher. Reply in one short sentence, plain text only.",
    userText: "Introduce yourself in one sentence.",
  });
  console.log(answer);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
