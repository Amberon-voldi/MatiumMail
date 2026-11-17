import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { DEFAULT_PREFERENCES, type MailPreferences } from "@/lib/mail-types";
import { db } from "./db";

/**
 * Per-person mail settings, kept under `mail` in users.preferences (other keys
 * in that JSON are left untouched).
 */

export const preferencesPatchSchema = z
  .object({
    remoteImages: z.enum(["proxy", "ask"]),
    conversationView: z.boolean(),
  })
  .partial()
  .strict();

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function getPreferences(userId: string): Promise<MailPreferences> {
  const row = await db().user.findUnique({ where: { id: userId }, select: { preferences: true } });
  const parsed = preferencesPatchSchema.safeParse(asObject(asObject(row?.preferences).mail));
  return { ...DEFAULT_PREFERENCES, ...(parsed.success ? parsed.data : {}) };
}

export async function updatePreferences(userId: string, patch: z.infer<typeof preferencesPatchSchema>): Promise<MailPreferences> {
  const p = db();
  const row = await p.user.findUniqueOrThrow({ where: { id: userId }, select: { preferences: true } });
  const all = asObject(row.preferences);
  const current = preferencesPatchSchema.safeParse(asObject(all.mail));
  const next: MailPreferences = { ...DEFAULT_PREFERENCES, ...(current.success ? current.data : {}), ...patch };
  await p.user.update({ where: { id: userId }, data: { preferences: { ...all, mail: next } as Prisma.InputJsonObject } });
  return next;
}
