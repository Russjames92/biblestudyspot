import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── Admin user ────────────────────────────────────────────────────────────────
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});
export const insertUserSchema = createInsertSchema(users).pick({ username: true, password: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// ── Teachers ──────────────────────────────────────────────────────────────────
// Each teacher has a login, a public profile, and manages their own blocks
export const teachers = sqliteTable("teachers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  name: text("name").notNull(),
  bio: text("bio"),                          // short intro shown on public page
  photoUrl: text("photo_url"),               // base64 data URL or external URL
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  // Private admin-only fields (not exposed publicly)
  firstName: text("first_name"),
  lastName: text("last_name"),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  dateOfBirth: text("date_of_birth"),
  emergencyContact: text("emergency_contact"),
  emergencyPhone: text("emergency_phone"),
  notes: text("notes"),
  dateJoined: text("date_joined"),
});
export const insertTeacherSchema = createInsertSchema(teachers).omit({ id: true });
export type InsertTeacher = z.infer<typeof insertTeacherSchema>;
export type Teacher = typeof teachers.$inferSelect;

// ── Availability blocks ───────────────────────────────────────────────────────
// Now linked to a teacher. teacherId = null means the block belongs to the admin.
export const availabilityBlocks = sqliteTable("availability_blocks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  teacherId: integer("teacher_id"),          // null = admin-created
  date: text("date").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  slotDuration: integer("slot_duration").notNull().default(60),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  note: text("note"),
});
export const insertAvailabilityBlockSchema = createInsertSchema(availabilityBlocks).omit({ id: true });
export type InsertAvailabilityBlock = z.infer<typeof insertAvailabilityBlockSchema>;
export type AvailabilityBlock = typeof availabilityBlocks.$inferSelect;

// ── Sessions ──────────────────────────────────────────────────────────────────
export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  blockId: integer("block_id").notNull(),
  teacherId: integer("teacher_id"),          // denormalized for easy querying
  date: text("date").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  sessionType: text("session_type").notNull(), // "one-on-one" | "group"
  isOpen: integer("is_open", { mode: "boolean" }).notNull().default(true),
  zoomMeetingUrl: text("zoom_meeting_url"),    // set when Zoom meeting is created
  zoomMeetingId: text("zoom_meeting_id"),      // Zoom's meeting ID for reference
  createdAt: text("created_at").notNull(),
});
export const insertSessionSchema = createInsertSchema(sessions).omit({ id: true, createdAt: true });
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessions.$inferSelect;

// ── Participants ──────────────────────────────────────────────────────────────
export const participants = sqliteTable("participants", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: integer("session_id").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  question: text("question"),        // the existential question they selected
  locationType: text("location_type"), // "in-person" or "zoom"
  groupSize: integer("group_size"),   // how many people in their party (group sessions)
  message: text("message"),           // their optional free-text note
  status: text("status").notNull().default("pending"),
  reminder24Sent: integer("reminder_24_sent", { mode: "boolean" }).notNull().default(false),
  reminder1Sent: integer("reminder_1_sent", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
});
export const insertParticipantSchema = createInsertSchema(participants).omit({ id: true, status: true, reminder24Sent: true, reminder1Sent: true, createdAt: true });
export type InsertParticipant = z.infer<typeof insertParticipantSchema>;
export type Participant = typeof participants.$inferSelect;

// ── Resources ──────────────────────────────────────────────────────────────────
// resourceType: "lesson" = single file/video, "series" = container for multiple lessons
// seriesId: non-null on lessons that belong to a series
// lessonOrder: ordering within a series (1-based)
export const resources = sqliteTable("resources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description"),
  category: text("category").notNull(),
  resourceType: text("resource_type").notNull().default("lesson"), // "lesson" | "series"
  seriesId: integer("series_id"),              // null for standalone/series root; lesson's parent series id
  lessonOrder: integer("lesson_order"),         // ordering within series
  fileType: text("file_type"),                  // "pdf" | "pptx" | "video" | null (series container has no file)
  fileData: text("file_data"),
  videoUrl: text("video_url"),
  fileName: text("file_name"),
  isShared: integer("is_shared", { mode: "boolean" }).notNull().default(false),
  uploadedByTeacherId: integer("uploaded_by_teacher_id"),
  createdAt: text("created_at").notNull(),
});
export const insertResourceSchema = createInsertSchema(resources).omit({ id: true, createdAt: true });
export type InsertResource = z.infer<typeof insertResourceSchema>;
export type Resource = typeof resources.$inferSelect;

// ── Notifications ──────────────────────────────────────────────────────────────────
// System notifications for teachers (e.g. "New booking from Jane Smith")
export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  teacherId: integer("teacher_id").notNull(),
  type: text("type").notNull(),          // "booking" | "message" | "system"
  title: text("title").notNull(),
  body: text("body"),
  isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
  relatedId: integer("related_id"),      // sessionId for bookings, messageId for messages
  createdAt: text("created_at").notNull(),
});
export type Notification = typeof notifications.$inferSelect;

// ── Zoom Settings ───────────────────────────────────────────────────────────────────
export const zoomSettings = sqliteTable("zoom_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: text("account_id").notNull().default(""),
  clientId: text("client_id").notNull().default(""),
  clientSecret: text("client_secret").notNull().default(""),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  updatedAt: text("updated_at").notNull(),
});
export type ZoomSetting = typeof zoomSettings.$inferSelect;

// ── Email Settings ───────────────────────────────────────────────────────────────────
// Single-row config table for outbound email (SMTP)
export const emailSettings = sqliteTable("email_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  smtpHost: text("smtp_host").notNull().default("smtp.gmail.com"),
  smtpPort: integer("smtp_port").notNull().default(587),
  smtpUser: text("smtp_user").notNull().default(""),
  smtpPass: text("smtp_pass").notNull().default(""),   // app password
  fromName: text("from_name").notNull().default("BibleStudySpot"),
  remindersEnabled: integer("reminders_enabled", { mode: "boolean" }).notNull().default(false),
  updatedAt: text("updated_at").notNull(),
});
export type EmailSetting = typeof emailSettings.$inferSelect;

// ── Messages ─────────────────────────────────────────────────────────────────────────
// Direct messages between teachers, or teacher <-> admin
// senderType: "teacher" | "admin"  recipientType: "teacher" | "admin"
export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  senderType: text("sender_type").notNull(),      // "teacher" | "admin"
  senderId: integer("sender_id"),                 // teacher id, null if admin
  recipientType: text("recipient_type").notNull(), // "teacher" | "admin"
  recipientId: integer("recipient_id"),            // teacher id, null if admin
  body: text("body").notNull(),
  isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
});
export type Message = typeof messages.$inferSelect;
