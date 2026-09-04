# ── Build ─────────────────────────────────────────────────────────────────────
# No NODE_ENV here: `npm ci` installs devDependencies whenever it is unset, and
# TypeScript lives in devDependencies. Declaring "development" only made the
# intent of the image ambiguous.
# Node 24, which is the active LTS. Node 20 went end-of-life in April 2026,
# so an image built on it had been shipping without security patches for
# months. 26 exists but is Current, not LTS, until October.
FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

# ── Deploy gates ──────────────────────────────────────────────────────────────
# Nothing ran the tests or the linter between a commit and production. The image
# was built from whatever was on the branch, and the first thing to notice a
# broken build was the ERP. These two lines are the whole of task E3 of the API
# standard, and they cost nothing to keep: a failing gate aborts the deploy, and
# the previous version stays up — the same property the CMD comment below relies
# on for migrations.
RUN npm run lint

# The two fake values are load-bearing, and neither leaves this line.
#
# `.dockerignore` keeps `.env` out of the build context, so the suite runs with
# nothing configured. Two things then fail, and the first version of this gate
# only knew about one of them — it aborted every build, which is exactly what an
# unbuilt image looks like:
#
#   · `DATABASE_URL` — `database/sequelize` calls `process.exit(1)` while being
#     *imported* when it finds no connection settings, so the suite would die on
#     its first `import` rather than fail a test. Nothing connects:
#     `new Sequelize(url)` opens no socket on its own, the address is the build
#     container's own loopback, and the handful of tests that do want a real
#     database skip themselves when none answers.
#   · `CORS_ORIGIN` — five test files send `allowedOrigins(...)[0]` as an `Origin`
#     header, and with nothing configured that list is empty outside development.
#     Node refuses a header whose value is `undefined`: **68 tests failed** for
#     that alone. `app.auth.test.ts` says in a comment that it relies on this
#     suite's `.env` always setting it.
#
# `ENV` is deliberately not used, so neither value can reach the runtime image —
# it starts from a second `FROM` and reads the real ones from the host.
RUN DATABASE_URL="postgres://gate:gate@127.0.0.1:5432/gate" \
    CORS_ORIGIN="https://www.osefi.net" \
    npm test

RUN npm run build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app

# Load-bearing. Every FROM resets ENV, so without this line the container runs
# with NODE_ENV undefined, which the code reads as development:
#   · sequelize.sync({ alter: true }) rewrites the live schema on every boot
#   · the connection is built from PG_IP/PG_PORT instead of DATABASE_URL
# Setting it to production means DATABASE_URL must be defined in the host's
# environment; the server refuses to start with a clear message otherwise.
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

# Photographs are written to IMAGES_DIR (default /images) by the upload
# controller. The path must be a volume mounted by the host — Coolify's
# "Persistent Storage" — or every redeploy discards the images uploaded since
# the previous one. Deliberately not declared with VOLUME: that would create an
# anonymous volume on each run, which looks like persistence and is not.

EXPOSE 3000

# Migrations no longer gate the server. Chained with &&, a failing migration
# left the API down and the container restarting forever — the reports break,
# and so does login. Run `npm run migrate:deploy` as a pre-deployment command
# instead: if it fails, the deploy aborts and the previous version stays up.
CMD ["node", "dist/index.js"]
