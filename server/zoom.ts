import { storage } from "./storage";

// ── Get a Server-to-Server OAuth access token from Zoom ───────────────────────
async function getZoomToken(accountId: string, clientId: string, clientSecret: string): Promise<string> {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Zoom auth failed: ${err}`);
  }
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

// ── Create a Zoom meeting and return the join URL + meeting ID ────────────────
export async function createZoomMeeting(opts: {
  topic: string;
  date: string;      // "2026-04-15"
  startTime: string; // "14:00"
  durationMinutes: number;
}): Promise<{ joinUrl: string; meetingId: string } | null> {
  try {
    const settings = storage.getZoomSettings();
    if (!settings?.enabled || !settings.accountId || !settings.clientId || !settings.clientSecret) {
      return null;
    }

    const token = await getZoomToken(settings.accountId, settings.clientId, settings.clientSecret);

    // Build ISO 8601 start time in local time (Zoom accepts this format)
    const [h, m] = opts.startTime.split(":").map(Number);
    const startDateTime = `${opts.date}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00`;

    const body = {
      topic: opts.topic,
      type: 2, // Scheduled meeting
      start_time: startDateTime,
      duration: opts.durationMinutes,
      timezone: "America/Los_Angeles",
      settings: {
        host_video: true,
        participant_video: true,
        join_before_host: true,   // participant can join early
        waiting_room: false,
        auto_recording: "none",
      },
    };

    const meetingRes = await fetch("https://api.zoom.us/v2/users/me/meetings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!meetingRes.ok) {
      const err = await meetingRes.text();
      throw new Error(`Zoom meeting creation failed: ${err}`);
    }

    const meeting = await meetingRes.json() as { join_url: string; id: number };
    return { joinUrl: meeting.join_url, meetingId: String(meeting.id) };
  } catch (e) {
    console.error("[zoom] Failed to create meeting:", e);
    return null;
  }
}

// ── Test Zoom credentials ─────────────────────────────────────────────────────
export async function testZoomConnection(): Promise<{ ok: boolean; error?: string }> {
  try {
    const settings = storage.getZoomSettings();
    if (!settings?.accountId || !settings.clientId || !settings.clientSecret) {
      return { ok: false, error: "Credentials not configured" };
    }
    await getZoomToken(settings.accountId, settings.clientId, settings.clientSecret);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
