import "dotenv/config";
import express from "express";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";
import { ConfigStore } from "./configStore.js";
import {
  buildSteamOpenIdRedirect,
  extractSteamIdFromClaimedId,
  fetchSteamProfileAndBans,
  verifySteamOpenIdResponse
} from "./steam.js";
import { VerifySessionStore } from "./verifySession.js";

const VERIFY_CHANNEL_STATUS_TTL_MS = 3 * 1000;

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  PUBLIC_URL,
  STEAM_WEB_API_KEY,
  PORT = "3000"
} = process.env;

if (!DISCORD_BOT_TOKEN || !DISCORD_CLIENT_ID || !PUBLIC_URL || !STEAM_WEB_API_KEY) {
  console.error("Missing required environment variables. Check README and .env.example.");
  process.exit(1);
}

function normalizePublicUrl(value) {
  const trimmed = String(value).trim();
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : /^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(trimmed)
      ? `http://${trimmed}`
      : `https://${trimmed}`;

  const parsed = new URL(withProtocol);
  return parsed.toString().replace(/\/$/, "");
}

const PUBLIC_BASE_URL = normalizePublicUrl(PUBLIC_URL);

const app = express();
const store = new ConfigStore();
const sessions = new VerifySessionStore();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Configure verify and logging channels for this server")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((option) =>
      option
        .setName("verify_channel")
        .setDescription("Channel where members verify their Steam account")
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
    )
    .addChannelOption((option) =>
      option
        .setName("logs_channel")
        .setDescription("Channel where verification logs are posted")
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
    )
    .addRoleOption((option) =>
      option
        .setName("verified_role")
        .setDescription("Role assigned after successful Steam verification")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("post-verify")
    .setDescription("Post the Steam verification embed in the configured verify channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("verify-status")
    .setDescription("Show current verification configuration")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map((command) => command.toJSON());

function baseEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(0x0f7bff)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp(new Date());
}

function buildVerifyEmbed(guildName) {
  return baseEmbed(
    "Steam Verification Required",
    `Welcome to **${guildName}**. Click **Verify with Steam** below and log in with your Steam account to unlock server access.`
  ).addFields(
    {
      name: "What happens",
      value: "Your Discord account will be linked to your Steam ID."
    },
    {
      name: "Logged information",
      value: "Steam profile, SteamID, and ban/warning status will be sent to admins channel of choice."
    }
  );
}

function buildVerifyButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("verify_start").setStyle(ButtonStyle.Primary).setLabel("Verify with Steam")
  );
}

async function registerGuildCommands(guildId) {
  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);
  await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, guildId), {
    body: commands
  });
}

async function sendGuildSetupPrompt(guild) {
  const setupEmbed = baseEmbed(
    "Thanks for adding Steam Verify Bot",
    "Run `/setup` to choose your verify channel, verification logs channel, and verified role. Then run `/post-verify` to post the verification embed."
  );

  const candidateChannels = guild.channels.cache
    .filter((channel) => channel.type === ChannelType.GuildText)
    .sort((a, b) => a.rawPosition - b.rawPosition);

  const target = guild.systemChannel || candidateChannels.first();
  if (target && target.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)) {
    await target.send({ embeds: [setupEmbed] }).catch(() => {});
  }
}

async function postVerifyPrompt(guild) {
  const cfg = store.getGuild(guild.id);
  if (!cfg?.verifyChannelId) {
    throw new Error("Verify channel is not configured. Run /setup first.");
  }

  const channel = await guild.channels.fetch(cfg.verifyChannelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error("Configured verify channel no longer exists.");
  }

  await channel.send({
    embeds: [buildVerifyEmbed(guild.name)],
    components: [buildVerifyButtonRow()]
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHtml(title, body, options = {}) {
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);
  const safeGuildName = options.guildName ? escapeHtml(options.guildName) : "this server";
  const guildInitial = safeGuildName.charAt(0).toUpperCase() || "S";
  const guildIdentity = options.guildIconUrl
    ? `<img class="guild-icon" src="${options.guildIconUrl}" alt="${safeGuildName} icon" />`
    : `<div class="guild-icon guild-fallback" aria-label="${safeGuildName} icon">${guildInitial}</div>`;
  const connectionRow = options.showConnectionHeader
    ? `<div class="identity-row" role="img" aria-label="${safeGuildName} connected to Steam">
        <div class="identity-block">
          ${guildIdentity}
          <span class="identity-label">${safeGuildName}</span>
        </div>
        <span class="link-word" aria-hidden="true">linked to</span>
        <div class="identity-block">
          <img class="steam-logo" src="https://store.steampowered.com/favicon.ico" alt="Steam logo" />
          <span class="identity-label">Steam</span>
        </div>
      </div>`
    : "";
  const successChip = options.showSuccessChip
    ? '<div class="status-chip"><span class="status-dot" aria-hidden="true"></span>Account linked</div>'
    : "";

  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #050505;
        --bg-soft: #0d0d0d;
        --card: #111111;
        --card-border: #272727;
        --text-main: #f6f6f6;
        --text-muted: #b8b8b8;
        --accent: #8ea2ff;
        --success: #3ad07a;
      }
      body {
        margin: 0;
        font-family: "Inter", "Segoe UI", sans-serif;
        background:
          radial-gradient(720px 340px at 50% -14%, rgba(142, 162, 255, 0.13), transparent 62%),
          linear-gradient(180deg, #030303 0%, var(--bg) 48%, var(--bg-soft) 100%);
        color: var(--text-main);
        min-height: 100vh;
        display: grid;
        place-items: center;
      }
      .card {
        width: min(92vw, 560px);
        margin: 24px;
        border: 1px solid var(--card-border);
        background: linear-gradient(180deg, #141414 0%, var(--card) 100%);
        border-radius: 16px;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
        padding: 26px;
      }
      .identity-row {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        margin: 0 0 16px;
        flex-wrap: wrap;
      }
      .identity-block {
        display: inline-flex;
        align-items: center;
        gap: 9px;
        padding: 0;
      }
      .identity-label {
        color: var(--text-muted);
        font-size: 0.9rem;
        letter-spacing: 0.01em;
      }
      .link-word {
        color: #9ea9d9;
        font-size: 0.82rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        font-weight: 700;
      }
      h1 {
        margin: 0 0 8px;
        font-size: clamp(1.3rem, 2vw, 1.65rem);
        letter-spacing: 0.01em;
      }
      p {
        margin: 0;
        line-height: 1.5;
        color: var(--text-muted);
      }
      a {
        color: var(--accent);
      }
      .guild-icon,
      .steam-logo {
        width: 28px;
        height: 28px;
        border-radius: 999px;
        object-fit: cover;
      }
      .guild-fallback {
        display: inline-grid;
        place-items: center;
        font-size: 0.82rem;
        font-weight: 700;
        color: #ffffff;
        background: linear-gradient(145deg, #4656b5, #2f3c8c);
      }
      .status-chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 11px;
        border: 1px solid rgba(58, 208, 122, 0.45);
        background: rgba(58, 208, 122, 0.12);
        color: #c8f7db;
        border-radius: 999px;
        padding: 6px 11px;
        font-size: 0.78rem;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        font-weight: 700;
      }
      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--success);
        box-shadow: 0 0 10px rgba(58, 208, 122, 0.8);
      }
      @media (max-width: 560px) {
        .card {
          padding: 22px 18px;
        }
      }
    </style>
  </head>
  <body>
    <article class="card">
      ${connectionRow}
      ${successChip}
      <h1>${safeTitle}</h1>
      <p>${safeBody}</p>
    </article>
  </body>
</html>`;
}

app.get("/", (_req, res) => {
  res.status(200).send("Steam Discord Verify bot is running.");
});

app.get("/verify/start", (req, res) => {
  const token = req.query.token;
  if (!token || typeof token !== "string") {
    return res.status(400).send(renderHtml("Invalid request", "Verification session token is missing."));
  }

  const session = sessions.getSession(token);
  if (!session) {
    return res
      .status(400)
      .send(
        renderHtml(
          "Session expired",
          "This verification link expired. Return to Discord and click Verify with Steam again."
        )
      );
  }

  const nonce = sessions.createNonce(token);
  const returnTo = `${PUBLIC_BASE_URL}/auth/steam/return?nonce=${encodeURIComponent(nonce)}`;
  const openIdUrl = buildSteamOpenIdRedirect({
    realm: PUBLIC_BASE_URL,
    returnTo
  });

  return res.redirect(openIdUrl);
});

app.get("/auth/steam/return", async (req, res) => {
  try {
    const nonce = req.query.nonce;
    if (!nonce || typeof nonce !== "string") {
      return res.status(400).send(renderHtml("Invalid callback", "Missing nonce in callback."));
    }

    const token = sessions.consumeNonce(nonce);
    if (!token) {
      return res
        .status(400)
        .send(renderHtml("Expired callback", "Verification callback expired. Start again from Discord."));
    }

    const session = sessions.consumeSession(token);
    if (!session) {
      return res
        .status(400)
        .send(renderHtml("Session expired", "Verification session expired. Start again from Discord."));
    }

    const isValid = await verifySteamOpenIdResponse(new URLSearchParams(req.query));
    if (!isValid) {
      return res.status(400).send(renderHtml("Verification failed", "Steam OpenID response was not valid."));
    }

    const steamId = extractSteamIdFromClaimedId(req.query["openid.claimed_id"]);
    if (!steamId) {
      return res.status(400).send(renderHtml("Verification failed", "Could not extract SteamID from response."));
    }

    const guild = await client.guilds.fetch(session.guildId);
    const guildConfig = store.getGuild(session.guildId);
    if (!guildConfig) {
      return res
        .status(400)
        .send(renderHtml("Not configured", "This Discord server has not completed bot setup."));
    }

    const steamInfo = await fetchSteamProfileAndBans(STEAM_WEB_API_KEY, steamId);

    store.setUserVerification(session.userId, session.guildId, steamInfo);

    const member = await guild.members.fetch(session.userId).catch(() => null);
    const roleResult = {
      status: "not_attempted",
      details: "Verified role assignment was not attempted.",
      roleLabel: guildConfig.verifiedRoleId ? `<@&${guildConfig.verifiedRoleId}>` : "(not configured)"
    };

    if (!guildConfig.verifiedRoleId) {
      roleResult.status = "missing_config";
      roleResult.details = "Verified role is not configured for this server.";
    } else if (!member) {
      roleResult.status = "member_not_found";
      roleResult.details = "Could not find the Discord member to apply the verified role.";
    } else {
      const verifiedRole = await guild.roles.fetch(guildConfig.verifiedRoleId).catch(() => null);
      const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));

      if (!verifiedRole) {
        roleResult.status = "missing_role";
        roleResult.details = "Configured verified role no longer exists.";
      } else {
        roleResult.roleLabel = `<@&${verifiedRole.id}>`;
        const hasManageRoles = Boolean(me?.permissions.has(PermissionFlagsBits.ManageRoles));

        if (!hasManageRoles) {
          roleResult.status = "missing_permission";
          roleResult.details = "Bot is missing the Manage Roles permission.";
        } else if (!me || me.roles.highest.comparePositionTo(verifiedRole) <= 0) {
          roleResult.status = "role_hierarchy";
          roleResult.details = "Bot role is not high enough to assign the configured verified role.";
        } else if (member.roles.cache.has(verifiedRole.id)) {
          roleResult.status = "already_has_role";
          roleResult.details = "Member already had the verified role.";
        } else {
          const addRoleError = await member.roles.add(verifiedRole).then(() => null).catch((error) => error);
          if (addRoleError) {
            roleResult.status = "apply_failed";
            roleResult.details = `Failed to assign verified role: ${addRoleError.message}`;
          } else {
            roleResult.status = "applied";
            roleResult.details = "Verified role was assigned successfully.";
          }
        }
      }
    }

    const logsChannel = await guild.channels.fetch(guildConfig.logsChannelId).catch(() => null);
    if (logsChannel && logsChannel.type === ChannelType.GuildText) {
      const discordTag = member ? `${member.user.username} (${member.user.id})` : `User ID ${session.userId}`;
      const bans = steamInfo.bans;
      const bansSummary = [
        `Community Banned: ${bans.communityBanned ? "Yes" : "No"}`,
        `VAC Banned: ${bans.vacBanned ? "Yes" : "No"}`,
        `Number of VAC Bans: ${bans.numberOfVacBans}`,
        `Days Since Last Ban: ${bans.daysSinceLastBan}`,
        `Number of Game Bans: ${bans.numberOfGameBans}`,
        `Economy Ban: ${bans.economyBan}`
      ].join("\n");

      const logEmbed = baseEmbed("User verified with Steam", "A member completed Steam verification.")
        .addFields(
          { name: "Discord User", value: discordTag },
          { name: "Steam Name", value: steamInfo.personaName },
          { name: "SteamID", value: steamInfo.steamId },
          { name: "Steam Profile", value: steamInfo.profileUrl },
          { name: "Ban / Warning Status", value: bansSummary },
          {
            name: "Verified Role Status",
            value: `${roleResult.roleLabel}\n${roleResult.details}`
          }
        )
        .setThumbnail(steamInfo.avatar);

      await logsChannel.send({ embeds: [logEmbed] }).catch(() => {});
    }

    const verifyChannel = await guild.channels.fetch(session.channelId).catch(() => null);
    if (verifyChannel && verifyChannel.type === ChannelType.GuildText) {
      const roleApplied = roleResult.status === "applied" || roleResult.status === "already_has_role";
      const verifyEmbed = baseEmbed(
        roleApplied ? "Verification successful" : "Verification completed with role issue",
        roleApplied
          ? `<@${session.userId}> connected their Steam account and now has ${roleResult.roleLabel}.`
          : `<@${session.userId}> connected their Steam account, but the verified role could not be applied automatically.`
      ).addFields(
        { name: "Steam Name", value: steamInfo.personaName, inline: true },
        { name: "SteamID", value: steamInfo.steamId, inline: true },
        {
          name: "Role Result",
          value: `${roleResult.roleLabel}\n${roleResult.details}`
        }
      );

      const sentMessage = await verifyChannel.send({ embeds: [verifyEmbed] }).catch(() => null);
      if (sentMessage) {
        setTimeout(() => {
          sentMessage.delete().catch(() => {});
        }, VERIFY_CHANNEL_STATUS_TTL_MS);
      }
    }

    return res
      .status(200)
      .send(
        renderHtml(
          "Verification successful",
          "Your Steam account is now linked. Return to Discord and you should have access shortly.",
          {
            showConnectionHeader: true,
            showSuccessChip: true,
            guildName: guild.name,
            guildIconUrl: guild.iconURL({ size: 128 })
          }
        )
      );
  } catch (error) {
    console.error("Steam callback error:", error);
    return res
      .status(500)
      .send(renderHtml("Server error", "An error occurred during verification. Please try again."));
  }
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  for (const guild of client.guilds.cache.values()) {
    try {
      await registerGuildCommands(guild.id);
      console.log(`Registered commands for guild ${guild.id}`);
    } catch (err) {
      console.error(`Failed to register commands for guild ${guild.id}:`, err);
    }
  }
});

client.on("guildCreate", async (guild) => {
  try {
    await registerGuildCommands(guild.id);
    await sendGuildSetupPrompt(guild);
  } catch (error) {
    console.error("Error handling guildCreate:", error);
  }
});

client.on("guildMemberAdd", async (member) => {
  try {
    const cfg = store.getGuild(member.guild.id);
    if (!cfg?.verifyChannelId) {
      return;
    }

    await member.send({
      embeds: [
        baseEmbed(
          "Complete verification",
          `Welcome to **${member.guild.name}**. Please go to <#${cfg.verifyChannelId}> and click **Verify with Steam** to unlock access.`
        )
      ]
    });
  } catch {
    // Ignore DM failures (user may have DMs disabled)
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "setup") {
        const verifyChannel = interaction.options.getChannel("verify_channel", true);
        const logsChannel = interaction.options.getChannel("logs_channel", true);
        const verifiedRole = interaction.options.getRole("verified_role", true);

        store.setGuild(interaction.guildId, {
          verifyChannelId: verifyChannel.id,
          logsChannelId: logsChannel.id,
          verifiedRoleId: verifiedRole.id
        });

        await interaction.reply({
          embeds: [
            baseEmbed(
              "Verification configured",
              `Verify channel: <#${verifyChannel.id}>\nLogs channel: <#${logsChannel.id}>\nVerified role: <@&${verifiedRole.id}>`
            )
          ],
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === "post-verify") {
        await postVerifyPrompt(interaction.guild);
        await interaction.reply({
          embeds: [baseEmbed("Posted", "Verification embed posted in the configured verify channel.")],
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === "verify-status") {
        const cfg = store.getGuild(interaction.guildId);
        if (!cfg) {
          await interaction.reply({
            embeds: [baseEmbed("Not configured", "Run `/setup` first.")],
            ephemeral: true
          });
          return;
        }

        await interaction.reply({
          embeds: [
            baseEmbed(
              "Current verification setup",
              `Verify channel: <#${cfg.verifyChannelId}>\nLogs channel: <#${cfg.logsChannelId}>\nVerified role: <@&${cfg.verifiedRoleId}>`
            )
          ],
          ephemeral: true
        });
        return;
      }
    }

    if (interaction.isButton() && interaction.customId === "verify_start") {
      if (!interaction.guildId) {
        await interaction.reply({
          embeds: [baseEmbed("Server only", "Verification can only be used inside a Discord server.")],
          ephemeral: true
        });
        return;
      }

      const cfg = store.getGuild(interaction.guildId);
      if (!cfg) {
        await interaction.reply({
          embeds: [baseEmbed("Not configured", "Server admins must run `/setup` first.")],
          ephemeral: true
        });
        return;
      }

      const token = sessions.createSession({
        guildId: interaction.guildId,
        userId: interaction.user.id,
        channelId: interaction.channelId
      });

      const verifyUrl = `${PUBLIC_BASE_URL}/verify/start?token=${encodeURIComponent(token)}`;
      const verifyLinkRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(verifyUrl).setLabel("Open Steam verification")
      );

      await interaction.reply({
        embeds: [
          baseEmbed(
            "Start Steam verification",
            `Use the button below to start Steam verification.\n\nIf the button does not work, open this URL:\n<${verifyUrl}>\n\nThis link expires in 10 minutes.`
          )
        ],
        components: [verifyLinkRow],
        ephemeral: true
      });
      return;
    }
  } catch (error) {
    console.error("Interaction error:", error);
    if (interaction.isRepliable() && !interaction.replied) {
      await interaction.reply({
        embeds: [baseEmbed("Error", "Something went wrong while handling this action.")],
        ephemeral: true
      });
    }
  }
});

app.listen(Number(PORT), () => {
  console.log(`Web server listening on port ${PORT}`);
});

client.login(DISCORD_BOT_TOKEN);
