---
name: create-dockerfile
description: Create or edit Dockerfiles for the project. Use when the user asks to create, update, or modify a Dockerfile.
allowed-tools: Read(Dockerfile*), Write(Dockerfile*), Edit(Dockerfile*), Glob, Grep
---

Create or edit files that begin with "Dockerfile" (e.g., `Dockerfile`, `Dockerfile.dev`, `Dockerfile.worker`).

## Conventions

- Use `oven/bun` as the base image since this project uses Bun
- Use specific minor versions of the image to ensure reproducible builds
- Use multi-stage builds to keep images small
- Copy `package.json` and `bun.lock` first, then `bun install`, then copy source (layer caching)
- Use `--frozen-lockfile --production` for production installs
- Set `NODE_ENV=production` in production images
- Expose the appropriate port
- Use `bun` as the entrypoint runtime, not `node`

## Steps

1. Ask the user what the Dockerfile is for (e.g., production, development, a specific entrypoint)
2. Check existing Dockerfiles with `Glob` to understand current patterns
3. Create or edit the Dockerfile following the conventions above
