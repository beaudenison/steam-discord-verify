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
      value: "Steam profile, SteamID, and ban/warning status will be sent to verification logs."
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

function renderHtml(title, body) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      :root {
        color-scheme: light;
      }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif;
        background: radial-gradient(circle at top, #dceeff, #f5f9ff 45%, #ffffff);
        color: #0b1f3a;
        min-height: 100vh;
        display: grid;
        place-items: center;
      }
      .card {
        max-width: 560px;
        margin: 16px;
        border: 1px solid #bdd8ff;
        background: #ffffff;
        border-radius: 14px;
        box-shadow: 0 10px 40px rgba(24, 72, 132, 0.15);
        padding: 28px;
      }
      h1 {
        margin: 0 0 10px;
        font-size: 1.5rem;
      }
      p {
        margin: 0;
        line-height: 1.45;
      }
      a {
        color: #0f62d6;
      }
    </style>
  </head>
  <body>
    <article class="card">
      <h1>${title}</h1>
      <p>${body}</p>
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
  const returnTo = `${PUBLIC_URL.replace(/\/$/, "")}/auth/steam/return?nonce=${encodeURIComponent(nonce)}`;
  const openIdUrl = buildSteamOpenIdRedirect({
    realm: PUBLIC_URL.replace(/\/$/, ""),
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
    if (member && guildConfig.verifiedRoleId) {
      await member.roles.add(guildConfig.verifiedRoleId).catch(() => {});
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
          { name: "Ban / Warning Status", value: bansSummary }
        )
        .setThumbnail(steamInfo.avatar);

      await logsChannel.send({ embeds: [logEmbed] }).catch(() => {});
    }

    return res
      .status(200)
      .send(
        renderHtml(
          "Verification successful",
          "Your Steam account is now linked. Return to Discord and you should have access shortly."
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

      const verifyUrl = `${PUBLIC_URL.replace(/\/$/, "")}/verify/start?token=${encodeURIComponent(token)}`;

      await interaction.reply({
        embeds: [
          baseEmbed(
            "Start Steam verification",
            `[Click here to verify with Steam](${verifyUrl})\n\nThis link expires in 10 minutes.`
          )
        ],
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
