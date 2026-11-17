import { describe, expect, it } from "vitest";
import { assignRoles, leafName, type FolderInput } from "./folders";

const f = (path: string, extra: Partial<FolderInput> = {}): FolderInput => ({ path, delimiter: ".", ...extra });

describe("assignRoles", () => {
  it("maps Dovecot INBOX.* names without SPECIAL-USE", () => {
    const roles = assignRoles([f("INBOX"), f("INBOX.Sent"), f("INBOX.Drafts"), f("INBOX.spam"), f("INBOX.Trash"), f("INBOX.Archive"), f("INBOX.Clients")]);
    expect(Object.fromEntries(roles)).toEqual({
      INBOX: "INBOX",
      "INBOX.Sent": "SENT",
      "INBOX.Drafts": "DRAFTS",
      "INBOX.spam": "JUNK",
      "INBOX.Trash": "TRASH",
      "INBOX.Archive": "ARCHIVE",
      "INBOX.Clients": "NONE",
    });
  });

  it("prefers SPECIAL-USE attributes over names", () => {
    const roles = assignRoles([
      f("INBOX"),
      f("Sent", { delimiter: "/" }),
      f("Sent Messages", { delimiter: "/", specialUse: "\\Sent" }),
    ]);
    expect(roles.get("Sent Messages")).toBe("SENT");
    expect(roles.get("Sent")).toBe("NONE");
  });

  it("assigns each role once, shallowest name first", () => {
    const roles = assignRoles([f("INBOX.Projects.Trash"), f("INBOX.Trash"), f("INBOX")]);
    expect(roles.get("INBOX.Trash")).toBe("TRASH");
    expect(roles.get("INBOX.Projects.Trash")).toBe("NONE");
  });

  it("recognises common provider names", () => {
    const roles = assignRoles([
      f("INBOX", { delimiter: "/" }),
      f("[Gmail]/Sent Mail", { delimiter: "/" }),
      f("Deleted Items", { delimiter: "/" }),
      f("Junk E-mail", { delimiter: "/" }),
      f("[Gmail]/All Mail", { delimiter: "/" }),
    ]);
    expect(roles.get("[Gmail]/Sent Mail")).toBe("SENT");
    expect(roles.get("Deleted Items")).toBe("TRASH");
    expect(roles.get("Junk E-mail")).toBe("JUNK");
    expect(roles.get("[Gmail]/All Mail")).toBe("ALL");
  });

  it("treats INBOX case-insensitively and ignores a misleading attribute on it", () => {
    const roles = assignRoles([f("Inbox", { specialUse: "\\Sent" })]);
    expect(roles.get("Inbox")).toBe("INBOX");
  });
});

describe("leafName", () => {
  it("returns the last path segment", () => {
    expect(leafName("INBOX.Clients.Acme", ".")).toBe("Acme");
    expect(leafName("Archive", null)).toBe("Archive");
  });
});
