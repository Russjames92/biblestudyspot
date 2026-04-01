import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, sql, isNull } from "drizzle-orm";
import {
  users, teachers, availabilityBlocks, sessions, participants, resources, notifications, messages, emailSettings, zoomSettings,
  type User, type InsertUser,
  type Teacher, type InsertTeacher,
  type AvailabilityBlock, type InsertAvailabilityBlock,
  type Session, type InsertSession,
  type Participant, type InsertParticipant,
  type Resource, type InsertResource,
  type Notification, type Message, type EmailSetting, type ZoomSetting,
} from "@shared/schema";

import path from "path";
// Use RAILWAY_VOLUME_MOUNT_PATH if on Railway (persistent disk), otherwise local
const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "biblestudyspot.db")
  : "biblestudyspot.db";
const sqlite = new Database(DB_PATH);
export const db = drizzle(sqlite);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS teachers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    bio TEXT,
    photo_url TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS availability_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    slot_duration INTEGER NOT NULL DEFAULT 60,
    is_active INTEGER NOT NULL DEFAULT 1,
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    block_id INTEGER NOT NULL,
    teacher_id INTEGER,
    date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    session_type TEXT NOT NULL,
    is_open INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    message TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  );
`);

// ── Run all migrations (ALTER TABLE IF NOT EXISTS equivalent via try/catch) ────
const migrations = [
  // Teachers extended fields
  `ALTER TABLE teachers ADD COLUMN first_name TEXT`,
  `ALTER TABLE teachers ADD COLUMN last_name TEXT`,
  `ALTER TABLE teachers ADD COLUMN email TEXT`,
  `ALTER TABLE teachers ADD COLUMN phone TEXT`,
  `ALTER TABLE teachers ADD COLUMN address TEXT`,
  `ALTER TABLE teachers ADD COLUMN city TEXT`,
  `ALTER TABLE teachers ADD COLUMN state TEXT`,
  `ALTER TABLE teachers ADD COLUMN zip TEXT`,
  `ALTER TABLE teachers ADD COLUMN date_of_birth TEXT`,
  `ALTER TABLE teachers ADD COLUMN emergency_contact TEXT`,
  `ALTER TABLE teachers ADD COLUMN emergency_phone TEXT`,
  `ALTER TABLE teachers ADD COLUMN notes TEXT`,
  `ALTER TABLE teachers ADD COLUMN date_joined TEXT`,
  // Sessions zoom fields
  `ALTER TABLE sessions ADD COLUMN zoom_meeting_url TEXT`,
  `ALTER TABLE sessions ADD COLUMN zoom_meeting_id TEXT`,
  // Participants extended fields
  `ALTER TABLE participants ADD COLUMN question TEXT`,
  `ALTER TABLE participants ADD COLUMN location_type TEXT`,
  `ALTER TABLE participants ADD COLUMN group_size INTEGER`,
  `ALTER TABLE participants ADD COLUMN reminder_24_sent INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE participants ADD COLUMN reminder_1_sent INTEGER NOT NULL DEFAULT 0`,
  // Notifications table
  `CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    related_id INTEGER,
    created_at TEXT NOT NULL
  )`,
  // Messages table
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_type TEXT NOT NULL,
    sender_id INTEGER,
    recipient_type TEXT NOT NULL,
    recipient_id INTEGER,
    body TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  // Resources table
  `CREATE TABLE IF NOT EXISTS resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL,
    resource_type TEXT NOT NULL DEFAULT 'lesson',
    series_id INTEGER,
    lesson_order INTEGER,
    file_type TEXT,
    file_data TEXT,
    video_url TEXT,
    file_name TEXT,
    is_shared INTEGER NOT NULL DEFAULT 0,
    uploaded_by_teacher_id INTEGER,
    created_at TEXT NOT NULL
  )`,
  // Email settings table
  `CREATE TABLE IF NOT EXISTS email_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    smtp_host TEXT NOT NULL DEFAULT 'smtp.gmail.com',
    smtp_port INTEGER NOT NULL DEFAULT 587,
    smtp_user TEXT NOT NULL DEFAULT '',
    smtp_pass TEXT NOT NULL DEFAULT '',
    from_name TEXT NOT NULL DEFAULT 'BibleStudySpot',
    reminders_enabled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  // Zoom settings table
  `CREATE TABLE IF NOT EXISTS zoom_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL DEFAULT '',
    client_id TEXT NOT NULL DEFAULT '',
    client_secret TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
];

for (const migration of migrations) {
  try { sqlite.exec(migration); } catch (_) { /* column/table already exists */ }
}

// Seed email_settings default row
const existingEmailSettings = sqlite.prepare('SELECT id FROM email_settings LIMIT 1').get();
if (!existingEmailSettings) {
  sqlite.prepare('INSERT INTO email_settings (smtp_host, smtp_port, smtp_user, smtp_pass, from_name, reminders_enabled, updated_at) VALUES (?,?,?,?,?,?,?)').run('smtp.gmail.com', 587, '', '', 'BibleStudySpot', 0, new Date().toISOString());
}

// Seed zoom_settings default row
const existingZoomSettings = sqlite.prepare('SELECT id FROM zoom_settings LIMIT 1').get();
if (!existingZoomSettings) {
  sqlite.prepare('INSERT INTO zoom_settings (account_id, client_id, client_secret, enabled, updated_at) VALUES (?,?,?,?,?)').run('', '', '', 0, new Date().toISOString());
}

// Seed admin
const existingAdmin = db.select().from(users).get();
if (!existingAdmin) {
  db.insert(users).values({ username: "admin", password: "biblestudyspot2024" }).run();
}

// ── Slot generator ────────────────────────────────────────────────────────────
export function generateSlots(startTime: string, endTime: string, duration: number) {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;
  const slots: { start: string; end: string }[] = [];
  for (let t = startMins; t + duration <= endMins; t += duration) {
    const s = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
    const e = `${String(Math.floor((t + duration) / 60)).padStart(2, "0")}:${String((t + duration) % 60).padStart(2, "0")}`;
    slots.push({ start: s, end: e });
  }
  return slots;
}

// ── Public slot resolver ──────────────────────────────────────────────────────
export function resolvePublicBlocks(
  rawBlocks: AvailabilityBlock[],
  allSessions: Session[],
  allParticipants: Participant[]
) {
  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];

  // All future active blocks (not yet expired today)
  const futureBlocks = rawBlocks.filter(b => {
    if (!b.isActive) return false;
    if (b.date < todayStr) return false;
    if (b.date === todayStr) {
      const [h, m] = b.endTime.split(":").map(Number);
      const blockEnd = new Date();
      blockEnd.setHours(h, m, 0, 0);
      if (blockEnd <= now) return false;
    }
    return true;
  });

  // Default window: today → +7 days
  let windowStartStr = todayStr;
  let windowEnd = new Date(now);
  windowEnd.setDate(windowEnd.getDate() + 7);
  let windowEndStr = windowEnd.toISOString().split("T")[0];

  // Check if any blocks fall in the default window
  const hasBlocksInDefault = futureBlocks.some(b => b.date <= windowEndStr);

  // If nothing in the default window, jump to the nearest future block date
  if (!hasBlocksInDefault && futureBlocks.length > 0) {
    const nearest = futureBlocks.slice().sort((a, b) => a.date.localeCompare(b.date))[0];
    windowStartStr = nearest.date;
    const ws = new Date(nearest.date + "T12:00:00");
    ws.setDate(ws.getDate() + 7);
    windowEndStr = ws.toISOString().split("T")[0];
  }

  return futureBlocks
    .filter(b => {
      if (b.date < windowStartStr) return false;
      if (b.date > windowEndStr) return false;
      return true;
    })
    .map(block => {
      const rawSlots = generateSlots(block.startTime, block.endTime, block.slotDuration);
      const blockSessions = allSessions.filter(s => s.blockId === block.id);

      const slots = rawSlots.map(slot => {
        if (block.date === todayStr) {
          const [h, m] = slot.start.split(":").map(Number);
          const slotTime = new Date();
          slotTime.setHours(h, m, 0, 0);
          if (slotTime <= now) return null;
        }
        const occupying = blockSessions.filter(s => s.startTime === slot.start && s.endTime === slot.end);
        const oneOnOne = occupying.find(s => s.sessionType === "one-on-one");
        if (oneOnOne) {
          const parts = allParticipants.filter(p => p.sessionId === oneOnOne.id && p.status !== "cancelled");
          if (parts.length > 0) return null;
        }
        const groupSession = occupying.find(s => s.sessionType === "group" && s.isOpen) || null;
        return { start: slot.start, end: slot.end, takenByOneOnOne: false, groupSession };
      }).filter(Boolean) as { start: string; end: string; takenByOneOnOne: boolean; groupSession: Session | null }[];

      return { ...block, slots };
    })
    .filter(b => b.slots.length > 0);
}

export interface IStorage {
  // Auth
  getUserByUsername(username: string): User | undefined;
  getTeacherByUsername(username: string): Teacher | undefined;
  getTeacherById(id: number): Teacher | undefined;

  // Teachers (admin manages)
  getTeachers(): Teacher[];
  createTeacher(t: InsertTeacher): Teacher;
  updateTeacher(id: number, updates: Partial<InsertTeacher>): Teacher | undefined;
  deleteTeacher(id: number): void;

  // Blocks
  getBlocks(): AvailabilityBlock[];
  getBlocksByTeacher(teacherId: number | null): AvailabilityBlock[];
  getBlockById(id: number): AvailabilityBlock | undefined;
  createBlock(block: InsertAvailabilityBlock): AvailabilityBlock;
  updateBlock(id: number, updates: Partial<InsertAvailabilityBlock>): AvailabilityBlock | undefined;
  deleteBlock(id: number): void;

  // Sessions
  getAllSessions(): Session[];
  getSessionsByTeacher(teacherId: number | null): Session[];
  getSessionsByBlock(blockId: number): Session[];
  getSessionById(id: number): Session | undefined;
  createSession(s: InsertSession): Session;
  deleteSession(id: number): void;

  // Participants
  getParticipantsBySession(sessionId: number): Participant[];
  getAllParticipants(): Participant[];
  addParticipant(p: InsertParticipant): Participant;
  updateParticipantStatus(id: number, status: string): Participant | undefined;
  deleteParticipant(id: number): void;

  // Public
  getPublicTeachers(): Teacher[];
  getPublicBlocksForTeacher(teacherId: number): ReturnType<typeof resolvePublicBlocks>;

  // Resources
  createResource(r: InsertResource): Resource;
  createSeries(seriesData: InsertResource, lessons: InsertResource[]): Resource; // creates series + all lesson children
  getSharedResources(): Resource[];
  getBSSResources(): Resource[];
  getResourceById(id: number): Resource | undefined;
  getLessonsBySeries(seriesId: number): Resource[];
  deleteResource(id: number): void;
  deleteSeriesWithLessons(seriesId: number): void;

  // Notifications
  createNotification(n: { teacherId: number; type: string; title: string; body?: string; relatedId?: number }): Notification;
  getNotificationsForTeacher(teacherId: number): Notification[];
  getUnreadCountForTeacher(teacherId: number): number;
  markNotificationRead(id: number): void;
  markAllNotificationsRead(teacherId: number): void;

  // Messages
  sendMessage(m: { senderType: string; senderId: number | null; recipientType: string; recipientId: number | null; body: string }): Message;
  getConversation(typeA: string, idA: number | null, typeB: string, idB: number | null): Message[];
  getConversationsForTeacher(teacherId: number): { partnerId: number | null; partnerType: string; partnerName: string; lastMessage: Message; unreadCount: number }[];
  getConversationsForAdmin(): { partnerId: number; partnerType: string; partnerName: string; lastMessage: Message; unreadCount: number }[];
  markMessagesRead(readerType: string, readerId: number | null, senderType: string, senderId: number | null): void;
  getUnreadMessageCount(recipientType: string, recipientId: number | null): number;
}

export const storage: IStorage = {
  getUserByUsername(username) {
    return db.select().from(users).where(eq(users.username, username)).get();
  },
  getTeacherByUsername(username) {
    return db.select().from(teachers).where(eq(teachers.username, username)).get();
  },
  getTeacherById(id) {
    return db.select().from(teachers).where(eq(teachers.id, id)).get();
  },

  getTeachers() {
    return db.select().from(teachers).all();
  },
  createTeacher(t) {
    return db.insert(teachers).values(t).returning().get();
  },
  updateTeacher(id, updates) {
    return db.update(teachers).set(updates).where(eq(teachers.id, id)).returning().get();
  },
  deleteTeacher(id) {
    db.delete(teachers).where(eq(teachers.id, id)).run();
  },

  getBlocks() {
    return db.select().from(availabilityBlocks).all();
  },
  getBlocksByTeacher(teacherId) {
    if (teacherId === null) {
      return db.select().from(availabilityBlocks).where(isNull(availabilityBlocks.teacherId)).all();
    }
    return db.select().from(availabilityBlocks).where(eq(availabilityBlocks.teacherId, teacherId)).all();
  },
  getBlockById(id) {
    return db.select().from(availabilityBlocks).where(eq(availabilityBlocks.id, id)).get();
  },
  createBlock(block) {
    return db.insert(availabilityBlocks).values(block).returning().get();
  },
  updateBlock(id, updates) {
    return db.update(availabilityBlocks).set(updates).where(eq(availabilityBlocks.id, id)).returning().get();
  },
  deleteBlock(id) {
    db.delete(availabilityBlocks).where(eq(availabilityBlocks.id, id)).run();
  },

  getAllSessions() {
    return db.select().from(sessions).all();
  },
  getSessionsByTeacher(teacherId) {
    if (teacherId === null) {
      return db.select().from(sessions).where(isNull(sessions.teacherId)).all();
    }
    return db.select().from(sessions).where(eq(sessions.teacherId, teacherId)).all();
  },
  getSessionsByBlock(blockId) {
    return db.select().from(sessions).where(eq(sessions.blockId, blockId)).all();
  },
  getSessionById(id) {
    return db.select().from(sessions).where(eq(sessions.id, id)).get();
  },
  createSession(s) {
    return db.insert(sessions).values({ ...s, createdAt: new Date().toISOString() }).returning().get();
  },
  deleteSession(id) {
    db.delete(sessions).where(eq(sessions.id, id)).run();
  },

  getAllParticipants() {
    return db.select().from(participants).all();
  },
  getParticipantsBySession(sessionId) {
    return db.select().from(participants).where(eq(participants.sessionId, sessionId)).all();
  },
  addParticipant(p) {
    return db.insert(participants).values({ ...p, createdAt: new Date().toISOString() }).returning().get();
  },
  updateParticipantStatus(id, status) {
    return db.update(participants).set({ status }).where(eq(participants.id, id)).returning().get();
  },
  deleteParticipant(id) {
    db.delete(participants).where(eq(participants.id, id)).run();
  },

  getPublicTeachers() {
    return db.select().from(teachers).where(eq(teachers.isActive, true)).all();
  },
  getPublicBlocksForTeacher(teacherId) {
    const blocks = db.select().from(availabilityBlocks)
      .where(eq(availabilityBlocks.teacherId, teacherId)).all();
    const allSessions = db.select().from(sessions)
      .where(eq(sessions.teacherId, teacherId)).all();
    const allParticipants = db.select().from(participants)
      .where(sql`${participants.status} != 'cancelled'`).all();
    return resolvePublicBlocks(blocks, allSessions, allParticipants);
  },

  // Resources
  createResource(r) {
    return db.insert(resources).values({ ...r, createdAt: new Date().toISOString() }).returning().get();
  },
  createSeries(seriesData, lessons) {
    // 1. Insert the series container row
    const series = db.insert(resources).values({ ...seriesData, resourceType: "series", createdAt: new Date().toISOString() }).returning().get();
    // 2. Insert each lesson linked to the series
    lessons.forEach((lesson, idx) => {
      db.insert(resources).values({
        ...lesson,
        resourceType: "lesson",
        seriesId: series.id,
        lessonOrder: idx + 1,
        isShared: seriesData.isShared,
        uploadedByTeacherId: seriesData.uploadedByTeacherId,
        createdAt: new Date().toISOString(),
      }).run();
    });
    return series;
  },
  getSharedResources() {
    // Return series containers + standalone lessons (not series children)
    return db.select().from(resources)
      .where(sql`${resources.isShared} = 1 AND ${resources.seriesId} IS NULL`).all();
  },
  getBSSResources() {
    return db.select().from(resources)
      .where(sql`${resources.isShared} = 0 AND ${resources.seriesId} IS NULL`).all();
  },
  getResourceById(id) {
    return db.select().from(resources).where(eq(resources.id, id)).get();
  },
  getLessonsBySeries(seriesId) {
    return db.select().from(resources)
      .where(eq(resources.seriesId, seriesId)).all()
      .sort((a, b) => (a.lessonOrder ?? 0) - (b.lessonOrder ?? 0));
  },
  deleteResource(id) {
    db.delete(resources).where(eq(resources.id, id)).run();
  },
  deleteSeriesWithLessons(seriesId) {
    db.delete(resources).where(eq(resources.seriesId, seriesId)).run();
    db.delete(resources).where(eq(resources.id, seriesId)).run();
  },

  // ── Notifications
  createNotification(n) {
    return db.insert(notifications).values({ ...n, isRead: false, createdAt: new Date().toISOString() }).returning().get();
  },
  getNotificationsForTeacher(teacherId) {
    return db.select().from(notifications).where(eq(notifications.teacherId, teacherId)).all()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  getUnreadCountForTeacher(teacherId) {
    const res = db.select().from(notifications)
      .where(sql`${notifications.teacherId} = ${teacherId} AND ${notifications.isRead} = 0`).all();
    return res.length;
  },
  markNotificationRead(id) {
    db.update(notifications).set({ isRead: true }).where(eq(notifications.id, id)).run();
  },
  markAllNotificationsRead(teacherId) {
    db.update(notifications).set({ isRead: true }).where(eq(notifications.teacherId, teacherId)).run();
  },

  // ── Messages
  sendMessage(m) {
    return db.insert(messages).values({ ...m, isRead: false, createdAt: new Date().toISOString() }).returning().get();
  },
  getConversation(typeA, idA, typeB, idB) {
    return db.select().from(messages).where(
      sql`(${messages.senderType} = ${typeA} AND ${messages.senderId} IS ${idA} AND ${messages.recipientType} = ${typeB} AND ${messages.recipientId} IS ${idB})
          OR (${messages.senderType} = ${typeB} AND ${messages.senderId} IS ${idB} AND ${messages.recipientType} = ${typeA} AND ${messages.recipientId} IS ${idA})`
    ).all().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },
  getConversationsForTeacher(teacherId) {
    // Get all messages involving this teacher
    const msgs = db.select().from(messages).where(
      sql`(${messages.senderType} = 'teacher' AND ${messages.senderId} = ${teacherId})
          OR (${messages.recipientType} = 'teacher' AND ${messages.recipientId} = ${teacherId})`
    ).all();
    // Group by partner
    const partnerMap = new Map<string, { msgs: typeof msgs; partnerType: string; partnerId: number | null }>();
    for (const m of msgs) {
      const isMe = m.senderType === 'teacher' && m.senderId === teacherId;
      const partnerType = isMe ? m.recipientType : m.senderType;
      const partnerId = isMe ? m.recipientId : m.senderId;
      const key = `${partnerType}-${partnerId}`;
      if (!partnerMap.has(key)) partnerMap.set(key, { msgs: [], partnerType, partnerId });
      partnerMap.get(key)!.msgs.push(m);
    }
    const allTeachers = db.select().from(teachers).all();
    return Array.from(partnerMap.entries()).map(([, v]) => {
      const sorted = v.msgs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const unread = v.msgs.filter(m => m.recipientType === 'teacher' && m.recipientId === teacherId && !m.isRead).length;
      const partnerName = v.partnerType === 'admin' ? 'Admin' : (allTeachers.find(t => t.id === v.partnerId)?.name ?? 'Teacher');
      return { partnerId: v.partnerId, partnerType: v.partnerType, partnerName, lastMessage: sorted[0], unreadCount: unread };
    }).sort((a, b) => b.lastMessage.createdAt.localeCompare(a.lastMessage.createdAt));
  },
  getConversationsForAdmin() {
    const msgs = db.select().from(messages).where(
      sql`${messages.senderType} = 'admin' OR ${messages.recipientType} = 'admin'`
    ).all();
    const partnerMap = new Map<string, { msgs: typeof msgs; partnerType: string; partnerId: number | null }>();
    for (const m of msgs) {
      const isMe = m.senderType === 'admin';
      const partnerType = isMe ? m.recipientType : m.senderType;
      const partnerId = isMe ? m.recipientId : m.senderId;
      const key = `${partnerType}-${partnerId}`;
      if (!partnerMap.has(key)) partnerMap.set(key, { msgs: [], partnerType, partnerId });
      partnerMap.get(key)!.msgs.push(m);
    }
    const allTeachers = db.select().from(teachers).all();
    return Array.from(partnerMap.entries()).map(([, v]) => {
      const sorted = v.msgs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const unread = v.msgs.filter(m => m.recipientType === 'admin' && !m.isRead).length;
      const partnerName = allTeachers.find(t => t.id === v.partnerId)?.name ?? 'Teacher';
      return { partnerId: v.partnerId as number, partnerType: v.partnerType, partnerName, lastMessage: sorted[0], unreadCount: unread };
    }).sort((a, b) => b.lastMessage.createdAt.localeCompare(a.lastMessage.createdAt));
  },
  markMessagesRead(readerType, readerId, senderType, senderId) {
    db.update(messages).set({ isRead: true }).where(
      sql`${messages.recipientType} = ${readerType} AND ${messages.recipientId} IS ${readerId}
          AND ${messages.senderType} = ${senderType} AND ${messages.senderId} IS ${senderId}`
    ).run();
  },
  getUnreadMessageCount(recipientType, recipientId) {
    return db.select().from(messages).where(
      sql`${messages.recipientType} = ${recipientType} AND ${messages.recipientId} IS ${recipientId} AND ${messages.isRead} = 0`
    ).all().length;
  },
  deleteConversation(typeA, idA, typeB, idB) {
    db.delete(messages).where(
      sql`(${messages.senderType} = ${typeA} AND ${messages.senderId} IS ${idA} AND ${messages.recipientType} = ${typeB} AND ${messages.recipientId} IS ${idB})
          OR (${messages.senderType} = ${typeB} AND ${messages.senderId} IS ${idB} AND ${messages.recipientType} = ${typeA} AND ${messages.recipientId} IS ${idA})`
    ).run();
  },

  // ── Zoom Settings ───────────────────────────────────────────────
  getZoomSettings(): ZoomSetting | undefined {
    return db.select().from(zoomSettings).get();
  },
  saveZoomSettings(updates: Partial<Omit<ZoomSetting, "id">>) {
    const existing = db.select().from(zoomSettings).get();
    const now = new Date().toISOString();
    if (existing) {
      return db.update(zoomSettings).set({ ...updates, updatedAt: now }).where(eq(zoomSettings.id, existing.id)).returning().get();
    } else {
      return db.insert(zoomSettings).values({ accountId: "", clientId: "", clientSecret: "", enabled: false, updatedAt: now, ...updates }).returning().get();
    }
  },
  setSessionZoomLink(sessionId: number, joinUrl: string, meetingId: string) {
    db.update(sessions).set({ zoomMeetingUrl: joinUrl, zoomMeetingId: meetingId }).where(eq(sessions.id, sessionId)).run();
  },

    // ── Email Settings ───────────────────────────────────────────────
  getEmailSettings(): EmailSetting | undefined {
    return db.select().from(emailSettings).get();
  },
  saveEmailSettings(updates: Partial<Omit<EmailSetting, 'id'>>) {
    const existing = db.select().from(emailSettings).get();
    const now = new Date().toISOString();
    if (existing) {
      return db.update(emailSettings).set({ ...updates, updatedAt: now }).where(eq(emailSettings.id, existing.id)).returning().get();
    } else {
      return db.insert(emailSettings).values({ smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpUser: '', smtpPass: '', fromName: 'BibleStudySpot', remindersEnabled: false, updatedAt: now, ...updates }).returning().get();
    }
  },

  // ── Reminder helpers ─────────────────────────────────────────────
  getTeacher(id: number): Teacher | undefined {
    return db.select().from(teachers).where(eq(teachers.id, id)).get();
  },
  getAllSessionsWithDetails() {
    const allSessions = db.select().from(sessions).all();
    const allParticipants = db.select().from(participants).all();
    return allSessions.map(s => ({
      ...s,
      participants: allParticipants.filter(p => p.sessionId === s.id),
    }));
  },
  markReminderSent(participantId: number, type: '24h' | '1h') {
    if (type === '24h') {
      db.update(participants).set({ reminder24Sent: true }).where(eq(participants.id, participantId)).run();
    } else {
      db.update(participants).set({ reminder1Sent: true }).where(eq(participants.id, participantId)).run();
    }
  },
};
