import { errorMessage } from "@gilbert/shared/errors";
import { ref } from "@gilbert/shared/jmapQuery";
import { create } from "zustand";
import { CAP, client, setErrorMessage } from "@/jmap/client";
import type {
  EmailSubmission,
  GetResponse,
  Id,
  Mailbox,
  QueryResponse,
  SetResponse,
} from "@/jmap/types";
import { t } from "@/lib/i18n";
import { canScheduleSend, maxDelayMs, type SubmissionCapability } from "@/lib/schedule";
import { toast } from "@/ui/toast";
import { useMail } from "./mail";
import { mailboxMap } from "./mail/mailboxes";
import { setEmails } from "./mail/mutations";
import { MAILBOX_PROPS } from "./mail/types";
import { useSession } from "./session";

/**
 * A held message lives in a folder of its own, the way Gmail's does, because
 * the alternatives are both wrong: leaving it in Drafts invites the user to
 * edit a message the queue has already frozen, and `onSuccessUpdateEmail`
 * files it in Sent the instant the submission is created -- which for a
 * scheduled send is a lie for however long the hold lasts.
 *
 * JMAP has no role for this (the IANA attribute registry has no `\Scheduled`),
 * so it is an ordinary folder found by name.
 */
const SCHEDULED_MAILBOX = "Scheduled";

/** What this account's server says about holding a message before sending it. */
function submissionCapability(): SubmissionCapability | undefined {
  const accountId = useMail.getState().accountId;
  if (!accountId) return undefined;
  return client.accountCapability<SubmissionCapability>(accountId, CAP.submission);
}

/** Whether to offer scheduled send at all. */
export function scheduleSupported(): boolean {
  return canScheduleSend(submissionCapability());
}

/** How far ahead this server will hold a message, in milliseconds. */
export function scheduleWindowMs(): number {
  return maxDelayMs(submissionCapability());
}

/** Whether this folder is the one held messages wait in. */
export function isScheduledMailbox(
  m: Pick<Mailbox, "role" | "parentId" | "name">,
): boolean {
  return (
    !m.role && !m.parentId && m.name.toLowerCase() === SCHEDULED_MAILBOX.toLowerCase()
  );
}

/** The Scheduled folder in a given set of mailboxes, if one exists yet. */
export function scheduledMailboxIdFrom(mailboxes: Record<Id, Mailbox>): Id | null {
  return Object.values(mailboxes).find(isScheduledMailbox)?.id ?? null;
}

/** The Scheduled folder, if one exists yet. */
export function scheduledMailboxId(): Id | null {
  return scheduledMailboxIdFrom(useMail.getState().mailboxes);
}

/** The Scheduled folder, creating it the first time something is scheduled. */
export async function ensureScheduledMailbox(accountId?: Id): Promise<Id> {
  const account = accountId ?? useMail.getState().accountId;
  if (!account) throw new Error("Not signed in");
  /*
   * The folder is looked for — and created — in the account that will hold the
   * message, which is not always the one on screen: a send inside the undo window
   * carries the account Send was pressed in, and a "Scheduled" created in
   * whichever mailbox the reader opened since would leave the message naming a
   * folder its own account does not hold, so the whole `Email/set` is refused and
   * a stray folder is left in the account they just opened.
   */
  const onScreen = useMail.getState().accountId === account;
  const ofAccount = async (): Promise<Record<Id, Mailbox>> =>
    onScreen
      ? useMail.getState().mailboxes
      : mailboxMap(
          (
            await client.call<GetResponse<Mailbox>>("Mailbox/get", {
              accountId: account,
              ids: null,
              properties: MAILBOX_PROPS,
            })
          ).list,
        );
  const existing = scheduledMailboxIdFrom(await ofAccount());
  if (existing) return existing;
  const res = await client.call<SetResponse<Mailbox>>("Mailbox/set", {
    accountId: account,
    create: { sched: { name: SCHEDULED_MAILBOX, parentId: null, isSubscribed: true } },
  });
  const err = res.notCreated?.sched;
  // A racing tab (or another client) may have created it between the two calls.
  if (err) {
    const again = scheduledMailboxIdFrom(await ofAccount());
    if (again) return again;
    throw new Error(setErrorMessage(err));
  }
  const id = res.created!.sched!.id;
  if (onScreen) await useMail.getState().loadMailboxes();
  return id;
}

interface PendingSend {
  id: Id;
  emailId: Id;
  /** Epoch milliseconds, as the server settled on it. */
  sendAt: number;
  undoStatus: EmailSubmission["undoStatus"];
}

interface ScheduledState {
  /** Pending submissions, keyed by the message they will send. */
  pending: Record<Id, PendingSend>;
  /**
   * Why the queue could not be read, or `null` when it was.
   *
   * `pending` alone cannot say this: an empty map is "the server is holding
   * nothing", and a read that failed is a different answer that used to be
   * dressed as that one — the message view simply dropped the banner naming when
   * a message goes out, so a scheduled message looked unscheduled for the rest
   * of the session. This is the field the surface reads. It replaces `loaded`,
   * which was written by four call sites and read by none.
   */
  loadError: string | null;
  load(): Promise<void>;
  cancel(emailId: Id): Promise<void>;
  reconcile(): Promise<void>;
  reset(): void;
}

const SUB_PROPS = ["id", "emailId", "sendAt", "undoStatus"];

function toPending(s: EmailSubmission): PendingSend {
  return {
    id: s.id,
    emailId: s.emailId,
    sendAt: Date.parse(s.sendAt),
    undoStatus: s.undoStatus,
  };
}

/**
 * The submissions matching a filter, whatever the filter is.
 *
 * Two questions are asked of the queue — "what is still sitting in it" and "what
 * went out with these messages" — and they were two functions whose bodies
 * differed by one line, the filter. The query and the `/get` that follows it are
 * the same pair either way, and a property list that drifted between them would
 * show a submission missing a field in one list and carrying it in the other.
 */
async function loadWhere(
  accountId: Id,
  filter: { undoStatus?: "pending"; emailIds?: Id[] },
): Promise<PendingSend[]> {
  const res = await client.chain([
    ["EmailSubmission/query", { accountId, filter }, "q"],
    [
      "EmailSubmission/get",
      {
        accountId,
        "#ids": ref("q", "EmailSubmission/query", "/ids"),
        properties: SUB_PROPS,
      },
      "g",
    ],
  ]);
  const got = res.get("g")?.[0] as unknown as GetResponse<EmailSubmission> | undefined;
  return (got?.list ?? []).map(toPending);
}

/** Every submission still sitting in the server's queue. */
async function loadPending(accountId: Id): Promise<PendingSend[]> {
  return loadWhere(accountId, { undoStatus: "pending" });
}

/** The submissions belonging to a specific set of messages, whatever their status. */
async function loadFor(accountId: Id, emailIds: Id[]): Promise<PendingSend[]> {
  // An empty list is not a filter the server answers, it is the question of
  // whether there is one at all: `filter: { emailIds: [] }` is a request with
  // no ids, and some servers refuse it.
  if (!emailIds.length) return [];
  return loadWhere(accountId, { emailIds });
}

export const useScheduled = create<ScheduledState>((set, get) => ({
  pending: {},
  loadError: null,

  async load() {
    const accountId = useMail.getState().accountId;
    if (!accountId) return;
    try {
      const list = await loadPending(accountId);
      const pending: Record<Id, PendingSend> = {};
      for (const s of list) pending[s.emailId] = s;
      set({ pending, loadError: null });
    } catch (err) {
      /*
       * What was known is kept, and the failure is said. Clearing `pending`
       * would answer "nothing is waiting to be sent" to a question that was
       * never answered, and a message already scheduled would lose the banner
       * naming when it goes out — the reader's only sign that it is on its way.
       * A server without the submission capability refuses this query too, so it
       * lands here rather than in a branch of its own; that is the same answer,
       * said the same way.
       */
      set({ loadError: errorMessage(err) });
    }
  },

  async cancel(emailId) {
    const accountId = useMail.getState().accountId!;
    const sub = get().pending[emailId];
    if (!sub) throw new Error("This message is no longer waiting to be sent");
    const draftsId = useMail.getState().roleId("drafts");
    const scheduledId = scheduledMailboxId();
    // Not `onSuccessUpdateEmail`: RFC 8621 keys it by submission id, but
    // Stalwart takes a plain key as an Email id and would patch the wrong
    // object. Moving the message back is a separate call in the same request.
    const res = await client.chain(
      [
        [
          "EmailSubmission/set",
          { accountId, update: { [sub.id]: { undoStatus: "canceled" } } },
          "s",
        ],
        [
          "Email/set",
          {
            accountId,
            update: {
              [emailId]: {
                "keywords/$draft": true,
                ...(draftsId ? { [`mailboxIds/${draftsId}`]: true } : {}),
                ...(scheduledId ? { [`mailboxIds/${scheduledId}`]: null } : {}),
              },
            },
          },
          "e",
        ],
      ],
      { allowErrors: true },
    );
    const subRes = res.get("s")?.[0] as unknown as SetResponse & {
      __error?: { type: string; description?: string };
    };
    const emailRes = res.get("e")?.[0] as unknown as SetResponse & {
      __error?: { type: string; description?: string };
    };
    const subError = subRes.__error ?? subRes.notUpdated?.[sub.id];
    if (subError) throw new Error(setErrorMessage(subError));
    // The message must be back in Drafts too: a cancelled submission whose
    // mailbox move failed leaves it stranded in Scheduled with no pending
    // entry, so the move is checked before the pending record is dropped.
    const emailError = emailRes.__error ?? emailRes.notUpdated?.[emailId];
    if (emailError) throw new Error(setErrorMessage(emailError));
    set((s) => {
      const { [emailId]: _drop, ...rest } = s.pending;
      return { pending: rest };
    });
    const mail = useMail.getState();
    void mail.loadMailboxes();
    void mail.refreshList();
  },

  /**
   * Nothing moves a message out of Scheduled when its hold expires -- the
   * server sends it and updates the submission, but the message stays where we
   * filed it. So on the way into the folder, settle up: what went out belongs
   * in Sent, what was cancelled elsewhere belongs back in Drafts.
   */
  async reconcile() {
    const mail = useMail.getState();
    const accountId = mail.accountId;
    const scheduledId = scheduledMailboxId();
    if (!accountId || !scheduledId) return;
    try {
      // Page the whole folder: a single page silently leaves everything past
      // the first page held in Scheduled, never settled into Sent or Drafts.
      const pageSize = 200;
      const ids: Id[] = [];
      for (let position = 0; ; position += pageSize) {
        const page = await client.call<QueryResponse>("Email/query", {
          accountId,
          filter: { inMailbox: scheduledId },
          position,
          limit: pageSize,
        });
        ids.push(...page.ids);
        if (page.ids.length < pageSize) break;
      }
      if (!ids.length) {
        set({ pending: {} });
        return;
      }
      const subs = await loadFor(accountId, ids);
      // A message may carry several submissions if it was rescheduled. One
      // still pending settles it whatever the timestamps say -- the queue holds
      // a copy either way -- and otherwise the most recent wins.
      const latest = new Map<Id, PendingSend>();
      for (const s of subs) {
        const prev = latest.get(s.emailId);
        if (!prev) {
          latest.set(s.emailId, s);
          continue;
        }
        if (prev.undoStatus === "pending") continue;
        if (s.undoStatus === "pending" || s.sendAt >= prev.sendAt)
          latest.set(s.emailId, s);
      }
      const sentId = mail.roleId("sent");
      const draftsId = mail.roleId("drafts");
      const update: Record<Id, Record<string, unknown>> = {};
      const pending: Record<Id, PendingSend> = {};
      for (const emailId of ids) {
        const s = latest.get(emailId);
        if (s?.undoStatus === "pending") {
          pending[emailId] = s;
          continue;
        }
        // Cancelled goes back to Drafts; sent (or a submission the server no
        // longer knows about) goes to Sent, which is where it actually is.
        const toDrafts = s?.undoStatus === "canceled";
        const dest = toDrafts ? draftsId : sentId;
        if (!dest) continue;
        update[emailId] = {
          [`mailboxIds/${scheduledId}`]: null,
          [`mailboxIds/${dest}`]: true,
          ...(toDrafts ? { "keywords/$draft": true } : {}),
        };
      }
      if (Object.keys(update).length) {
        /*
         * A folder can hold more messages than one `Email/set` accepts, so the
         * move goes in batches the server will take (`setEmails`, the writer
         * every other move uses) and the pending list advances only once it
         * has landed: a refused or partial write must not leave the queue
         * claiming the mail is settled when it is still in Scheduled.
         */
        await setEmails(accountId, update);
        set({ pending });
        void mail.loadMailboxes();
        void mail.refreshList();
      } else {
        set({ pending });
      }
    } catch (err) {
      toast.error(
        t("Could not update the Scheduled folder: {error}", {
          error: errorMessage(err),
        }),
      );
    }
  },
  reset: () => set({ pending: {}, loadError: null }),
}));

// A session ending drops the pending list: it names submissions of an account
// nobody is signed into any more, and the next sign-in's load is what fills it.
useSession.subscribe((s) => {
  if (s.status !== "authenticated") useScheduled.getState().reset();
});
