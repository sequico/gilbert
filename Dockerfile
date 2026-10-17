# ---- build stage ----
FROM node:24-alpine AS build
# What this build calls itself -- `2026.8.30+pr129`, from the commit it was
# built at -- worked out by whoever runs the build. It cannot be worked out in
# here: .dockerignore keeps .git out of the context on purpose, and git is not
# installed either. `node scripts/version.mjs` in a checkout prints the right
# answer; deploy.sh passes it through. Left empty, the build reports
# `0.0.0`, which is what an unversioned build is meant to look like.
ARG GILBERT_VERSION=""
ENV GILBERT_VERSION=$GILBERT_VERSION
# The subpath the app will be served from, e.g. /mail. Empty -- the default --
# is the domain root and is what every deployment gets unless it asks
# otherwise. Unlike the rest of Gilbert's configuration this cannot wait for
# the process to start: the web build writes its own asset URLs into
# index.html, so a build that does not know the prefix produces a shell that
# cannot load itself under one. It is therefore a build argument here and an
# environment variable in the runtime stage, from the same value.
ARG BASE_PATH=""
ENV BASE_PATH=$BASE_PATH
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# ---- runtime stage ----
FROM node:24-bookworm-slim AS runtime
# Re-declared: an ARG does not cross stages.
ARG GILBERT_VERSION=""
ARG BASE_PATH=""
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    STATIC_DIR=/app/web/dist \
    GILBERT_VERSION=$GILBERT_VERSION \
    BASE_PATH=$BASE_PATH
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY server/package.json server/
# config.ts reads the version through this at startup. With GILBERT_VERSION
# set it never looks further; without it, `resolveVersion()` finds neither a
# `.git` nor a `git` binary in here and reports the unversioned `0.0.0` -- the
# same answer as the ARG's own default above, and the reason a release build
# passes it.
COPY scripts/ ./scripts/
# Only what the server loads at runtime: hono and its Node adapter, about 4 MB.
# The build stage's tree is 132 MB of vite, TypeScript, esbuild and React that
# never executes here but shipped anyway -- and showed up in every CVE scan.
RUN npm ci --ignore-scripts --omit=dev --workspace server \
 && rm -rf /root/.npm /tmp/* \
 && mkdir -p /data && chown node:node /data \
 # The base image ships a package manager the server never calls. Anyone who
 # gets code execution should not find one waiting for them.
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
USER node
# No `VOLUME ["/data"]`. Docker acts on that directive: a container started
# without `-v` gets an anonymous volume mounted there anyway, and that mount
# stays writable even under `--read-only` -- a writable hole in a container
# meant to be immutable, and an orphaned volume left behind every time one is
# replaced. Nothing here needs one: the app keeps nothing durable on disk, as
# sessions and every other record live in Stalwart. `deploy.example.sh` mounts a
# named volume at /data only in its IMMUTABLE=0 branch.
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "/app/scripts/healthcheck.mjs"]
CMD ["node", "server/dist/index.js"]
