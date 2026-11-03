/**
 * Prints the exact system instruction sent to Gemini for a given mode/level.
 *
 *   npm run prompt -- conversation n5
 *   npm run prompt -- grammar n4
 *
 * Useful when you want to see how the persona, mode rules and memory summary
 * are assembled without digging through the source.
 */
import { LEVEL_IDS, MODE_IDS, buildSystemInstruction, isLevelId, isModeId } from "../src/ai.js";

const modeArgument = process.argv[2] ?? "conversation";
const levelArgument = process.argv[3] ?? "n5";

if (!isModeId(modeArgument)) {
  console.error(`Unknown mode "${modeArgument}". Available: ${MODE_IDS.join(", ")}`);
  process.exit(1);
}

if (!isLevelId(levelArgument)) {
  console.error(
    `Unknown level "${levelArgument}". Available: ${LEVEL_IDS.map((l) => l.toUpperCase()).join(", ")}`
  );
  process.exit(1);
}

console.log(
  buildSystemInstruction({
    mode: modeArgument,
    level: levelArgument,
    nativeLang: "en",
    summary: null,
    inGroup: false,
  })
);
