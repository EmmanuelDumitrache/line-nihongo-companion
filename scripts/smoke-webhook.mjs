/**
 * Sends a correctly signed fake webhook to a locally running bot.
 * Useful for checking signature verification, command routing and logging
 * without opening LINE on your phone.
 *
 *   node scripts/smoke-webhook.mjs http://127.0.0.1:3100/webhook "/help"
 *
 * The replyToken is fake on purpose: the bot will fail to reply and fall back
 * to push, which also exercises the error path. Nothing is delivered.
 */
import { readFileSync } from "node:fs";
import crypto from "node:crypto";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    })
);

const secret = env.LINE_CHANNEL_SECRET;
if (!secret) {
  console.error("LINE_CHANNEL_SECRET is missing from .env");
  process.exit(1);
}

const url = process.argv[2] ?? `http://127.0.0.1:${env.PORT ?? 3000}/webhook`;
const text = process.argv[3] ?? "/help";
const id = `smoke-${Date.now()}`;

const body = JSON.stringify({
  destination: "smoke-test",
  events: [
    {
      type: "message",
      mode: "active",
      timestamp: Date.now(),
      webhookEventId: id,
      deliveryContext: { isRedelivery: false },
      replyToken: "00000000000000000000000000000000",
      source: { type: "user", userId: "U_SMOKE_TEST" },
      message: { type: "text", id, text },
    },
  ],
});

const signature = crypto.createHmac("sha256", secret).update(body).digest("base64");

const response = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-line-signature": signature,
  },
  body,
});

console.log(`HTTP ${response.status}`, await response.text());
