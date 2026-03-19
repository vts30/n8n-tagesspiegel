# ─── Stage 1: Build the custom node ─────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /build
COPY package.json tsconfig.json ./
RUN npm install
COPY src/ ./src/
RUN npm run build

# ─── Stage 2: Alpine + n8n (via npm) + Chromium ──────────────────────────────
FROM node:20-alpine

USER root

# Install n8n globally
RUN npm install -g n8n

# ─── Install custom node (outside volume path so it survives mount) ───────────
ENV NODE_PACKAGE_PATH=/opt/n8n-custom
RUN mkdir -p ${NODE_PACKAGE_PATH}/n8n-nodes-tagesspiegel

COPY --from=builder /build/dist/        ${NODE_PACKAGE_PATH}/n8n-nodes-tagesspiegel/dist/
COPY --from=builder /build/package.json ${NODE_PACKAGE_PATH}/n8n-nodes-tagesspiegel/

WORKDIR ${NODE_PACKAGE_PATH}/n8n-nodes-tagesspiegel
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev && \
    ln -sf /usr/local/lib/node_modules/n8n/node_modules/n8n-workflow ./node_modules/n8n-workflow

RUN mkdir -p /home/node/.n8n && chown -R node:node /home/node/.n8n

USER node

ENV GENERIC_TIMEZONE=Europe/Berlin
WORKDIR /home/node
EXPOSE 5678
CMD ["n8n", "start"]
