import { Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { labelKeywordFromName } from "@/lib/labelKeyword";
import type { Label } from "@/store/settings";
import { promptDialog } from "@/ui/dialog";
import { CALENDAR_COLORS, ColorSwatches } from "@/ui/misc";

/**
 * One label, as both catalogue editors draw it.
 *
 * A group's own catalogue (`views/admin/GroupLabels.tsx`, ADR 0005) and a
 * person's own labels (`views/settings/LabelsSettings.tsx`) are held in
 * different places and written through different doors — one is a document in
 * the group's Files, written as the installation's agent; the other is a
 * setting that follows the account. What a label *is* does not differ: the
 * colour dot, the name that becomes an input when it is clicked, the keyword
 * beside it that never changes, the delete button and the colour swatches are
 * the same row in both.
 *
 * The surface keeps what is its own: what a delete asks first, and whatever
 * else it edits — the settings surface's nesting and sidebar visibility arrive
 * as `children`, below the colour swatches.
 *
 * Every edit replaces the whole catalogue, which is how both surfaces write it:
 * `update({ labels })` for the account's own settings, and one `POST` of the
 * list for a group's. That is why a row hands back `labels` rather than a
 * patch.
 */
export interface LabelRowProps {
  /** The catalogue this row belongs to, as it stands. */
  labels: Label[];
  label: Label;
  onChange: (labels: Label[]) => void;
  /** Delete this label. What that asks first is the surface's business. */
  onDelete: () => void;
  /** True while this row's name is an input. */
  editing: boolean;
  onEdit: (keyword: string | null) => void;
  /** A write is in flight: the delete button goes dead. */
  busy?: boolean;
  /** Anything this surface edits besides the name and the colour. */
  children?: ReactNode;
}

export function LabelRow({
  labels,
  label,
  onChange,
  onDelete,
  editing,
  onEdit,
  busy,
  children,
}: LabelRowProps) {
  const rename = (name: string) =>
    onChange(
      labels.map((x) => (x.keyword === label.keyword ? { ...x, name: name || x.name } : x)),
    );

  return (
    <div className="card">
      <div className="card-head">
        <span
          className="label-dot"
          style={{ background: label.color, width: 14, height: 14 }}
        />
        {editing ? (
          <input
            className="input sm"
            defaultValue={label.name}
            autoFocus
            onBlur={(e) => {
              rename(e.target.value.trim());
              onEdit(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            style={{ width: 240 }}
          />
        ) : (
          <h3 style={{ cursor: "text" }} onClick={() => onEdit(label.keyword)}>
            {label.name}{" "}
            <span className="hint" style={{ fontWeight: 400 }}>
              ({label.keyword})
            </span>
          </h3>
        )}
        <button
          className="icon-btn sm danger"
          aria-label={t("Delete label")}
          disabled={busy}
          onClick={onDelete}
        >
          <Trash2 size={16} />
        </button>
      </div>
      <div style={{ marginTop: 8 }}>
        <ColorSwatches
          value={label.color}
          onChange={(color) =>
            onChange(
              labels.map((x) => (x.keyword === label.keyword ? { ...x, color } : x)),
            )
          }
        />
      </div>
      {children}
    </div>
  );
}

/**
 * Ask for a new label and build the entry, or answer null.
 *
 * The same question in both surfaces, down to the colour: a fresh label takes
 * the next swatch of the fixed palette by how many there already are, so a list
 * that grows has distinguishable colours without anybody choosing one, and a
 * name that would collide with a keyword already in the catalogue is refused —
 * the keyword is the stable identity, so two labels cannot share it.
 */
export async function askNewLabel(labels: Label[]): Promise<Label | null> {
  const name = await promptDialog({
    title: t("New label"),
    placeholder: t("Label name"),
  });
  if (!name?.trim()) return null;
  const keyword = labelKeywordFromName(name);
  if (labels.some((l) => l.keyword === keyword)) return null;
  return {
    keyword,
    name: name.trim(),
    color: CALENDAR_COLORS[labels.length % CALENDAR_COLORS.length]!,
  };
}

/** The button both surfaces add a label with. */
export function NewLabelButton({
  onClick,
  busy,
}: {
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <button className="btn" disabled={busy} onClick={onClick}>
      <Plus size={16} /> {t("New label")}
    </button>
  );
}
