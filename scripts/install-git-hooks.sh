#!/usr/bin/env bash
#
# Installs the local-only git hooks for this repository.
#
#   ./scripts/install-git-hooks.sh
#
# Git does not track .git/hooks, so a fresh clone has none of these. Run this
# once after cloning. It only writes inside .git/ and never touches the working
# tree or the remote.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .git/hooks/pre-commit ]; then
  echo "pre-commit hook is already present — refreshing it."
else
  echo "Installing pre-commit hook."
fi

install -m 0755 scripts/git-hooks/pre-commit .git/hooks/pre-commit

echo "Done. The hook now blocks any commit containing:"
echo "  .superpowers/  docs/superpowers/  opencode.json  AGENTS.md  CLAUDE.md  GEMINI.md"
