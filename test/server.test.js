const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
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
  assert.match(html, /id="media-input" type="file" accept="image\/\*,video\/\*" multiple/);
  assert.match(html, /id="file-input" type="file" multiple/);
  assert.match(html, /id="pickup-name"[^>]+maxlength="6"/);
  assert.match(html, /id="verification-required" type="checkbox"/);
  assert.match(html, /id="multi-recipient" type="checkbox"/);
  assert.match(html, /id="multi-status-card"/);
  assert.match(html, /id="multi-stop-all"/);
  assert.match(html, /id="download-list"/);
  assert.match(html, /id="add-sender-task"/);
  assert.match(html, /id="task-panels"/);
  assert.match(html, /id="sender-wake-status"/);
  assert.match(html, /id="receiver-wake-status"/);
  assert.match(html, /id="home-gateway"/);
  assert.match(html, /id="gateway-pickup-form"/);
  assert.match(html, /id="gateway-pickup-input"/);
  assert.match(html, /id="gateway-choose-media"/);
  assert.match(html, /id="gateway-choose-files"/);
  assert.match(html, /class="github-star-link"[^>]+href="https:\/\/github\.com\/semimail-source\/relay-file-transfer"/);
  assert.match(html, /id="nav-send" class="transfer-nav-link"[^>]+data-i18n="nav.send"/);
  assert.match(html, /class="transfer-nav-link"[^>]+data-i18n="nav.pickup"/);
  assert.match(html, /<meta name="description"[^>]+浏览器文件直传工具/);
  assert.match(html, /<link rel="canonical" href="https:\/\/relay\.xueai\.pro\/\?lang=zh">/);
  assert.match(html, /hreflang="en" href="https:\/\/relay\.xueai\.pro\/\?lang=en"/);
  assert.match(html, /type="application\/ld\+json"/);
  assert.match(html, /<h1 data-i18n="home\.gatewayTitle">浏览器文件直传<\/h1>/);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'self'/);
  assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("permissions-policy"), /screen-wake-lock=\(self\)/);

  const fontResponse = await fetch(`${origin}/fonts/nebula-sans/NebulaSans-Book.woff2`);
  assert.equal(fontResponse.status, 200);
  assert.equal(fontResponse.headers.get("content-type"), "font/woff2");
});

test("publishes crawl rules, localized sitemap entries, and a favicon", async () => {
  const robotsResponse = await fetch(`${origin}/robots.txt`);
  assert.equal(robotsResponse.status, 200);
  assert.match(robotsResponse.headers.get("content-type"), /^text\/plain/);
  const robots = await robotsResponse.text();
  assert.match(robots, /Disallow: \/admin/);
  assert.match(robots, /Disallow: \/api/);
  assert.match(robots, /Sitemap: https:\/\/relay\.xueai\.pro\/sitemap\.xml/);

  const sitemapResponse = await fetch(`${origin}/sitemap.xml`);
  assert.equal(sitemapResponse.status, 200);
  assert.match(sitemapResponse.headers.get("content-type"), /^application\/xml/);
  const sitemap = await sitemapResponse.text();
  assert.match(sitemap, /https:\/\/relay\.xueai\.pro\/\?lang=zh/);
  assert.match(sitemap, /https:\/\/relay\.xueai\.pro\/\?lang=en/);
  assert.match(sitemap, /hreflang="x-default"/);

  const faviconResponse = await fetch(`${origin}/favicon.svg`);
  assert.equal(faviconResponse.status, 200);
  assert.equal(faviconResponse.headers.get("content-type"), "image/svg+xml");

  const pickupResponse = await fetch(`${origin}/pickup`);
  assert.equal(pickupResponse.status, 200);
  assert.match(await pickupResponse.text(), /<meta name="robots" content="noindex,follow">/);
});

test("keeps the screen awake only while file bytes are transferring", async () => {
  const response = await fetch(`${origin}/app.js`);
  assert.equal(response.status, 200);
  const script = await response.text();
  assert.match(script, /navigator\.wakeLock\.request\("screen"\)/);
  assert.match(script, /clipboard-write; screen-wake-lock/);
  assert.match(script, /async function releaseTransferWakeLock/);
  assert.match(script, /document\.addEventListener\("visibilitychange"/);
  const vercelConfig = await readFile(require.resolve("../vercel.json"), "utf8");
  assert.match(vercelConfig, /screen-wake-lock=\(self\)/);
});

test("lets either device stop an active transfer and warns before leaving", async () => {
  const pageResponse = await fetch(`${origin}/`);
  assert.equal(pageResponse.status, 200);
  const html = await pageResponse.text();
  assert.match(html, /id="sender-stop-transfer"/);
  assert.match(html, /id="receiver-stop-transfer"/);
  assert.equal((html.match(/data-i18n="transfer\.keepOpen"/g) || []).length, 3);

  const scriptResponse = await fetch(`${origin}/app.js`);
  assert.equal(scriptResponse.status, 200);
  const script = await scriptResponse.text();
  assert.match(script, /sendSecure\("terminate", \{ reason: "user" \}\)/);
  assert.match(script, /message\.type === "terminate"/);
  assert.match(script, /await abortReceiveSink\(\)/);
  assert.match(script, /window\.addEventListener\("beforeunload"/);
  assert.match(script, /event\.returnValue = ""/);
  assert.match(script, /senderSessions: new Map\(\)/);
  assert.match(script, /terminateAllSenderSessions/);
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
  assert.match(first.body.receiverId, /^[A-Za-z0-9_-]{10,20}$/);
  assert.equal(room.multiRecipient, false);
  assert.equal(room.maxReceivers, 1);
  assert.equal(first.body.multiRecipient, false);
  assert.equal(first.body.maxReceivers, 1);

  const second = await claimRoom(room);
  assert.equal(second.response.status, 409);
  assert.equal(second.body.error, "room_claimed");

  const messages = await fetch(`${origin}/api/rooms/${room.roomId}/signals?after=0`, { headers: bearer(room.senderToken) });
  assert.equal(messages.status, 200);
  const result = await messages.json();
  assert.equal(result.messages[0].type, "join");
  assert.equal(result.messages[0].data.code, first.body.code);
  assert.equal(result.messages[0].data.pickup, false);
  assert.equal(result.messages[0].receiverId, first.body.receiverId);
});

test("isolates signaling for up to five recipients across direct and pickup claims", async () => {
  const hash = pickupHash("Relay-135790");
  const room = await createRoom({ pickupCodeHash: hash, multiRecipient: true });
  assert.equal(room.multiRecipient, true);
  assert.equal(room.maxReceivers, 5);

  const direct = await claimRoom(room);
  assert.equal(direct.response.status, 201);
  const pickupResponse = await fetch(`${origin}/api/pickup/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pickupCodeHash: hash })
  });
  assert.equal(pickupResponse.status, 201);
  const pickup = await pickupResponse.json();
  assert.notEqual(direct.body.receiverId, pickup.receiverId);
  assert.equal(pickup.multiRecipient, true);
  assert.equal(pickup.maxReceivers, 5);

  const endpoint = `${origin}/api/rooms/${room.roomId}/signals`;
  const approval = await fetch(endpoint, {
    method: "POST",
    headers: { ...bearer(room.senderToken), "content-type": "application/json" },
    body: JSON.stringify({ type: "approved", data: null, receiverId: direct.body.receiverId })
  });
  assert.equal(approval.status, 201);
  const directMessages = await fetch(`${endpoint}?after=0`, { headers: bearer(direct.body.receiverToken) });
  assert.deepEqual((await directMessages.json()).messages.map(message => message.type), ["approved"]);
  const pickupMessages = await fetch(`${endpoint}?after=0`, { headers: bearer(pickup.receiverToken) });
  assert.deepEqual((await pickupMessages.json()).messages, []);

  const answer = await fetch(endpoint, {
    method: "POST",
    headers: { ...bearer(pickup.receiverToken), "content-type": "application/json" },
    body: JSON.stringify({ type: "answer", data: { type: "answer", sdp: "recipient two" } })
  });
  assert.equal(answer.status, 201);
  const senderMessages = await fetch(`${endpoint}?after=0`, { headers: bearer(room.senderToken) });
  const senderResult = await senderMessages.json();
  assert.deepEqual(senderResult.messages.slice(0, 2).map(message => message.receiverId), [direct.body.receiverId, pickup.receiverId]);
  assert.equal(senderResult.messages.at(-1).receiverId, pickup.receiverId);
  assert.equal(senderResult.messages.at(-1).type, "answer");

  const remaining = [];
  for (let index = 0; index < 3; index += 1) remaining.push(await claimRoom(room));
  assert.ok(remaining.every(result => result.response.status === 201));
  const receiverIds = [direct.body.receiverId, pickup.receiverId, ...remaining.map(result => result.body.receiverId)];
  assert.equal(new Set(receiverIds).size, 5);
  const full = await claimRoom(room);
  assert.equal(full.response.status, 409);
  assert.equal(full.body.error, "room_full");
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
  assert.match(html, /class="transfer-nav-link"[^>]+data-i18n="nav.send"/);
  assert.match(html, /class="transfer-nav-link active"[^>]+data-i18n="nav.pickup"/);
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

  const multiResponse = await fetch(`${origin}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ multiRecipient: "true" })
  });
  assert.equal(multiResponse.status, 400);
  assert.equal((await multiResponse.json()).error, "invalid_multi_recipient_setting");
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

  const senderTerminate = await fetch(endpoint, {
    method: "POST",
    headers: { ...bearer(room.senderToken), "content-type": "application/json" },
    body: JSON.stringify({ type: "terminate", data: { reason: "user" } })
  });
  assert.equal(senderTerminate.status, 201);
  const receiverAfterTerminate = await fetch(`${endpoint}?after=${result.messages.at(-1).id}`, { headers: bearer(claim.body.receiverToken) });
  assert.deepEqual((await receiverAfterTerminate.json()).messages.map(message => message.type), ["terminate"]);

  const receiverTerminate = await fetch(endpoint, {
    method: "POST",
    headers: { ...bearer(claim.body.receiverToken), "content-type": "application/json" },
    body: JSON.stringify({ type: "terminate", data: { reason: "user" } })
  });
  assert.equal(receiverTerminate.status, 201);
  const senderMessages = await fetch(`${endpoint}?after=1`, { headers: bearer(room.senderToken) });
  const senderResult = await senderMessages.json();
  assert.equal(senderResult.messages.at(-1).type, "terminate");
  assert.equal(senderResult.messages.at(-1).receiverId, claim.body.receiverId);
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
