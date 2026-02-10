---
name: install
description: Install bun packages. Use when the user asks to install, add, or set up a new dependency or package.
argument-hint: [package-names...]
allowed-tools: Bash(bun:*)
---

Install the requested bun packages: $ARGUMENTS

Rules:
- If a package name starts with `@types/`, install it as a dev dependency using `bun add -D`
- Otherwise, install it as a regular dependency using `bun add`
- If installing multiple packages where some are type definitions and some are not, run two separate commands: one `bun add` for regular dependencies and one `bun add -D` for type definitions
