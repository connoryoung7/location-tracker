# location-tracker

## Setup

### Prerequisites

- [Bun](https://bun.sh)
- [prek](https://prek.j178.dev) (`brew install prek`)

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

```
<type>[optional scope][optional !]: <description>
```

Valid types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`, `revert`

Examples:

```
feat(auth): add API key rotation
fix: handle null location payload
chore!: drop support for MQTT v3
```

