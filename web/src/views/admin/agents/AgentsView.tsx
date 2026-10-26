import { errorMessage } from "@gilbert/shared/errors";
import { Fragment, useCallback, useEffect, useState } from "react";
import { type FactView, fetchFacts } from "@/lib/agentAdmin";
import { t } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { useMail } from "@/store/mail";
import { AgentGeneral } from "./AgentGeneral";
import { AgentGroup } from "./AgentGroup";
import { AgentMemory } from "./AgentMemory";
import { AgentOverview } from "./AgentOverview";

/**
 * The installation's agent, in one place: the document that configures it, the
 * rule and memory that are the installation's, and one tab per group it works.
 *
 * The installation's document is its own administration section; what is here
 * is the agent's part of it — the model, the standing rule, the memory — and one
 * tab per group it works, with that group's rules and runs.
 *
 * Tabs are mounted the first time they are opened and kept mounted afterwards,
 * so an edit in progress survives a look at another tab; the hidden panels cost
 * nothing and no group's prose is read until its tab is visited.
 */
const OVERVIEW = "overview";
const GENERAL = "general";
const MEMORY = "memory";

export function AgentsView() {
  const groups = groupMailboxAccounts(useMail((s) => s.mailAccounts));
  const entries: Array<{ id: string; label: string; accountId?: string }> = [
    { id: OVERVIEW, label: t("Overview") },
    { id: GENERAL, label: t("General") },
    { id: MEMORY, label: t("Memory") },
    ...groups.map((g) => ({
      id: `group:${g.name}`,
      label: g.name,
      accountId: g.accountId,
    })),
  ];
  const [tab, setTab] = useState(OVERVIEW);
  const [visited, setVisited] = useState<ReadonlySet<string>>(new Set([OVERVIEW]));
  /*
   * The groups are the session's, read live: one the Master is taken out of
   * stops being a tab, and a page still pointing at it would show nothing at
   * all. The selection falls back to General, and the panel of a group that is
   * gone is unmounted with it.
   */
  const active = entries.some((entry) => entry.id === tab) ? tab : OVERVIEW;
  const groupNames = groups.map((group) => group.name).join("\n");
  useEffect(() => {
    const live = new Set(entries.map((entry) => entry.id));
    setVisited((held) => {
      const next = new Set([...held].filter((id) => live.has(id)));
      next.add(active);
      const same = next.size === held.size && [...held].every((id) => next.has(id));
      return same ? held : next;
    });
    // `entries` is rebuilt every render; the names and the selection are what
    // change what a tab is.
  }, [groupNames, active]);

  const [facts, setFacts] = useState<FactView[]>([]);
  const [factProblems, setFactProblems] = useState<string[]>([]);
  const [factTotal, setFactTotal] = useState(0);
  const [factsMore, setFactsMore] = useState(false);
  const [factsError, setFactsError] = useState<string | null>(null);

  const loadFacts = useCallback(async () => {
    setFactsError(null);
    try {
      const reading = await fetchFacts();
      setFacts(reading.facts);
      setFactProblems(reading.problems);
      setFactTotal(reading.total);
      setFactsMore(reading.more);
    } catch (err) {
      setFactsError(errorMessage(err));
    }
  }, []);

  /** The next page, from the last id this reader holds. */
  const loadMoreFacts = useCallback(async () => {
    const last = facts[facts.length - 1]?.id;
    if (!last) return;
    try {
      const reading = await fetchFacts(last);
      setFacts((held) => [...held, ...reading.facts]);
      setFactProblems(reading.problems);
      setFactTotal(reading.total);
      setFactsMore(reading.more);
    } catch (err) {
      setFactsError(errorMessage(err));
    }
  }, [facts]);

  useEffect(() => {
    void loadFacts();
  }, [loadFacts]);

  const select = (id: string) => {
    setVisited((held) => (held.has(id) ? held : new Set(held).add(id)));
    setTab(id);
    document.getElementById(`agents-${id}`)?.focus();
  };

  const neighbour = (id: string, delta: number): string => {
    const index = entries.findIndex((entry) => entry.id === id);
    const next = (index + delta + entries.length) % entries.length;
    return entries[next]?.id ?? id;
  };

  return (
    <div>
      <div className="tabs" role="tablist" aria-label={t("AI Agents")}>
        {entries.map((entry, i) => (
          <Fragment key={entry.id}>
            {/* The views and the groups are two different things in one row: a
                group is a subject, not a page. The heading says which is which
                without giving the group its own tablist to navigate. */}
            {entry.accountId && !entries[i - 1]?.accountId && (
              <span className="tabs-label">{t("Groups")}</span>
            )}
            <button
              type="button"
              className="tab"
              role="tab"
              id={`agents-${entry.id}`}
              aria-selected={active === entry.id}
              aria-controls={`agents-${entry.id}-panel`}
              tabIndex={active === entry.id ? 0 : -1}
              onClick={() => select(entry.id)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                  event.preventDefault();
                  select(neighbour(entry.id, 1));
                } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                  event.preventDefault();
                  select(neighbour(entry.id, -1));
                }
              }}
            >
              {entry.label}
            </button>
          </Fragment>
        ))}
      </div>
      {entries
        .filter((entry) => visited.has(entry.id))
        .map((entry) => (
          <div
            key={entry.id}
            id={`agents-${entry.id}-panel`}
            role="tabpanel"
            aria-labelledby={`agents-${entry.id}`}
            hidden={active !== entry.id}
          >
            {entry.id === OVERVIEW && (
              <AgentOverview groups={groups} facts={factTotal} memory={facts} />
            )}
            {entry.id === GENERAL && <AgentGeneral onDocumentSaved={() => undefined} />}
            {entry.id === MEMORY && (
              <AgentMemory
                facts={facts}
                problems={factProblems}
                error={factsError}
                onChanged={loadFacts}
                more={factsMore}
                onMore={loadMoreFacts}
              />
            )}
            {entry.id.startsWith("group:") && (
              <AgentGroup
                group={entry.id.slice("group:".length)}
                accountId={entry.accountId}
                facts={facts}
              />
            )}
          </div>
        ))}
    </div>
  );
}
