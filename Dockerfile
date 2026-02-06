FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Production image
FROM base
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "src/entrypoints/main.ts", "http"]
