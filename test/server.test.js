const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
  createApp,
  MemoryRoomStore,
  relaySafetyStatus,
  utcMonthRange
} = require("../server");

const ADMIN_TOKEN = "test_admin_token_1234567890123456";

let server;
let origin;

before(async () => {
  const app = createApp({ port: 0, adminToken: ADMIN_TOKEN });
  server = app.server;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
});

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

async function createRoom(body = {}) {
  const response = await fetch(`${origin}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 201);
  return response.json();
}

function pickupHash(code) {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return createHash("sha256").update(`relay-pickup-lookup-v1:${normalized}`).digest("hex");
}

async function claimRoom(room) {
  const response = await fetch(`${origin}/api/rooms/${room.roomId}/claim`, {
    method: "POST",
    headers: bearer(room.inviteToken),
    body: "{}"
  });
  return { response, body: await response.json() };
}

test("serves the encrypted sender page with security headers", async () => {
  const response = await fetch(`${origin}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /端到端加密/);
  assert.match(html, /id="file-input" type="file" multiple/);
  assert.match(html, /id="pickup-name"[^>]+maxlength="6"/);
  assert.match(html, /id="verification-required" type="checkbox"/);
  assert.match(html, /id="download-list"/);
  assert.match(html, /id="add-sender-task"/);
  assert.match(html, /id="task-panels"/);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'self'/);
  assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("reports local signaling and TURN configuration", async () => {
  const response = await fetch(`${origin}/api/status`);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.ok, true);
  assert.equal(status.persistentSignaling, false);
  assert.equal(status.relayConfigured, false);
  assert.equal(status.relayEnvironmentEnabled, false);
  assert.equal(status.relayAllowed, false);
  assert.equal(status.relayLimitGb, 800);
  assert.equal(status.roomTtlMinutes, 24 * 60);
  assert.equal(status.confirmedRoomTtlMinutes, 20);
});

test("protects the manual relay switch and persists its state", async () => {
  const endpoint = `${origin}/api/admin/relay`;
  assert.equal((await fetch(endpoint)).status, 401);

  const enabledResponse = await fetch(endpoint, {
    method: "POST",
    headers: { ...bearer(ADMIN_TOKEN), "content-type": "application/json" },
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(enabledResponse.status, 200);
  const enabledStatus = await enabledResponse.json();
  assert.equal(enabledStatus.manualEnabled, true);
  assert.equal(enabledStatus.enabled, false);
  assert.equal(enabledStatus.reason, "not_configured");

  const disabledResponse = await fetch(endpoint, {
    method: "POST",
    headers: { ...bearer(ADMIN_TOKEN), "content-type": "application/json" },
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(disabledResponse.status, 200);
  assert.equal((await disabledResponse.json()).manualEnabled, false);
});

test("keeps Cloudflare relay available below the 800 GB safety line", async () => {
  const store = new MemoryRoomStore();
  await store.setRelayControl({ enabled: true, reason: "manual", updatedAt: new Date().toISOString() });
  const status = await relaySafetyStatus(store, {
    configured: true,
    environmentEnabled: true,
    limitGb: 800,
    accountId: "account",
    analyticsToken: "analytics",
    turnKeyId: "key",
    turnKeyApiToken: "secret",
    usageProvider: async () => 799_000_000_000
  });
  assert.equal(status.enabled, true);
  assert.equal(status.reason, "available");
  assert.equal(status.usageBytes, 799_000_000_000);
});

test("automatically disables Cloudflare relay at the 800 GB safety line", async () => {
  const store = new MemoryRoomStore();
  await store.setRelayControl({ enabled: true, reason: "manual", updatedAt: new Date().toISOString() });
  const status = await relaySafetyStatus(store, {
    configured: true,
    environmentEnabled: true,
    limitGb: 800,
    accountId: "account",
    analyticsToken: "analytics",
    turnKeyId: "key",
    turnKeyApiToken: "secret",
    usageProvider: async () => 800_000_000_000
  });
  assert.equal(status.enabled, false);
  assert.equal(status.manualEnabled, false);
  assert.equal(status.reason, "quota_reached");
  assert.equal((await store.getRelayControl()).enabled, false);
});

test("fails closed when Cloudflare usage cannot be checked", async () => {
  const store = new MemoryRoomStore();
  await store.setRelayControl({ enabled: true, reason: "manual", updatedAt: new Date().toISOString() });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const status = await relaySafetyStatus(store, {
      configured: true,
      environmentEnabled: true,
      accountId: "account",
      analyticsToken: "analytics",
      turnKeyId: "key",
      turnKeyApiToken: "secret",
      usageProvider: async () => { throw new Error("network"); }
    });
    assert.equal(status.enabled, false);
    assert.equal(status.reason, "quota_check_failed");
  } finally {
    console.error = originalConsoleError;
  }
});

test("uses the current UTC month for Cloudflare analytics", () => {
  assert.deepEqual(utcMonthRange(new Date("2026-09-01T00:00:00Z")), {
    dateFrom: "2026-09-01",
    dateTo: "2026-09-01"
  });
  assert.deepEqual(utcMonthRange(new Date("2026-12-31T23:59:59Z")), {
    dateFrom: "2026-12-01",
    dateTo: "2026-12-31"
  });
});

test("creates role secrets, allows one receiver claim, and announces its code", async () => {
  const beforeCreate = Date.now();
  const room = await createRoom();
  assert.match(room.roomId, /^[A-Za-z0-9_-]{20,40}$/);
  assert.match(room.senderToken, /^[A-Za-z0-9_-]{32,128}$/);
  assert.match(room.inviteToken, /^[A-Za-z0-9_-]{32,128}$/);
  assert.equal(room.receiverBaseUrl.includes("#"), false);
  const lifetimeMs = Date.parse(room.expiresAt) - beforeCreate;
  assert.ok(lifetimeMs > 24 * 60 * 60 * 1000 - 10_000);
  assert.ok(lifetimeMs <= 24 * 60 * 60 * 1000 + 10_000);

  const first = await claimRoom(room);
  assert.equal(first.response.status, 201);
  assert.match(first.body.code, /^\d{6}$/);
  assert.match(first.body.receiverToken, /^[A-Za-z0-9_-]{32,128}$/);

  const second = await claimRoom(room);
  assert.equal(second.response.status, 409);
  assert.equal(second.body.error, "room_claimed");

  const messages = await fetch(`${origin}/api/rooms/${room.roomId}/signals?after=0`, { headers: bearer(room.senderToken) });
  assert.equal(messages.status, 200);
  const result = await messages.json();
  assert.equal(result.messages[0].type, "join");
  assert.equal(result.messages[0].data.code, first.body.code);
  assert.equal(result.messages[0].data.pickup, false);
});

test("starts the 20-minute expiry only when the receiver explicitly confirms", async () => {
  const room = await createRoom();
  const claim = await claimRoom(room);
  const endpoint = `${origin}/api/rooms/${room.roomId}/confirm`;

  const senderAttempt = await fetch(endpoint, {
    method: "POST",
    headers: bearer(room.senderToken),
    body: "{}"
  });
  assert.equal(senderAttempt.status, 403);

  const beforeConfirm = Date.now();
  const confirmation = await fetch(endpoint, {
    method: "POST",
    headers: bearer(claim.body.receiverToken),
    body: "{}"
  });
  assert.equal(confirmation.status, 200);
  const confirmed = await confirmation.json();
  const confirmedLifetimeMs = Date.parse(confirmed.expiresAt) - beforeConfirm;
  assert.ok(confirmedLifetimeMs > 20 * 60 * 1000 - 10_000);
  assert.ok(confirmedLifetimeMs <= 20 * 60 * 1000 + 10_000);

  const messagesEndpoint = `${origin}/api/rooms/${room.roomId}/signals?after=0`;
  const firstMessages = await fetch(messagesEndpoint, { headers: bearer(room.senderToken) });
  assert.deepEqual((await firstMessages.json()).messages.map(message => message.type), ["join", "confirmed"]);

  const repeated = await fetch(endpoint, {
    method: "POST",
    headers: bearer(claim.body.receiverToken),
    body: "{}"
  });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).expiresAt, confirmed.expiresAt);

  const repeatedMessages = await fetch(messagesEndpoint, { headers: bearer(room.senderToken) });
  assert.deepEqual((await repeatedMessages.json()).messages.map(message => message.type), ["join", "confirmed"]);
});

test("serves a name-plus-six-digits, case-insensitive pickup-code entry page", async () => {
  const response = await fetch(`${origin}/pickup`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /4–6 位英文字母 \+ 6 位数字，不区分大小写/);
  assert.match(html, /id="pickup-input"[^>]+maxlength="13"/);
});

test("claims an active generated pickup code once and marks the join as pickup", async () => {
  const hash = pickupHash("Emma-482731");
  const room = await createRoom({ pickupCodeHash: hash, verificationRequired: true });
  assert.match(room.pickupUrl, /\/pickup$/);
  assert.equal(room.verificationRequired, true);

  const conflict = await fetch(`${origin}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pickupCodeHash: hash })
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, "pickup_code_unavailable");

  const claim = await fetch(`${origin}/api/pickup/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pickupCodeHash: hash })
  });
  assert.equal(claim.status, 201);
  const claimed = await claim.json();
  assert.equal(claimed.roomId, room.roomId);
  assert.match(claimed.receiverToken, /^[A-Za-z0-9_-]{32,128}$/);
  assert.equal(claimed.verificationRequired, true);

  const second = await fetch(`${origin}/api/pickup/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pickupCodeHash: hash })
  });
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error, "room_claimed");

  const messages = await fetch(`${origin}/api/rooms/${room.roomId}/signals?after=0`, { headers: bearer(room.senderToken) });
  const result = await messages.json();
  assert.equal(result.messages[0].data.pickup, true);
});

test("defaults optional verification to off for direct links", async () => {
  const room = await createRoom();
  assert.equal(room.verificationRequired, false);

  const claim = await claimRoom(room);
  assert.equal(claim.response.status, 201);
  assert.equal(claim.body.verificationRequired, false);
});

test("rejects a non-boolean verification setting", async () => {
  const response = await fetch(`${origin}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ verificationRequired: "false" })
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_verification_setting");
});

test("requires role authentication and relays only valid signaling", async () => {
  const room = await createRoom();
  const claim = await claimRoom(room);
  const endpoint = `${origin}/api/rooms/${room.roomId}/signals`;
  assert.equal((await fetch(`${endpoint}?after=0`)).status, 401);

  const invalid = await fetch(endpoint, {
    method: "POST",
    headers: { ...bearer(claim.body.receiverToken), "content-type": "application/json" },
    body: JSON.stringify({ type: "offer", data: { type: "offer", sdp: "wrong role" } })
  });
  assert.equal(invalid.status, 400);

  const approval = await fetch(endpoint, {
    method: "POST",
    headers: { ...bearer(room.senderToken), "content-type": "application/json" },
    body: JSON.stringify({ type: "approved", data: null })
  });
  assert.equal(approval.status, 201);

  const receiverMessages = await fetch(`${endpoint}?after=0`, { headers: bearer(claim.body.receiverToken) });
  const result = await receiverMessages.json();
  assert.deepEqual(result.messages.map(message => message.type), ["approved"]);
});

test("returns ICE configuration only to room participants", async () => {
  const room = await createRoom();
  assert.equal((await fetch(`${origin}/api/rooms/${room.roomId}/ice`)).status, 401);
  const response = await fetch(`${origin}/api/rooms/${room.roomId}/ice`, { headers: bearer(room.senderToken) });
  assert.equal(response.status, 200);
  const config = await response.json();
  assert.equal(config.relayAvailable, false);
  assert.match(JSON.stringify(config.iceServers), /stun\.cloudflare\.com/);

  const statusResponse = await fetch(`${origin}/api/rooms/${room.roomId}/relay-status`, { headers: bearer(room.senderToken) });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.enabled, false);
  assert.equal(status.reason, "not_configured");
});

test("only sender can delete a room", async () => {
  const room = await createRoom();
  const claim = await claimRoom(room);
  const endpoint = `${origin}/api/rooms/${room.roomId}`;
  assert.equal((await fetch(endpoint, { method: "DELETE", headers: bearer(claim.body.receiverToken) })).status, 403);
  assert.equal((await fetch(endpoint, { method: "DELETE", headers: bearer(room.senderToken) })).status, 200);
  assert.equal((await fetch(`${endpoint}/signals?after=0`, { headers: bearer(room.senderToken) })).status, 401);
});
