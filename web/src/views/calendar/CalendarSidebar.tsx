import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  MoreVertical,
  Pencil,
  Plus,
  Share2,
  Star,
  Trash2,
  Upload,
  UserMinus,
  X,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import type { Calendar, Id } from "@/jmap/types";
import { BIRTHDAY_CALENDAR_ID } from "@/lib/birthdays";
import {
  addMonths,
  isSameDay,
  isToday,
  monthGrid,
  startOfDay,
  toLocalDateOnly,
} from "@/lib/dates";
import { formatMonthYear, formatWeekday } from "@/lib/datetime";
import { plural, t } from "@/lib/i18n";
import { groupMailboxAccounts } from "@/lib/mailAccounts";
import { sharedKey } from "@/lib/sharedKey";
import { subscriptionCalendarId, useCalendar } from "@/store/calendar";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { dateTimeKey, useSettings } from "@/store/settings";
import { confirmDialog } from "@/ui/dialog";
import { MenuItem, MenuSep, Popover, useMenu } from "@/ui/popover";
import { toast } from "@/ui/toast";
import { ShareDialog } from "../settings/ShareDialog";
import { CalendarDialog } from "./CalendarDialog";

export function CalendarSidebar() {
  const [location, navigate] = useLocation();
  const cal = useCalendar();
  const weekStart = useSettings((s) => s.settings.weekStart);
  const locale = useSettings((s) => dateTimeKey(s.settings));
  const parts = location.split("/");
  const view = parts[2] || "week";
  const dateStr = parts[3];
  const selected = useMemo(
    () => (dateStr ? new Date(`${dateStr}T00:00:00`) : new Date()),
    [dateStr],
  );
  const [anchor, setAnchor] = useState(() => startOfDay(selected));
  const grid = useMemo(() => monthGrid(anchor, weekStart), [anchor, weekStart]);
  const menu = useMenu();
  /*
   * The file picker for "Import iCAL file". A MenuItem is a button, so it
   * cannot wrap a hidden input the way the address-book import does; the input
   * lives at the end of the sidebar and the menu item reaches it through this.
   *
   * The calendar is remembered separately because opening the picker closes the
   * menu, and `menuCal` goes with it -- by the time a file comes back there
   * would be nothing left saying which calendar it was chosen for.
   */
  const fileRef = useRef<HTMLInputElement>(null);
  const importInto = useRef<Id | null>(null);

  /*
   * Handing the file over, which the browser only does from a click. The
   * revoke below is what keeps a calendar's worth of text from sitting in
   * memory after the download has started.
   */
  const exportFile = async (c: Calendar) => {
    try {
      const { text, count } = await cal.exportIcs(c.id);
      const url = URL.createObjectURL(new Blob([text], { type: "text/calendar" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${c.name.replace(/[^\w.-]+/g, "_") || "calendar"}.ics`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(
        plural(count, { one: "Exported {n} event", other: "Exported {n} events" }),
      );
    } catch (err) {
      toast.error(
        t("Could not export this calendar: {error}", { error: (err as Error).message }),
      );
    }
  };

  const importFile = async (file: File) => {
    const calendarId = importInto.current;
    if (!calendarId) return;
    try {
      const { created, updated } = await cal.importIcs(await file.text(), calendarId);
      /*
       * The two counts are kept apart on purpose, the way the contacts import
       * keeps them. "Imported 40 events" over a file of 240 reads as a failure
       * when the other 200 were updated, and a re-import of a corrected export
       * -- the reason for doing this at all -- creates nothing and would
       * otherwise report importing nothing at all.
       */
      const imported = plural(created, {
        one: "Imported {n} event",
        other: "Imported {n} events",
      });
      const refreshed = plural(updated, {
        one: "{n} updated",
        other: "{n} updated",
      });
      if (!created)
        toast.success(
          plural(updated, {
            one: "Updated {n} event, nothing new",
            other: "Updated {n} events, nothing new",
          }),
        );
      else if (updated) toast.success(`${imported} · ${refreshed}`);
      else toast.success(imported);
    } catch (err) {
      toast.error(
        t("Could not import this file: {error}", { error: (err as Error).message }),
      );
    }
  };
  /* Added if the server says so or the reader's settings do; Stalwart will not
     always take the flag, so the settings carry it where it refuses. */
  const addedShares = new Set(useSettings((s) => s.settings).addedShares);
  const isAdded = (c: {
    accountId: string;
    calendar: { id: string; isSubscribed?: boolean };
  }) =>
    Boolean(c.calendar.isSubscribed) ||
    addedShares.has(sharedKey(c.accountId, c.calendar.id));
  /* Accounts that are group mailboxes get their own calendar section; any
     other shared account (a colleague's calendar-only share) stays in the
     read-only area below the group sections. */
  const mailAccounts = useMail((s) => s.mailAccounts);
  /* The product-admin group is not a working group: it never gets a section
     or a "+", and its calendars fall into the read-only area below. */
  const groups = useMemo(() => groupMailboxAccounts(mailAccounts), [mailAccounts]);
  const groupIds = new Set(groups.map((g) => g.accountId));
  const sharedOnlySubscribed = cal.sharedCalendars.filter(
    (c) => !groupIds.has(c.accountId) && isAdded(c),
  );
  const sharedOnlyAvailable = cal.sharedCalendars.filter(
    (c) => !groupIds.has(c.accountId) && !isAdded(c),
  );

  const [menuCal, setMenuCal] = useState<Calendar | null>(null);
  /** The account the menu's calendar lives in; own when null/equal to own. */
  const [menuAccountId, setMenuAccountId] = useState<Id | null>(null);
  const [editCal, setEditCal] = useState<Partial<Calendar> | null>(null);
  const [editAccountId, setEditAccountId] = useState<Id | null>(null);
  const [share, setShare] = useState<Calendar | null>(null);

  /* Shared-calendar rows, used both under a group's section and in the
     read-only area for shares that are not a group. Keying is the caller's
     job (the row has no key of its own). */
  const subscribedRow = (accountId: Id, accountName: string, c: Calendar) => (
    <div
      className={`cal-list-item ${cal.hidden[sharedKey(accountId, c.id)] ? "hidden-cal" : ""}`}
      onClick={() => cal.toggleHidden(sharedKey(accountId, c.id))}
      title={`${c.name} — shared by ${accountName}`}
    >
      <span
        className="cal-color"
        style={{
          background: c.color ?? "var(--accent)",
          borderColor: c.color ?? "var(--accent)",
        }}
      />
      <span className="cal-name">{c.name}</span>
      <button
        className="icon-btn xs nav-more"
        title={t("Remove from my calendar")}
        aria-label={t("Remove from my calendar")}
        onClick={(e) => {
          e.stopPropagation();
          void cal.setSharedSubscribed(accountId, c.id, false);
        }}
      >
        <X size={14} />
      </button>
      <button
        className="icon-btn xs nav-more"
        aria-label={t("Calendar options")}
        title={c.name}
        onClick={(e) => {
          e.stopPropagation();
          setMenuCal(c);
          setMenuAccountId(accountId);
          menu.open(e);
        }}
      >
        <MoreVertical size={14} />
      </button>
    </div>
  );
  const availableRow = (accountId: Id, accountName: string, c: Calendar) => (
    <div className="cal-list-item" title={`${c.name} — from ${accountName}`}>
      <span
        className="cal-color"
        style={{
          background: "transparent",
          borderColor: c.color ?? "var(--border-strong)",
        }}
      />
      <span className="cal-name faint">{c.name}</span>
      <button
        className="icon-btn sm"
        title={t("Add to my calendar")}
        aria-label={t("Add to my calendar")}
        onClick={(e) => {
          e.stopPropagation();
          void cal.setSharedSubscribed(accountId, c.id, true);
        }}
      >
        <Plus size={14} />
      </button>
    </div>
  );
  const instances = cal.instancesIn(grid[0]!, new Date(grid[41]!.getTime() + 86400000));
  const dow = useMemo(
    () => grid.slice(0, 7).map((d) => formatWeekday(d, "narrow")),
    [grid, locale],
  );

  const birthdaysOn = useSettings((st) => st.settings.birthdayCalendar);
  const subscriptions = useSettings((st) => st.settings.icalSubscriptions);
  /*
   * Refreshed when the calendar is opened, and not on a timer. Gilbert has
   * nowhere to run a schedule -- no worker, no server-side state -- so the
   * honest guarantee is that a subscription is as current as the last time
   * somebody looked, which is also when it matters.
   */
  useEffect(() => {
    if (subscriptions.length) void useCalendar.getState().refreshSubscriptions();
  }, [subscriptions]);

  /*
   * The cards have to be loaded for there to be any birthdays to derive, and
   * the calendar is a view somebody can land on directly without ever opening
   * Contacts.
   */
  useEffect(() => {
    if (birthdaysOn && !useContacts.getState().loaded && !useContacts.getState().loading)
      void useContacts.getState().loadAll();
  }, [birthdaysOn]);

  if (!cal.available) return null;
  const calendars = Object.values(cal.calendars).sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );

  return (
    <div style={{ padding: "4px 8px" }}>
      <div className="mini-cal">
        <div className="mc-head">
          <button
            className="icon-btn xs"
            onClick={() => setAnchor(addMonths(anchor, -1))}
            aria-label={t("Previous month")}
          >
            <ChevronLeft size={16} />
          </button>
          <span>{formatMonthYear(anchor)}</span>
          <button
            className="icon-btn xs"
            onClick={() => setAnchor(addMonths(anchor, 1))}
            aria-label={t("Next month")}
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="mc-grid">
          {dow.map((d, i) => (
            <div key={i} className="mc-dow">
              {d}
            </div>
          ))}
          {grid.map((d) => (
            <div
              key={d.toISOString()}
              className={`mc-day ${d.getMonth() !== anchor.getMonth() ? "other" : ""} ${isToday(d) ? "today" : ""} ${isSameDay(d, selected) ? "selected" : ""} ${instances.some((i) => i.start < new Date(d.getTime() + 86400000) && i.end > d) ? "has-events" : ""}`}
              onClick={() =>
                navigate(
                  `/calendar/${view === "month" ? "day" : view}/${toLocalDateOnly(d)}`,
                )
              }
            >
              {d.getDate()}
            </div>
          ))}
        </div>
      </div>
      <div className="nav-section" style={{ paddingLeft: 4 }}>
        <span>{t("My calendars")}</span>
        <button
          className="icon-btn"
          title={t("New calendar")}
          onClick={() => setEditCal({})}
        >
          <Plus size={16} />
        </button>
      </div>
      {/* Derived, so no context menu and nothing to share or make default --
          it is a switch, and Settings is where it is turned off entirely. */}
      {birthdaysOn && (
        <div
          className={`cal-list-item ${cal.hidden[BIRTHDAY_CALENDAR_ID] ? "hidden-cal" : ""}`}
          onClick={() => cal.toggleHidden(BIRTHDAY_CALENDAR_ID)}
          title={t("From the birthdays on your contacts. Nothing is stored.")}
        >
          <span
            className="cal-color"
            style={{ background: "#e0a33e", borderColor: "#e0a33e" }}
          />
          <span className="cal-name">{t("Birthdays")}</span>
        </div>
      )}
      {subscriptions.map((sub) => {
        const id = subscriptionCalendarId(sub.id);
        const failed = cal.subscriptionErrors[sub.id];
        const count = cal.subscriptionEvents[sub.id]?.length ?? 0;
        return (
          <div
            key={id}
            className={`cal-list-item ${cal.hidden[id] ? "hidden-cal" : ""}`}
            onClick={() => cal.toggleHidden(id)}
            title={
              failed
                ? t("Could not read this calendar: {reason}", { reason: failed })
                : t("Subscribed to {url}", { url: sub.url })
            }
          >
            <span
              className="cal-color"
              style={{ background: sub.color, borderColor: sub.color }}
            />
            <span className="cal-name">{sub.name}</span>
            {/* A subscription that cannot be read says so here rather than
                drawing an empty calendar, which looks like a calendar with
                nothing in it. */}
            {failed ? (
              <AlertTriangle
                size={12}
                className="faint"
                aria-label={t("Could not be read")}
              />
            ) : count === 0 ? null : null}
          </div>
        );
      })}
      {calendars.map((c) => (
        <div
          key={c.id}
          className={`cal-list-item ${cal.hidden[c.id] ? "hidden-cal" : ""}`}
          onClick={() => cal.toggleHidden(c.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenuCal(c);
            setMenuAccountId(cal.accountId);
            menu.openAt(e.clientX, e.clientY);
          }}
        >
          <span
            className="cal-color"
            style={{
              background: c.color ?? "var(--accent)",
              borderColor: c.color ?? "var(--accent)",
            }}
          />
          <span className="cal-name">{c.name}</span>
          {Object.keys(c.shareWith ?? {}).length > 0 && (
            <Share2 size={12} className="faint" aria-label={t("Shared")} />
          )}
          {c.isDefault && <Star size={12} className="faint" />}
          <button
            className="icon-btn xs nav-more"
            onClick={(e) => {
              e.stopPropagation();
              setMenuCal(c);
              setMenuAccountId(cal.accountId);
              menu.open(e);
            }}
            aria-label={t("Calendar options")}
          >
            <MoreVertical size={14} />
          </button>
        </div>
      ))}
      {/* Calendars other people shared, split by whether the reader has added
          them. Stalwart returns every calendar in a reachable account with full
          rights, so "shared with me" and "there is an account here at all" look
          identical -- `isSubscribed` is the only thing that tells them apart,
          and adding one is a deliberate act rather than a guess on our part. */}
      {groups.map((g) => (
        <Fragment key={g.accountId}>
          <div className="nav-section">
            <span>{g.name}</span>
            <button
              className="icon-btn xs"
              title={t("New calendar in {group}", { group: g.name })}
              aria-label={t("New calendar in {group}", { group: g.name })}
              onClick={() => {
                setEditCal({});
                setEditAccountId(g.accountId);
              }}
            >
              <Plus size={16} />
            </button>
          </div>
          {cal.sharedCalendars
            .filter((c) => c.accountId === g.accountId)
            .map((c) => (
              <Fragment key={sharedKey(c.accountId, c.calendar.id)}>
                {isAdded(c)
                  ? subscribedRow(c.accountId, c.accountName, c.calendar)
                  : availableRow(c.accountId, c.accountName, c.calendar)}
              </Fragment>
            ))}
        </Fragment>
      ))}
      {sharedOnlySubscribed.length > 0 && (
        <>
          <div className="nav-section">
            <span>{t("Shared with me")}</span>
          </div>
          {sharedOnlySubscribed.map((c) => (
            <Fragment key={sharedKey(c.accountId, c.calendar.id)}>
              {subscribedRow(c.accountId, c.accountName, c.calendar)}
            </Fragment>
          ))}
        </>
      )}
      {sharedOnlyAvailable.length > 0 && (
        <>
          <div className="nav-section">
            <span>{t("Available to add")}</span>
          </div>
          {sharedOnlyAvailable.map((c) => (
            <Fragment key={sharedKey(c.accountId, c.calendar.id)}>
              {availableRow(c.accountId, c.accountName, c.calendar)}
            </Fragment>
          ))}
        </>
      )}

      <Popover
        anchor={menu.anchor}
        onClose={menu.close}
        trigger={menu.trigger}
        width={220}
      >
        {menuCal &&
          (() => {
            const shared = menuAccountId !== null && menuAccountId !== cal.accountId;
            const hidKey = shared ? `${menuAccountId}:${menuCal.id}` : menuCal.id;
            const hidden = Boolean(cal.hidden[hidKey]);
            return (
              <>
                <MenuItem
                  icon={hidden ? <Eye size={16} /> : <EyeOff size={16} />}
                  label={hidden ? "Show" : "Hide"}
                  onClick={() => cal.toggleHidden(hidKey)}
                />
                <MenuItem
                  icon={<Pencil size={16} />}
                  label={t("Edit")}
                  disabled={shared && !menuCal.myRights.mayWriteAll}
                  onClick={() => {
                    setEditCal(menuCal);
                    setEditAccountId(menuAccountId);
                  }}
                />
                <MenuItem
                  icon={<Upload size={16} />}
                  label={t("Import iCAL file…")}
                  disabled={
                    shared ||
                    (!menuCal.myRights.mayWriteAll && !menuCal.myRights.mayWriteOwn)
                  }
                  onClick={() => {
                    importInto.current = menuCal.id;
                    fileRef.current?.click();
                  }}
                />
                {/* No rights test: exporting is reading, and a calendar you cannot
                read is not in this list to begin with. Shared exports would
                need the owning account to read from, so they stay disabled. */}
                <MenuItem
                  icon={<Download size={16} />}
                  label={t("Export iCAL file")}
                  disabled={shared}
                  onClick={() => void exportFile(menuCal)}
                />
                <MenuItem
                  icon={<Share2 size={16} />}
                  label={t("Share…")}
                  disabled={shared || !menuCal.myRights.mayShare}
                  onClick={() => setShare(menuCal)}
                />
                {/* Revoking every share at once, without walking the dialog and
                removing people one at a time. Only offered when there is
                something to revoke. */}
                {!shared && Object.keys(menuCal.shareWith ?? {}).length > 0 && (
                  <MenuItem
                    icon={<UserMinus size={16} />}
                    label={t("Stop sharing")}
                    disabled={!menuCal.myRights.mayShare}
                    onClick={async () => {
                      const who = Object.keys(menuCal.shareWith ?? {}).length;
                      if (
                        !(await confirmDialog({
                          title: t("Stop sharing “{name}”?", { name: menuCal.name }),
                          message: plural(who, {
                            one: "{n} person will lose access. Events in it are not affected.",
                            other:
                              "{n} people will lose access. Events in it are not affected.",
                          }),
                          confirmLabel: t("Stop sharing"),
                          danger: true,
                        }))
                      )
                        return;
                      try {
                        await cal.updateCalendar(menuCal.id, { shareWith: null });
                        toast.success(t("No longer shared"));
                      } catch (err) {
                        toast.error((err as Error).message);
                      }
                    }}
                  />
                )}
                <MenuItem
                  icon={<Star size={16} />}
                  label={t("Make default")}
                  disabled={shared || menuCal.isDefault}
                  onClick={() =>
                    void cal
                      .updateCalendar(menuCal.id, {
                        isDefault: true,
                      } as Partial<Calendar>)
                      .catch((err) => toast.error((err as Error).message))
                  }
                />
                <MenuSep />
                <MenuItem
                  danger
                  icon={<Trash2 size={16} />}
                  label={t("Delete")}
                  disabled={shared || !menuCal.myRights.mayDelete}
                  onClick={async () => {
                    if (
                      await confirmDialog({
                        title: t("Delete “{name}”?", { name: menuCal.name }),
                        message: t("All events in this calendar will be deleted."),
                        confirmLabel: t("Delete"),
                        danger: true,
                      })
                    )
                      void cal
                        .destroyCalendar(menuCal.id)
                        .catch((err) => toast.error((err as Error).message));
                  }}
                />
              </>
            );
          })()}
      </Popover>
      {/* Cleared after every pick, so choosing the same file twice still counts
          as a change and fires again. */}
      <input
        ref={fileRef}
        type="file"
        accept=".ics,.ical,text/calendar"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void importFile(file);
        }}
      />
      {editCal && (
        <CalendarDialog
          calendar={editCal}
          accountId={editAccountId ?? undefined}
          onClose={() => {
            setEditCal(null);
            setEditAccountId(null);
          }}
        />
      )}
      {share && (
        <ShareDialog
          kind="Calendar"
          id={share.id}
          name={share.name}
          shareWith={share.shareWith}
          onClose={() => setShare(null)}
        />
      )}
    </div>
  );
}
