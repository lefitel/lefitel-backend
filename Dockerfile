# ── Build ─────────────────────────────────────────────────────────────────────
# No NODE_ENV here: `npm ci` installs devDependencies whenever it is unset, and
# TypeScript lives in devDependencies. Declaring "development" only made the
# intent of the image ambiguous.
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine
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
