# ── Build ─────────────────────────────────────────────────────────────────────
# Node 24, which is the active LTS. Node 20 went end-of-life in April 2026,
# so an image built on it had been shipping without security patches for
# months. 26 exists but is Current, not LTS, until October.
FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
# `--include=dev`, said out loud, because this stage does not get to choose its
# own NODE_ENV. Coolify injects an `ARG` right after every `FROM` for each
# variable marked "Available at Buildtime", and on this application that list
# includes `NODE_ENV=production` — so a bare `npm ci` here skipped every
# devDependency and the very next step died with `eslint: not found`. Measured
# by building this file with those ARGs put where Coolify puts them.
#
# This comment used to say the opposite: "No NODE_ENV here: `npm ci` installs
# devDependencies whenever it is unset". True, and it is not unset. The image of
# `master` survived the same injection only because it declared
# `ENV NODE_ENV=development` in this stage, which was later removed as noise.
RUN npm ci --include=dev
COPY . .

# ── Deploy gates ──────────────────────────────────────────────────────────────
# Nothing ran the tests or the linter between a commit and production. The image
# was built from whatever was on the branch, and the first thing to notice a
# broken build was the ERP. These two lines are the whole of task E3 of the API
# standard, and they cost nothing to keep: a failing gate aborts the deploy, and
# the previous version stays up.
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
#
# `NODE_ENV=test` is the third, and it is here for the same reason `--include=dev`
# is on `npm ci` above: Coolify hands this stage `NODE_ENV=production` as a build
# ARG. Vitest sets `test` itself only when the variable is unset, so without
# this the suite ran in production mode — where the cookie, the CORS list and
# the required-variable checks all behave differently from what the tests were
# written against. `DATABASE_URL` and `CORS_ORIGIN` arrive the same way, with
# the real production values, and the two assignments on this line are also
# what keeps the gate from being pointed at the production database.
RUN NODE_ENV=test \
    DATABASE_URL="postgres://gate:gate@127.0.0.1:5432/gate" \
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

# How the host knows this container is up, and the half that makes the CMD below
# safe. `/api/health` answers 204 to anybody and writes no line in the log; it
# is enough that it answers, because the server only starts listening after the
# database answered and the boot checks ran. (The first version of this probe
# asked for `/` and took any answer: it worked, and it wrote a 401 warning into
# the log every ten seconds.) With a health check
# declared, Coolify's rolling update starts the new container beside the old
# one and only switches once this passes; if it never does, it logs "New
# container is not healthy, rolling back to the old container" and the previous
# version keeps serving.
#
# **The four numbers are read by Coolify, not only by Docker, and it reads the
# start period differently.** With the health check switched off in its panel —
# which is how this application is configured, and how it has to stay — Coolify
# copies these values out of this file (`parseHealthcheckFromDockerfile`) and
# then *sleeps the whole start period* before it looks at the container even
# once. To Docker a start period is a grace window; to Coolify it is a fixed
# wait added to every deploy. It was 180 s here, which would have been three
# idle minutes per release.
#
# So: thirty seconds, then up to six looks ten seconds apart — a minute and a
# half for the migrations to run and the server to listen. Measured against a
# copy of production on 9 October 2026, the eighteen migrations of the first
# deploy and the boot took twelve seconds together.
#
# 🔴 Do not switch the health check on in Coolify's panel. Its own defaults ask
# for `GET /` on port 80 and expect 200; this server answers 401 there, on 3000.
# Switched on, the panel's check replaces this one and every deploy is judged
# unhealthy and rolled back.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# The image checks its configuration, migrates itself, then serves. If either of
# the first two fails the server never starts, the health check above never
# passes, and the deploy rolls back.
#
# This line has been three things. First it was exactly this chain, with no
# health check: a failing migration left the API down and the container
# restarting forever — the reports broke, and so did login. Then migrations were
# taken out and the comment here said to run `npm run migrate:deploy` as a
# Coolify pre-deployment command. That could never have worked: Coolify runs a
# pre-deployment command "in the existing container" — the *previous* image,
# with the previous release's migrations and, on the first deploy, no such
# script at all — and this server cannot boot on a schema that has not been
# migrated. A post-deployment command is no better, for the same reason: it
# runs in a container that has to be up already.
#
# So the migrations travel with the code that needs them, and what was missing
# the first time is the health check, not a hook.
#
# What this depends on in the host, checked in the panel on 9 October 2026:
#   · rolling updates need the application to have no port mapped to the host
#     and no fixed container name — it has neither. With either, Coolify stops
#     the old container first and a failed migration is an outage until the
#     next deploy;
#   · the health check in Coolify's panel stays off, so the one above is the one
#     that counts — see the warning beside it.
#
# **Three links, and the first one is there so the second cannot strand the
# database.** `preflight.js` asks whether this environment can start the server
# at all — the same refusals `index.js` makes — *before* anything is migrated.
# Without it a missing variable was found by the server, after the migrations:
# the deploy rolled back to a container whose image can no longer boot on the
# schema it was left with. Production held six variables on 10 October 2026 and
# this version requires nine more, so that was the likeliest way for the first
# deploy to go wrong. See `src/scripts/preflight.ts`.
#
# `exec` so Node replaces the shell and receives SIGTERM itself — the graceful
# shutdown in `src/lifecycle.ts` depends on it.
CMD ["sh", "-c", "node dist/scripts/preflight.js && node dist/database/migrate.js && exec node dist/index.js"]
