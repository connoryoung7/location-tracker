# Default: list available commands
default:
    @just --list

# Start development server with hot reloading
dev:
    bun --hot src/entrypoints/http.ts

# Start production server
start:
    bun src/entrypoints/main.ts http

# Run tests
test *args:
    bun test {{args}}

# Run tests in watch mode
test-watch:
    bun test --watch

# Type-check the project
typecheck:
    bunx tsc --noEmit

# Lint the project
lint:
    bunx oxlint src/

# Lint and auto-fix
lint-fix:
    bunx oxlint --fix src/

# Format the project
fmt:
    bunx oxfmt --write src/

# Check formatting without writing
fmt-check:
    bunx oxfmt src/

# Install dependencies
install:
    bun install

# Build production Docker image
docker-build:
    docker build -t location-tracker .

# Build development Docker image
docker-build-dev:
    docker build -f Dockerfile.dev -t location-tracker-dev .

# Run production Docker container
docker-run: docker-build
    docker run -p 3000:3000 location-tracker

# Run development Docker container with hot reloading
docker-dev: docker-build-dev
    docker run -v ./src:/app/src -v ./drizzle:/app/drizzle -v ./tsconfig.json:/app/tsconfig.json -p 3000:3000 location-tracker-dev

# Generate a new Drizzle migration from schema changes
db-generate:
    bunx drizzle-kit generate

# Run pending database migrations
db-migrate:
    bun src/infrastructure/persistence/migrate.ts

# Open Drizzle Studio for database inspection
db-studio:
    bunx drizzle-kit studio

# Start Docker Compose services
compose-up:
    docker compose up -d --build

# Stop Docker Compose services
compose-down:
    docker compose down

# Follow Docker Compose logs
compose-logs:
    docker compose logs -f

# Run all checks (typecheck, lint, test)
check: typecheck lint test
