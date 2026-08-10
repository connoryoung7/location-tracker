FROM oven/bun:1.3.13 AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS runtime-dir
RUN mkdir -p /home/bun/app && chown -R bun:bun /home/bun/app

# Production image
FROM oven/bun:1.3.13-distroless
COPY --from=runtime-dir --chown=1000:1000 /home/bun/app /home/bun/app
WORKDIR /home/bun/app
COPY --from=deps --chown=1000:1000 /app/node_modules ./node_modules
COPY --chown=1000:1000 package.json bun.lock tsconfig.json drizzle.config.ts ./
COPY --chown=1000:1000 src ./src
COPY --chown=1000:1000 drizzle ./drizzle
COPY --chown=1000:1000 public ./public

ENV NODE_ENV=production
# 3001 serves the OwnTracks ingestion API; 3002 serves the area map UI.
EXPOSE 3001 3002

USER 1000:1000
CMD ["src/entrypoints/main.ts", "http"]
