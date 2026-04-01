import { storage } from "./storage";
import { sendEmail, build24HourEmail, build1HourEmail } from "./email";
import { log } from "./index";

const SPOT_ADDRESS = "7412 Van Maren Ln, Citrus Heights, CA 95621";

// ── Parse a session datetime into a JS Date ────────────────────────────────
function sessionDate(date: string, time: string): Date {
  // date = "2026-04-01", time = "14:00"
  const [y, mo, d] = date.split("-").map(Number);
  const [h, m] = time.split(":").map(Number);
  return new Date(y, mo - 1, d, h, m, 0, 0);
}

// ── Main reminder check — runs every 30 minutes ────────────────────────────
export async function checkAndSendReminders() {
  try {
    const settings = storage.getEmailSettings();
    if (!settings?.remindersEnabled || !settings.smtpUser || !settings.smtpPass) return;

    const now = new Date();
    const allSessions = storage.getAllSessionsWithDetails();

    for (const session of allSessions) {
      const sessionStart = sessionDate(session.date, session.startTime);
      const msUntil = sessionStart.getTime() - now.getTime();
      const hoursUntil = msUntil / (1000 * 60 * 60);

      // Skip past sessions
      if (hoursUntil < 0) continue;

      // Get teacher name
      const teacher = session.teacherId ? storage.getTeacher(session.teacherId) : null;
      const teacherName = teacher?.name ?? "your Bible study teacher";

      for (const participant of session.participants) {
        // Only remind confirmed or pending participants (not cancelled)
        if (participant.status === "cancelled") continue;

        // ── 24-hour reminder: send when 23h ≤ hoursUntil ≤ 25h ──────────
        if (!participant.reminder24Sent && hoursUntil >= 23 && hoursUntil <= 25) {
          const html = build24HourEmail({
            name: participant.name,
            date: session.date,
            startTime: session.startTime,
            endTime: session.endTime,
            locationType: participant.locationType ?? "in-person",
            question: participant.question,
            teacherName,
            spotAddress: participant.locationType !== "zoom" ? SPOT_ADDRESS : undefined,
          });

          const sent = await sendEmail(
            participant.email,
            `Reminder: Your Bible study session is tomorrow ✦`,
            html
          );

          if (sent) {
            storage.markReminderSent(participant.id, "24h");
            log(`[reminders] 24h reminder sent to ${participant.email} for session ${session.id}`);
          }
        }

        // ── 1-hour reminder: send when 0.75h ≤ hoursUntil ≤ 1.5h ────────
        if (!participant.reminder1Sent && hoursUntil >= 0.75 && hoursUntil <= 1.5) {
          const html = build1HourEmail({
            name: participant.name,
            date: session.date,
            startTime: session.startTime,
            endTime: session.endTime,
            locationType: participant.locationType ?? "in-person",
            question: participant.question,
            teacherName,
            spotAddress: participant.locationType !== "zoom" ? SPOT_ADDRESS : undefined,
          });

          const sent = await sendEmail(
            participant.email,
            `Starting in 1 hour: Your Bible study session ✦`,
            html
          );

          if (sent) {
            storage.markReminderSent(participant.id, "1h");
            log(`[reminders] 1h reminder sent to ${participant.email} for session ${session.id}`);
          }
        }
      }
    }
  } catch (e) {
    console.error("[reminders] Error during reminder check:", e);
  }
}

// ── Start the scheduler — checks every 30 minutes ─────────────────────────
export function startReminderScheduler() {
  // Run once on boot (after a short delay to let DB settle)
  setTimeout(() => checkAndSendReminders(), 15_000);
  // Then every 30 minutes
  setInterval(() => checkAndSendReminders(), 30 * 60 * 1000);
  log("[reminders] Scheduler started — checking every 30 minutes");
}
