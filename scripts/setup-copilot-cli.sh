#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -eq 0 ]]; then
  echo "Run this script as a normal user (no sudo)."
  exit 1
fi

echo "Installing GitHub CLI..."
if ! command -v gh >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y gh
fi

echo "Installing Copilot CLI extension..."
if ! gh extension list | grep -q "github/gh-copilot"; then
  gh extension install github/gh-copilot
fi

echo "Done."
echo "Next steps:"
echo "1) gh auth login"
echo "2) gh copilot suggest 'how do I run this project?'"
