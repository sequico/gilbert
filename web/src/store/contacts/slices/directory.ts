import { ref } from "@gilbert/shared/jmapQuery";
import { CAP, client } from "@/jmap/client";
import type { ContactCard, GetResponse, Principal } from "@/jmap/types";
import { contactDisplayName, contactEmails } from "@/lib/contacts";
import { accountOfSharedKey } from "@/lib/sharedKey";
import { accountKey, saveJson } from "@/lib/storage";
import { useSession } from "../../session";
import { sessionEpoch } from "../shared";
import type { ContactsGet, ContactsSet, ContactsState, Suggestion } from "../types";

/**
 * The directory, the suggestion list, and the addresses recently written to.
 *
 * A slice of the contacts store: the state is assembled in `../index`, and this
 * function only says what this job does with `set` and `get`.
 */
export function directorySlice(
  set: ContactsSet,
  get: ContactsGet,
): Pick<ContactsState, "loadPrincipals" | "suggest" | "addRecent" | "lookupByEmail"> {
  return {
    async loadPrincipals() {
      if (get().principalsLoaded) return;
      const accountId = useSession.getState().accountFor(CAP.principals);
      if (!accountId || !client.hasCapability(CAP.principals)) {
        set({ principalsLoaded: true });
        return;
      }
      const epoch = sessionEpoch;
      try {
        const res = await client.chain([
          ["Principal/query", { accountId, limit: 1000 }, "q"],
          [
            "Principal/get",
            {
              accountId,
              "#ids": ref("q", "Principal/query", "/ids"),
              properties: ["id", "type", "name", "description", "email", "timeZone"],
            },
            "g",
          ],
        ]);
        if (epoch !== sessionEpoch) return;
        const g = res.get("g")?.[0] as unknown as GetResponse<Principal>;
        set({ principals: g.list, principalsLoaded: true });
      } catch {
        if (epoch !== sessionEpoch) return;
        set({ principalsLoaded: true });
      }
    },

    async suggest(query, limit = 8) {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const st = get();
      if (!st.loaded && st.available && !st.loading) void st.loadAll();
      if (!st.principalsLoaded) void st.loadPrincipals();
      const out: Suggestion[] = [];
      const seen = new Set<string>();
      const add = (s: Suggestion) => {
        // A group has no address; its own key is its account and card. Without
        // this every group would answer to the empty string and only the first
        // would ever be offered.
        const k = s.group
          ? `group:${s.group.accountId}:${s.contactId ?? ""}`
          : s.email.toLowerCase();
        if (!k || seen.has(k)) return;
        seen.add(k);
        out.push(s);
      };
      /*
       * Words in any order: "jane smi" finds "Smith, Jane", and a nickname or
       * the organization counts as much as the name. Each word typed has to
       * start a word of the person's name, nickname, organization or address.
       */
      const tokens = q.split(/\s+/).filter(Boolean);
      const wordsOf = (parts: Array<string | null | undefined>) =>
        parts
          .flatMap((p) => (p ?? "").toLowerCase().split(/[\s,.;:@_+()<>"'-]+/))
          .filter(Boolean);
      const score = (
        name: string | null,
        email: string,
        extra: Array<string | null | undefined> = [],
      ): number => {
        const n = (name ?? "").toLowerCase();
        const e = email.toLowerCase();
        if (e.startsWith(q) || n.startsWith(q)) return 0;
        const words = wordsOf([name, email, ...extra]);
        if (tokens.every((t) => words.some((w) => w.startsWith(t)))) return 1;
        if (e.includes(q) || n.includes(q)) return 2;
        return 99;
      };
      /*
       * Someone written to lately ranks a little above someone not, within the
       * same kind of match -- the list of recent recipients is the only signal
       * the reader has given about who they write to.
       */
      const recentRank = new Map(
        st.recent.map((r, i) => [r.email.toLowerCase(), i] as const),
      );
      const recency = (email: string) => {
        const i = recentRank.get(email.toLowerCase());
        return i === undefined ? 0 : -0.3 * (1 - i / Math.max(1, st.recent.length));
      };
      const candidates: Array<Suggestion & { score: number }> = [];
      // A shared address book is only useful if it answers when you are writing
      // to someone in it, so its cards are offered alongside the reader's own.
      // They rank a shade lower, so a name in both wins from your own book.
      /* Own cards carry the reader's own account; a shared card carries the
         account it came from, which is what its key is made of -- a group's
         members are in that account, and a uid means nothing outside it. */
      const own = Object.values(st.cards).map((c) => ({
        c,
        penalty: 0,
        accountId: st.accountId,
      }));
      const shared = Object.entries(st.sharedCards).map(([key, c]) => ({
        c,
        penalty: 0.5,
        accountId: accountOfSharedKey(key, c.id),
      }));
      for (const { c, penalty, accountId } of [...own, ...shared]) {
        const extra = [
          ...Object.values(c.nicknames ?? {}).map((x) => x.name),
          ...Object.values(c.organizations ?? {}).map((x) => x.name),
        ];
        for (const a of contactEmails(c)) {
          const sc = score(a.name, a.email, extra);
          if (sc < 99)
            candidates.push({
              name: a.name,
              email: a.email,
              source: "contact",
              contactId: c.id,
              score: sc + penalty + recency(a.email),
            });
        }
        /*
         * A group is offered as one choice, and it expands when it is taken
         * (ADR 0003). It has no address of its own, so nothing here adds one;
         * what the row needs is a name, the account its members are in, and how
         * many there are.
         */
        if (c.kind === "group") {
          const name = contactDisplayName(c);
          const sc = score(name, "", extra);
          if (sc < 99)
            candidates.push({
              name,
              email: "",
              source: "contact",
              contactId: c.id,
              group: {
                accountId: accountId ?? st.accountId ?? "",
                members: Object.keys(c.members ?? {}).length,
              },
              score: sc + penalty,
            });
        }
      }
      for (const p of st.principals) {
        if (!p.email) continue;
        const sc = score(p.name, p.email);
        if (sc < 99)
          candidates.push({
            name: p.name,
            email: p.email,
            source: "gal",
            score: sc + 0.5 + recency(p.email),
          });
      }
      for (const r of st.recent) {
        const sc = score(r.name, r.email);
        if (sc < 99)
          candidates.push({
            name: r.name,
            email: r.email,
            source: "recent",
            score: sc + 0.25 + recency(r.email),
          });
      }
      candidates.sort(
        (a, b) =>
          a.score - b.score || (a.name ?? a.email).localeCompare(b.name ?? b.email),
      );
      for (const c of candidates) {
        add(c);
        if (out.length >= limit) break;
      }
      return out;
    },

    addRecent(addrs) {
      const cur = get().recent;
      const next = [
        ...addrs.filter((a) => a.email),
        ...cur.filter(
          (r) => !addrs.some((a) => a.email.toLowerCase() === r.email.toLowerCase()),
        ),
      ].slice(0, 200);
      set({ recent: next });
      try {
        saveJson(accountKey(get().accountId, "recent"), next);
      } catch {
        /* ignore */
      }
    },

    lookupByEmail(email) {
      const e = email.toLowerCase();
      const match = (c: ContactCard) =>
        Object.values(c.emails ?? {}).some((x) => x.address.toLowerCase() === e);
      // The reader's own books first: a card they wrote themselves should win
      // over a colleague's version of the same person.
      return (
        Object.values(get().cards).find(match) ??
        Object.values(get().sharedCards).find(match)
      );
    },
  };
}
