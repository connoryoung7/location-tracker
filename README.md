# location-tracker

## Testing GitHub Actions workflows locally

Workflows in `.github/workflows/` can be exercised locally with [`act`](https://github.com/nektos/act) so problems are caught before pushing to `main`.

### Prerequisites

- [`act`](https://github.com/nektos/act) — `brew install act`
- Docker running (act spins up containers that mimic GitHub-hosted runners)

### Recipes

| Command | What it does |
|---------|--------------|
| `just act-list` | List all workflows and jobs act discovers in `.github/workflows/` |
| `just act-dry` | Dry-run the CI workflow — prints the execution plan without running steps |
| `just act-ci` | Run the CI workflow end-to-end, simulating a push to `main` |

All run-style recipes pass `--container-architecture linux/amd64` so the default runner images work on Apple Silicon.

First invocation of `just act-ci` pulls the `catthehacker/ubuntu:act-latest` image (~1 GB); subsequent runs reuse it.
