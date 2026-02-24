#!/bin/sh
# Setup git hooks for ravenhud
# Run this script after cloning the repository

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$SCRIPT_DIR/hooks"
GIT_HOOKS_DIR="$(git rev-parse --git-dir)/hooks"

echo "Setting up git hooks..."

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "ERROR: Not a git repository"
  exit 1
fi

# Check if hooks directory exists
if [ ! -d "$HOOKS_DIR" ]; then
  echo "ERROR: Hooks directory not found: $HOOKS_DIR"
  exit 1
fi

# Copy hooks
for hook in "$HOOKS_DIR"/*; do
  if [ -f "$hook" ]; then
    hook_name=$(basename "$hook")
    echo "  Installing $hook_name..."
    cp "$hook" "$GIT_HOOKS_DIR/$hook_name"
    chmod +x "$GIT_HOOKS_DIR/$hook_name"
  fi
done

echo ""
echo "Git hooks installed successfully!"
echo ""
echo "Installed hooks:"
echo "  - commit-msg: Validates commit message format (warning mode)"
echo ""
