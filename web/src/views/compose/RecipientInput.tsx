import { Users, X } from "lucide-react";
import {
  type ClipboardEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import type { EmailAddress } from "@/jmap/types";
import { displayName, isValidEmail, parseAddressList } from "@/lib/address";
import { plural, t } from "@/lib/i18n";
import { type Suggestion, useContacts } from "@/store/contacts";
import { Avatar } from "@/ui/misc";
import { toast } from "@/ui/toast";

interface Props {
  value: EmailAddress[];
  onChange: (v: EmailAddress[]) => void;
  placeholder?: string;
  autoFocus?: boolean;
  id?: string;
}

export function RecipientInput({ value, onChange, placeholder, autoFocus, id }: Props) {
  const [text, setText] = useState("");
  const [sugg, setSugg] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggest = useContacts((s) => s.suggest);
  const reqId = useRef(0);

  useEffect(() => {
    const q = text.trim();
    if (!q) {
      setSugg([]);
      setOpen(false);
      return;
    }
    const id = ++reqId.current;
    const t = window.setTimeout(() => {
      void suggest(q).then((list) => {
        if (id !== reqId.current) return;
        const existing = new Set(value.map((v) => v.email.toLowerCase()));
        const filtered = list.filter((s) => !existing.has(s.email.toLowerCase()));
        setSugg(filtered);
        setActive(0);
        setOpen(filtered.length > 0);
      });
    }, 120);
    return () => window.clearTimeout(t);
  }, [text, suggest, value]);

  const commit = (raw?: string) => {
    const s = (raw ?? text).trim().replace(/[,;]+$/, "");
    if (!s) return;
    const parsed = parseAddressList(s);
    if (!parsed.length) return;
    onChange([
      ...value,
      ...parsed.filter(
        (p) => !value.some((v) => v.email.toLowerCase() === p.email.toLowerCase()),
      ),
    ]);
    setText("");
    setOpen(false);
  };

  const pick = (s: Suggestion) => {
    if (s.group) {
      /*
       * A group is chosen as a whole and becomes the people in it (ADR 0004):
       * the members are the cards of the account the group lives in, one
       * address each, and anyone already addressed is not written twice. What
       * could not be resolved is counted and said -- a group that silently
       * drops three people is worse than one that refuses.
       */
      const contacts = useContacts.getState();
      const card = contacts.cardsIn(s.group.accountId).find((c) => c.id === s.contactId);
      const { addresses, skipped } = card
        ? contacts.expandGroup(card, s.group.accountId)
        : { addresses: [], skipped: 0 };
      const known = new Set(value.map((v) => v.email.toLowerCase()));
      const added = addresses.filter((a) => !known.has(a.email.toLowerCase()));
      if (added.length) onChange([...value, ...added]);
      if (skipped)
        toast.show(
          plural(
            skipped,
            {
              one: "{n} member of {group} has no address and was not added.",
              other: "{n} members of {group} have no address and were not added.",
            },
            { group: s.name ?? "" },
          ),
        );
      setText("");
      setOpen(false);
      inputRef.current?.focus();
      return;
    }
    onChange([...value, { name: s.name, email: s.email }]);
    setText("");
    setOpen(false);
    inputRef.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (open && sugg.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % sugg.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + sugg.length) % sugg.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (sugg[active]) {
          e.preventDefault();
          pick(sugg[active]!);
          return;
        }
      }
      if (e.key === "Escape") {
        setOpen(false);
        e.stopPropagation();
        return;
      }
    }
    if (e.key === "Enter" || e.key === "," || e.key === ";") {
      if (text.trim()) {
        e.preventDefault();
        commit();
      } else if (e.key === "Enter") e.preventDefault();
    } else if (e.key === "Tab" && text.trim()) {
      commit();
    } else if (e.key === "Backspace" && !text && value.length) {
      const last = value[value.length - 1]!;
      onChange(value.slice(0, -1));
      setText(last.name ? `${last.name} <${last.email}>` : last.email);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const t = e.clipboardData.getData("text");
    if (t && /[,;\n]|<.+@.+>/.test(t)) {
      e.preventDefault();
      commit(text + t);
    }
  };

  return (
    <div className="recipients" onClick={() => inputRef.current?.focus()}>
      {value.map((a, i) => (
        <span
          key={`${a.email}-${i}`}
          className={`chip ${isValidEmail(a.email) ? "" : "invalid"}`}
          title={a.email}
        >
          <span className="truncate" style={{ maxWidth: 220 }}>
            {a.name ? displayName(a) : a.email}
          </span>
          <button
            type="button"
            className="chip-x"
            aria-label={t("Remove {email}", { email: a.email })}
            onClick={(e) => {
              e.stopPropagation();
              onChange(value.filter((_, j) => j !== i));
            }}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        id={id}
        ref={inputRef}
        value={text}
        autoFocus={autoFocus}
        placeholder={value.length ? "" : placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onPaste={onPaste}
        onBlur={() => {
          window.setTimeout(() => {
            setOpen(false);
            if (text.trim()) commit();
          }, 150);
        }}
        onFocus={() => sugg.length && setOpen(true)}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-autocomplete="list"
        aria-expanded={open}
      />
      {open && (
        <div className="suggest-list" role="listbox">
          {sugg.map((s, i) => (
            <div
              key={s.contactId ?? s.email}
              className={`suggest-item ${i === active ? "active" : ""}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {s.group ? (
                <Users size={16} className="faint" />
              ) : (
                <Avatar who={s} size="sm" />
              )}
              <div className="col" style={{ minWidth: 0 }}>
                <span className="s-name truncate">{s.name ?? s.email}</span>
                <span className="s-email truncate">
                  {s.group
                    ? plural(s.group.members, {
                        one: "group · {n} member",
                        other: "group · {n} members",
                      })
                    : s.name
                      ? s.email
                      : ""}
                </span>
              </div>
              <span className="s-src">
                {s.source === "gal" ? "Directory" : s.source === "recent" ? "Recent" : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
