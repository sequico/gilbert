import { readdirSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { baseUrlOf } from "../scripts/basePath.mjs";
import { resolveVersion } from "../scripts/version.mjs";

// Resolved here, at build time: the browser has no git to ask, and neither does
// the Docker build, which is handed the answer as GILBERT_VERSION instead.
const version = resolveVersion();

/*
 * Where the app is mounted. Unlike everything else Gilbert is told, this one
 * cannot wait until the process starts: the hashed asset URLs are written into
 * index.html when the bundle is built, so a build that does not know its prefix
 * emits `/assets/...` and the shell 404s under `/mail/`. So `BASE_PATH` is read
 * at build time here as well as at run time in the server, and the Dockerfile
 * carries one value into both.
 *
 * Vite wants the directory form with the trailing slash, and hands it back to
 * the app as `import.meta.env.BASE_URL` -- which is where `lib/basePath.ts`
 * gets it, so the browser never has to be told separately.
 */
const base = baseUrlOf(process.env.BASE_PATH);

/*
 * Print the live app URL when the dev server is up. The Node server on :8080
 * logs first and serves the *built* app, so a dev:mock console reads as if
 * :8080 were the app -- and a browser opened there shows yesterday's build.
 * Vite's own banner says the real URL, but buried among three processes;
 * this line appears under the [web] prefix at the moment it matters.
 */
const devUrlHint = (): Plugin => ({
  name: "gilbert-dev-url-hint",
  apply: "serve",
  configureServer(server) {
    server.httpServer?.once("listening", () => {
      const { address } = server.httpServer!.address() as {
        address: unknown;
        port?: number;
      };
      const port =
        typeof address === "object" && address
          ? (address as { port: number }).port
          : 5173;
      console.log(
        `\n  Web app (dev, live reload): http://localhost:${port}\n  :8080 serves the built app (npm run build) — not the live one\n`,
      );
    });
  },
});

/*
 * Write the build's own asset list into the app page.
 *
 * The page is where a browser learns what a build consists of, and the service
 * worker reads the list back to fetch the rest of a build in the background
 * (`web/public/sw.js`). Without it the worker only ever learns about the files
 * a reader happened to ask for, so the first time after a deploy that somebody
 * opened the composer, settings or a viewer, they waited on the server for that
 * code -- which this build makes worth avoiding, since the lazy views are
 * hundreds of kilobytes each.
 *
 * Language catalogs are deliberately left out: they are one per language at
 * 80-125 KB, and a reader uses one of them.
 */
const ASSET_LIST_ID = "gilbert-assets";

/*
 * Which chunks are language catalogs, derived from the catalogues themselves.
 *
 * Vite names a chunk `<entry>-<hash>.js`, and every hash is eight characters --
 * so a pattern for "a name and a hash" matches *every* chunk in the build,
 * which is what an earlier version of this got wrong and what this avoids:
 * the language codes come from the directory rather than from a guess about
 * the shape of a file name.
 */
const localeCodes = new Set(
  readdirSync(fileURLToPath(new URL("./src/locales", import.meta.url)))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/, "")),
);
const isLocaleChunk = (name: string): boolean => {
  const base = name.split("/").pop() ?? "";
  return localeCodes.has(base.replace(/-[A-Za-z0-9_-]{8}\.js$/, ""));
};

const assetList = (): Plugin => ({
  name: "gilbert-asset-list",
  apply: "build",
  /*
   * `post`, because the list is the bundle's own file names: the default order
   * runs before there is a bundle, and `ctx.bundle` is then undefined.
   */
  transformIndexHtml: {
    order: "post",
    handler(html, ctx) {
      const files = (ctx.bundle ? Object.keys(ctx.bundle) : []).filter(
        (name) => name.endsWith(".js") && !isLocaleChunk(name),
      );
      if (!files.length) return html;
      /*
       * Prefixed with `base`, because a deployment is mounted under one: the
       * shell's own asset URLs are `/webmail/assets/…` and a list of
       * `/assets/…` would have the worker fetch 404s for the whole build.
       */
      const payload = JSON.stringify({ precache: files.map((f) => `${base}${f}`) });
      return html.replace(
        "</head>",
        `    <script type="application/json" id="${ASSET_LIST_ID}">${payload}</script>\n  </head>`,
      );
    },
  },
});

export default defineConfig({
  base,
  plugins: [react(), devUrlHint(), assetList()],
  define: { __GILBERT_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The shared tier: one definition, in the server tree, read by both
      // tiers (see the note in web/tsconfig.json).
      "@gilbert/shared": fileURLToPath(new URL("../server/src/shared", import.meta.url)),
      "@gilbert/agent": fileURLToPath(new URL("../server/src/agent", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      // Under a prefix the dev server serves the app from `base`, so the app's
      // API calls arrive here prefixed too. Forwarded whole, prefix included:
      // the dev server behind this reads the same BASE_PATH and expects it.
      [`${base}api`]: {
        target: "http://127.0.0.1:8080",
        changeOrigin: false,
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["wouter", "zustand", "dompurify", "@tanstack/react-virtual"],
          icons: ["lucide-react"],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
