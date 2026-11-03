import "dotenv/config";
import express from "express";
import { config } from "./config.js";
import { closeDatabase, initDatabase } from "./database.js";
import { handleWebhook, lineClient, lineMiddleware } from "./line.js";
import { startReminderScheduler, stopReminderScheduler } from "./reminders.js";

initDatabase();

startReminderScheduler(async (reminder) => {
  await lineClient.pushMessage({
    to: reminder.targetId,
    messages: [
      {
        type: "text",
        text: `⏰ Reminder\n・${reminder.text}`,
      },
    ],
  });
});

const app = express();

// Health check for deployment platforms (Render, Cloud Run, etc.)
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    app: "Nihongo Companion",
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// LINE webhook route.
// NOTE: no express.json() here — the LINE middleware handles raw body parsing
// so signature verification works correctly.
app.post("/webhook", lineMiddleware, handleWebhook);

const server = app.listen(config.server.port, () => {
  console.log(`Nihongo Companion running on port ${config.server.port}`);
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n${signal} received — shutting down`);
  stopReminderScheduler();

  server.close(() => {
    closeDatabase();
    process.exit(0);
  });

  // Do not hang forever if a connection refuses to drain.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// A rejected promise in a background task (summariser, reminder tick) must
// never take the whole server down.
process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandled rejection:", reason);
});
