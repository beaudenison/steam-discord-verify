import crypto from "node:crypto";

const SESSION_TTL_MS = 10 * 60 * 1000;
const NONCE_TTL_MS = 10 * 60 * 1000;

export class VerifySessionStore {
  constructor() {
    this.sessions = new Map();
    this.nonces = new Map();
  }

  createSession({ guildId, userId, channelId }) {
    this.cleanup();

    const token = crypto.randomBytes(24).toString("hex");
    this.sessions.set(token, {
      guildId,
      userId,
      channelId,
      expiresAt: Date.now() + SESSION_TTL_MS
    });

    return token;
  }

  getSession(token) {
    const session = this.sessions.get(token);
    if (!session) {
      return null;
    }

    if (session.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return null;
    }

    return session;
  }

  consumeSession(token) {
    const session = this.getSession(token);
    if (!session) {
      return null;
    }

    this.sessions.delete(token);
    return session;
  }

  createNonce(token) {
    this.cleanup();

    const nonce = crypto.randomBytes(24).toString("hex");
    this.nonces.set(nonce, {
      token,
      expiresAt: Date.now() + NONCE_TTL_MS
    });
    return nonce;
  }

  consumeNonce(nonce) {
    const record = this.nonces.get(nonce);
    if (!record) {
      return null;
    }

    if (record.expiresAt < Date.now()) {
      this.nonces.delete(nonce);
      return null;
    }

    this.nonces.delete(nonce);
    return record.token;
  }

  cleanup() {
    const now = Date.now();
    for (const [token, value] of this.sessions.entries()) {
      if (value.expiresAt < now) {
        this.sessions.delete(token);
      }
    }

    for (const [nonce, value] of this.nonces.entries()) {
      if (value.expiresAt < now) {
        this.nonces.delete(nonce);
      }
    }
  }
}
