import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const savedSessionsTable = pgTable("saved_sessions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  name: text("name").notNull(),
  cookie: text("cookie").notNull(),
  dtsg: text("dtsg"),
  eaagToken: text("eaag_token"),
  sessionToken: text("session_token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const reactionsTable = pgTable("reactions", {
  id: serial("id").primaryKey(),
  postUrl: text("post_url").notNull(),
  userId: text("user_id").notNull(),
  reactionType: text("reaction_type").notNull().default("LIKE"),
  reactedAt: timestamp("reacted_at", { withTimezone: true }).defaultNow(),
});

export type SavedSession = typeof savedSessionsTable.$inferSelect;
export type InsertSavedSession = typeof savedSessionsTable.$inferInsert;
