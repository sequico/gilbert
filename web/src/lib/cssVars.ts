/**
 * The app's own theme is a set of CSS custom properties on the document root
 * (see `styles/app.css`). A few places need their values from JavaScript — the
 * browser chrome colour and the checklist builder's MUI island — so this is the
 * one reader of them, rather than a `getComputedStyle` call beside each use.
 */
export function readCssVar(name: string, fallback = ""): string {
  if (typeof getComputedStyle === "function") {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    if (value) return value;
  }
  return fallback;
}
