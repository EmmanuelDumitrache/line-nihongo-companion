import { config } from "./config.js";
import {
  bumpReminderAttempt,
  dueReminders,
  markReminderSent,
  pruneOldData,
} from "./database.js";
import type { Reminder } from "./database.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const JST_OFFSET_MS = config.jstOffsetMinutes * MINUTE;

/* ------------------------------------------------------------------ */
/* JST helpers                                                        */
/* ------------------------------------------------------------------ */

export interface JstParts {
  year: number;
  /** 0-based, matching Date.getUTCMonth(). */
  monthIndex: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

export function toJstParts(epochMs: number): JstParts {
  const shifted = new Date(epochMs + JST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    monthIndex: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

export function fromJstParts(parts: {
  year: number;
  monthIndex: number;
  day: number;
  hour: number;
  minute: number;
}): number {
  // Date.UTC normalises overflow (day 32 → next month), which is exactly what
  // we want for "tomorrow" across month and year boundaries.
  return (
    Date.UTC(parts.year, parts.monthIndex, parts.day, parts.hour, parts.minute) -
    JST_OFFSET_MS
  );
}

export function formatJst(epochMs: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(epochMs));
}

/* ------------------------------------------------------------------ */
/* Duration parsing                                                   */
/* ------------------------------------------------------------------ */

const EN_DURATION_RE =
  /(\d+)\s*(months?|minutes?|mins?|min|hours?|hrs?|hr|days?|weeks?|wks?|wk|m|h|d|w)\b/gi;

const JA_DURATION_RE = /(\d+)\s*(ヶ月|か月|週間|時間|分|日|秒)/g;

function unitToMs(unit: string): number | null {
  const u = unit.toLowerCase();
  if (u.startsWith("month")) return 30 * DAY;
  if (u === "m" || u.startsWith("min")) return MINUTE;
  if (u === "h" || u.startsWith("hour") || u.startsWith("hr")) return HOUR;
  if (u === "d" || u.startsWith("day")) return DAY;
  if (u === "w" || u.startsWith("week") || u.startsWith("wk")) return WEEK;
  switch (unit) {
    case "秒":
      return 1_000;
    case "分":
      return MINUTE;
    case "時間":
      return HOUR;
    case "日":
      return DAY;
    case "週間":
      return WEEK;
    case "ヶ月":
    case "か月":
      return 30 * DAY;
    default:
      return null;
  }
}

/** Sums every duration in the string, so "1 hour 30 minutes" works. */
export function parseDuration(text: string): number | null {
  let total = 0;
  let found = false;

  for (const match of text.matchAll(EN_DURATION_RE)) {
    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(amount) || !unit) continue;
    const ms = unitToMs(unit);
    if (ms === null) continue;
    total += amount * ms;
    found = true;
  }

  for (const match of text.matchAll(JA_DURATION_RE)) {
    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(amount) || !unit) continue;
    const ms = unitToMs(unit);
    if (ms === null) continue;
    total += amount * ms;
    found = true;
  }

  return found && total > 0 ? total : null;
}

/* ------------------------------------------------------------------ */
/* Clock parsing                                                      */
/* ------------------------------------------------------------------ */

interface ClockTime {
  hour: number;
  minute: number;
  explicitMeridiem: boolean;
}

function parseClockTime(text: string): ClockTime | null {
  const withMeridiem = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (withMeridiem) {
    const rawHour = Number(withMeridiem[1]);
    const minute = withMeridiem[2] ? Number(withMeridiem[2]) : 0;
    const meridiem = withMeridiem[3]?.toLowerCase();
    if (rawHour > 23 || minute > 59) return null;

    let hour = rawHour;
    if (meridiem === "pm" && rawHour < 12) hour = rawHour + 12;
    if (meridiem === "am" && rawHour === 12) hour = 0;
    return { hour, minute, explicitMeridiem: true };
  }

  const withDayWord = text.match(
    /\b(?:day after tomorrow|tomorrow|today|tonight)\b\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?/i
  );
  if (withDayWord) {
    const hour = Number(withDayWord[1]);
    const minute = withDayWord[2] ? Number(withDayWord[2]) : 0;
    if (hour > 23 || minute > 59) return null;
    return { hour, minute, explicitMeridiem: false };
  }

  const withAt = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?/i);
  if (withAt) {
    const hour = Number(withAt[1]);
    const minute = withAt[2] ? Number(withAt[2]) : 0;
    if (hour > 23 || minute > 59) return null;
    return { hour, minute, explicitMeridiem: false };
  }

  const withColon = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (withColon) {
    const hour = Number(withColon[1]);
    const minute = Number(withColon[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute, explicitMeridiem: false };
  }

  const japanese = text.match(/(\d{1,2})時(?:(?:(\d{1,2})分)|(半))?/);
  if (japanese) {
    const hour = Number(japanese[1]);
    const minute = japanese[3] ? 30 : japanese[2] ? Number(japanese[2]) : 0;
    if (hour > 23 || minute > 59) return null;
    return { hour, minute, explicitMeridiem: false };
  }

  return null;
}

function dayOffsetOf(text: string): number {
  if (/明後日|day after tomorrow/i.test(text)) return 2;
  if (/明日|tomorrow/i.test(text)) return 1;
  return 0;
}

function hasDayWord(text: string): boolean {
  return /明後日|明日|今日|tomorrow|today|tonight|今夜|今晩|day after tomorrow/i.test(text);
}

function resolveClock(
  nowMs: number,
  hour: number,
  minute: number,
  dayOffset: number,
  explicitMeridiem: boolean
): number {
  const today = toJstParts(nowMs);

  const build = (h: number): number =>
    fromJstParts({
      year: today.year,
      monthIndex: today.monthIndex,
      day: today.day + dayOffset,
      hour: h,
      minute,
    });

  // "at 8" is ambiguous. Pick the next 8:00 or 20:00, whichever comes first.
  if (!explicitMeridiem && hour <= 12) {
    const candidates = [build(hour)];
    if (hour !== 12) candidates.push(build(hour + 12));
    const future = candidates.filter((candidate) => candidate > nowMs);
    if (future.length > 0) return Math.min(...future);
  }

  const candidate = build(hour);
  if (candidate > nowMs) return candidate;

  // A bare time that already passed today means tomorrow, unless the user
  // explicitly named a day.
  if (dayOffset === 0) return build(hour) + DAY;
  return candidate;
}

/* ------------------------------------------------------------------ */
/* Finding the time phrase inside free text                           */
/* ------------------------------------------------------------------ */

export interface TimeMatch {
  at: number;
  guessed: boolean;
  start: number;
  end: number;
}

const DURATION_SPANS = [
  /(?:\b(?:in|after)\s+)?(?:\d+\s*(?:months?|minutes?|mins?|min|hours?|hrs?|hr|days?|weeks?|wks?|wk|m|h|d|w)\b\s*)+(?:from now)?/i,
  /(?:\d+\s*(?:ヶ月|か月|週間|時間|分|日|秒)\s*)+(?:後|後に|あとで)?/,
];

const CLOCK_SPANS = [
  /\b(?:day after tomorrow|tomorrow|today|tonight)\b\s*(?:at\s+)?\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?/i,
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i,
  /\bat\s+\d{1,2}(?::\d{2})?/i,
  /\b\d{1,2}:\d{2}\b/,
  /(?:明後日|明日|今日|今夜|今晩)の?\s*\d{1,2}時(?:\d{1,2}分|半)?\s*に?/,
  /\d{1,2}時(?:\d{1,2}分|半)?\s*に?/,
];

export function findTimeMatch(text: string, nowMs = Date.now()): TimeMatch | null {
  for (const pattern of DURATION_SPANS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const duration = parseDuration(match[0]);
    if (duration !== null) {
      return {
        at: nowMs + duration,
        guessed: false,
        start: match.index,
        end: match.index + match[0].length,
      };
    }
  }

  for (const pattern of CLOCK_SPANS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const clock = parseClockTime(match[0]);
    if (!clock) continue;
    return {
      at: resolveClock(
        nowMs,
        clock.hour,
        clock.minute,
        dayOffsetOf(text),
        clock.explicitMeridiem
      ),
      guessed: false,
      start: match.index,
      end: match.index + match[0].length,
    };
  }

  // "tomorrow" with no time → 09:00 JST.
  const dayOnly = /\b(?:day after tomorrow|tomorrow)\b|明後日|明日/i.exec(text);
  if (dayOnly && hasDayWord(text)) {
    const offset = Math.max(1, dayOffsetOf(text));
    const today = toJstParts(nowMs);
    return {
      at: fromJstParts({
        year: today.year,
        monthIndex: today.monthIndex,
        day: today.day + offset,
        hour: 9,
        minute: 0,
      }),
      guessed: true,
      start: dayOnly.index,
      end: dayOnly.index + dayOnly[0].length,
    };
  }

  return null;
}

export interface ParsedTime {
  at: number;
  /** true when we guessed a clock time instead of using an explicit one. */
  guessed: boolean;
}

/** Parses a standalone time expression; mainly for tests and reminders. */
export function parseTimeExpression(text: string, nowMs = Date.now()): ParsedTime | null {
  const match = findTimeMatch(text, nowMs);
  return match ? { at: match.at, guessed: match.guessed } : null;
}

/* ------------------------------------------------------------------ */
/* Reminder request parsing                                           */
/* ------------------------------------------------------------------ */

export interface ParsedReminderRequest {
  text: string;
  at: number;
  guessed: boolean;
}

function cleanupTask(raw: string): string {
  let task = raw;

  // Strip connector debris left behind once the time phrase is removed.
  // Only leading English connectors are stripped ("go to the bank" keeps its
  // "to"), and only trailing Japanese particles.
  for (let i = 0; i < 3; i += 1) {
    task = task
      .replace(/^\s*(?:to|at|in|after|from now|please|that)\b\s*/i, "")
      .replace(/^\s*[のにをがはで、,。:：!！]+\s*/u, "")
      .replace(/\s*[のにをがはで、,。:：!！]+\s*$/u, "")
      .replace(/\b(?:please|from now|ok|okay)\s*$/i, "")
      .trim();
  }

  return task.replace(/\s+/g, " ").trim();
}

/**
 * Accepts the shapes people actually type:
 *   remind me in 10 minutes to call the dentist
 *   remind me to call the dentist in 10 minutes
 *   remind me at 8pm to take medicine
 *   remind me tomorrow to renew my visa
 *   /remind in 2 hours stretch
 *   明日の8時に歯医者に行くのをリマインドして
 */
export function parseReminderRequest(
  raw: string,
  nowMs = Date.now()
): ParsedReminderRequest | null {
  let text = raw.trim();

  const startsWithTrigger =
    /^(?:\/remind|remind me|remind|リマインドして|リマインド|リマインダー)\b/i.test(text);
  const endsWithTrigger = /(?:リマインドして|リマインド|リマインダー)(?:ください)?[。!！]?$/u.test(
    text
  );

  if (!startsWithTrigger && !endsWithTrigger) return null;

  text = text
    .replace(/^\/remind\b\s*/i, "")
    .replace(/^remind me\b\s*/i, "")
    .replace(/^remind\b\s*/i, "")
    .replace(/^リマインドして\s*/i, "")
    .replace(/^リマインド\s*/i, "")
    .replace(/^リマインダー\s*/i, "")
    .replace(/(?:を)?\s*(?:リマインドして|リマインド|リマインダー)(?:ください)?[。!！]?$/u, "")
    .trim();

  if (!text) return null;

  const match = findTimeMatch(text, nowMs);
  if (!match) return null;

  const task = cleanupTask(text.slice(0, match.start) + " " + text.slice(match.end));
  if (task.length < 2) return null;

  return { text: task, at: match.at, guessed: match.guessed };
}

/* ------------------------------------------------------------------ */
/* Scheduler                                                          */
/* ------------------------------------------------------------------ */

export type ReminderSender = (reminder: Reminder) => Promise<void>;

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastPrune = 0;
const inFlight = new Set<number>();

export function startReminderScheduler(send: ReminderSender): void {
  if (timer) return;

  timer = setInterval(() => {
    void tick(send);
  }, 20_000);
  // Never keep the process alive just for the scheduler.
  timer.unref();

  void tick(send);
}

export function stopReminderScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(send: ReminderSender): Promise<void> {
  if (running) return;
  running = true;

  try {
    if (Date.now() - lastPrune > DAY) {
      lastPrune = Date.now();
      pruneOldData();
    }

    for (const reminder of dueReminders(Date.now())) {
      if (inFlight.has(reminder.id)) continue;
      inFlight.add(reminder.id);

      try {
        await send(reminder);
        markReminderSent(reminder.id);
      } catch (error) {
        const attempts = bumpReminderAttempt(reminder.id);
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[reminder ${reminder.id}] delivery failed (attempt ${attempts}/${config.limits.maxReminderAttempts}): ${message}`
        );
        if (attempts >= config.limits.maxReminderAttempts) {
          // Give up, but keep the row so it stays visible in /reminders.
          markReminderSent(reminder.id);
        }
      } finally {
        inFlight.delete(reminder.id);
      }
    }
  } catch (error) {
    console.error("[reminder] scheduler tick failed:", error);
  } finally {
    running = false;
  }
}
