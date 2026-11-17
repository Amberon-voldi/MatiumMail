/**
 * Provision the organisation, mail server profiles, domains and allowed users.
 *
 *   npm run setup -- config/setup.example.json    (the committed MilesWeb config)
 *   npm run setup -- config/setup.local.json      (your own copy; gitignored)
 *
 * This writes to the database in `.env` — the MilesWeb production database.
 *
 * Idempotent: re-running updates existing rows and adds new ones; it never
 * deletes anything. No passwords are involved — each user proves their
 * mailbox password at first sign-in, and the app stores it encrypted then.
 *
 * Every user gets a mailbox of the same address, owned by them. Adding a domain
 * or a person is a config change + re-run, never a code change.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { db } from "../src/server/db";

const endpoint = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  security: z.enum(["TLS", "STARTTLS"]),
});

const configSchema = z.object({
  organization: z.object({
    name: z.string().min(1),
    slug: z.string().regex(/^[a-z0-9-]+$/),
  }),
  serverProfiles: z
    .array(
      z.object({
        key: z.string().min(1),
        name: z.string().min(1),
        imap: endpoint,
        smtp: endpoint,
        tlsServername: z.string().nullable().optional(),
        maxConnectionsPerMailbox: z.number().int().min(1).max(10).optional(),
        smtpMaxPerHour: z.number().int().positive().nullable().optional(),
      }),
    )
    .min(1),
  domains: z
    .array(
      z.object({
        name: z.string().min(3).transform((s) => s.toLowerCase()),
        serverProfile: z.string(),
        defaultQuotaGb: z.number().positive().nullable().optional(),
        status: z.enum(["ACTIVE", "DISABLED"]).default("ACTIVE"),
        /** Any mailbox on this domain can sign in; its account is created on first login. */
        autoProvision: z.boolean().default(false),
      }),
    )
    .min(1),
  users: z.array(
    z.object({
      email: z.email().transform((s) => s.toLowerCase()),
      displayName: z.string().nullable().optional(),
      role: z.enum(["OWNER", "ADMIN", "MEMBER"]).default("MEMBER"),
    }),
  ),
});

type Config = z.infer<typeof configSchema>;
const MB = BigInt(1024 * 1024);

function load(path: string | undefined): Config {
  if (!path) throw new Error("Usage: npm run setup -- <config.json>");
  const parsed = configSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new Error(`Invalid config ${path}:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  const cfg = parsed.data;
  const profileKeys = new Set(cfg.serverProfiles.map((p) => p.key));
  for (const d of cfg.domains) {
    if (!profileKeys.has(d.serverProfile)) throw new Error(`Domain ${d.name}: unknown serverProfile '${d.serverProfile}'`);
  }
  const domainNames = new Set(cfg.domains.map((d) => d.name));
  for (const u of cfg.users) {
    const domain = u.email.split("@")[1];
    if (!domainNames.has(domain)) throw new Error(`User ${u.email}: domain ${domain} is not listed in domains`);
  }
  return cfg;
}

async function main() {
  const cfg = load(process.argv[2]);
  const p = db();

  const org = await p.organization.upsert({
    where: { slug: cfg.organization.slug },
    create: { name: cfg.organization.name, slug: cfg.organization.slug },
    update: { name: cfg.organization.name },
  });
  console.log(`organization  ${org.slug}`);

  const profileIds = new Map<string, string>();
  for (const sp of cfg.serverProfiles) {
    const data = {
      name: sp.name,
      imapHost: sp.imap.host,
      imapPort: sp.imap.port,
      imapSecurity: sp.imap.security,
      smtpHost: sp.smtp.host,
      smtpPort: sp.smtp.port,
      smtpSecurity: sp.smtp.security,
      tlsServername: sp.tlsServername ?? null,
      maxConnectionsPerMailbox: sp.maxConnectionsPerMailbox ?? 3,
      smtpMaxPerHour: sp.smtpMaxPerHour ?? null,
    };
    const existing = await p.mailServerProfile.findFirst({ where: { organizationId: org.id, name: sp.name } });
    const row = existing
      ? await p.mailServerProfile.update({ where: { id: existing.id }, data })
      : await p.mailServerProfile.create({ data: { ...data, organizationId: org.id } });
    profileIds.set(sp.key, row.id);
    console.log(`server        ${sp.name}  imap ${sp.imap.host}:${sp.imap.port}/${sp.imap.security}  smtp ${sp.smtp.host}:${sp.smtp.port}/${sp.smtp.security}`);
  }

  const domainRows = new Map<string, { id: string; defaultQuotaBytes: bigint | null }>();
  for (const d of cfg.domains) {
    // GB → bytes via whole megabytes (keeps fractional GB like 2.5 exact enough).
    const defaultQuotaBytes = d.defaultQuotaGb ? BigInt(Math.round(d.defaultQuotaGb * 1024)) * MB : null;
    const row = await p.domain.upsert({
      where: { name: d.name },
      create: {
        name: d.name,
        organizationId: org.id,
        serverProfileId: profileIds.get(d.serverProfile)!,
        status: d.status,
        autoProvision: d.autoProvision,
        defaultQuotaBytes,
      },
      update: { serverProfileId: profileIds.get(d.serverProfile)!, status: d.status, defaultQuotaBytes, autoProvision: d.autoProvision },
    });
    domainRows.set(d.name, { id: row.id, defaultQuotaBytes });
    console.log(`domain        ${d.name}  (${d.status}${d.autoProvision ? ", auto-provision" : ""})`);
  }

  for (const u of cfg.users) {
    const domain = domainRows.get(u.email.split("@")[1])!;
    const user = await p.user.upsert({
      where: { email: u.email },
      create: { email: u.email, displayName: u.displayName ?? null, role: u.role, organizationId: org.id, preferences: {} },
      update: { displayName: u.displayName ?? null, role: u.role },
    });
    const mailbox = await p.mailbox.upsert({
      where: { address: u.email },
      create: {
        address: u.email,
        displayName: u.displayName ?? null,
        organizationId: org.id,
        domainId: domain.id,
        settings: {},
        quotaLimitBytes: domain.defaultQuotaBytes,
        quotaSource: domain.defaultQuotaBytes ? "MANUAL" : null,
      },
      update: { domainId: domain.id },
    });
    await p.mailboxAccess.upsert({
      where: { userId_mailboxId: { userId: user.id, mailboxId: mailbox.id } },
      create: { userId: user.id, mailboxId: mailbox.id, role: "OWNER" },
      update: { role: "OWNER" },
    });
    console.log(`user+mailbox  ${u.email}  (${u.role}, mailbox status ${mailbox.status})`);
  }

  console.log("\nDone. Users can now sign in with their mailbox password.");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db().$disconnect());
