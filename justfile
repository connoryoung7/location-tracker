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

# Lint TypeScript sources with oxlint
lint-ts:
    bunx oxlint src/

# Lint Dockerfiles with hadolint (run as a pinned Docker container)
lint-docker:
    docker run --rm --entrypoint hadolint -v "$PWD:/workdir" -w /workdir hadolint/hadolint:v2.12.0 \
        Dockerfile Dockerfile.dev

# Lint Markdown files with markdownlint-cli
lint-markdown:
    bunx markdownlint --config .markdownlint.jsonc --ignore-path .markdownlintignore '**/*.md'

# Lint the project (TypeScript + Dockerfiles + Markdown)
lint: lint-ts lint-docker lint-markdown

# Lint and auto-fix the project
lint-fix:
    bunx oxlint --fix src/
    bunx markdownlint --fix --config .markdownlint.jsonc --ignore-path .markdownlintignore '**/*.md'

# Format the project
fmt:
    bunx oxfmt --write src/

# Check formatting without writing
fmt-check:
    bunx oxfmt --check src/

# Install dependencies
install:
    bun install

# Install git hooks via prek
hooks-install:
    prek install

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

# Start dev Docker Compose services
up:
    docker compose -f docker-compose.dev.yml up -d --build

# Stop dev Docker Compose services
down:
    docker compose -f docker-compose.dev.yml down

# Follow Docker Compose logs
compose-logs:
    docker compose logs -f

# Send all test-data payloads to the OwnTracks endpoint
test-data url="http://localhost:3000":
    ./test-data/send-all.sh {{url}}

# Run the full CI pipeline locally (mirrors .github/workflows/ci.yml)
ci:
    bun install --frozen-lockfile
    just fmt-check
    just check

# Run all checks (typecheck, lint, test)
check: typecheck lint test
