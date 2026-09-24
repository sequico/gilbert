# ---- build stage ----
FROM node:24-alpine AS build
# What this build calls itself: 2.16.<PR>, worked out by whoever runs the
# build. It cannot be worked out in here -- .dockerignore keeps .git out of the
# context on purpose, and git is not installed either. `node scripts/version.mjs`
# in a checkout prints the right answer; gilbert-deploy.sh passes it through.
# Left empty, the build falls back to the base version from package.json.
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
# The bridge's main config, from the one definition of the media range the
# administration also shows (ADR 0023).
RUN node scripts/janusConfig.mjs /janus.jcfg

# ---- the phone's bridge (ADR 0023) ----
# Janus with its SIP plugin, built from the pinned upstream release. It is the
# second process of the one image, not a service of its own, so the phone
# arrives with Gilbert and nothing is installed by hand.
FROM debian:bookworm AS janus
ARG JANUS_VERSION=""
COPY deploy/janus/VERSION /janus-version
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl autoconf automake libtool pkg-config \
      gcc g++ make cmake gengetopt \
      libglib2.0-dev libjansson-dev libconfig-dev libssl-dev libsrtp2-dev \
      libnice-dev libcurl4-openssl-dev libsofia-sip-ua-dev libopus-dev \
      libogg-dev libwebsockets-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN VERSION="${JANUS_VERSION:-$(cat /janus-version)}" \
 && curl -fsSL "https://github.com/meetecho/janus-gateway/archive/refs/tags/${VERSION}.tar.gz" \
      | tar xz \
 && mv janus-gateway-* janus
WORKDIR /src/janus
# Only the two plugins the phone uses, only the WebSocket transport, and no
# data channels, docs or JS modules: the smallest bridge that carries a call.
RUN ./autogen.sh \
 && ./configure --prefix=/usr/local \
      --disable-docs --disable-data-channels \
      --disable-all-plugins --enable-plugin-sip --enable-plugin-echotest \
      --disable-all-transports --enable-websockets \
      --disable-all-handlers --disable-all-loggers \
 && make -j"$(nproc)" \
 && make install \
 && mkdir -p /usr/local/share/janus /usr/local/lib/janus/loggers /usr/local/lib/janus/events \
 && cp COPYING /usr/local/share/janus/COPYING

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
# The bridge's runtime libraries, and Janus itself from the stage above.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      libglib2.0-0 libjansson4 libconfig9 libssl3 libsrtp2-1 libnice10 \
      libcurl4 libsofia-sip-ua0 libopus0 libogg0 libwebsockets17 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=janus /usr/local /usr/local
COPY --from=build /janus.jcfg /usr/local/etc/janus/janus.jcfg
COPY deploy/janus/janus.transport.websockets.jcfg \
     deploy/janus/janus.plugin.sip.jcfg \
     deploy/janus/janus.plugin.echotest.jcfg \
     /usr/local/etc/janus/
COPY deploy/janus/entrypoint.sh /usr/local/bin/gilbert-entrypoint
COPY package.json package-lock.json* ./
COPY server/package.json server/
# config.ts reads the version through this at startup. With GILBERT_VERSION
# set it never looks further; without it, it falls back to package.json rather
# than failing, since there is no git in here to ask.
COPY scripts/ ./scripts/
# Only what the server loads at runtime: hono and its Node adapter, about 4 MB.
# The build stage's tree is 132 MB of vite, TypeScript, esbuild and React that
# never executes here but shipped anyway -- and showed up in every CVE scan.
RUN chmod +x /usr/local/bin/gilbert-entrypoint \
 && npm ci --ignore-scripts --omit=dev --workspace server \
 && rm -rf /root/.npm /tmp/* \
 && mkdir -p /data && chown node:node /data \
 # The base image ships a package manager the server never calls. Anyone who
 # gets code execution should not find one waiting for them.
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
USER node
# No `VOLUME ["/data"]`. It reads like documentation for where the session file
# goes, but Docker acts on it: a container started without `-v` gets an
# anonymous volume mounted there anyway, and that mount stays writable even
# under `--read-only`. So the directive quietly put a writable hole in a
# container meant to be immutable, and left an orphaned volume behind every
# time one was replaced -- while never persisting anything across a redeploy,
# since each new container got a fresh empty volume of its own. Deployments
# that want the sessions to survive say so themselves: docker-compose.yml and
# deploy.example.sh both mount a *named* volume at /data, which is unaffected.
EXPOSE 8080
# The bridge's API is loopback-only and its media range is a deployment fact
# (ADR 0023): the range is stated in the administration, and an operator opens
# it on the host.
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "/app/scripts/healthcheck.mjs"]
# Janus first, then whatever this image was told to run (ADR 0023).
ENTRYPOINT ["/usr/local/bin/gilbert-entrypoint"]
CMD ["node", "server/dist/index.js"]
