#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="steam-discord-verify"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required but not found."
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required but not found."
  exit 1
fi

if [[ -d "$REPO_DIR/.git" ]]; then
  echo "Using existing $REPO_DIR directory"
  if [[ -n "$(git -C "$REPO_DIR" status --porcelain)" ]]; then
    echo "Local changes detected in $REPO_DIR. Skipping auto-update pull."
    echo "Commit/stash your changes, then run: git -C $REPO_DIR pull --ff-only"
  else
    echo "Pulling latest changes from origin/main..."
    git -C "$REPO_DIR" pull --ff-only
  fi
else
  git clone https://github.com/beaudenison/steam-discord-verify.git "$REPO_DIR"
fi

cd "$REPO_DIR"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from template."
fi

echo ""
echo "Enter required environment values:"
read -r -p "Discord Bot Token: " DISCORD_BOT_TOKEN
read -r -p "Discord Application Client ID: " DISCORD_CLIENT_ID
read -r -p "Steam Web API Key: " STEAM_WEB_API_KEY
read -r -p "Public URL for web callback (example: https://verify.example.com): " PUBLIC_URL

cat > .env <<EOF
DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}
DISCORD_CLIENT_ID=${DISCORD_CLIENT_ID}
STEAM_WEB_API_KEY=${STEAM_WEB_API_KEY}
PUBLIC_URL=${PUBLIC_URL}
PORT=3000
EOF

echo ""
echo "Starting bot via Docker Compose..."
docker compose up -d --build

echo ""
echo "Setup complete."
echo "Next in Discord:"
echo "1) Invite bot to your server"
echo "2) Run /setup and choose verify/log channels + verified role"
echo "3) Run /post-verify"
