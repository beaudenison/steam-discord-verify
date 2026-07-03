import fs from "node:fs";
import path from "node:path";

const DEFAULT_DB_PATH = path.resolve(process.cwd(), "data", "db.json");

const defaultData = {
  guilds: {},
  users: {}
};

export class ConfigStore {
  constructor(filePath = DEFAULT_DB_PATH) {
    this.filePath = filePath;
    this.ensureFile();
    this.data = this.read();
  }

  ensureFile() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify(defaultData, null, 2));
    }
  }

  read() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        guilds: parsed.guilds || {},
        users: parsed.users || {}
      };
    } catch {
      return structuredClone(defaultData);
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  getGuild(guildId) {
    return this.data.guilds[guildId] || null;
  }

  setGuild(guildId, config) {
    this.data.guilds[guildId] = {
      ...(this.data.guilds[guildId] || {}),
      ...config,
      updatedAt: new Date().toISOString()
    };
    this.save();
    return this.data.guilds[guildId];
  }

  setUserVerification(discordUserId, guildId, steamInfo) {
    this.data.users[discordUserId] = {
      discordUserId,
      guildId,
      steamInfo,
      verifiedAt: new Date().toISOString()
    };
    this.save();
    return this.data.users[discordUserId];
  }

  getUserVerification(discordUserId) {
    return this.data.users[discordUserId] || null;
  }
}
