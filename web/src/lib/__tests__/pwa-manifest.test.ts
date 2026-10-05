import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The install surface: the manifest, and the files it points at.
 *
 * This is what a phone shows before any of the app has run -- the home screen
 * icon, the splash, the task switcher -- and nothing in the build connects the
 * manifest to the images beside it. A manifest naming an icon that is not
 * there, or declaring a size the file does not have, does not fail: the browser
 * skips that entry and installs the app with the one it can use, or with none.
 * The icons are made by hand from the mark beside them, and nothing in the
 * build derives one from the other -- which is exactly the arrangement in which
 * a manifest entry quietly stops matching the file it names.
 *
 * So the two are checked against each other here: every `src` exists, every
 * declared `sizes` is the file's real pixel size (read from the PNG's IHDR
 * chunk -- `sizes` is a claim about the file, and the file is the thing that
 * can be wrong), and the colours are the app's own.
 *
 * `process.cwd()` rather than `import.meta.url`: vitest serves modules over
 * http, so the latter is not a file URL.
 */
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const manifest = JSON.parse(read("public/manifest.webmanifest")) as {
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; purpose?: string }[];
};

/** Width and height from a PNG's IHDR: 8 bytes of signature, then the chunk. */
function pngSize(rel: string): { w: number; h: number } {
  const buf = readFileSync(join(process.cwd(), "public", rel));
  expect(buf.subarray(0, 8).toString("latin1"), `${rel} is not a PNG`).toContain("PNG");
  expect(buf.subarray(12, 16).toString("latin1"), `${rel} has no IHDR`).toBe("IHDR");
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

describe("the installed app", () => {
  it("names an icon that is actually there, at the size it declares", () => {
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      const { w, h } = pngSize(icon.src);
      expect(`${w}x${h}`, `${icon.src} declares ${icon.sizes}`).toBe(icon.sizes);
    }
  });

  it("ships a maskable icon, which is the one a launcher may crop", () => {
    const maskable = manifest.icons.filter((i) => i.purpose?.includes("maskable"));
    expect(maskable).toHaveLength(1);
    /* A maskable icon is cropped to whatever shape the launcher wants, so the
       manifest has to say it is one -- an `any` icon may be shown whole and
       scaled to fit, and a maskable one drawn that way is a shrunken mark in a
       circle. */
    expect(maskable[0]!.sizes).toBe("192x192");
  });

  it("paints its splash in the app's own colours, not in some other theme's", () => {
    /*
     * The default account runs the gilbert palette in dark mode, whose `--bg`
     * is #0d2430 -- the value index.html puts on the meta tag for the first
     * paint. The manifest is read before any theme is applied, so it can only
     * carry where the app starts, and a splash in a theme the reader is not
     * about to see is a flash of somebody else's colours.
     *
     * Read from index.html rather than written twice: the meta tag is the copy
     * that has to be right, and this asserts the manifest agrees with it.
     */
    const meta = /<meta name="theme-color" content="([^"]+)"/.exec(read("index.html"));
    expect(meta, "no theme-color meta in index.html").not.toBeNull();
    expect(manifest.theme_color).toBe(meta![1]);
    expect(manifest.background_color).toBe(meta![1]);
  });

  it("keeps the favicon the manifest's icons are built from in the tree too", () => {
    /* `index.html` names it directly, and a browser asks for it at `/favicon.ico`
       whatever the manifest says. */
    for (const rel of ["favicon.ico", "img/favicon-64.png", "img/apple-touch-icon.png"]) {
      expect(() => readFileSync(join(process.cwd(), "public", rel)), rel).not.toThrow();
    }
  });
});
