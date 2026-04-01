import type { Express } from "express";
import type { Server } from "http";
import jwt from "jsonwebtoken";
import zipcodes from "zipcodes";
import { format, parseISO } from "date-fns";
import Anthropic from "@anthropic-ai/sdk";
import PDFDocument from "pdfkit";
import { storage } from "./storage";
import { testEmailConnection, sendEmail, buildConfirmationEmail } from "./email";
import { createZoomMeeting, testZoomConnection } from "./zoom";
import { insertAvailabilityBlockSchema, insertParticipantSchema, insertTeacherSchema } from "@shared/schema";

const JWT_SECRET = "biblestudyspot-jwt-secret-2024";
const JWT_EXPIRES = "7d";
const SPOT_ADDRESS = "7412 Van Maren Ln, Citrus Heights, CA 95621";

// ── Fire confirmation email (+ Zoom meeting creation) when a participant is confirmed ──
async function maybeSendConfirmation(participantId: number) {
  try {
    const emailSettings = storage.getEmailSettings();
    if (!emailSettings?.remindersEnabled || !emailSettings.smtpUser || !emailSettings.smtpPass) return;

    const participant = storage.getAllParticipants().find(p => p.id === participantId);
    if (!participant) return;

    const session = storage.getSessionById(participant.sessionId);
    if (!session) return;

    const teacher = session.teacherId ? storage.getTeacher(session.teacherId) : null;
    const teacherName = teacher?.name ?? "your Bible study teacher";

    // ── If Zoom session and no link yet, create one now ───────────────────
    let zoomLink: string | undefined;
    if (participant.locationType === "zoom") {
      if (session.zoomMeetingUrl) {
        // Reuse existing meeting link (e.g. group session with multiple participants)
        zoomLink = session.zoomMeetingUrl;
      } else {
        // Calculate duration in minutes
        const [sh, sm] = session.startTime.split(":").map(Number);
        const [eh, em] = session.endTime.split(":").map(Number);
        const durationMins = (eh * 60 + em) - (sh * 60 + sm);
        const result = await createZoomMeeting({
          topic: `Bible Study — ${participant.question ?? "Open Conversation"}`,
          date: session.date,
          startTime: session.startTime,
          durationMinutes: durationMins,
        });
        if (result) {
          zoomLink = result.joinUrl;
          storage.setSessionZoomLink(session.id, result.joinUrl, result.meetingId);
          console.log(`[zoom] Created meeting ${result.meetingId} for session ${session.id}`);
        }
      }
    }

    const html = buildConfirmationEmail({
      name: participant.name,
      date: session.date,
      startTime: session.startTime,
      endTime: session.endTime,
      locationType: participant.locationType ?? "in-person",
      question: participant.question,
      teacherName,
      spotAddress: participant.locationType !== "zoom" ? SPOT_ADDRESS : undefined,
      zoomLink,
    });

    await sendEmail(
      participant.email,
      `Your Bible study session is confirmed ✨`,
      html
    );
  } catch (e) {
    console.error("[email] Failed to send confirmation:", e);
  }
}

function signToken(payload: object) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token: string): any {
  return jwt.verify(token, JWT_SECRET);
}

function getToken(req: any): string | null {
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAdmin(req: any, res: any, next: any) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    const payload = verifyToken(token);
    if (payload.role !== "admin") return res.status(403).json({ error: "Not authorized" });
    req.adminPayload = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireTeacher(req: any, res: any, next: any) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    const payload = verifyToken(token);
    if (payload.role !== "teacher") return res.status(403).json({ error: "Not authorized" });
    req.teacherPayload = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function requireAny(req: any, res: any, next: any) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    const payload = verifyToken(token);
    req.authPayload = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function registerRoutes(httpServer: Server, app: Express) {

  // ── Admin login ─────────────────────────────────────────────────────────────
  app.post("/api/auth/login", (req, res) => {
    const { username, password } = req.body;
    const user = storage.getUserByUsername(username);
    if (!user || user.password !== password) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = signToken({ role: "admin", id: user.id, username: user.username });
    res.json({ success: true, role: "admin", username: user.username, token });
  });

  // ── Teacher login ───────────────────────────────────────────────────────────
  app.post("/api/auth/teacher-login", (req, res) => {
    const { username, password } = req.body;
    const teacher = storage.getTeacherByUsername(username);
    if (!teacher || teacher.password !== password) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    if (!teacher.isActive) {
      return res.status(403).json({ error: "Account is inactive" });
    }
    const token = signToken({ role: "teacher", id: teacher.id, name: teacher.name });
    res.json({ success: true, role: "teacher", teacherId: teacher.id, name: teacher.name, token });
  });

  // ── Verify token (replaces /api/auth/me) ───────────────────────────────────
  app.get("/api/auth/me", requireAny, (req: any, res) => {
    const p = req.authPayload;
    if (p.role === "admin") return res.json({ role: "admin", username: p.username });
    if (p.role === "teacher") return res.json({ role: "teacher", teacherId: p.id, name: p.name });
    return res.status(401).json({ error: "Unknown role" });
  });

  // ── Public: zip code proximity check ────────────────────────────────────────
  // StudySpot location: 7412 Van Maren Ln, Citrus Heights CA 95621
  const SPOT_ZIP = "95621";
  const SPOT_LAT = 38.6952;
  const SPOT_LON = -121.3075;
  const MAX_MILES = 15;

  function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number) {
    const R = 3958.8;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  app.get("/api/public/check-zip", (req, res) => {
    const zip = String(req.query.zip || "").trim();
    if (!zip || !/^\d{5}$/.test(zip)) {
      return res.status(400).json({ error: "Please enter a valid 5-digit ZIP code" });
    }
    const loc = (zipcodes as any).lookup(zip);
    if (!loc) {
      return res.status(404).json({ error: "ZIP code not found. Please double-check and try again." });
    }
    const miles = haversineMiles(SPOT_LAT, SPOT_LON, loc.latitude, loc.longitude);
    const inRange = miles <= MAX_MILES;
    res.json({
      inRange,
      miles: Math.round(miles * 10) / 10,
      city: loc.city,
      state: loc.state,
    });
  });

  // Address only revealed after booking is confirmed
  app.get("/api/public/spot-address", (req, res) => {
    res.json({ address: "7412 Van Maren Ln, Citrus Heights, CA 95621" });
  });

  // ── Public ──────────────────────────────────────────────────────────────────
  app.get("/api/public/teachers", (req, res) => {
    const ts = storage.getPublicTeachers().map(({ password, ...t }) => t);
    res.json(ts);
  });

  app.get("/api/public/teachers/:id/blocks", (req, res) => {
    res.json(storage.getPublicBlocksForTeacher(parseInt(req.params.id)));
  });

  // ── Group sessions forming now ──────────────────────────────────────────────
  // Returns open group sessions that are joinable (within 30 min of start or currently running)
  // and have fewer than 50 participants.
  app.get("/api/public/group-sessions", (req, res) => {
    const MAX_GROUP_SIZE = 50;
    const JOIN_WINDOW_MINUTES = 30;

    const now = new Date();
    // Use America/Los_Angeles for date/time comparisons since blocks are set in Pacific time
    const pacificFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    const parts = pacificFormatter.formatToParts(now);
    const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const todayStr = `${p.year}-${p.month}-${p.day}`; // YYYY-MM-DD
    const nowMinutes = parseInt(p.hour) * 60 + parseInt(p.minute);

    // Get all open group sessions
    const allSessions = storage.getAllSessions().filter(
      s => s.sessionType === "group" && s.isOpen
    );

    const result = allSessions
      .filter(s => {
        // Must be today or in the future
        if (s.date < todayStr) return false;
        // For future dates, always show. For today, apply the 30-min cutoff.
        if (s.date > todayStr) return true;
        // Parse start/end times ("HH:MM" format)
        const [sh, sm] = s.startTime.split(":").map(Number);
        const [eh, em] = s.endTime.split(":").map(Number);
        const startMinutes = sh * 60 + sm;
        const endMinutes = eh * 60 + em;
        // Visible from now until 30 min before start time, then hidden
        return nowMinutes < startMinutes - JOIN_WINDOW_MINUTES;
      })
      .map(s => {
        const ps = storage.getParticipantsBySession(s.id)
          .filter(p => p.status !== "cancelled");
        const teacher = storage.getPublicTeachers().find(t => t.id === s.teacherId);
        // Sum group sizes so one booking of 5 counts as 5 spots used
        const totalPeople = ps.reduce((sum: number, p: any) => sum + (p.groupSize || 1), 0);
        return {
          id: s.id,
          date: s.date,
          startTime: s.startTime,
          endTime: s.endTime,
          teacherName: teacher ? teacher.name : "A teacher",
          teacherPhoto: teacher ? (teacher as any).photoUrl : null,
          participantCount: totalPeople,
          spotsLeft: Math.max(0, MAX_GROUP_SIZE - totalPeople),
          isFull: totalPeople >= MAX_GROUP_SIZE,
          blockId: s.blockId,
        };
      })
      .filter(s => !s.isFull);

    res.json(result);
  });

  app.post("/api/public/book", (req, res) => {
    const { blockId, startTime, endTime, sessionType, name, email, phone, question, locationType, groupSize, message } = req.body;
    if (!blockId || !startTime || !endTime || !sessionType || !name || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    if (!["one-on-one", "group"].includes(sessionType)) {
      return res.status(400).json({ error: "Invalid session type" });
    }
    const block = storage.getBlockById(blockId);
    if (!block || !block.isActive) return res.status(404).json({ error: "Block not found" });

    const blockSessions = storage.getSessionsByBlock(blockId);

    if (sessionType === "one-on-one") {
      const conflict = blockSessions.find(
        s => s.startTime === startTime && s.endTime === endTime && s.sessionType === "one-on-one"
      );
      if (conflict) return res.status(409).json({ error: "This time slot is already booked" });
      const session = storage.createSession({
        blockId, teacherId: block.teacherId, date: block.date,
        startTime, endTime, sessionType: "one-on-one", isOpen: false,
      });
      const participant = storage.addParticipant({ sessionId: session.id, name, email, phone, question, locationType: locationType || "in-person", groupSize: groupSize ?? null, message });
      // Notify the teacher
      if (block.teacherId) {
        storage.createNotification({ teacherId: block.teacherId, type: 'booking', title: `New booking: ${name}`, body: question ? `"${question.substring(0, 80)}"` : `${format(parseISO(block.date), 'MMM d')} · ${startTime}`, relatedId: session.id });
      }
      return res.status(201).json({ session, participant });
    }

    let groupSession = blockSessions.find(
      s => s.startTime === startTime && s.endTime === endTime && s.sessionType === "group" && s.isOpen
    );
    if (!groupSession) {
      groupSession = storage.createSession({
        blockId, teacherId: block.teacherId, date: block.date,
        startTime, endTime, sessionType: "group", isOpen: true,
      });
    }
    const participant = storage.addParticipant({ sessionId: groupSession.id, name, email, phone, question, locationType: locationType || "in-person", groupSize: groupSize ?? null, message });
    // Notify the teacher
    if (block.teacherId) {
      storage.createNotification({ teacherId: block.teacherId, type: 'booking', title: `New group booking: ${name}`, body: question ? `"${question.substring(0, 80)}"` : `${format(parseISO(block.date), 'MMM d')} · ${startTime}`, relatedId: groupSession.id });
    }
    return res.status(201).json({ session: groupSession, participant });
  });

  // ── Admin: teachers ─────────────────────────────────────────────────────────
  app.get("/api/admin/teachers", requireAdmin, (req, res) => {
    res.json(storage.getTeachers().map(({ password, ...t }) => t));
  });

  app.post("/api/admin/teachers", requireAdmin, (req, res) => {
    const parsed = insertTeacherSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    try {
      const { password, ...rest } = storage.createTeacher(parsed.data);
      res.status(201).json(rest);
    } catch (e: any) {
      if (e?.message?.includes("UNIQUE constraint")) {
        return res.status(409).json({ error: `The username "${req.body.username}" is already taken.` });
      }
      return res.status(500).json({ error: e?.message || "Failed to create teacher" });
    }
  });

  app.patch("/api/admin/teachers/:id", requireAdmin, (req, res) => {
    const t = storage.updateTeacher(parseInt(req.params.id), req.body);
    if (!t) return res.status(404).json({ error: "Not found" });
    const { password, ...rest } = t;
    res.json(rest);
  });

  // Admin: change teacher password
  app.patch("/api/admin/teachers/:id/password", requireAdmin, (req, res) => {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    const t = storage.updateTeacher(parseInt(req.params.id), { password });
    if (!t) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  });

  // Admin: get full teacher record (includes private fields)
  app.get("/api/admin/teachers/:id", requireAdmin, (req, res) => {
    const t = storage.getTeachers().find(t => t.id === parseInt(req.params.id));
    if (!t) return res.status(404).json({ error: "Not found" });
    const { password, ...rest } = t;
    res.json(rest);
  });

  app.delete("/api/admin/teachers/:id", requireAdmin, (req, res) => {
    storage.deleteTeacher(parseInt(req.params.id));
    res.json({ success: true });
  });

  // ── Admin: blocks ───────────────────────────────────────────────────────────
  app.get("/api/admin/blocks", requireAdmin, (req, res) => {
    res.json(storage.getBlocks());
  });

  app.post("/api/admin/blocks", requireAdmin, (req, res) => {
    const parsed = insertAvailabilityBlockSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.status(201).json(storage.createBlock(parsed.data));
  });

  app.patch("/api/admin/blocks/:id", requireAdmin, (req, res) => {
    const b = storage.updateBlock(parseInt(req.params.id), req.body);
    if (!b) return res.status(404).json({ error: "Not found" });
    res.json(b);
  });

  app.delete("/api/admin/blocks/:id", requireAdmin, (req, res) => {
    storage.deleteBlock(parseInt(req.params.id));
    res.json({ success: true });
  });

  // ── Admin: sessions ─────────────────────────────────────────────────────────
  app.get("/api/admin/sessions", requireAdmin, (req, res) => {
    const allSessions = storage.getAllSessions();
    const allBlocks = storage.getBlocks();
    const allTeachers = storage.getTeachers();
    res.json(allSessions.map(s => ({
      ...s,
      block: allBlocks.find(b => b.id === s.blockId),
      teacher: s.teacherId ? allTeachers.find(t => t.id === s.teacherId) : null,
      participants: storage.getParticipantsBySession(s.id),
    })));
  });

  app.delete("/api/admin/sessions/:id", requireAdmin, (req, res) => {
    storage.deleteSession(parseInt(req.params.id));
    res.json({ success: true });
  });

  app.patch("/api/admin/participants/:id/status", requireAdmin, async (req, res) => {
    const { status } = req.body;
    if (!["pending", "confirmed", "cancelled"].includes(status)) return res.status(400).json({ error: "Invalid status" });
    const p = storage.updateParticipantStatus(parseInt(req.params.id), status);
    if (!p) return res.status(404).json({ error: "Not found" });
    if (status === "confirmed") maybeSendConfirmation(p.id); // fire-and-forget
    res.json(p);
  });

  app.delete("/api/admin/participants/:id", requireAdmin, (req, res) => {
    storage.deleteParticipant(parseInt(req.params.id));
    res.json({ success: true });
  });

  // ── Teacher: own data ───────────────────────────────────────────────────────
  app.get("/api/teacher/blocks", requireTeacher, (req: any, res) => {
    res.json(storage.getBlocksByTeacher(req.teacherPayload.id));
  });

  app.post("/api/teacher/blocks", requireTeacher, (req: any, res) => {
    const parsed = insertAvailabilityBlockSchema.safeParse({ ...req.body, teacherId: req.teacherPayload.id });
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    res.status(201).json(storage.createBlock(parsed.data));
  });

  app.patch("/api/teacher/blocks/:id", requireTeacher, (req: any, res) => {
    const block = storage.getBlockById(parseInt(req.params.id));
    if (!block || block.teacherId !== req.teacherPayload.id) return res.status(403).json({ error: "Not your block" });
    res.json(storage.updateBlock(parseInt(req.params.id), req.body));
  });

  app.delete("/api/teacher/blocks/:id", requireTeacher, (req: any, res) => {
    const block = storage.getBlockById(parseInt(req.params.id));
    if (!block || block.teacherId !== req.teacherPayload.id) return res.status(403).json({ error: "Not your block" });
    storage.deleteBlock(parseInt(req.params.id));
    res.json({ success: true });
  });

  // ── Bulk block creation ─────────────────────────────────────────────────
  // Body: { daysOfWeek: number[], fromDate: string, toDate: string,
  //         startTime: string, endTime: string, slotDuration: number, note?: string }
  // daysOfWeek: 0=Sun, 1=Mon ... 6=Sat
  app.post("/api/teacher/blocks/bulk", requireTeacher, (req: any, res) => {
    const { daysOfWeek, fromDate, toDate, startTime, endTime, slotDuration, note } = req.body;
    if (!Array.isArray(daysOfWeek) || !fromDate || !toDate || !startTime || !endTime || !slotDuration) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const teacherId = req.teacherPayload.id;
    const created: any[] = [];
    const current = new Date(fromDate + "T12:00:00"); // noon to avoid DST edge cases
    const end = new Date(toDate + "T12:00:00");
    while (current <= end) {
      if (daysOfWeek.includes(current.getDay())) {
        const dateStr = current.toISOString().split("T")[0];
        try {
          const block = storage.createBlock({
            teacherId, date: dateStr, startTime, endTime,
            slotDuration: parseInt(slotDuration), isActive: true, note: note || "",
          });
          created.push(block);
        } catch {}
      }
      current.setDate(current.getDate() + 1);
    }
    res.status(201).json({ created: created.length, blocks: created });
  });

  app.get("/api/teacher/sessions", requireTeacher, (req: any, res) => {
    const mySessions = storage.getSessionsByTeacher(req.teacherPayload.id);
    const myBlocks = storage.getBlocksByTeacher(req.teacherPayload.id);
    res.json(mySessions.map(s => ({
      ...s,
      block: myBlocks.find(b => b.id === s.blockId),
      participants: storage.getParticipantsBySession(s.id),
    })));
  });

  app.patch("/api/teacher/participants/:id/status", requireTeacher, async (req: any, res) => {
    const { status } = req.body;
    if (!["pending", "confirmed", "cancelled"].includes(status)) return res.status(400).json({ error: "Invalid status" });
    const p = storage.updateParticipantStatus(parseInt(req.params.id), status);
    if (!p) return res.status(404).json({ error: "Not found" });
    if (status === "confirmed") maybeSendConfirmation(p.id); // fire-and-forget
    res.json(p);
  });

  app.delete("/api/teacher/sessions/:id", requireTeacher, (req: any, res) => {
    const session = storage.getSessionById(parseInt(req.params.id));
    if (!session || session.teacherId !== req.teacherPayload.id) return res.status(403).json({ error: "Not your session" });
    storage.deleteSession(parseInt(req.params.id));
    res.json({ success: true });
  });

  app.patch("/api/teacher/profile", requireTeacher, (req: any, res) => {
    const { bio, photoUrl, name } = req.body;
    const t = storage.updateTeacher(req.teacherPayload.id, { bio, photoUrl, name });
    if (!t) return res.status(404).json({ error: "Not found" });
    const { password, ...rest } = t;
    res.json(rest);
  });

  // ── Resources ─────────────────────────────────────────────────────────────────

  // GET all resources (shared + BSS-specific) — teachers and admin
  app.get("/api/resources", (req, res) => {
    const shared = storage.getSharedResources();
    const bss = storage.getBSSResources();
    // Strip file data from list response for performance; download endpoint provides full data
    const strip = (r: any) => ({ ...r, fileData: r.fileData ? "[file]" : null });
    res.json({ shared: shared.map(strip), bss: bss.map(strip) });
  });

  // GET single resource with full file data (for download)
  app.get("/api/resources/:id/download", (req, res) => {
    const r = storage.getResourceById(parseInt(req.params.id));
    if (!r) return res.status(404).json({ error: "Not found" });
    res.json(r);
  });

  // GET lessons for a series
  app.get("/api/resources/:id/lessons", (req, res) => {
    const lessons = storage.getLessonsBySeries(parseInt(req.params.id));
    // Strip file data for list — download endpoint has full data
    res.json(lessons.map((l: any) => ({ ...l, fileData: l.fileData ? "[file]" : null })));
  });

  // Admin: upload single lesson
  app.post("/api/admin/resources", requireAdmin, (req, res) => {
    const { title, description, category, fileType, fileData, videoUrl, fileName, isShared } = req.body;
    if (!title || !category || !fileType) return res.status(400).json({ error: "Missing required fields" });
    if (fileType !== "video" && !fileData) return res.status(400).json({ error: "File data required" });
    if (fileType === "video" && !videoUrl) return res.status(400).json({ error: "Video URL required" });
    const r = storage.createResource({ title, description, category, resourceType: "lesson", fileType, fileData: fileData || null, videoUrl: videoUrl || null, fileName: fileName || null, isShared: isShared ?? false, uploadedByTeacherId: null, seriesId: null, lessonOrder: null });
    res.status(201).json(r);
  });

  // Admin: upload series with lessons
  app.post("/api/admin/resources/series", requireAdmin, (req, res) => {
    const { title, description, category, isShared, lessons } = req.body;
    if (!title || !category || !Array.isArray(lessons) || lessons.length === 0)
      return res.status(400).json({ error: "Missing required fields" });
    const seriesData = { title, description, category, resourceType: "series" as const, fileType: null, fileData: null, videoUrl: null, fileName: null, isShared: isShared ?? false, uploadedByTeacherId: null, seriesId: null, lessonOrder: null };
    const series = storage.createSeries(seriesData, lessons);
    res.status(201).json(series);
  });

  // Admin: delete any resource (or series + its lessons)
  app.delete("/api/admin/resources/:id", requireAdmin, (req, res) => {
    const r = storage.getResourceById(parseInt(req.params.id));
    if (!r) return res.status(404).json({ error: "Not found" });
    if (r.resourceType === "series") {
      storage.deleteSeriesWithLessons(parseInt(req.params.id));
    } else {
      storage.deleteResource(parseInt(req.params.id));
    }
    res.json({ success: true });
  });

  // Teacher: upload single lesson
  app.post("/api/teacher/resources", requireTeacher, (req: any, res) => {
    const { title, description, category, fileType, fileData, videoUrl, fileName } = req.body;
    if (!title || !category || !fileType) return res.status(400).json({ error: "Missing required fields" });
    if (fileType !== "video" && !fileData) return res.status(400).json({ error: "File data required" });
    if (fileType === "video" && !videoUrl) return res.status(400).json({ error: "Video URL required" });
    const r = storage.createResource({ title, description, category, resourceType: "lesson", fileType, fileData: fileData || null, videoUrl: videoUrl || null, fileName: fileName || null, isShared: false, uploadedByTeacherId: req.teacherPayload.id, seriesId: null, lessonOrder: null });
    res.status(201).json(r);
  });

  // Teacher: upload series with lessons
  app.post("/api/teacher/resources/series", requireTeacher, (req: any, res) => {
    const { title, description, category, lessons } = req.body;
    if (!title || !category || !Array.isArray(lessons) || lessons.length === 0)
      return res.status(400).json({ error: "Missing required fields" });
    const seriesData = { title, description, category, resourceType: "series" as const, fileType: null, fileData: null, videoUrl: null, fileName: null, isShared: false, uploadedByTeacherId: req.teacherPayload.id, seriesId: null, lessonOrder: null };
    const series = storage.createSeries(seriesData, lessons);
    res.status(201).json(series);
  });

  // Teacher: delete own uploaded resource or series
  app.delete("/api/teacher/resources/:id", requireTeacher, (req: any, res) => {
    const r = storage.getResourceById(parseInt(req.params.id));
    if (!r) return res.status(404).json({ error: "Not found" });
    if (r.uploadedByTeacherId !== req.teacherPayload.id) return res.status(403).json({ error: "Not authorized" });
    if (r.resourceType === "series") {
      storage.deleteSeriesWithLessons(parseInt(req.params.id));
    } else {
      storage.deleteResource(parseInt(req.params.id));
    }
    res.json({ success: true });
  });

  // ── Notifications ────────────────────────────────────────────────────────────
  app.get("/api/teacher/notifications", requireTeacher, (req: any, res) => {
    const notifs = storage.getNotificationsForTeacher(req.teacherPayload.id);
    const unread = storage.getUnreadCountForTeacher(req.teacherPayload.id);
    res.json({ notifications: notifs, unreadCount: unread });
  });

  app.patch("/api/teacher/notifications/:id/read", requireTeacher, (req: any, res) => {
    storage.markNotificationRead(parseInt(req.params.id));
    res.json({ success: true });
  });

  app.patch("/api/teacher/notifications/read-all", requireTeacher, (req: any, res) => {
    storage.markAllNotificationsRead(req.teacherPayload.id);
    res.json({ success: true });
  });

  // ── Messages (Teacher) ────────────────────────────────────────────────────
  app.get("/api/teacher/conversations", requireTeacher, (req: any, res) => {
    const convos = storage.getConversationsForTeacher(req.teacherPayload.id);
    const unread = storage.getUnreadMessageCount('teacher', req.teacherPayload.id);
    res.json({ conversations: convos, unreadCount: unread });
  });

  app.get("/api/teacher/messages/:partnerType/:partnerId", requireTeacher, (req: any, res) => {
    const { partnerType, partnerId } = req.params;
    const pid = partnerId === 'null' ? null : parseInt(partnerId);
    const msgs = storage.getConversation('teacher', req.teacherPayload.id, partnerType, pid);
    // Mark as read
    storage.markMessagesRead('teacher', req.teacherPayload.id, partnerType, pid);
    res.json(msgs);
  });

  app.delete("/api/teacher/conversations/:partnerType/:partnerId", requireTeacher, (req: any, res) => {
    const { partnerType, partnerId } = req.params;
    const pid = partnerId === 'null' ? null : parseInt(partnerId);
    storage.deleteConversation('teacher', req.teacherPayload.id, partnerType, pid);
    res.json({ success: true });
  });

  app.post("/api/teacher/messages", requireTeacher, (req: any, res) => {
    const { recipientType, recipientId, body } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: "Message body required" });
    const rid = recipientId === null || recipientId === 'null' ? null : parseInt(recipientId);
    const msg = storage.sendMessage({ senderType: 'teacher', senderId: req.teacherPayload.id, recipientType, recipientId: rid, body });
    // If messaging admin, create a notification for admin (stored as teacher notification for now)
    // If messaging another teacher, notify them
    if (recipientType === 'teacher' && rid !== null) {
      storage.createNotification({ teacherId: rid, type: 'message', title: `New message from ${req.teacherPayload.name}`, body: body.substring(0, 100), relatedId: msg.id });
    }
    res.status(201).json(msg);
  });

  // ── Messages (Admin) ──────────────────────────────────────────────────────
  app.get("/api/admin/conversations", requireAdmin, (req, res) => {
    const convos = storage.getConversationsForAdmin();
    const unread = storage.getUnreadMessageCount('admin', null);
    res.json({ conversations: convos, unreadCount: unread });
  });

  app.get("/api/admin/messages/:teacherId", requireAdmin, (req, res) => {
    const teacherId = parseInt(req.params.teacherId);
    const msgs = storage.getConversation('admin', null, 'teacher', teacherId);
    storage.markMessagesRead('admin', null, 'teacher', teacherId);
    res.json(msgs);
  });

  app.delete("/api/admin/conversations/:teacherId", requireAdmin, (req, res) => {
    storage.deleteConversation('admin', null, 'teacher', parseInt(req.params.teacherId));
    res.json({ success: true });
  });

  app.post("/api/admin/messages", requireAdmin, (req, res) => {
    const { recipientId, body } = req.body;
    if (!body?.trim() || !recipientId) return res.status(400).json({ error: "Missing fields" });
    const msg = storage.sendMessage({ senderType: 'admin', senderId: null, recipientType: 'teacher', recipientId: parseInt(recipientId), body });
    // Notify the teacher
    storage.createNotification({ teacherId: parseInt(recipientId), type: 'message', title: 'New message from Admin', body: body.substring(0, 100), relatedId: msg.id });
    res.status(201).json(msg);
  });

  // ── Zoom Settings (admin only) ──────────────────────────────────────────
  app.get("/api/admin/zoom-settings", requireAdmin, (_req, res) => {
    const s = storage.getZoomSettings();
    if (s) res.json({ ...s, clientSecret: s.clientSecret ? '••••••••' : '' });
    else res.json(null);
  });

  app.post("/api/admin/zoom-settings", requireAdmin, (req, res) => {
    const { accountId, clientId, clientSecret, enabled } = req.body;
    const existing = storage.getZoomSettings();
    const secret = clientSecret && clientSecret !== '••••••••' ? clientSecret : (existing?.clientSecret ?? '');
    const updated = storage.saveZoomSettings({ accountId, clientId, clientSecret: secret, enabled: !!enabled });
    res.json({ ok: true, settings: updated });
  });

  app.post("/api/admin/zoom-test", requireAdmin, async (_req, res) => {
    const result = await testZoomConnection();
    res.json(result);
  });

  // ── Email Settings (admin only) ──────────────────────────────────────────
  app.get("/api/admin/email-settings", requireAdmin, (_req, res) => {
    const s = storage.getEmailSettings();
    // Never send the raw password back to the client
    if (s) res.json({ ...s, smtpPass: s.smtpPass ? '••••••••' : '' });
    else res.json(null);
  });

  app.post("/api/admin/email-settings", requireAdmin, (req, res) => {
    const { smtpHost, smtpPort, smtpUser, smtpPass, fromName, remindersEnabled } = req.body;
    const existing = storage.getEmailSettings();
    // Only update password if a real value was sent (not the masked placeholder)
    const pass = smtpPass && smtpPass !== '••••••••' ? smtpPass : (existing?.smtpPass ?? '');
    const updated = storage.saveEmailSettings({
      smtpHost: smtpHost ?? 'smtp.gmail.com',
      smtpPort: parseInt(smtpPort) || 587,
      smtpUser: smtpUser ?? '',
      smtpPass: pass,
      fromName: fromName ?? 'BibleStudySpot',
      remindersEnabled: !!remindersEnabled,
    });
    res.json({ ok: true, settings: updated });
  });

  app.post("/api/admin/email-test", requireAdmin, async (_req, res) => {
    const result = await testEmailConnection();
    res.json(result);
  });

  app.post("/api/admin/email-send-test", requireAdmin, async (_req, res) => {
    const settings = storage.getEmailSettings();
    if (!settings?.smtpUser) return res.status(400).json({ error: "No email configured" });
    const { sendEmail, build24HourEmail, build1HourEmail } = await import("./email");
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split("T")[0];
    const html24 = build24HourEmail({
      name: "Russell",
      date: dateStr,
      startTime: "14:00",
      endTime: "15:00",
      locationType: "in-person",
      question: "If God is good, why is there so much suffering in the world?",
      teacherName: "Russell Champlain",
      spotAddress: "7412 Van Maren Ln, Citrus Heights, CA 95621",
    });
    const html1 = build1HourEmail({
      name: "Russell",
      date: dateStr,
      startTime: "14:00",
      endTime: "15:00",
      locationType: "in-person",
      question: "If God is good, why is there so much suffering in the world?",
      teacherName: "Russell Champlain",
      spotAddress: "7412 Van Maren Ln, Citrus Heights, CA 95621",
    });
    // Send test to the admin email stored in smtpUser field
    const testTo = settings.smtpUser || "18russjames@gmail.com";
    const ok24 = await sendEmail(testTo, "[TEST] 24-hour reminder sample ✦", html24);
    const ok1  = await sendEmail(testTo, "[TEST] 1-hour reminder sample ✦", html1);
    if (ok24 && ok1) res.json({ ok: true });
    else res.status(500).json({ error: "Failed to send — check your credentials" });
  });

  // ── AI Bible Study Generator ───────────────────────────────────────────────
  // Streams a Bible study via SSE. Works for both admin and teacher (just requires any valid JWT).
  app.post("/api/generate-bible-study", async (req, res) => {
    // Validate auth (admin or teacher token)
    const authHeader = req.headers["authorization"];
    if (!authHeader) return res.status(401).json({ error: "Not authorized" });
    try {
      jwt.verify(authHeader.replace("Bearer ", ""), JWT_SECRET);
    } catch {
      return res.status(401).json({ error: "Not authorized" });
    }

    const { title, topic, category, audience, numLessons, depth } = req.body;
    if (!title || !topic) return res.status(400).json({ error: "Title and topic required" });

    const audienceMap: Record<string, string> = {
      seeker: "spiritual seekers or people new to Christianity with little Bible knowledge",
      newbeliever: "new believers in the first year of their faith",
      growing: "growing Christians with some biblical foundation",
      mature: "mature Christians with solid biblical knowledge",
    };
    const depthMap: Record<string, string> = {
      light: "concise (1-2 paragraphs per section), accessible, conversational",
      medium: "moderate depth (2-3 paragraphs per section) with good scriptural grounding",
      deep: "in-depth (3-4 paragraphs per section) with thorough exposition and cross-references",
    };

    const lessons = parseInt(numLessons) || 4;
    const audienceDesc = audienceMap[audience] || audienceMap.growing;
    const depthDesc = depthMap[depth] || depthMap.medium;

    const prompt = `You are an experienced Bible teacher and pastor. Write a complete, ready-to-teach Bible study series.

Series Title: "${title}"
Topic/Theme: ${topic}
Category: ${category}
Target Audience: ${audienceDesc}
Number of Lessons: ${lessons}
Depth: ${depthDesc}

Format the output EXACTLY as follows (use these exact markdown headers):

# ${title}

## Series Overview
[2-3 sentences describing the purpose and heart of this series]

## Series Goals
- [Goal 1]
- [Goal 2]
- [Goal 3]

---

${Array.from({ length: lessons }, (_, i) => `## Lesson ${i + 1}: [Lesson Title]

### Key Scripture
[Primary scripture passage with full text]

### Introduction
[Opening hook — a question, story, or observation that draws people in]

### Main Teaching
[Core content of the lesson — expository, clear, biblical]

### Supporting Scriptures
- [Reference]: [Key point it supports]
- [Reference]: [Key point it supports]
- [Reference]: [Key point it supports]

### Discussion Questions
1. [Question that opens up personal reflection]
2. [Question that digs into the text]
3. [Question that applies the truth to daily life]
4. [Question for those who are skeptical or new]

### Application
[1-2 concrete, specific ways participants can apply this lesson this week]

### Closing Prayer Points
- [Prayer point 1]
- [Prayer point 2]`).join('\n\n---\n\n')}

---

## Leader Notes
[2-3 paragraphs of practical advice for the teacher — what to emphasize, common questions, how to handle skeptics, pastoral sensitivity]

Write with warmth, theological depth appropriate for the audience, and pastoral sensitivity. Use modern, clear English. Scripture quotes should be from ESV or NIV.`;

    // Set up SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.flushHeaders();

    const client = new Anthropic();

    try {
      const stream = client.messages.stream({
        model: "claude_sonnet_4_6",
        max_tokens: 6000,
        messages: [{ role: "user", content: prompt }],
      });

      for await (const chunk of stream) {
        if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
          const text = chunk.delta.text;
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        }
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (e: any) {
      res.write(`data: ${JSON.stringify({ error: e.message || "Generation failed" })}\n\n`);
      res.end();
    }
  });

  // ── Markdown → PDF conversion ─────────────────────────────────────────────
  // Accepts { markdown, title } and returns base64-encoded PDF
  app.post("/api/markdown-to-pdf", (req: any, res) => {
    // Auth check (admin or teacher token)
    const authHeader = req.headers["authorization"];
    if (!authHeader) return res.status(401).json({ error: "Not authorized" });

    const { markdown, title } = req.body;
    if (!markdown) return res.status(400).json({ error: "Missing markdown" });

    try {
      const doc = new PDFDocument({ margin: 60, size: "LETTER" });
      const buffers: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => buffers.push(chunk));
      doc.on("end", () => {
        const pdfBuffer = Buffer.concat(buffers);
        const base64 = pdfBuffer.toString("base64");
        res.json({ base64 });
      });

      // ── Fonts & colours ────────────────────────────────────────────────────
      const ACCENT   = "#7C4A1E"; // warm brown
      const HEADING1 = "#3B2A1A";
      const HEADING2 = "#5C3A1E";
      const HEADING3 = "#7C4A1E";
      const BODY     = "#1A1209";
      const RULE_COLOR = "#C8A97A";

      const pageWidth = doc.page.width - 120; // margins

      // Cover title
      if (title) {
        doc.fontSize(26).fillColor(ACCENT).font("Helvetica-Bold").text(title, { align: "center" });
        doc.moveDown(0.4);
        doc.moveTo(60, doc.y).lineTo(doc.page.width - 60, doc.y).strokeColor(RULE_COLOR).lineWidth(1.5).stroke();
        doc.moveDown(0.8);
      }

      // Parse markdown line-by-line
      const lines = markdown.split("\n");
      let inList = false;

      for (const raw of lines) {
        const line = raw;

        // H1
        if (line.startsWith("# ")) {
          if (inList) { doc.moveDown(0.3); inList = false; }
          doc.moveDown(0.6);
          doc.moveTo(60, doc.y).lineTo(doc.page.width - 60, doc.y).strokeColor(RULE_COLOR).lineWidth(1).stroke();
          doc.moveDown(0.3);
          doc.fontSize(18).fillColor(HEADING1).font("Helvetica-Bold")
            .text(line.slice(2).trim(), { continued: false });
          doc.moveDown(0.2);
          continue;
        }

        // H2
        if (line.startsWith("## ")) {
          if (inList) { doc.moveDown(0.3); inList = false; }
          doc.moveDown(0.5);
          doc.fontSize(14).fillColor(HEADING2).font("Helvetica-Bold")
            .text(line.slice(3).trim(), { continued: false });
          doc.moveDown(0.15);
          continue;
        }

        // H3
        if (line.startsWith("### ")) {
          if (inList) { doc.moveDown(0.3); inList = false; }
          doc.moveDown(0.35);
          doc.fontSize(12).fillColor(HEADING3).font("Helvetica-Bold")
            .text(line.slice(4).trim(), { continued: false });
          doc.moveDown(0.1);
          continue;
        }

        // H4 / H5 / H6
        if (line.startsWith("#### ") || line.startsWith("##### ") || line.startsWith("###### ")) {
          if (inList) { doc.moveDown(0.3); inList = false; }
          doc.moveDown(0.3);
          const text = line.replace(/^#{4,6}\s+/, "").trim();
          doc.fontSize(11).fillColor(HEADING3).font("Helvetica-Bold").text(text);
          doc.moveDown(0.1);
          continue;
        }

        // Horizontal rule
        if (/^[-*_]{3,}$/.test(line.trim())) {
          doc.moveDown(0.3);
          doc.moveTo(60, doc.y).lineTo(doc.page.width - 60, doc.y).strokeColor(RULE_COLOR).lineWidth(0.75).stroke();
          doc.moveDown(0.3);
          continue;
        }

        // Bullet list item
        if (/^[\s]*[-*+] /.test(line)) {
          inList = true;
          const indent = (line.match(/^(\s*)/) || ["",""])[1].length;
          const text = line.replace(/^\s*[-*+]\s+/, "").trim();
          const x = 60 + Math.min(indent, 3) * 12;
          doc.fontSize(10.5).fillColor(BODY).font("Helvetica")
            .text(`• ${renderInline(text)}`, x, doc.y, { width: pageWidth - Math.min(indent,3)*12, lineGap: 2 });
          continue;
        }

        // Numbered list
        if (/^\s*\d+\.\s/.test(line)) {
          inList = true;
          const num = (line.match(/^\s*(\d+)\./) || ["","1"])[1];
          const text = line.replace(/^\s*\d+\.\s+/, "").trim();
          doc.fontSize(10.5).fillColor(BODY).font("Helvetica")
            .text(`${num}. ${renderInline(text)}`, 72, doc.y, { width: pageWidth - 12, lineGap: 2 });
          continue;
        }

        // Blank line
        if (line.trim() === "") {
          if (inList) inList = false;
          doc.moveDown(0.35);
          continue;
        }

        // Bold-only line (e.g. **Scripture:**)
        if (/^\*\*.*\*\*$/.test(line.trim())) {
          if (inList) { doc.moveDown(0.2); inList = false; }
          const text = line.trim().replace(/^\*\*|\*\*$/g, "");
          doc.fontSize(10.5).fillColor(BODY).font("Helvetica-Bold").text(text, { lineGap: 2 });
          continue;
        }

        // Regular paragraph
        if (inList) { doc.moveDown(0.2); inList = false; }
        doc.fontSize(10.5).fillColor(BODY).font("Helvetica")
          .text(renderInline(line.trim()), { lineGap: 3, paragraphGap: 2 });
      }

      doc.end();
    } catch (e: any) {
      res.status(500).json({ error: e.message || "PDF generation failed" });
    }
  });
}

// Strip inline markdown (bold, italic, code) to plain text for pdfkit
function renderInline(text: string): string {
  return text
    .replace(/\*\*\*(.*?)\*\*\*/g, "$1")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`(.*?)`/g, "$1")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1");
}
