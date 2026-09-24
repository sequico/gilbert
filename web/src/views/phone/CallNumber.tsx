import { usePhone } from "@/store/phone";
import { useIsTouch } from "@/ui/misc";

/**
 * A phone number that reaches the number the way the device can.
 *
 * On a desktop where the phone is offered, the press goes to the **in-app
 * phone** — the Janus leg — rather than to the system's `tel:` handler, which on
 * a desktop is either nothing or a second softphone the reader never set up.
 * Everywhere else (a touch device, or a deployment with no bridge) it stays a
 * `tel:` link, so the system dialer is still one press away.
 *
 * One definition, so every number in the product behaves the same: the rule is
 * the rule wherever a number is shown.
 */
export function CallNumber({ number }: { number: string }) {
  const ready = usePhone((s) => s.ready);
  const touch = useIsTouch();
  if (ready && !touch)
    return (
      <button
        type="button"
        className="link-btn"
        style={{ color: "var(--link)" }}
        onClick={() => void usePhone.getState().dial(number)}
      >
        {number}
      </button>
    );
  return <a href={`tel:${number}`}>{number}</a>;
}
