# Pinned rather than floating on `node:22-alpine`: the server depends on
# `node:sqlite`, which is still an experimental API and has changed shape
# between minors. A register that stops syncing after an unattended base-image
# bump is exactly the failure this pin exists to prevent.
FROM node:22.14-alpine

# No package.json and no npm install anywhere in this image — the server uses
# only Node built-ins, so there is nothing to resolve, audit, or break.
WORKDIR /app
COPY server.mjs admin.html ./
# Chart.js, vendored so the admin page has no external dependency — see the
# /vendor route in server.mjs.
COPY vendor ./vendor

# Data lives on a volume, owned by the unprivileged user the process runs as.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV POS_DATA_DIR=/data \
    PORT=8787

EXPOSE 8787

# Hits the one route that needs no key, so the check never carries a secret.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so the process is PID 1 and receives SIGTERM directly — that is
# what triggers the shutdown backup in server.mjs on `docker compose down`.
CMD ["node", "server.mjs"]
