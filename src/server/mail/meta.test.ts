import { describe, expect, it } from "vitest";
import type { MessageStructureObject } from "imapflow";
import {
  expungedIds,
  flagColumns,
  hasAttachments,
  normalizeMessageId,
  parseReferences,
  sameFlags,
  threadKeyFor,
  toAddressList,
  toDate,
} from "./meta";

describe("parseReferences", () => {
  it("reads folded References headers and ignores other headers", () => {
    const raw = "References: <a@x>\r\n <b@x>\r\n\t<c@x>\r\nSubject: hi\r\n";
    expect(parseReferences(Buffer.from(raw))).toEqual(["<a@x>", "<b@x>", "<c@x>"]);
  });
  it("returns [] when absent", () => {
    expect(parseReferences(Buffer.from("Subject: x\r\n"))).toEqual([]);
    expect(parseReferences(undefined)).toEqual([]);
  });
  it("dedupes and caps very long chains", () => {
    const ids = Array.from({ length: 80 }, (_, i) => `<m${i}@x>`).join(" ");
    const out = parseReferences(`References: <m0@x> ${ids}\r\n`);
    expect(out).toHaveLength(50);
    expect(new Set(out).size).toBe(50);
  });
});

describe("threadKeyFor", () => {
  it("uses the thread root so replies share a key", () => {
    const root = threadKeyFor("<root@x>", null, []);
    const reply = threadKeyFor("<r1@x>", "<root@x>", ["<root@x>"]);
    const replyToReply = threadKeyFor("<r2@x>", "<r1@x>", ["<root@x>", "<r1@x>"]);
    expect(reply).toBe(root);
    expect(replyToReply).toBe(root);
    expect(root).toHaveLength(32);
  });
  it("is null without any id", () => {
    expect(threadKeyFor(null, null, [])).toBeNull();
  });
});

describe("hasAttachments", () => {
  const node = (n: Partial<MessageStructureObject>): MessageStructureObject => ({ type: "text/plain", ...n }) as MessageStructureObject;

  it("finds attachments in nested multiparts", () => {
    const tree = node({
      type: "multipart/mixed",
      childNodes: [
        node({ type: "multipart/alternative", childNodes: [node({ type: "text/plain" }), node({ type: "text/html" })] }),
        node({ type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "invoice.pdf" } }),
      ],
    });
    expect(hasAttachments(tree)).toBe(true);
  });

  it("ignores inline images referenced by Content-ID", () => {
    const tree = node({
      type: "multipart/related",
      childNodes: [node({ type: "text/html" }), node({ type: "image/png", disposition: "inline", id: "<logo@x>", parameters: { name: "logo.png" } })],
    });
    expect(hasAttachments(tree)).toBe(false);
  });

  it("treats named non-text parts without disposition as attachments", () => {
    expect(hasAttachments(node({ type: "application/zip", parameters: { name: "a.zip" } }))).toBe(true);
    expect(hasAttachments(node({ type: "text/plain" }))).toBe(false);
    expect(hasAttachments(undefined)).toBe(false);
  });
});

describe("expungedIds", () => {
  const rows = [
    { id: "a", uid: 1n },
    { id: "b", uid: 2n },
    { id: "c", uid: 3n },
  ];

  it("regression: never deletes messages inserted above the searched range", () => {
    // Cache held only UID 1, we searched 1:1, then inserted UIDs 2 and 3.
    expect(expungedIds(rows, 1, 1, [1])).toEqual([]);
  });

  it("reports cached UIDs inside the range that the server no longer has", () => {
    expect(expungedIds(rows, 1, 3, [1, 3])).toEqual(["b"]);
    expect(expungedIds(rows, 1, 3, [])).toEqual(["a", "b", "c"]);
  });
});

describe("small helpers", () => {
  it("normalizes Message-IDs", () => {
    expect(normalizeMessageId(" abc@x ")).toBe("<abc@x>");
    expect(normalizeMessageId("<abc@x>")).toBe("<abc@x>");
    expect(normalizeMessageId("")).toBeNull();
    expect(normalizeMessageId("<" + "a".repeat(600) + ">")).toBeNull();
  });

  it("maps flags to columns case-insensitively", () => {
    expect(flagColumns(new Set(["\\seen", "\\Flagged", "$Label1"]))).toEqual({
      flags: ["\\seen", "\\Flagged", "$Label1"],
      isSeen: true,
      isFlagged: true,
      isAnswered: false,
      isDraft: false,
    });
    expect(sameFlags(["\\Seen", "\\Flagged"], new Set(["\\flagged", "\\seen"]))).toBe(true);
    expect(sameFlags(["\\Seen"], new Set(["\\Seen", "\\Answered"]))).toBe(false);
  });

  it("normalizes addresses", () => {
    expect(toAddressList([{ name: " Ana ", address: " Ana@X.COM " }, { address: "b@x.com" }])).toEqual([
      { name: "Ana", address: "ana@x.com" },
      { name: null, address: "b@x.com" },
    ]);
  });

  it("parses dates defensively", () => {
    expect(toDate("2026-11-17T10:00:00Z")?.toISOString()).toBe("2026-11-17T10:00:00.000Z");
    expect(toDate("not a date")).toBeNull();
    expect(toDate(undefined)).toBeNull();
  });
});
