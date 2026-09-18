import { t } from "@/lib/i18n";

/**
 * Which day a week starts on.
 *
 * The three choices are the three the calendar arithmetic supports
 * (`weekStart` is `0 | 1 | 6`, Sunday / Monday / Saturday), and the control is
 * the same one in General and in Calendar: a setting that is one fact about the
 * account, offered wherever a week is drawn.
 *
 * `locked` is the policy's answer for the key, passed in rather than read here,
 * so the control does not decide for itself whether an installation has fixed
 * it — and a locked one goes visibly dead rather than silently ignoring a
 * change.
 */
export function WeekStartField({
  value,
  locked,
  onChange,
}: {
  value: 0 | 1 | 6;
  locked: boolean;
  onChange: (weekStart: 0 | 1 | 6) => void;
}) {
  return (
    <div className="field">
      <label>{t("Week starts on")}</label>
      <select
        disabled={locked}
        className="select"
        value={String(value)}
        onChange={(e) => onChange(Number(e.target.value) as 0 | 1 | 6)}
      >
        <option value="1">{t("Monday")}</option>
        <option value="0">{t("Sunday")}</option>
        <option value="6">{t("Saturday")}</option>
      </select>
    </div>
  );
}
