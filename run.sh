#!/bin/zsh
# Build from your own computer instead of GitHub Actions (for testing).
# Needs BUILD_TOKEN (and optionally ANTHROPIC_API_KEY) in ~/.config/front-page/secrets.env.
cd "$(dirname "$0")"
mkdir -p logs
set -a; . "$HOME/.config/front-page/secrets.env"; set +a
python3 generate.py "$@" 2>&1 | tee "logs/run-$(date +%Y-%m-%d_%H%M).log"
