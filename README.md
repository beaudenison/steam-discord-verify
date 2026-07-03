# Steam Discord Verify Bot

Discord bot + web callback service that verifies new server members using Steam OpenID, then logs linked Steam account information in a verification logs channel.

## Features

- Admin setup with slash command:
	- Set verify channel
	- Set verification logs channel
	- Set verified role to unlock access
- Verification embed with a `Verify with Steam` button
- Steam login flow via OpenID
- Logs in your chosen channel include:
	- Discord username + user ID
	- Steam persona name
	- SteamID
	- Steam profile link
	- Ban/warning details from Steam Web API (`VAC`, game bans, economy ban, community ban)
- Dockerized deployment

## One-Line Install + Setup Command

Run this on your host/server:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/beaudenison/steam-discord-verify/main/scripts/setup.sh)
```

This command clones the repo, asks for your required keys/IDs, writes `.env`, builds Docker image, and starts the bot.

## Local Project Setup (Codespace)

```bash
npm install
cp .env.example .env
```

Fill `.env` values, then run:

```bash
docker compose up -d --build
```

## Required Environment Variables

Copy `.env.example` to `.env`:

```env
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
STEAM_WEB_API_KEY=
PUBLIC_URL=
PORT=3000
```

Notes:

- `PUBLIC_URL` must be a publicly reachable HTTPS URL that points to this service.
- If using a reverse proxy, route traffic to container port `3000`.

## Discord Developer Setup

1. Go to the Discord Developer Portal and create a new application.
2. Open `Bot` and create the bot user.
3. Enable required privileged intent:
	 - `SERVER MEMBERS INTENT`
4. Copy the bot token into `.env` as `DISCORD_BOT_TOKEN`.
5. Copy `Application ID` into `.env` as `DISCORD_CLIENT_ID`.
6. In `OAuth2 > URL Generator`:
	 - Scopes: `bot`, `applications.commands`
	 - Bot permissions: at minimum
		 - `View Channels`
		 - `Send Messages`
		 - `Embed Links`
		 - `Read Message History`
		 - `Manage Roles`
7. Use generated URL to invite bot to your server.

## Steam Developer Setup

1. Sign in to Steam account that will own your API key.
2. Get a key from Steam Web API key registration page:
	 - https://steamcommunity.com/dev/apikey
3. Put this key into `.env` as `STEAM_WEB_API_KEY`.
4. `PUBLIC_URL` must exactly match the domain/host you use for callbacks.

The bot uses Steam OpenID login endpoint and Steam Web API methods:

- `ISteamUser/GetPlayerSummaries`
- `ISteamUser/GetPlayerBans`

## First-Time Discord Server Setup

After inviting the bot, it posts a setup message in a text channel (usually system channel).

Run:

1. `/setup verify_channel:<channel> logs_channel:<channel> verified_role:<role>`
2. `/post-verify`

New members can click the verify button, complete Steam login, then receive the verified role.

## Verification Log Output

When user verification succeeds, the bot sends an embed to the logs channel containing:

- Discord username + ID
- Steam persona name
- SteamID
- Steam profile URL
- `Community Banned`
- `VAC Banned`
- `Number of VAC Bans`
- `Days Since Last Ban`
- `Number of Game Bans`
- `Economy Ban`

## Running and Operations

Start/update:

```bash
docker compose up -d --build
```

View logs:

```bash
docker compose logs -f
```

Stop:

```bash
docker compose down
```

## Security Notes

- Keep `.env` secret. Never commit real tokens/keys.
- Run behind HTTPS for `PUBLIC_URL`.
- Restrict role permissions and place bot role above verified role in Discord role hierarchy.

## Troubleshooting

- Slash commands not visible:
	- Re-invite bot with `applications.commands` scope.
	- Wait briefly after startup; guild command registration occurs on bot connect.
- Role not assigned:
	- Ensure bot has `Manage Roles` permission.
	- Ensure bot role is above your configured verified role.
- Steam callback failing:
	- Check `PUBLIC_URL` is reachable and HTTPS.
	- Confirm reverse proxy forwards requests to port `3000`.