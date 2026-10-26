/**
 * The lines of the thread a message belongs to (ADR 0038).
 *
 * A case is known by the reference its thread carries, and the person who sent it
 * lives across the whole conversation: a turn handed one message alone looks for the
 * rest by hand, which is where the failing runs of 2026-10-26 spent their first ten
 * steps. What is answered here is **lines** — who, when, what it was about — never a
 * body: the run opens the one message it needs.
 *
 * JMAP's own route to a thread is `Thread/get`, reached from the message's
 * `threadId`: a thread has no filter of its own, and `Email/query` cannot ask for one.
 */
import { type Ctx } from "../appFolder.js";
import { CAPABILITIES } from "../shared/capabilities.js";
import { isRecord } from "../shared/json.js";
import { clientOf } from "../util.js";

/** The most lines a case's thread carries into a turn. */
export const THREAD_LINES_MAX = 20;

/** One line of a thread: who wrote it, when, and what it was about. */
export interface ThreadLine {
  at: string;
  from: string;
  subject: string;
  /** Whether the message carries an attachment, which is often what the case is. */
  attachments: boolean;
}

/**
 * The thread a message belongs to, oldest first, bounded.
 *
 * Two calls: the message's own `threadId`, then the thread's messages without their
 * bodies. A message the server no longer holds answers the empty list — the thread is
 * an advantage, never a reason the run cannot start.
 */
export async function threadLines(
  ctx: Ctx,
  accountId: string,
  messageId: string,
  limit = THREAD_LINES_MAX,
): Promise<ThreadLine[]> {
  const client = clientOf(ctx);
  const held = await client.call<{ list?: unknown[] }>(
    "Email/get",
    { accountId, ids: [messageId], properties: ["threadId"] },
    [CAPABILITIES.mail],
  );
  const first = held.list?.[0];
  const threadId =
    isRecord(first) && typeof first.threadId === "string" ? first.threadId : null;
  if (!threadId) return [];

  const thread = await client.call<{ list?: unknown[] }>(
    "Thread/get",
    { accountId, ids: [threadId] },
    [CAPABILITIES.mail],
  );
  const one = thread.list?.[0];
  const ids =
    isRecord(one) && Array.isArray(one.emailIds)
      ? one.emailIds.filter((id): id is string => typeof id === "string")
      : [];
  if (!ids.length) return [];

  const messages = await client.call<{ list?: unknown[] }>(
    "Email/get",
    {
      accountId,
      ids,
      properties: ["from", "subject", "receivedAt", "sentAt", "hasAttachment"],
    },
    [CAPABILITIES.mail],
  );
  const lines = (messages.list ?? []).flatMap((one): ThreadLine[] => {
    if (!isRecord(one)) return [];
    const from = isRecord(one.from) && Array.isArray(one.from) ? one.from[0] : null;
    const address =
      isRecord(from) && typeof from.email === "string" ? String(from.email) : "(unknown)";
    const name = isRecord(from) && typeof from.name === "string" ? `${from.name} ` : "";
    return [
      {
        at:
          typeof one.receivedAt === "string"
            ? one.receivedAt
            : typeof one.sentAt === "string"
              ? one.sentAt
              : "",
        from: `${name}<${address}>`.trim(),
        subject: typeof one.subject === "string" ? one.subject : "(no subject)",
        attachments: one.hasAttachment === true,
      },
    ];
  });
  /*
   * JMAP answers a `get` by ids without promising an order, and the window is the
   * newest lines of the conversation: sort by the moment each was received so the
   * slice drops the oldest, whatever order the server answered in.
   */
  lines.sort((a, b) => a.at.localeCompare(b.at));
  return lines.slice(-limit);
}
