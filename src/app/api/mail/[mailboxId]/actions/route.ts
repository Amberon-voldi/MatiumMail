import { z } from "zod";
import { json, mailboxRoute, readJson } from "@/server/api";
import {
  archiveMessages,
  deleteMessages,
  emptyFolder,
  moveMessages,
  setFlags,
  spamMessages,
  trashMessages,
} from "@/server/mail/messages";

const ids = z.array(z.uuid()).min(1).max(500);

const action = z.discriminatedUnion("op", [
  z.object({ op: z.literal("flags"), ids, seen: z.boolean().optional(), flagged: z.boolean().optional() }),
  z.object({ op: z.literal("move"), ids, folderId: z.uuid() }),
  z.object({ op: z.literal("trash"), ids }),
  z.object({ op: z.literal("archive"), ids }),
  z.object({ op: z.literal("spam"), ids }),
  z.object({ op: z.literal("notSpam"), ids }),
  z.object({ op: z.literal("delete"), ids }),
  z.object({ op: z.literal("emptyFolder"), folderId: z.uuid() }),
]);

/** Organise messages: flags, move, archive, spam, trash, delete forever, empty Trash/Junk. */
export async function POST(request: Request, ctx: RouteContext<"/api/mail/[mailboxId]/actions">) {
  return mailboxRoute(request, ctx.params, "organise", async (auth) => {
    const a = await readJson(request, action);
    let count = 0;
    switch (a.op) {
      case "flags":
        await setFlags(auth, a.ids, { seen: a.seen, flagged: a.flagged });
        count = a.ids.length;
        break;
      case "move":
        count = await moveMessages(auth, a.ids, a.folderId);
        break;
      case "trash":
        count = await trashMessages(auth, a.ids);
        break;
      case "archive":
        count = await archiveMessages(auth, a.ids);
        break;
      case "spam":
      case "notSpam":
        count = await spamMessages(auth, a.ids, a.op === "spam");
        break;
      case "delete":
        count = await deleteMessages(auth, a.ids);
        break;
      case "emptyFolder":
        await emptyFolder(auth, a.folderId);
        break;
    }
    return json({ ok: true, count });
  });
}
