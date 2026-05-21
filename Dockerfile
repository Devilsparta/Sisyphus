# Sisyphus — web deploy form (Tauri uses a separate workflow).
#
# Single-stage on purpose: monorepo is small enough that the install +
# build time wins beat the multi-stage image-size savings. Optimize when
# the image grows past ~500MB.
#
# Build:    docker build -t sisyphus .
# Run:      docker run -p 8787:8787 \
#             -v ~/.sisyphus:/root/.sisyphus \
#             -e OPENAI_API_KEY=... \
#             -e OPENAI_BASE_URL=https://api.openai.com/v1 \
#             -e OPENAI_MODEL=gpt-4o \
#             sisyphus
#
# Visit http://localhost:8787 — daemon serves the UI from
# /app/packages/ui/dist via SISYPHUS_UI_DIR.
#
# Volume mount: ~/.sisyphus holds plugins-node_modules, plugins.config.json,
# config.json, per-plugin storage. Keep this on a host volume so plugins
# persist across container restarts.
FROM node:20-alpine

RUN corepack enable
WORKDIR /app

# Workspace metadata first so the install layer caches.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/kernel/package.json packages/kernel/
COPY packages/daemon/package.json packages/daemon/
COPY packages/ui/package.json packages/ui/
COPY packages/plugin-base/package.json packages/plugin-base/
COPY packages/plugin-todo/package.json packages/plugin-todo/

RUN pnpm install --frozen-lockfile

# Copy source after deps so editing src doesn't blow up the install cache.
COPY packages packages

# Build plugin UI bundles (esbuild) and host UI bundle (vite).
# Daemon stays in TS form and runs via tsx at runtime.
RUN pnpm -r --filter './packages/plugin-*' build:ui && \
    pnpm --filter @sisyphus/ui build

ENV SISYPHUS_UI_DIR=/app/packages/ui/dist
ENV SISYPHUS_DAEMON_PORT=8787
EXPOSE 8787

WORKDIR /app/packages/daemon
CMD ["pnpm", "start"]
