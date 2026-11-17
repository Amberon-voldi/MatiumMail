import { describe, expect, it } from "vitest";
import { conversationKey, decodeCursor, dedupeCopies, encodeCursor, groupByConversation, participantsOf, shortName } from "./threads";

const row = (id: string, threadKey: string | null) => ({ id, threadKey });

describe("groupByConversation", () => {
  it("groups newest-first rows in order of each conversation's newest message", () => {
    const rows = [row("a", "T1"), row("b", "T2"), row("c", "T1"), row("d", null), row("e", "T2")];
    const { groups, truncated } = groupByConversation(rows, 10);
    expect(groups.map((g) => g.map((r) => r.id))).toEqual([["a", "c"], ["b", "e"], ["d"]]);
    expect(truncated).toBe(false);
  });

  it("stops at the limit but still collects later rows of included conversations", () => {
    const rows = [row("a", "T1"), row("b", "T2"), row("c", "T3"), row("d", "T1")];
    const { groups, truncated } = groupByConversation(rows, 2);
    expect(groups.map((g) => g.map((r) => r.id))).toEqual([["a", "d"], ["b"]]);
    expect(truncated).toBe(true);
  });

  it("keys lone messages by id", () => {
    expect(conversationKey(row("x", null))).toBe("m:x");
    expect(conversationKey(row("x", "T"))).toBe("T");
  });
});

describe("participantsOf", () => {
  it("lists distinct senders oldest first and calls the owner 'me'", () => {
    const members = [
      { fromName: "Asha Rao", fromAddress: "asha@x.com" },
      { fromName: null, fromAddress: "me@corp.com" },
      { fromName: "Asha Rao", fromAddress: "asha@x.com" },
      { fromName: "Bob", fromAddress: "bob@y.com" },
    ];
    expect(participantsOf(members, "ME@corp.com")).toEqual(["Asha", "me", "Bob"]);
  });

  it("shortens long lists", () => {
    const members = ["a", "b", "c", "d", "e", "f"].map((n) => ({ fromName: null, fromAddress: `${n}@x.com` }));
    expect(participantsOf(members, "z@x.com")).toEqual(["a", "…", "e", "f"]);
  });

  it("falls back to the address' local part", () => {
    expect(shortName({ name: null, address: "sales.team@x.com" })).toBe("sales.team");
  });
});

describe("dedupeCopies", () => {
  it("keeps one copy per Message-ID, preferring the folder being viewed", () => {
    const rows = [
      { id: "1", messageIdHeader: "<m1@x>", folderId: "sent" },
      { id: "2", messageIdHeader: "<M1@x>", folderId: "inbox" },
      { id: "3", messageIdHeader: null, folderId: "inbox" },
    ];
    expect(dedupeCopies(rows, "inbox").map((r) => r.id)).toEqual(["2", "3"]);
    expect(dedupeCopies(rows).map((r) => r.id)).toEqual(["1", "3"]);
  });
});

describe("cursor", () => {
  it("round-trips and rejects junk", () => {
    const id = "0196f2a4-6a2b-7c3d-8e9f-0123456789ab";
    const c = encodeCursor(new Date(1_700_000_000_123), id);
    expect(decodeCursor(c)).toEqual({ date: new Date(1_700_000_000_123), id });
    expect(decodeCursor("nope")).toBeNull();
    expect(decodeCursor("123.not-a-uuid")).toBeNull();
    expect(decodeCursor(null)).toBeNull();
  });
});
