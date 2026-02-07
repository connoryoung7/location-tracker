#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENDPOINT="$BASE_URL/owntracks"

passed=0
failed=0

for file in "$SCRIPT_DIR"/*.json; do
  name=$(basename "$file")
  printf "%-30s " "$name"

  http_code=$(curl -s -o /tmp/owntracks-response -w "%{http_code}" \
    -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d @"$file")

  if [ "$http_code" -eq 200 ]; then
    printf "\033[32mHTTP %s\033[0m\n" "$http_code"
    passed=$((passed + 1))
  else
    body=$(cat /tmp/owntracks-response)
    printf "\033[31mHTTP %s\033[0m  %s\n" "$http_code" "$body"
    failed=$((failed + 1))
  fi
done

echo ""
echo "Results: $passed passed, $failed failed"

if [ "$failed" -gt 0 ]; then
  exit 1
fi
