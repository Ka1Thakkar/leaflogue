# Leaflogue's web app, served by apps/server on one origin, for a library
# synced through PostgreSQL. Build from the repository root:
#   docker build -f deploy/web/Dockerfile -t leaflogue-web .

FROM node:22.22.2-bookworm-slim AS build
WORKDIR /src
COPY . .
# No install scripts: nothing here needs them, and the desktop's Electron
# download is not wanted in a server image.
RUN npm ci --ignore-scripts --no-audit --no-fund
RUN npm run build --workspace @leaflogue/web && npm run build --workspace @leaflogue/server

FROM node:22.22.2-bookworm-slim
WORKDIR /app
# The server bundle keeps `pg` external; install exactly the tested version.
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund pg@8.23.0 && npm cache clean --force
COPY --from=build /src/apps/server/dist/server.mjs ./server.mjs
COPY --from=build /src/apps/web/dist ./web
COPY LICENSE ./
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 LEAFLOGUE_WEB_ROOT=/app/web
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server.mjs"]
