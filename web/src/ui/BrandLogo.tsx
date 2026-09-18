import { withBase } from "@/lib/basePath";

/*
 * The mark, in the two colorways it is drawn in.
 *
 * One file cannot be right on both surfaces. The base lockup is navy, and navy
 * on a dark card is a logo nobody can see; the inverted lockup is white, and
 * white on a white card is the same nothing. So both ship and the stylesheet
 * decides which is shown: `.brand-logo-base` and `.brand-logo-inverse` in
 * `app.css`, keyed off the `data-theme` attribute `applyTheme()` writes before
 * the first paint.
 *
 * Two `<img>` and a rule, rather than a hook reading the settings: a caller
 * would then have to know which theme it is in, and every one of them would
 * have to be revisited for a third colorway. The file the theme did not pick is
 * `display: none` -- out of the layout and out of the accessibility tree, so a
 * pair of images does not announce as two. Both are in the shell cache
 * (`sw.js`), so the one that is not shown is already there rather than a second
 * round trip.
 *
 * The two kinds are the sheet's own two: the lockup (wordmark, mark and
 * tagline) for the surfaces with room for it, and the mark alone where there is
 * not -- the top bar draws it at 34px, below the size the tagline survives.
 */
export const BRAND_LOGO_FILES = {
  lockup: { base: "logo.png", inverse: "logo-inverse.png" },
  mark: { base: "mark.png", inverse: "mark-inverse.png" },
} as const;

export type BrandLogoKind = keyof typeof BRAND_LOGO_FILES;

/** The class each colorway is shown by. `app.css` owns the rule that swaps them. */
export const BRAND_LOGO_COLORWAY_CLASS = {
  base: "brand-logo-base",
  inverse: "brand-logo-inverse",
} as const;

const COLORWAYS = ["base", "inverse"] as const;

export function BrandLogo({
  kind = "lockup",
  width,
  height,
  alt = "",
}: {
  /** `lockup` when there is room for the wordmark, `mark` when there is not. */
  kind?: BrandLogoKind;
  width?: number;
  height?: number;
  alt?: string;
}) {
  const files = BRAND_LOGO_FILES[kind];
  return (
    <>
      {COLORWAYS.map((colorway) => (
        <img
          key={colorway}
          className={BRAND_LOGO_COLORWAY_CLASS[colorway]}
          src={withBase(`/img/${files[colorway]}`)}
          alt={alt}
          width={width}
          height={height}
        />
      ))}
    </>
  );
}
