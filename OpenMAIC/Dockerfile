# ---- Stage 1: Base ----
FROM node:22-alpine AS base

RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

WORKDIR /app

# ---- Stage 2: Dependencies ----
FROM base AS deps

# Native build tools for sharp, @napi-rs/canvas
RUN apk add --no-cache python3 build-base g++ cairo-dev pango-dev jpeg-dev giflib-dev librsvg-dev

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ ./packages/

RUN pnpm install --frozen-lockfile
RUN mkdir -p /opt/runtime-node-modules && cp -RL node_modules/ws /opt/runtime-node-modules/ws

# ---- Stage 3: Builder ----
FROM base AS builder

ARG NEXT_PUBLIC_A3_API_BASE_URL=http://localhost:8000
ENV NEXT_PUBLIC_A3_API_BASE_URL=$NEXT_PUBLIC_A3_API_BASE_URL

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY . .

RUN pnpm build

# ---- Stage 4: Runner ----
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN apk add --no-cache libc6-compat cairo pango jpeg giflib librsvg

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/scripts/a3-dashscope-realtime-proxy.mjs ./scripts/a3-dashscope-realtime-proxy.mjs
COPY --from=deps --chown=nextjs:nodejs /opt/runtime-node-modules/ws ./node_modules/ws

RUN node --check scripts/a3-dashscope-realtime-proxy.mjs && \
    node --input-type=module -e "import WebSocket from 'ws'; if (!WebSocket) process.exit(1)"

USER nextjs

EXPOSE 3000 3003

CMD ["node", "server.js"]
