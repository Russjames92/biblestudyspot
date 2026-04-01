import { Resend } from "resend";
import { storage } from "./storage";

// smtpPass = Resend API key, smtpUser = from-email address
function getResendClient() {
  const settings = storage.getEmailSettings();
  if (!settings?.smtpPass) return null;
  return new Resend(settings.smtpPass);
}

// ── Shared email wrapper ──────────────────────────────────────────────────
export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  try {
    const resend = getResendClient();
    if (!resend) return false;
    const settings = storage.getEmailSettings()!;
    const fromEmail = settings.smtpUser || "onboarding@resend.dev";
    const fromName = settings.fromName || "BibleStudySpot";
    const { error } = await resend.emails.send({
      from: `${fromName} <${fromEmail}>`,
      to,
      subject,
      html,
    });
    if (error) { console.error("[email] Resend error:", error); return false; }
    return true;
  } catch (e) {
    console.error("[email] Failed to send:", e);
    return false;
  }
}

// ── Test connection ────────────────────────────────────────────────────────
export async function testEmailConnection(): Promise<{ ok: boolean; error?: string }> {
  try {
    const resend = getResendClient();
    if (!resend) return { ok: false, error: "No API key configured" };
    // Send a real test to verify the key works
    const settings = storage.getEmailSettings()!;
    const fromEmail = settings.smtpUser || "onboarding@resend.dev";
    const fromName = settings.fromName || "BibleStudySpot";
    const { error } = await resend.emails.send({
      from: `${fromName} <${fromEmail}>`,
      to: settings.smtpUser || "onboarding@resend.dev",
      subject: "BibleStudySpot — connection test",
      html: "<p>Your Resend connection is working correctly.</p>",
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// ── HTML email templates ───────────────────────────────────────────────────
const emailBase = (content: string) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>BibleStudySpot</title>
</head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:'Georgia',serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#fffdf8;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.07);">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#7c4a1e,#a0622a);padding:28px 32px;text-align:center;">
            <p style="margin:0;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:rgba(255,255,255,0.7);font-family:Arial,sans-serif;">BibleStudySpot</p>
            <p style="margin:6px 0 0;font-size:22px;font-weight:600;color:#fff;font-family:'Georgia',serif;">Your session is coming up</p>
          </td>
        </tr>

        <!-- Content -->
        <tr>
          <td style="padding:32px;">
            ${content}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:20px 32px 28px;border-top:1px solid #efe8d8;text-align:center;">
            <p style="margin:0;font-size:12px;color:#a09070;font-family:Arial,sans-serif;">
              BibleStudySpot · Free, always · No pressure<br/>
              <span style="color:#c8a97a;">Every question worth asking has an answer in Scripture.</span>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>
`;

function sessionBlock(date: string, startTime: string, endTime: string, locationType: string, spotAddress?: string) {
  const fmt = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
  };
  const fmtDate = (d: string) => {
    const [y, mo, day] = d.split("-").map(Number);
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const dt = new Date(y, mo - 1, day);
    return `${days[dt.getDay()]}, ${months[mo - 1]} ${day}, ${y}`;
  };

  const locationLine = locationType === "zoom"
    ? `<p style="margin:4px 0 0;font-size:13px;color:#7c4a1e;font-family:Arial,sans-serif;">📹 Online via Zoom — link will be sent separately</p>`
    : spotAddress
      ? `<p style="margin:4px 0 0;font-size:13px;color:#7c4a1e;font-family:Arial,sans-serif;">📍 ${spotAddress}</p>`
      : `<p style="margin:4px 0 0;font-size:13px;color:#7c4a1e;font-family:Arial,sans-serif;">📍 In-person — location provided at booking</p>`;

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#faf6f0;border-radius:10px;border:1px solid #e8ddd0;margin-bottom:20px;">
      <tr><td style="padding:16px 20px;">
        <p style="margin:0;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#a09070;font-family:Arial,sans-serif;">Session Details</p>
        <p style="margin:6px 0 0;font-size:17px;font-weight:600;color:#3b2a1a;font-family:'Georgia',serif;">${fmtDate(date)}</p>
        <p style="margin:4px 0 0;font-size:14px;color:#5c3a1e;font-family:Arial,sans-serif;">🕐 ${fmt(startTime)} – ${fmt(endTime)}</p>
        ${locationLine}
      </td></tr>
    </table>
  `;
}

// ── 24-hour reminder ───────────────────────────────────────────────────────
export function build24HourEmail(opts: {
  name: string;
  date: string;
  startTime: string;
  endTime: string;
  locationType: string;
  question?: string | null;
  teacherName: string;
  spotAddress?: string;
}) {
  const content = `
    <p style="margin:0 0 6px;font-size:15px;color:#3b2a1a;font-family:Arial,sans-serif;">Hi ${opts.name},</p>
    <p style="margin:0 0 20px;font-size:15px;color:#5c3a1e;line-height:1.6;font-family:Arial,sans-serif;">
      Just a reminder — your Bible study session with <strong>${opts.teacherName}</strong> is <strong>tomorrow</strong>.
    </p>

    ${sessionBlock(opts.date, opts.startTime, opts.endTime, opts.locationType, opts.spotAddress)}

    ${opts.question ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0ebe0;border-radius:10px;border-left:3px solid #c8a97a;margin-bottom:20px;">
      <tr><td style="padding:14px 18px;">
        <p style="margin:0;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#a09070;font-family:Arial,sans-serif;">Your question</p>
        <p style="margin:6px 0 0;font-size:14px;color:#3b2a1a;line-height:1.5;font-style:italic;font-family:'Georgia',serif;">"${opts.question}"</p>
      </td></tr>
    </table>` : ""}

    <p style="margin:0 0 6px;font-size:14px;color:#5c3a1e;line-height:1.6;font-family:Arial,sans-serif;">
      Come as you are — no preparation needed, no agenda. Just bring the question on your heart and we'll open the book together.
    </p>
    <p style="margin:16px 0 0;font-size:13px;color:#a09070;font-family:Arial,sans-serif;">
      Need to reschedule? Just reply to this email.
    </p>
  `;
  return emailBase(content);
}

// ── 1-hour reminder ────────────────────────────────────────────────────────
export function build1HourEmail(opts: {
  name: string;
  date: string;
  startTime: string;
  endTime: string;
  locationType: string;
  question?: string | null;
  teacherName: string;
  spotAddress?: string;
}) {
  const content = `
    <p style="margin:0 0 6px;font-size:15px;color:#3b2a1a;font-family:Arial,sans-serif;">Hi ${opts.name},</p>
    <p style="margin:0 0 20px;font-size:15px;color:#5c3a1e;line-height:1.6;font-family:Arial,sans-serif;">
      Your session with <strong>${opts.teacherName}</strong> starts in <strong>about 1 hour</strong>. Looking forward to it!
    </p>

    ${sessionBlock(opts.date, opts.startTime, opts.endTime, opts.locationType, opts.spotAddress)}

    ${opts.question ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0ebe0;border-radius:10px;border-left:3px solid #c8a97a;margin-bottom:20px;">
      <tr><td style="padding:14px 18px;">
        <p style="margin:0;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#a09070;font-family:Arial,sans-serif;">Your question</p>
        <p style="margin:6px 0 0;font-size:14px;color:#3b2a1a;line-height:1.5;font-style:italic;font-family:'Georgia',serif;">"${opts.question}"</p>
      </td></tr>
    </table>` : ""}

    <p style="margin:0 0 6px;font-size:14px;color:#5c3a1e;line-height:1.6;font-family:Arial,sans-serif;">
      See you soon — no need to bring anything, just yourself and your question.
    </p>
    ${opts.locationType === "zoom" ? `<p style="margin:12px 0 0;font-size:13px;color:#7c4a1e;font-family:Arial,sans-serif;">📹 <strong>Online session:</strong> Your teacher will send the Zoom link shortly if you haven't received it.</p>` : ""}
  `;
  return emailBase(content);
}

// ── Booking confirmed email ──────────────────────────────────────────────────
export function buildConfirmationEmail(opts: {
  name: string;
  date: string;
  startTime: string;
  endTime: string;
  locationType: string;
  question?: string | null;
  teacherName: string;
  spotAddress?: string;
  zoomLink?: string;
}) {
  const locationBlock = opts.locationType === "zoom"
    ? `
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#fdf6f0;border-radius:10px;border-left:4px solid #c8a97a;margin-bottom:20px;">
        <tr><td style="padding:16px 20px;">
          <p style="margin:0;font-size:13px;font-weight:600;color:#5c3a1e;font-family:Arial,sans-serif;">📹 Online via Zoom</p>
          ${opts.zoomLink
            ? `<p style="margin:8px 0 4px;font-size:13px;color:#3b2a1a;font-family:Arial,sans-serif;">Your meeting link:</p>
               <a href="${opts.zoomLink}" style="display:inline-block;margin-top:4px;padding:10px 20px;background:#0b5cff;color:white;text-decoration:none;border-radius:8px;font-size:13px;font-family:Arial,sans-serif;font-weight:600;">Join Zoom Meeting</a>
               <p style="margin:8px 0 0;font-size:11px;color:#a09070;font-family:Arial,sans-serif;word-break:break-all;">${opts.zoomLink}</p>`
            : `<p style="margin:6px 0 0;font-size:13px;color:#7c4a1e;font-family:Arial,sans-serif;">Your teacher will send the Zoom meeting link shortly. Keep an eye on your inbox.</p>`
          }
        </td></tr>
      </table>`
    : `
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#fdf6f0;border-radius:10px;border-left:4px solid #c8a97a;margin-bottom:20px;">
        <tr><td style="padding:16px 20px;">
          <p style="margin:0;font-size:13px;font-weight:600;color:#5c3a1e;font-family:Arial,sans-serif;">📍 In-Person Location</p>
          <p style="margin:6px 0 0;font-size:15px;font-weight:600;color:#3b2a1a;font-family:'Georgia',serif;">${opts.spotAddress}</p>
          <p style="margin:4px 0 0;font-size:12px;color:#a09070;font-family:Arial,sans-serif;">This address is only shared with confirmed participants.</p>
        </td></tr>
      </table>`;

  const content = `
    <p style="margin:0 0 6px;font-size:15px;color:#3b2a1a;font-family:Arial,sans-serif;">Hi ${opts.name},</p>
    <p style="margin:0 0 20px;font-size:15px;color:#5c3a1e;line-height:1.6;font-family:Arial,sans-serif;">
      Your Bible study session has been <strong style="color:#3a7a4a;">confirmed</strong> by ${opts.teacherName}. We’re looking forward to it!
    </p>

    ${sessionBlock(opts.date, opts.startTime, opts.endTime, opts.locationType, opts.locationType !== "zoom" ? opts.spotAddress : undefined)}
    ${locationBlock}

    ${opts.question ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0ebe0;border-radius:10px;border-left:3px solid #c8a97a;margin-bottom:20px;">
      <tr><td style="padding:14px 18px;">
        <p style="margin:0;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#a09070;font-family:Arial,sans-serif;">Your question</p>
        <p style="margin:6px 0 0;font-size:14px;color:#3b2a1a;line-height:1.5;font-style:italic;font-family:'Georgia',serif;">"${opts.question}"</p>
      </td></tr>
    </table>` : ""}

    <p style="margin:0;font-size:14px;color:#5c3a1e;line-height:1.6;font-family:Arial,sans-serif;">
      Come as you are — no preparation needed, no agenda. Just bring the question on your heart.
    </p>
    <p style="margin:12px 0 0;font-size:13px;color:#a09070;font-family:Arial,sans-serif;">
      Need to reschedule? Just reply to this email.
    </p>
  `;

  // Override header text for confirmation
  return emailBase(content).replace(
    "Your session is coming up",
    "Your session is confirmed ✨"
  );
}
