/**
 * A group's standing instruction (ADR 0003 resolution 17, ADR 0019).
 *
 * The second of the three levels of prose an agent carries: what is true of
 * this group, handed to the model on every call of the group's agent, after the
 * installation's own rules and before the automation's own instruction.
 *
 * It is one component of two — the installation's rules are the other — and
 * this file exists to say what this scope *is*, in the reader's language. The
 * document, its bound and the reading beside it are `ProsePanel`'s.
 */
import { t } from "@/lib/i18n";
import { ProsePanel } from "./ProsePanel";

export function GroupInstruction({ group }: { group: string }) {
  if (!group)
    return (
      <section>
        <h2>{t("Standing instruction")}</h2>
        <p className="hint">
          {t("No group is picked, so there is no standing instruction to read here.")}
        </p>
      </section>
    );
  return (
    <ProsePanel
      key={group}
      scope={group}
      heading={t("Standing instruction")}
      lead={t(
        "Written once for the whole group and handed to the model on every call, after the installation's own rules and before the automation's own instruction. It says how the agent should work; what an automation may do is its capability list, and nothing written here widens it.",
      )}
      label={t("How this group's agent works")}
      placeholder={t(
        "Write to the group in its own language, and always cite the invoice number.",
      )}
      readingAbout={t("the group's standing instruction")}
    />
  );
}
