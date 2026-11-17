import { describe, expect, it } from "vitest";
import type { MessageStructureObject } from "imapflow";
import { attachmentParts, bodyLeaves, decodedSize, isPartId, partHeaders, safeFilename, stripContentHeaders, syntheticMessage } from "./structure";

const leaf = (o: Partial<MessageStructureObject>): MessageStructureObject => ({ type: "text/plain", ...o });

// multipart/mixed
//   1   multipart/alternative
//   1.1   text/plain
//   1.2   multipart/related
//   1.2.1   text/html
//   1.2.2   image/png (cid: logo)
//   2   application/pdf (attachment)
//   3   message/rfc822 (forwarded)
//   4   image/jpeg inline, named, no Content-ID (Apple Mail style)
const tree: MessageStructureObject = {
  type: "multipart/mixed",
  childNodes: [
    {
      part: "1",
      type: "multipart/alternative",
      childNodes: [
        leaf({ part: "1.1", type: "text/plain", size: 120 }),
        {
          part: "1.2",
          type: "multipart/related",
          childNodes: [
            leaf({ part: "1.2.1", type: "text/html", size: 900 }),
            leaf({ part: "1.2.2", type: "image/png", id: "<logo@x>", disposition: "inline", size: 4000, encoding: "base64" }),
          ],
        },
      ],
    },
    leaf({
      part: "2",
      type: "application/pdf",
      disposition: "attachment",
      dispositionParameters: { filename: "Invoice 42.pdf" },
      encoding: "base64",
      size: 78_000,
    }),
    leaf({ part: "3", type: "message/rfc822", size: 5000, envelope: { subject: "Old thread" } as MessageStructureObject["envelope"] }),
    leaf({ part: "4", type: "image/jpeg", disposition: "inline", parameters: { name: "photo.jpg" }, size: 1000 }),
  ],
};

describe("attachmentParts", () => {
  it("lists real attachments with their part numbers, not the body or cid: images", () => {
    const list = attachmentParts(tree);
    expect(list.map((a) => a.part)).toEqual(["2", "3", "4"]);
    expect(list[0]).toMatchObject({ filename: "Invoice 42.pdf", contentType: "application/pdf", encoding: "base64", encodedSize: 78_000 });
    expect(list[0].size).toBe(57_000);
    expect(list[1].filename).toBe("Old thread.eml");
    expect(list[2].filename).toBe("photo.jpg");
  });

  it("treats a whole single-part message as part 1", () => {
    expect(attachmentParts(leaf({ type: "application/pdf", disposition: "attachment" }))[0].part).toBe("1");
    expect(attachmentParts(leaf({ type: "text/plain" }))).toEqual([]);
  });
});

describe("bodyLeaves", () => {
  it("finds the HTML, the plain text and the embedded images", () => {
    const b = bodyLeaves(tree);
    expect(b.html?.part).toBe("1.2.1");
    expect(b.text?.part).toBe("1.1");
    expect(b.inline.map((n) => n.part)).toEqual(["1.2.2"]);
  });
});

describe("helpers", () => {
  it("validates part ids", () => {
    expect(isPartId("1")).toBe(true);
    expect(isPartId("1.2.3")).toBe(true);
    expect(isPartId("1.")).toBe(false);
    expect(isPartId("HEADER")).toBe(false);
    expect(isPartId("1;DROP")).toBe(false);
  });

  it("makes filenames safe", () => {
    expect(safeFilename("../../etc/passwd", "x")).toBe(".._.._etc_passwd");
    expect(safeFilename("a\u0000b\r\n.txt", "x")).toBe("ab.txt");
    expect(safeFilename("", "fallback.bin")).toBe("fallback.bin");
  });

  it("estimates decoded sizes", () => {
    expect(decodedSize(78, "base64")).toBe(57);
    expect(decodedSize(100, "7bit")).toBe(100);
  });
});

describe("syntheticMessage", () => {
  it("replaces the top-level content headers, keeps the rest byte for byte", () => {
    const headers = Buffer.from("Subject: =?UTF-8?Q?H=C3=A9llo?=\r\nContent-Type: multipart/mixed;\r\n boundary=\"old\"\r\nX-Raw: caf\xe9\r\n\r\n", "latin1");
    const msg = syntheticMessage(headers, [{ mime: "Content-Type: text/html\r\n\r\n", body: Buffer.from("<p>hi</p>") }], "B");
    const text = msg.toString("latin1");
    expect(text).toContain("Subject: =?UTF-8?Q?H=C3=A9llo?=\r\n");
    expect(text).toContain("X-Raw: caf\xe9\r\n");
    expect(text).not.toContain('boundary="old"');
    expect(text).toContain('Content-Type: multipart/related; boundary="B"\r\n\r\n--B\r\nContent-Type: text/html\r\n\r\n<p>hi</p>\r\n--B--\r\n');
  });

  it("rebuilds part headers from BODYSTRUCTURE (no header injection)", () => {
    expect(partHeaders(leaf({ type: "TEXT/HTML", parameters: { charset: "utf-8" }, encoding: "QUOTED-PRINTABLE" }))).toBe(
      'Content-Type: text/html; charset="utf-8"\r\nContent-Transfer-Encoding: quoted-printable',
    );
    expect(partHeaders(leaf({ type: "image/png", id: "<logo@x>", disposition: "inline", encoding: "base64", parameters: { name: "l.png" } }))).toBe(
      "Content-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <logo@x>\r\nContent-Disposition: inline",
    );
    expect(partHeaders(leaf({ type: "text/plain", parameters: { charset: 'x"\r\nBcc: evil@x' } }))).not.toMatch(/\r\nBcc/);
  });

  it("strips folded content headers", () => {
    expect(stripContentHeaders("A: 1\r\nContent-Type: x;\r\n\ty=1\r\nB: 2\r\n")).toBe("A: 1\r\nB: 2");
  });
});
