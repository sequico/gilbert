import type { ChangeEvent } from "react";

/**
 * The two checkboxes a list with a selection is made of.
 *
 * One definition for every list that has one -- the mail list, the contact list
 * and the Files list -- because the two rules they carry are not obvious enough
 * to be re-derived beside each list:
 *
 *  - **A row's box is not the row.** Ticking it must not also open, navigate or
 *    activate what it belongs to, so the click stops where it lands and only the
 *    change travels.
 *  - **The header's box has three states.** HTML has an `indeterminate`
 *    property and no attribute for it, so it can only be set on the element --
 *    and a list that forgets to is one whose "some rows are ticked" state is
 *    invisible, which is how a reader selects all of something they had picked
 *    a part of.
 *
 * The class names are each list's own, so the stylesheet can address the three
 * separately where their surroundings differ and together where they do not.
 */
export function SelectAllCheckbox({
  checked,
  partial,
  onChange,
  label,
  className = "select-all",
}: {
  checked: boolean;
  /** Some rows are ticked, but not all of them. */
  partial: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  label: string;
  className?: string;
}) {
  return (
    <input
      type="checkbox"
      className={className}
      aria-label={label}
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = partial;
      }}
      onChange={onChange}
    />
  );
}

export function RowCheckbox({
  checked,
  onChange,
  label,
  className,
}: {
  checked: boolean;
  /** What the row should be once the box has been clicked. */
  onChange: (checked: boolean) => void;
  label: string;
  className: string;
}) {
  return (
    <input
      type="checkbox"
      className={className}
      checked={checked}
      onClick={(ev) => ev.stopPropagation()}
      /*
       * A double click is its own event and follows its own path: the browser
       * dispatches it on the element the two clicks landed on and lets it
       * bubble, so a row with a double-click action -- opening a file, entering
       * a folder -- would run it on a box that was merely ticked twice. The
       * click is stopped so the box is not the row; the double click has to be
       * stopped for the same reason.
       */
      onDoubleClick={(ev) => ev.stopPropagation()}
      onChange={(ev) => onChange(ev.target.checked)}
      aria-label={label}
    />
  );
}
