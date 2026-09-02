const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CONFIRMED_ROOM_TTL_MS = 20 * 60 * 1000;
const MAX_SIGNAL_MESSAGES = 240;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const PICKUP_HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_TURN_LIMIT_GB = 800;
const DEFAULT_TURN_TTL_SECONDS = 3600;
const TURN_USAGE_CACHE_SECONDS = 60;
const DECIMAL_GB = 1_000_000_000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

function firstLanAddress() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "localhost";
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function safeHashEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function pairingCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function securityHeaders(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const headers = {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; object-src 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), screen-wake-lock=(self)",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN"
  };
  if (forwardedProto === "https" || process.env.NODE_ENV === "production") {
    headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload";
  }
  return headers;
}

function writeHead(req, res, status, headers = {}) {
  res.writeHead(status, { ...securityHeaders(req), ...headers });
}

function json(req, res, status, body) {
  const payload = JSON.stringify(body);
  writeHead(req, res, status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store"
  });
  res.end(payload);
}

async function readJson(req, limit = 64 * 1024) {
  if (req.body !== undefined) {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
    if (Buffer.byteLength(JSON.stringify(body || {})) > limit) throw new Error("PAYLOAD_TOO_LARGE");
    return body || {};
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function normalizedHost(req) {
  const raw = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return /^[A-Za-z0-9.:[\]-]+(?::\d+)?$/.test(raw) ? raw : "localhost";
}

function requestOrigin(req, port) {
  const configured = String(process.env.PUBLIC_ORIGIN || "").replace(/\/$/, "");
  if (configured) return configured;
  const host = normalizedHost(req);
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  if (host === "localhost" || host.startsWith("localhost:") || host === "127.0.0.1" || host.startsWith("127.0.0.1:")) {
    const hostname = host.split(":")[0];
    return `http://${hostname === "localhost" ? firstLanAddress() : hostname}:${port}`;
  }
  return `${forwardedProto === "http" ? "http" : "https"}://${host}`;
}

function sameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const requestUrl = new URL(origin);
    const ownHost = normalizedHost(req);
    const configured = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN) : null;
    return requestUrl.host === ownHost || Boolean(configured && requestUrl.origin === configured.origin);
  } catch (_) {
    return false;
  }
}

function bearerToken(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer ([A-Za-z0-9_-]+)$/);
  return match ? match[1] : "";
}

function requestIp(req) {
  if (process.env.TRUST_PROXY === "1" || process.env.VERCEL === "1") {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded.slice(0, 80);
  }
  return String(req.socket?.remoteAddress || "unknown").slice(0, 80);
}

class MemoryRoomStore {
  constructor() {
    this.rooms = new Map();
    this.pickupRooms = new Map();
    this.rates = new Map();
    this.relayControl = null;
    this.turnUsageCache = null;
  }

  clean() {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      if (room.meta.expiresAt <= now) {
        this.rooms.delete(id);
        if (room.meta.pickupCodeHash) this.pickupRooms.delete(room.meta.pickupCodeHash);
      }
    }
    for (const [key, rate] of this.rates) if (rate.expiresAt <= now) this.rates.delete(key);
  }

  async create(meta) {
    this.clean();
    if (this.rooms.has(meta.id) || (meta.pickupCodeHash && this.pickupRooms.has(meta.pickupCodeHash))) return false;
    this.rooms.set(meta.id, {
      meta,
      receiverSessionHash: null,
      nextMessageId: 1,
      messages: { sender: [], receiver: [] }
    });
    if (meta.pickupCodeHash) this.pickupRooms.set(meta.pickupCodeHash, meta.id);
    return true;
  }

  async getMeta(id) {
    this.clean();
    return this.rooms.get(id)?.meta || null;
  }

  async claim(id, inviteHash, receiverSessionHash) {
    this.clean();
    const room = this.rooms.get(id);
    if (!room) return { status: "not_found" };
    if (!safeHashEqual(room.meta.inviteTokenHash, inviteHash)) return { status: "unauthorized" };
    if (room.receiverSessionHash) return { status: "claimed" };
    room.receiverSessionHash = receiverSessionHash;
    return { status: "ok", meta: room.meta };
  }

  async claimPickup(pickupCodeHash, receiverSessionHash) {
    this.clean();
    const id = this.pickupRooms.get(pickupCodeHash);
    const room = id ? this.rooms.get(id) : null;
    if (!room || !safeHashEqual(room.meta.pickupCodeHash, pickupCodeHash)) return { status: "not_found" };
    if (room.receiverSessionHash) return { status: "claimed" };
    room.receiverSessionHash = receiverSessionHash;
    return { status: "ok", meta: room.meta };
  }

  async authenticate(id, tokenHash) {
    this.clean();
    const room = this.rooms.get(id);
    if (!room) return null;
    if (safeHashEqual(room.meta.senderTokenHash, tokenHash)) return { role: "sender", meta: room.meta };
    if (room.receiverSessionHash && safeHashEqual(room.receiverSessionHash, tokenHash)) return { role: "receiver", meta: room.meta };
    return null;
  }

  async hasReceiver(id) {
    this.clean();
    return Boolean(this.rooms.get(id)?.receiverSessionHash);
  }

  async confirm(id, confirmedAt, expiresAt) {
    this.clean();
    const room = this.rooms.get(id);
    if (!room) return { status: "not_found" };
    if (!room.receiverSessionHash) return { status: "receiver_not_ready" };
    const newlyConfirmed = !room.meta.confirmedAt;
    if (!room.meta.confirmedAt) {
      room.meta = { ...room.meta, confirmedAt, expiresAt };
    }
    return { status: "ok", meta: room.meta, newlyConfirmed };
  }

  async addMessage(id, target, message) {
    this.clean();
    const room = this.rooms.get(id);
    if (!room) return null;
    const stored = { ...message, id: room.nextMessageId++ };
    room.messages[target].push(stored);
    if (room.messages[target].length > MAX_SIGNAL_MESSAGES) room.messages[target].shift();
    return stored;
  }

  async getMessages(id, target, after) {
    this.clean();
    const room = this.rooms.get(id);
    return room ? room.messages[target].filter(message => message.id > after) : null;
  }

  async delete(id) {
    const room = this.rooms.get(id);
    if (room?.meta.pickupCodeHash) this.pickupRooms.delete(room.meta.pickupCodeHash);
    this.rooms.delete(id);
  }

  async allowRate(key, limit, windowSeconds) {
    this.clean();
    const now = Date.now();
    const existing = this.rates.get(key);
    const rate = existing && existing.expiresAt > now
      ? existing
      : { count: 0, expiresAt: now + windowSeconds * 1000 };
    rate.count += 1;
    this.rates.set(key, rate);
    return rate.count <= limit;
  }

  async getRelayControl() {
    return this.relayControl || { enabled: false, reason: "initial", updatedAt: null };
  }

  async setRelayControl(control) {
    this.relayControl = control;
  }

  async getTurnUsageCache() {
    if (!this.turnUsageCache || this.turnUsageCache.expiresAt <= Date.now()) return null;
    return this.turnUsageCache.value;
  }

  async setTurnUsageCache(value, ttlSeconds) {
    this.turnUsageCache = { value, expiresAt: Date.now() + ttlSeconds * 1000 };
  }
}

class RedisRoomStore {
  constructor(url, token) {
    this.url = url.replace(/\/$/, "");
    this.token = token;
  }

  async command(args) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args)
    });
    if (!response.ok) throw new Error(`REDIS_${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(`REDIS_${payload.error}`);
    return payload.result;
  }

  base(id) { return `relay:room:${id}`; }

  pickupBase(pickupCodeHash) { return `relay:pickup:${pickupCodeHash}`; }

  async create(meta) {
    const ttl = Math.max(1, Math.ceil((meta.expiresAt - Date.now()) / 1000));
    const created = await this.command(["SET", `${this.base(meta.id)}:meta`, JSON.stringify(meta), "EX", ttl, "NX"]);
    if (created !== "OK") return false;
    if (meta.pickupCodeHash) {
      const indexed = await this.command(["SET", this.pickupBase(meta.pickupCodeHash), meta.id, "EX", ttl, "NX"]);
      if (indexed !== "OK") {
        await this.command(["DEL", `${this.base(meta.id)}:meta`]);
        return false;
      }
    }
    return true;
  }

  async getMeta(id) {
    const value = await this.command(["GET", `${this.base(id)}:meta`]);
    if (!value) return null;
    const meta = JSON.parse(value);
    return meta.expiresAt > Date.now() ? meta : null;
  }

  async claim(id, inviteHash, receiverSessionHash) {
    const meta = await this.getMeta(id);
    if (!meta) return { status: "not_found" };
    if (!safeHashEqual(meta.inviteTokenHash, inviteHash)) return { status: "unauthorized" };
    const ttl = Math.max(1, Math.ceil((meta.expiresAt - Date.now()) / 1000));
    const result = await this.command(["SET", `${this.base(id)}:receiver`, receiverSessionHash, "EX", ttl, "NX"]);
    return result === "OK" ? { status: "ok", meta } : { status: "claimed" };
  }

  async claimPickup(pickupCodeHash, receiverSessionHash) {
    const id = await this.command(["GET", this.pickupBase(pickupCodeHash)]);
    if (!id) return { status: "not_found" };
    const meta = await this.getMeta(id);
    if (!meta || !meta.pickupCodeHash || !safeHashEqual(meta.pickupCodeHash, pickupCodeHash)) return { status: "not_found" };
    const ttl = Math.max(1, Math.ceil((meta.expiresAt - Date.now()) / 1000));
    const result = await this.command(["SET", `${this.base(id)}:receiver`, receiverSessionHash, "EX", ttl, "NX"]);
    return result === "OK" ? { status: "ok", meta } : { status: "claimed" };
  }

  async authenticate(id, tokenHash) {
    const meta = await this.getMeta(id);
    if (!meta) return null;
    if (safeHashEqual(meta.senderTokenHash, tokenHash)) return { role: "sender", meta };
    const receiverHash = await this.command(["GET", `${this.base(id)}:receiver`]);
    if (receiverHash && safeHashEqual(receiverHash, tokenHash)) return { role: "receiver", meta };
    return null;
  }

  async hasReceiver(id) {
    return Boolean(await this.command(["GET", `${this.base(id)}:receiver`]));
  }

  async confirm(id, confirmedAt, expiresAt) {
    const meta = await this.getMeta(id);
    if (!meta) return { status: "not_found" };
    if (!await this.hasReceiver(id)) return { status: "receiver_not_ready" };
    if (meta.confirmedAt) return { status: "ok", meta, newlyConfirmed: false };
    const updated = { ...meta, confirmedAt, expiresAt };
    const ttl = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
    const saved = await this.command(["SET", `${this.base(id)}:meta`, JSON.stringify(updated), "EX", ttl, "XX"]);
    if (saved !== "OK") return { status: "not_found" };
    const expiringKeys = [
      `${this.base(id)}:receiver`, `${this.base(id)}:seq`,
      `${this.base(id)}:signals:sender`, `${this.base(id)}:signals:receiver`,
      ...(meta.pickupCodeHash ? [this.pickupBase(meta.pickupCodeHash)] : [])
    ];
    for (const key of expiringKeys) await this.command(["EXPIRE", key, ttl]);
    return { status: "ok", meta: updated, newlyConfirmed: true };
  }

  async addMessage(id, target, message) {
    const meta = await this.getMeta(id);
    if (!meta) return null;
    const ttl = Math.max(1, Math.ceil((meta.expiresAt - Date.now()) / 1000));
    const sequence = Number(await this.command(["INCR", `${this.base(id)}:seq`]));
    const stored = { ...message, id: sequence };
    const key = `${this.base(id)}:signals:${target}`;
    await this.command(["RPUSH", key, JSON.stringify(stored)]);
    await this.command(["LTRIM", key, -MAX_SIGNAL_MESSAGES, -1]);
    await this.command(["EXPIRE", key, ttl]);
    await this.command(["EXPIRE", `${this.base(id)}:seq`, ttl]);
    return stored;
  }

  async getMessages(id, target, after) {
    if (!await this.getMeta(id)) return null;
    const values = await this.command(["LRANGE", `${this.base(id)}:signals:${target}`, 0, -1]);
    return (values || []).map(value => JSON.parse(value)).filter(message => message.id > after);
  }

  async delete(id) {
    const meta = await this.getMeta(id);
    await this.command(["DEL",
      `${this.base(id)}:meta`, `${this.base(id)}:receiver`, `${this.base(id)}:seq`,
      `${this.base(id)}:signals:sender`, `${this.base(id)}:signals:receiver`,
      ...(meta?.pickupCodeHash ? [this.pickupBase(meta.pickupCodeHash)] : [])
    ]);
  }

  async allowRate(key, limit, windowSeconds) {
    const redisKey = `relay:rate:${crypto.createHash("sha256").update(key).digest("hex")}`;
    const count = Number(await this.command(["INCR", redisKey]));
    if (count === 1) await this.command(["EXPIRE", redisKey, windowSeconds]);
    return count <= limit;
  }

  async getRelayControl() {
    const value = await this.command(["GET", "relay:control:turn"]);
    return value ? JSON.parse(value) : { enabled: false, reason: "initial", updatedAt: null };
  }

  async setRelayControl(control) {
    await this.command(["SET", "relay:control:turn", JSON.stringify(control)]);
  }

  async getTurnUsageCache() {
    const value = await this.command(["GET", "relay:usage:turn"]);
    return value ? JSON.parse(value) : null;
  }

  async setTurnUsageCache(value, ttlSeconds) {
    await this.command(["SET", "relay:usage:turn", JSON.stringify(value), "EX", ttlSeconds]);
  }
}

function defaultStore() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new RedisRoomStore(url, token) : new MemoryRoomStore();
}

function hasTurnConfiguration() {
  return Boolean(
    (process.env.TURN_KEY_ID && process.env.TURN_KEY_API_TOKEN) ||
    process.env.ICE_SERVERS_JSON
  );
}

function relaySettings(overrides = {}) {
  const limitGb = Number(overrides.limitGb ?? process.env.TURN_MONTHLY_LIMIT_GB ?? DEFAULT_TURN_LIMIT_GB);
  return {
    configured: overrides.configured ?? hasTurnConfiguration(),
    environmentEnabled: overrides.environmentEnabled ?? process.env.TURN_ENABLED === "1",
    limitGb: Number.isFinite(limitGb) && limitGb > 0 ? limitGb : DEFAULT_TURN_LIMIT_GB,
    accountId: overrides.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    analyticsToken: overrides.analyticsToken ?? process.env.CLOUDFLARE_ANALYTICS_API_TOKEN ?? "",
    turnKeyId: overrides.turnKeyId ?? process.env.TURN_KEY_ID ?? "",
    turnKeyApiToken: overrides.turnKeyApiToken ?? process.env.TURN_KEY_API_TOKEN ?? "",
    iceServersJson: overrides.iceServersJson ?? process.env.ICE_SERVERS_JSON ?? "",
    usageProvider: overrides.usageProvider ?? cloudflareTurnUsage,
    usageCacheSeconds: overrides.usageCacheSeconds ?? TURN_USAGE_CACHE_SECONDS
  };
}

function publicRelayStatus(status) {
  return {
    configured: status.configured,
    environmentEnabled: status.environmentEnabled,
    manualEnabled: status.manualEnabled,
    enabled: status.enabled,
    reason: status.reason,
    limitGb: status.limitGb,
    usageGb: status.usageBytes === null ? null : status.usageBytes / DECIMAL_GB,
    usageCheckedAt: status.usageCheckedAt
  };
}

function stunOnly(reason, status = null) {
  return {
    iceServers: [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] }],
    relayAvailable: false,
    relayReason: reason,
    relayStatus: status ? publicRelayStatus(status) : undefined
  };
}

function utcMonthRange(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return { dateFrom: `${year}-${month}-01`, dateTo: `${year}-${month}-${day}` };
}

async function cloudflareTurnUsage(settings) {
  const query = `query TurnUsage($accountId: String!, $dateFrom: Date!, $dateTo: Date!) {
    viewer {
      accounts(filter: { accountTag: $accountId }) {
        callsTurnUsageAdaptiveGroups(
          limit: 10000
          filter: { date_geq: $dateFrom, date_leq: $dateTo }
        ) { sum { egressBytes } }
      }
    }
  }`;
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.analyticsToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables: { accountId: settings.accountId, ...utcMonthRange() } })
  });
  if (!response.ok) throw new Error(`TURN_ANALYTICS_${response.status}`);
  const payload = await response.json();
  if (payload.errors?.length) throw new Error("TURN_ANALYTICS_QUERY");
  const groups = payload.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups;
  if (!Array.isArray(groups)) throw new Error("TURN_ANALYTICS_INVALID");
  return groups.reduce((total, group) => total + Number(group.sum?.egressBytes || 0), 0);
}

async function relaySafetyStatus(store, overrides = {}) {
  const settings = relaySettings(overrides);
  const control = await store.getRelayControl();
  const cached = await store.getTurnUsageCache();
  const status = {
    configured: settings.configured,
    environmentEnabled: settings.environmentEnabled,
    manualEnabled: control.enabled === true,
    enabled: false,
    reason: "not_configured",
    limitGb: settings.limitGb,
    usageBytes: cached?.usageBytes ?? null,
    usageCheckedAt: cached?.checkedAt ?? null
  };

  if (!settings.configured) return status;
  if (!settings.environmentEnabled) return { ...status, reason: "environment_disabled" };
  if (!control.enabled) {
    return { ...status, reason: control.reason === "quota" ? "quota_reached" : "manual_disabled" };
  }

  const needsCloudflareMonitor = Boolean(settings.turnKeyId && settings.turnKeyApiToken);
  if (!needsCloudflareMonitor) return { ...status, enabled: true, reason: "custom_relay" };
  if (!settings.accountId || !settings.analyticsToken) {
    return { ...status, reason: "quota_monitor_unconfigured" };
  }

  let usage = cached;
  if (!usage) {
    try {
      const usageBytes = await settings.usageProvider(settings);
      usage = { usageBytes, checkedAt: new Date().toISOString() };
      await store.setTurnUsageCache(usage, settings.usageCacheSeconds);
    } catch (error) {
      console.error("Unable to read TURN usage:", error.message);
      return { ...status, reason: "quota_check_failed" };
    }
  }

  const measured = { ...status, usageBytes: usage.usageBytes, usageCheckedAt: usage.checkedAt };
  if (usage.usageBytes >= settings.limitGb * DECIMAL_GB) {
    await store.setRelayControl({ enabled: false, reason: "quota", updatedAt: new Date().toISOString() });
    return { ...measured, manualEnabled: false, reason: "quota_reached" };
  }
  return { ...measured, enabled: true, reason: "available" };
}

async function iceConfiguration(settings = relaySettings()) {
  if (settings.iceServersJson) {
    const iceServers = JSON.parse(settings.iceServersJson);
    return { iceServers, relayAvailable: iceServers.some(server => JSON.stringify(server.urls).includes("turn:")) };
  }

  if (settings.turnKeyId && settings.turnKeyApiToken) {
    const ttl = DEFAULT_TURN_TTL_SECONDS;
    const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(settings.turnKeyId)}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.turnKeyApiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ttl })
    });
    if (!response.ok) throw new Error(`TURN_${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.iceServers)) throw new Error("TURN_INVALID_RESPONSE");
    return { iceServers: payload.iceServers, relayAvailable: true };
  }

  return stunOnly("not_configured");
}

async function guardedIceConfiguration(store, overrides = {}) {
  const settings = relaySettings(overrides);
  const safety = await relaySafetyStatus(store, settings);
  if (!safety.enabled) return stunOnly(safety.reason, safety);
  try {
    return { ...await iceConfiguration(settings), relayStatus: publicRelayStatus(safety) };
  } catch (error) {
    console.error("Unable to create TURN credentials:", error.message);
    return stunOnly("relay_unavailable", { ...safety, enabled: false, reason: "relay_unavailable" });
  }
}

function validSignal(role, type, data) {
  const allowed = role === "sender"
    ? ["approved", "offer", "candidate"]
    : ["answer", "candidate"];
  if (!allowed.includes(type)) return false;
  if (type === "approved") return data === null || data === undefined;
  if (type === "offer" || type === "answer") {
    return data && data.type === type && typeof data.sdp === "string" && data.sdp.length <= 48 * 1024;
  }
  return data && typeof data.candidate === "string" && data.candidate.length <= 4096 &&
    (data.sdpMid === null || data.sdpMid === undefined || typeof data.sdpMid === "string") &&
    (data.sdpMLineIndex === null || data.sdpMLineIndex === undefined || Number.isInteger(data.sdpMLineIndex));
}

function createHandler(options = {}) {
  const store = options.store || defaultStore();
  const port = Number(options.port || process.env.PORT || 8788);
  const roomTtlMs = Number(options.roomTtlMs || process.env.ROOM_TTL_MS || DEFAULT_ROOM_TTL_MS);
  const confirmedRoomTtlMs = Number(options.confirmedRoomTtlMs || process.env.CONFIRMED_ROOM_TTL_MS || DEFAULT_CONFIRMED_ROOM_TTL_MS);
  const relayOptions = options.relayOptions || {};
  const adminToken = options.adminToken ?? process.env.RELAY_ADMIN_TOKEN ?? "";

  async function authenticate(req, res, roomId) {
    const token = bearerToken(req);
    if (!TOKEN_PATTERN.test(token)) {
      json(req, res, 401, { error: "unauthorized" });
      return null;
    }
    const auth = await store.authenticate(roomId, hashToken(token));
    if (!auth) json(req, res, 401, { error: "unauthorized" });
    return auth;
  }

  function authenticateAdmin(req, res) {
    if (!adminToken) {
      json(req, res, 503, { error: "admin_not_configured" });
      return false;
    }
    const supplied = bearerToken(req);
    if (!supplied || !safeHashEqual(hashToken(supplied), hashToken(adminToken))) {
      json(req, res, 401, { error: "unauthorized" });
      return false;
    }
    return true;
  }

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const rewrittenRoute = url.searchParams.get("route");
      const pathname = rewrittenRoute
        ? `/api/${rewrittenRoute.replace(/^\/+|\/+$/g, "")}`
        : url.pathname;
      const ip = requestIp(req);

      if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !sameOriginRequest(req)) {
        json(req, res, 403, { error: "invalid_origin" });
        return;
      }

      if (!await store.allowRate(`global:${ip}`, 600, 60)) {
        json(req, res, 429, { error: "rate_limited" });
        return;
      }

      if (req.method === "GET" && pathname === "/api/status") {
        const settings = relaySettings(relayOptions);
        const control = await store.getRelayControl();
        json(req, res, 200, {
          ok: true,
          roomTtlMinutes: roomTtlMs / 60_000,
          confirmedRoomTtlMinutes: confirmedRoomTtlMs / 60_000,
          persistentSignaling: store instanceof RedisRoomStore,
          relayConfigured: settings.configured,
          relayEnvironmentEnabled: settings.environmentEnabled,
          relayAllowed: control.enabled === true,
          relayLimitGb: settings.limitGb
        });
        return;
      }

      if (pathname === "/api/admin/relay" && ["GET", "POST"].includes(req.method)) {
        if (!await store.allowRate(`admin:${ip}`, 30, 600)) {
          json(req, res, 429, { error: "rate_limited" });
          return;
        }
        if (!authenticateAdmin(req, res)) return;
        if (req.method === "POST") {
          const body = await readJson(req);
          if (typeof body.enabled !== "boolean") {
            json(req, res, 400, { error: "invalid_request" });
            return;
          }
          await store.setRelayControl({
            enabled: body.enabled,
            reason: "manual",
            updatedAt: new Date().toISOString()
          });
        }
        const status = await relaySafetyStatus(store, relayOptions);
        json(req, res, 200, publicRelayStatus(status));
        return;
      }

      if (req.method === "POST" && pathname === "/api/rooms") {
        if (!await store.allowRate(`create:${ip}`, 12, 600)) {
          json(req, res, 429, { error: "rate_limited" });
          return;
        }
        const body = await readJson(req);
        const pickupCodeHash = body.pickupCodeHash;
        if (pickupCodeHash !== undefined && !PICKUP_HASH_PATTERN.test(pickupCodeHash)) {
          json(req, res, 400, { error: "invalid_pickup_code" });
          return;
        }
        if (body.verificationRequired !== undefined && typeof body.verificationRequired !== "boolean") {
          json(req, res, 400, { error: "invalid_verification_setting" });
          return;
        }
        const id = randomToken(18);
        const senderToken = randomToken();
        const inviteToken = randomToken();
        const now = Date.now();
        const meta = {
          id,
          createdAt: now,
          expiresAt: now + roomTtlMs,
          code: pairingCode(),
          senderTokenHash: hashToken(senderToken),
          inviteTokenHash: hashToken(inviteToken),
          verificationRequired: body.verificationRequired === true,
          ...(pickupCodeHash ? { pickupCodeHash } : {})
        };
        if (!await store.create(meta)) {
          json(req, res, 409, { error: "pickup_code_unavailable" });
          return;
        }
        json(req, res, 201, {
          roomId: id,
          senderToken,
          inviteToken,
          receiverBaseUrl: `${requestOrigin(req, port)}/?room=${encodeURIComponent(id)}`,
          pickupUrl: `${requestOrigin(req, port)}/pickup`,
          verificationRequired: meta.verificationRequired,
          expiresAt: new Date(meta.expiresAt).toISOString()
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/pickup/claim") {
        if (!await store.allowRate(`pickup:${ip}`, 12, 600)) {
          json(req, res, 429, { error: "rate_limited" });
          return;
        }
        const body = await readJson(req);
        if (!PICKUP_HASH_PATTERN.test(body.pickupCodeHash || "")) {
          json(req, res, 400, { error: "invalid_pickup_code" });
          return;
        }
        const receiverToken = randomToken();
        const result = await store.claimPickup(body.pickupCodeHash, hashToken(receiverToken));
        if (result.status === "not_found") json(req, res, 404, { error: "pickup_not_found" });
        else if (result.status === "claimed") json(req, res, 409, { error: "room_claimed" });
        else {
          await store.addMessage(result.meta.id, "sender", {
            from: "system",
            type: "join",
            data: { code: result.meta.code, pickup: true }
          });
          json(req, res, 201, {
            roomId: result.meta.id,
            receiverToken,
            code: result.meta.code,
            verificationRequired: result.meta.verificationRequired === true,
            expiresAt: new Date(result.meta.expiresAt).toISOString()
          });
        }
        return;
      }

      const claimMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{20,40})\/claim$/);
      if (claimMatch && req.method === "POST") {
        if (!await store.allowRate(`claim:${ip}`, 30, 600)) {
          json(req, res, 429, { error: "rate_limited" });
          return;
        }
        const inviteToken = bearerToken(req);
        if (!TOKEN_PATTERN.test(inviteToken)) {
          json(req, res, 401, { error: "unauthorized" });
          return;
        }
        const receiverToken = randomToken();
        const result = await store.claim(claimMatch[1], hashToken(inviteToken), hashToken(receiverToken));
        if (result.status === "not_found") json(req, res, 404, { error: "room_not_found" });
        else if (result.status === "unauthorized") json(req, res, 401, { error: "unauthorized" });
        else if (result.status === "claimed") json(req, res, 409, { error: "room_claimed" });
        else {
          await store.addMessage(claimMatch[1], "sender", {
            from: "system",
            type: "join",
            data: { code: result.meta.code, pickup: false }
          });
          json(req, res, 201, {
            receiverToken,
            code: result.meta.code,
            verificationRequired: result.meta.verificationRequired === true,
            expiresAt: new Date(result.meta.expiresAt).toISOString()
          });
        }
        return;
      }

      const iceMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{20,40})\/ice$/);
      if (iceMatch && req.method === "GET") {
        const auth = await authenticate(req, res, iceMatch[1]);
        if (!auth) return;
        if (!await store.allowRate(`ice:${iceMatch[1]}:${auth.role}`, 6, 600)) {
          json(req, res, 429, { error: "rate_limited" });
          return;
        }
        json(req, res, 200, await guardedIceConfiguration(store, relayOptions));
        return;
      }

      const confirmMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{20,40})\/confirm$/);
      if (confirmMatch && req.method === "POST") {
        const auth = await authenticate(req, res, confirmMatch[1]);
        if (!auth) return;
        if (auth.role !== "receiver") {
          json(req, res, 403, { error: "forbidden" });
          return;
        }
        if (!await store.allowRate(`confirm:${confirmMatch[1]}`, 6, 600)) {
          json(req, res, 429, { error: "rate_limited" });
          return;
        }
        const confirmedAt = Date.now();
        const result = await store.confirm(confirmMatch[1], confirmedAt, confirmedAt + confirmedRoomTtlMs);
        if (result.status !== "ok") {
          json(req, res, result.status === "not_found" ? 404 : 409, { error: result.status });
          return;
        }
        if (result.newlyConfirmed) {
          await store.addMessage(confirmMatch[1], "sender", {
            from: "system",
            type: "confirmed",
            data: { expiresAt: new Date(result.meta.expiresAt).toISOString() }
          });
        }
        json(req, res, 200, {
          confirmedAt: new Date(result.meta.confirmedAt).toISOString(),
          expiresAt: new Date(result.meta.expiresAt).toISOString()
        });
        return;
      }

      const relayStatusMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{20,40})\/relay-status$/);
      if (relayStatusMatch && req.method === "GET") {
        const auth = await authenticate(req, res, relayStatusMatch[1]);
        if (!auth) return;
        if (!await store.allowRate(`relay-status:${relayStatusMatch[1]}:${auth.role}`, 15, 600)) {
          json(req, res, 429, { error: "rate_limited" });
          return;
        }
        json(req, res, 200, publicRelayStatus(await relaySafetyStatus(store, relayOptions)));
        return;
      }

      const roomMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{20,40})$/);
      if (roomMatch && req.method === "DELETE") {
        const auth = await authenticate(req, res, roomMatch[1]);
        if (!auth) return;
        if (auth.role !== "sender") {
          json(req, res, 403, { error: "forbidden" });
          return;
        }
        await store.delete(roomMatch[1]);
        json(req, res, 200, { ok: true });
        return;
      }

      const signalMatch = pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{20,40})\/signals$/);
      if (signalMatch) {
        const auth = await authenticate(req, res, signalMatch[1]);
        if (!auth) return;
        if (!await store.allowRate(`signal:${signalMatch[1]}:${auth.role}`, 480, 600)) {
          json(req, res, 429, { error: "rate_limited" });
          return;
        }

        if (req.method === "POST") {
          if (auth.role === "sender" && !await store.hasReceiver(signalMatch[1])) {
            json(req, res, 409, { error: "receiver_not_ready" });
            return;
          }
          const body = await readJson(req);
          if (!validSignal(auth.role, body.type, body.data)) {
            json(req, res, 400, { error: "invalid_signal" });
            return;
          }
          const target = auth.role === "sender" ? "receiver" : "sender";
          const stored = await store.addMessage(signalMatch[1], target, {
            from: auth.role,
            type: body.type,
            data: body.data ?? null
          });
          if (!stored) json(req, res, 404, { error: "room_not_found" });
          else json(req, res, 201, { ok: true, id: stored.id });
          return;
        }

        if (req.method === "GET") {
          const after = Number(url.searchParams.get("after") || 0);
          if (!Number.isSafeInteger(after) || after < 0) {
            json(req, res, 400, { error: "invalid_query" });
            return;
          }
          const messages = await store.getMessages(signalMatch[1], auth.role, after);
          if (!messages) json(req, res, 404, { error: "room_not_found" });
          else json(req, res, 200, { messages });
          return;
        }
      }

      if (req.method === "GET" && !pathname.startsWith("/api/")) {
        await serveStatic(req, res, pathname);
        return;
      }

      json(req, res, 404, { error: "not_found" });
    } catch (error) {
      const status = error.message === "PAYLOAD_TOO_LARGE" ? 413 :
        error instanceof SyntaxError ? 400 : 500;
      json(req, res, status, { error: status === 413 ? "payload_too_large" : status === 400 ? "invalid_json" : "server_error" });
      if (status === 500) console.error(error);
    }
  };
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === "/" ? "index.html" :
    pathname === "/admin" ? "admin.html" :
      pathname === "/pickup" ? "pickup.html" : pathname.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    json(req, res, 403, { error: "forbidden" });
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    const type = MIME_TYPES[path.extname(filePath)] || "application/octet-stream";
    writeHead(req, res, 200, {
      "Content-Type": type,
      "Content-Length": data.length,
      "Cache-Control": type.startsWith("text/html") ? "no-store" : "public, max-age=300"
    });
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT") json(req, res, 404, { error: "not_found" });
    else throw error;
  }
}

function createApp(options = {}) {
  const store = options.store || defaultStore();
  const port = Number(options.port || process.env.PORT || 8788);
  const handler = createHandler({ ...options, store, port });
  return { server: http.createServer(handler), store, port };
}

if (require.main === module) {
  const { server, port } = createApp();
  server.listen(port, "0.0.0.0", () => {
    console.log(`Relay is ready: http://localhost:${port}`);
    console.log(`On your network: http://${firstLanAddress()}:${port}`);
  });
}

module.exports = {
  createApp,
  createHandler,
  MemoryRoomStore,
  RedisRoomStore,
  firstLanAddress,
  hashToken,
  iceConfiguration,
  guardedIceConfiguration,
  relaySafetyStatus,
  utcMonthRange
};
