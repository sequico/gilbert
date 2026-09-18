import { useMemo, useState } from "react";
import { t, tNode } from "@/lib/i18n";
import { descendantKeywords, labelTree } from "@/lib/labelTree";
import { type LabelVisibility, useSettings } from "@/store/settings";
import { askNewLabel, LabelRow, NewLabelButton } from "@/views/labels/LabelCatalog";

export function LabelsSettings() {
  const labels = useSettings((s) => s.settings.labels);
  const update = useSettings((s) => s.update);
  const [editing, setEditing] = useState<string | null>(null);
  const roots = useMemo(() => labelTree(labels), [labels]);
  const descendantsOf = (keyword: string) => descendantKeywords(roots, keyword);

  const add = async () => {
    const label = await askNewLabel(labels);
    if (label) update({ labels: [...labels, label] });
  };

  return (
    <div>
      <h1>{t("Labels")}</h1>
      <p className="lead">
        {t(
          "Labels are IMAP keywords stored on your messages, so every other client sees them. Names, colours and nesting are Gilbert\u2019s own and follow your account. Nesting is display only \u2014 it rewrites nothing in the mailbox.",
        )}
      </p>
      {labels.map((l) => (
        <LabelRow
          key={l.keyword}
          labels={labels}
          label={l}
          onChange={(next) => update({ labels: next })}
          onDelete={() =>
            update({ labels: labels.filter((x) => x.keyword !== l.keyword) })
          }
          editing={editing === l.keyword}
          onEdit={setEditing}
        >
          <div className="field-row" style={{ marginTop: 10 }}>
            <div className="field">
              <label>{t("Nested under")}</label>
              <select
                className="select"
                value={l.parent ?? ""}
                onChange={(e) =>
                  update({
                    labels: labels.map((x) =>
                      x.keyword === l.keyword
                        ? { ...x, parent: e.target.value || undefined }
                        : x,
                    ),
                  })
                }
              >
                <option value="">{t("Nothing (top level)")}</option>
                {/* Itself and anything already beneath it are left out, so the
                    picker cannot be used to build a loop. */}
                {labels
                  .filter(
                    (c) =>
                      c.keyword !== l.keyword && !descendantsOf(l.keyword).has(c.keyword),
                  )
                  .map((c) => (
                    <option key={c.keyword} value={c.keyword}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="field">
              <label>{t("Show in the sidebar")}</label>
              <select
                className="select"
                value={l.visibility ?? "always"}
                onChange={(e) =>
                  update({
                    labels: labels.map((x) =>
                      x.keyword === l.keyword
                        ? { ...x, visibility: e.target.value as LabelVisibility }
                        : x,
                    ),
                  })
                }
              >
                <option value="always">{t("Always")}</option>
                <option value="unread">{t("Only when it has unread mail")}</option>
                <option value="hidden">{t("Never")}</option>
              </select>
            </div>
          </div>
        </LabelRow>
      ))}
      <NewLabelButton onClick={() => void add()} />
      <p className="hint mt-8">
        {tNode(
          "Tip: press {key} on a conversation to apply labels. Search with {operator}.",
          { key: <kbd className="kbd">l</kbd>, operator: <code>label:name</code> },
        )}
      </p>
    </div>
  );
}
