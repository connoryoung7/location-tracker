# location-tracker

## Setup

### Prerequisites

- [Bun](https://bun.sh)
- [prek](https://prek.j178.dev) (`brew install prek`)
- [Docker](https://www.docker.com) — required by `just lint` / `just check`
  (used to run hadolint in a pinned container)

### Install

```sh
bun install
prek install   # or: just hooks-install
```

### Git hooks

[prek](https://prek.j178.dev) manages the pre-commit hooks defined in `prek.toml`:

- **oxfmt** — formats staged TypeScript files
- **oxlint** — lints staged TypeScript files
- **conventional-commit** — enforces [Conventional Commits](https://www.conventionalcommits.org) on commit messages

Commit messages must follow the format:

```text
<type>[optional scope][optional !]: <description>
```

Valid types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`, `revert`

Examples:

```text
feat(auth): add API key rotation
fix: handle null location payload
chore!: drop support for MQTT v3
```

## SQLite Studio

`just db-studio` starts Drizzle Studio at <https://local.drizzle.studio> using the
SQLite file at `DB_PATH` (default: `location-tracker.db`). Bun loads `DB_PATH` from
`.env`; a value passed in the shell takes precedence. Studio does not require
`ENCRYPTION_KEY` or Redis. Initialize the database with `just db-migrate` before
inspecting application tables.

Studio uses the development-only `@libsql/client` driver; the application continues
to use `bun:sqlite`. This command inspects SQLite even when the application is
configured to use Postgres.
