const $ = selector => document.querySelector(selector);
const relayLanguage = window.RelayI18n.lang;
const withLanguage = window.RelayI18n.withLang;
const t = (key, zh, variables = {}) => window.RelayI18n.t(key, { ...variables, zh });
const { Sha256, base64UrlEncode, base64UrlDecode } = window.RelayCrypto;
const {
  formatCode: formatPickupCode,
  generateCode: generatePickupCode,
  isValidCode: isValidPickupCode,
  isValidName: isValidPickupName,
  lookupHash: pickupLookupHash,
  normalizeCode: normalizePickupCode,
  normalizeName: normalizePickupName
} = window.RelayPickup;
const {
  AES_GCM_TAG_BYTES,
  SAFE_CHUNK_SIZE,
  isValidChunkSize,
  selectChunkSize
} = window.RelayChunking;
const {
  waitForWritableBuffer,
  createRateTracker,
  sampleRate
} = window.RelayTransferFlow;
const MAX_FILES = 100;
const MAX_SENDER_TASKS = 6;
const DANGEROUS_EXTENSIONS = /\.(?:exe|msi|bat|cmd|com|scr|ps1|vbs|jar|app|pkg|dmg|sh)$/i;
const pageParams = new URLSearchParams(window.location.search);
const embeddedTaskId = pageParams.get("senderTask");
const isEmbeddedSender = pageParams.get("embedded") === "1" && Boolean(embeddedTaskId);

const state = {
  role: null,
  files: [],
  roomId: null,
  authToken: null,
  cryptoKey: null,
  transferKeyValue: null,
  receiverNeedsKey: false,
  verificationRequired: false,
  peer: null,
  channel: null,
  pollTimer: null,
  relayMonitorTimer: null,
  relayCredentialIssued: false,
  connectionPath: null,
  connectionPathPromise: null,
  sendRateTracker: null,
  receiveRateTracker: null,
  lastSignal: 0,
  pendingCandidates: [],
  manifest: null,
  metadata: null,
  currentFileIndex: -1,
  noncePrefix: null,
  receivedBytes: 0,
  totalReceivedBytes: 0,
  receivedChunks: 0,
  sink: null,
  receiveQueue: Promise.resolve(),
  accepted: false,
  sending: false,
  transferAborted: false,
  transferComplete: false,
  sentHashes: new Map(),
  receivedAcks: new Set(),
  savedAcks: new Set(),
  objectUrls: [],
  receiveCleanups: [],
  downloadClicks: new Set(),
  disconnectTimer: null,
  pairingCode: null,
  receiptConfirmed: false,
  expiryTimer: null,
  lastTaskProgress: -1,
  wakeLockWanted: false,
  wakeLockSentinel: null,
  wakeLockRequest: null,
  chunkSize: SAFE_CHUNK_SIZE
};

const taskHubState = {
  activeId: null,
  nextNumber: 1,
  tasks: new Map()
};

function notifyTaskParent(phase, detail = {}) {
  if (!isEmbeddedSender || window.parent === window) return;
  window.parent.postMessage({ type: "relay:task-status", taskId: embeddedTaskId, phase, ...detail }, window.location.origin);
}

function taskStatusText(phase, detail = {}) {
  const labels = {
    ready: t("task.ready", "等待选择文件"),
    selected: t("task.selected", `已选择 ${detail.fileCount || 0} 个文件`, { count: detail.fileCount || 0 }),
    creating: t("task.creating", "正在生成入口"),
    waiting: t("task.waiting", "等待对方打开"),
    opened: t("task.opened", "等待对方确认"),
    confirmed: t("task.confirmed", "对方已确认"),
    connecting: t("task.connecting", "正在建立连接"),
    connected: t("task.connected", "等待对方接收"),
    transferring: t("task.transferring", `传输中 ${detail.percent ?? 0}%`, { percent: detail.percent ?? 0 }),
    received: t("task.received", "已接收，等待保存"),
    complete: t("task.complete", "已完成"),
    error: t("task.error", "连接遇到问题"),
    stopped: t("task.stopped", "已终止")
  };
  return labels[phase] || t("task.default", "发送任务");
}

function setActiveSenderTask(taskId) {
  if (!taskHubState.tasks.has(taskId)) return;
  taskHubState.activeId = taskId;
  for (const [id, task] of taskHubState.tasks) {
    const active = id === taskId;
    task.tab.classList.toggle("active", active);
    task.tabButton.setAttribute("aria-selected", String(active));
    task.panel.classList.toggle("hidden", !active);
  }
}

function finalizeSenderTaskRemoval(taskId) {
  const task = taskHubState.tasks.get(taskId);
  if (!task) return;
  const wasActive = taskHubState.activeId === taskId;
  task.tab.remove();
  task.panel.remove();
  taskHubState.tasks.delete(taskId);
  if (wasActive) {
    const next = taskHubState.tasks.keys().next().value;
    if (next) setActiveSenderTask(next);
  }
  if (taskHubState.tasks.size === 0) createSenderTask();
  refreshAddTaskButton();
}

function requestSenderTaskRemoval(taskId) {
  const task = taskHubState.tasks.get(taskId);
  if (!task) return;
  const activePhases = new Set(["creating", "waiting", "opened", "confirmed", "connecting", "connected", "transferring", "received"]);
  if (activePhases.has(task.phase) && !window.confirm(t("task.closeConfirm", "关闭这个任务会停止传输并让取件入口失效。确定关闭吗？"))) return;
  task.iframe.contentWindow?.postMessage({ type: "relay:cancel-task", taskId }, window.location.origin);
  task.closeTimer = setTimeout(() => finalizeSenderTaskRemoval(taskId), 1200);
}

function refreshAddTaskButton() {
  const button = $("#add-sender-task");
  if (!button) return;
  const full = taskHubState.tasks.size >= MAX_SENDER_TASKS;
  button.disabled = full;
  button.title = full
    ? t("task.limit", `一次最多保留 ${MAX_SENDER_TASKS} 个发送任务`, { count: MAX_SENDER_TASKS })
    : t("task.addTitle", "在当前页面新增发送任务");
}

function createSenderTask() {
  if (taskHubState.tasks.size >= MAX_SENDER_TASKS) return;
  const number = taskHubState.nextNumber++;
  const taskId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${number}`;

  const tab = document.createElement("div");
  tab.className = "task-tab";
  const tabButton = document.createElement("button");
  tabButton.type = "button";
  tabButton.className = "task-tab-main";
  tabButton.setAttribute("role", "tab");
  tabButton.innerHTML = `<span class="task-dot"></span><span class="task-tab-copy"><strong>${t("task.number", `任务 ${number}`, { number })}</strong><small>${t("task.ready", "等待选择文件")}</small></span>`;
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "task-close";
  closeButton.setAttribute("aria-label", t("task.closeAria", `关闭任务 ${number}`, { number }));
  closeButton.textContent = "×";
  tab.append(tabButton, closeButton);

  const panel = document.createElement("div");
  panel.className = "task-panel";
  panel.setAttribute("role", "tabpanel");
  const iframe = document.createElement("iframe");
  iframe.className = "task-frame";
  iframe.title = t("task.frameTitle", `发送任务 ${number}`, { number });
  iframe.src = `/?embedded=1&senderTask=${encodeURIComponent(taskId)}&lang=${relayLanguage}`;
  iframe.setAttribute("allow", "clipboard-write; screen-wake-lock");
  panel.append(iframe);

  const task = { id: taskId, number, tab, tabButton, panel, iframe, phase: "ready", closeTimer: null };
  taskHubState.tasks.set(taskId, task);
  $("#task-tabs").append(tab);
  $("#task-panels").append(panel);
  tabButton.addEventListener("click", () => setActiveSenderTask(taskId));
  closeButton.addEventListener("click", () => requestSenderTaskRemoval(taskId));
  setActiveSenderTask(taskId);
  refreshAddTaskButton();
}

function openSenderView() {
  document.body.classList.remove("landing");
  showView("#sender-start");
  $("#nav-send")?.classList.add("active");
  $("#nav-send")?.setAttribute("aria-current", "page");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function sendGatewayFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  openSenderView();
  const task = taskHubState.tasks.get(taskHubState.activeId);
  if (!task) return;
  const deliver = () => task.iframe.contentWindow?.postMessage({
    type: "relay:select-files",
    taskId: task.id,
    files
  }, window.location.origin);
  if (task.iframe.contentDocument?.readyState === "complete") deliver();
  else task.iframe.addEventListener("load", deliver, { once: true });
}

async function claimFromGateway(event) {
  event.preventDefault();
  const input = $("#gateway-pickup-input");
  const button = $("#gateway-pickup-submit");
  const errorElement = $("#gateway-pickup-error");
  const code = normalizePickupCode(input.value);
  if (!isValidPickupCode(code)) {
    errorElement.textContent = t("pickup.invalid", "请输入完整的英文名字和 6 位数字。");
    input.focus();
    return;
  }

  button.disabled = true;
  errorElement.textContent = "";
  try {
    const pickupCodeHash = await pickupLookupHash(code);
    const response = await fetch("/api/pickup/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pickupCodeHash }),
      cache: "no-store"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `HTTP_${response.status}`);
    const fragment = new URLSearchParams({
      receiver: result.receiverToken,
      code: result.code,
      verify: result.verificationRequired ? "1" : "0"
    });
    window.location.replace(`/?room=${encodeURIComponent(result.roomId)}&lang=${relayLanguage}#${fragment}`);
  } catch (error) {
    const messages = {
      pickup_not_found: t("pickup.notFound", "取件码错误、已过期或尚未生成，请向发送方确认。"),
      room_claimed: t("pickup.claimed", "这批文件已被另一台设备领取。"),
      rate_limited: t("pickup.rateLimited", "尝试次数过多，请 10 分钟后再试。")
    };
    errorElement.textContent = messages[error.message] || t("pickup.failed", "暂时无法取件，请稍后重试。");
    button.disabled = false;
  }
}

function initTaskHub() {
  $("#sender-task-editor").classList.add("hidden");
  $("#task-hub").classList.remove("hidden");
  $("#add-sender-task").addEventListener("click", createSenderTask);
  for (const trigger of document.querySelectorAll("[data-open-sender]")) {
    trigger.addEventListener("click", event => {
      event.preventDefault();
      openSenderView();
    });
  }
  const gatewayPickupInput = $("#gateway-pickup-input");
  gatewayPickupInput.addEventListener("input", () => {
    gatewayPickupInput.value = formatPickupCode(gatewayPickupInput.value);
    $("#gateway-pickup-error").textContent = "";
  });
  $("#gateway-pickup-form").addEventListener("submit", claimFromGateway);
  const gatewayMediaInput = $("#gateway-media-input");
  const gatewayFileInput = $("#gateway-file-input");
  $("#gateway-choose-media").addEventListener("click", () => gatewayMediaInput.click());
  $("#gateway-choose-files").addEventListener("click", () => gatewayFileInput.click());
  gatewayMediaInput.addEventListener("change", () => sendGatewayFiles(gatewayMediaInput.files));
  gatewayFileInput.addEventListener("change", () => sendGatewayFiles(gatewayFileInput.files));
  window.addEventListener("message", event => {
    if (event.origin !== window.location.origin || !event.data || typeof event.data !== "object") return;
    const task = taskHubState.tasks.get(event.data.taskId);
    if (!task || event.source !== task.iframe.contentWindow) return;
    if (event.data.type === "relay:task-height") {
      const height = Math.max(590, Math.min(1700, Number(event.data.height) || 0));
      task.iframe.style.height = `${height}px`;
      return;
    }
    if (event.data.type === "relay:task-closed") {
      clearTimeout(task.closeTimer);
      finalizeSenderTaskRemoval(task.id);
      return;
    }
    if (event.data.type !== "relay:task-status") return;
    task.phase = event.data.phase;
    task.tab.dataset.phase = event.data.phase;
    const title = task.tab.querySelector("strong");
    const status = task.tab.querySelector("small");
    if (event.data.pickupCode) title.textContent = event.data.pickupCode;
    status.textContent = taskStatusText(event.data.phase, event.data);
  });
  createSenderTask();
  showView("#home-gateway");
}

function showView(selector) {
  for (const view of document.querySelectorAll(".view")) view.classList.add("hidden");
  $(selector).classList.remove("hidden");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** index);
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function wakeLockStatusElement() {
  return state.role === "receiver" ? $("#receiver-wake-status") : $("#sender-wake-status");
}

function showWakeLockStatus(kind) {
  const element = wakeLockStatusElement();
  if (!element) return;
  const messages = {
    active: t("wake.active", "传输期间屏幕将保持常亮"),
    unsupported: t("wake.unsupported", "此浏览器无法保持屏幕常亮，请勿锁屏或切到后台"),
    denied: t("wake.denied", "无法保持屏幕常亮，请保持此页面在前台")
  };
  if (!kind) {
    element.classList.add("hidden");
    element.removeAttribute("data-kind");
    element.textContent = "";
    return;
  }
  element.textContent = messages[kind];
  element.dataset.kind = kind;
  element.classList.remove("hidden");
}

async function acquireTransferWakeLock() {
  state.wakeLockWanted = true;
  if (!("wakeLock" in navigator)) {
    showWakeLockStatus("unsupported");
    return;
  }
  if (document.visibilityState !== "visible" || state.wakeLockSentinel) return;
  if (state.wakeLockRequest) return state.wakeLockRequest;

  state.wakeLockRequest = (async () => {
    try {
      const sentinel = await navigator.wakeLock.request("screen");
      if (!state.wakeLockWanted) {
        await sentinel.release();
        return;
      }
      state.wakeLockSentinel = sentinel;
      sentinel.addEventListener("release", () => {
        if (state.wakeLockSentinel === sentinel) state.wakeLockSentinel = null;
        if (state.wakeLockWanted && document.visibilityState === "visible") showWakeLockStatus("denied");
      }, { once: true });
      showWakeLockStatus("active");
    } catch (_) {
      if (state.wakeLockWanted) showWakeLockStatus("denied");
    } finally {
      state.wakeLockRequest = null;
    }
  })();
  return state.wakeLockRequest;
}

async function releaseTransferWakeLock() {
  state.wakeLockWanted = false;
  const sentinel = state.wakeLockSentinel;
  state.wakeLockSentinel = null;
  showWakeLockStatus(null);
  if (sentinel) await sentinel.release().catch(() => {});
}

function formatCode(code) {
  const value = String(code || "").padStart(6, "0");
  return `${value.slice(0, 3)} ${value.slice(3)}`;
}

function stopExpiryCountdown() {
  if (state.expiryTimer) clearTimeout(state.expiryTimer);
  state.expiryTimer = null;
}

function startExpiryCountdown(expiresAt) {
  stopExpiryCountdown();
  const target = Date.parse(expiresAt);
  const badge = state.role === "sender" ? $("#sender-expiry") : $("#receiver-expiry");
  const value = state.role === "sender" ? $("#sender-expiry-time") : $("#receiver-expiry-time");
  badge.classList.remove("hidden");
  const tick = () => {
    const remaining = Math.max(0, target - Date.now());
    const totalSeconds = Math.ceil(remaining / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    value.textContent = `${minutes}:${seconds}`;
    if (remaining <= 0) {
      stopPolling();
      stopRelayMonitoring();
      state.peer?.close();
      showConnectionError(new Error(t("error.expiredWindow", "本次 20 分钟接收时间已结束，请让发送方重新生成。")));
      return;
    }
    state.expiryTimer = setTimeout(tick, Math.min(1000, remaining));
  };
  tick();
}

function safeFilename(name) {
  const cleaned = String(name || "download")
    .replace(/[\\/\u0000-\u001f\u007f]/g, "_")
    .replace(/^\.+$/, "download")
    .trim();
  return (cleaned || "download").slice(0, 180);
}

function totalSize(files) {
  return files.reduce((sum, file) => sum + file.size, 0);
}

function fileNameSummary(files, limit = 4) {
  const names = files.slice(0, limit).map(file => safeFilename(file.name)).join(relayLanguage === "en" ? ", " : "、");
  return files.length > limit ? t("files.more", `${names} 等 ${files.length} 个`, { names, count: files.length }) : names;
}

function refreshCreateButton() {
  $("#create-room").disabled = state.files.length === 0 || !isValidPickupName($("#pickup-name").value);
}

function setSelectedFiles(fileList) {
  const files = Array.from(fileList || []).slice(0, MAX_FILES);
  state.files = files;
  $("#selected-file").classList.toggle("hidden", files.length === 0);
  refreshCreateButton();
  $("#drop-zone").classList.toggle("hidden", files.length > 0);
  $("#start-error").textContent = Array.from(fileList || []).length > MAX_FILES
    ? t("files.limit", `一次最多选择 ${MAX_FILES} 个文件。`, { count: MAX_FILES })
    : "";
  if (files.length) {
    $("#selected-name").textContent = files.length === 1 ? safeFilename(files[0].name) : t("files.selected", `已选择 ${files.length} 个文件`, { count: files.length });
    $("#selected-size").textContent = t("files.total", `${formatBytes(totalSize(files))} · 总大小`, { size: formatBytes(totalSize(files)) });
    $("#selected-list").textContent = fileNameSummary(files);
  }
  notifyTaskParent(files.length ? "selected" : "ready", { fileCount: files.length });
}

async function api(path, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  if (state.authToken && !headers.Authorization) headers.Authorization = `Bearer ${state.authToken}`;
  const response = await fetch(path, { ...options, headers, cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `HTTP_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function importTransferKey(encoded) {
  const bytes = base64UrlDecode(encoded);
  if (bytes.length !== 32) throw new Error("invalid_link");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function roomAdditionalData() {
  return new TextEncoder().encode(`relay:${state.roomId}`);
}

function chunkIv(prefix, index) {
  const iv = new Uint8Array(12);
  iv.set(prefix, 0);
  new DataView(iv.buffer).setBigUint64(4, BigInt(index));
  return iv;
}

async function sendSecure(type, payload) {
  if (state.channel?.readyState !== "open") throw new Error(t("error.channelClosed", "连接已经关闭。"));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify({ type, payload }));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: roomAdditionalData() }, state.cryptoKey, plaintext);
  state.channel.send(JSON.stringify({ secure: 1, iv: base64UrlEncode(iv), data: base64UrlEncode(encrypted) }));
}

async function decryptSecure(value) {
  const envelope = JSON.parse(value);
  if (envelope.secure !== 1 || typeof envelope.iv !== "string" || typeof envelope.data !== "string") throw new Error(t("error.invalidEncryptedMessage", "收到无效的加密消息。"));
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(envelope.iv), additionalData: roomAdditionalData() },
    state.cryptoKey,
    base64UrlDecode(envelope.data)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function postSignal(type, data) {
  return api(`/api/rooms/${encodeURIComponent(state.roomId)}/signals`, {
    method: "POST",
    body: JSON.stringify({ type, data })
  });
}

async function getIceConfiguration() {
  const result = await api(`/api/rooms/${encodeURIComponent(state.roomId)}/ice`);
  state.relayCredentialIssued = result.relayAvailable === true;
  if (!result.relayAvailable) {
    const detail = state.role === "sender" ? $("#sender-detail") : $("#receiver-message");
    const messages = {
      not_configured: t("relay.notConfigured", "中继尚未配置；同一网络通常可用，不同网络可能无法连接。"),
      environment_disabled: t("relay.environmentDisabled", "公网中继安全开关已关闭；同一网络仍可尝试直连。"),
      manual_disabled: t("relay.manualDisabled", "公网中继已由管理员关闭；同一网络仍可尝试直连。"),
      quota_monitor_unconfigured: t("relay.monitorMissing", "用量保护尚未配置，公网中继保持关闭。"),
      quota_check_failed: t("relay.checkFailed", "无法确认中继用量，为避免费用已暂停公网中继。"),
      quota_reached: t("relay.quotaReached", "本月中继已达到安全线，公网中继自动关闭。"),
      relay_unavailable: t("relay.unavailable", "公网中继暂时不可用；同一网络仍可尝试直连。")
    };
    detail.textContent = messages[result.relayReason] || messages.not_configured;
  }
  return result.iceServers;
}

function stopRelayMonitoring() {
  if (state.relayMonitorTimer) clearTimeout(state.relayMonitorTimer);
  state.relayMonitorTimer = null;
}

function startRelayMonitoring() {
  stopRelayMonitoring();
  const tick = async () => {
    try {
      const status = await api(`/api/rooms/${encodeURIComponent(state.roomId)}/relay-status`);
      if (!status.enabled) {
        stopRelayMonitoring();
        state.peer?.close();
        showConnectionError(new Error(t("error.relayStopped", "公网中继安全保护已触发，当前连接已停止。请下月或开启中继后重新传输。")));
        return;
      }
    } catch (_) {
      stopRelayMonitoring();
      state.peer?.close();
      showConnectionError(new Error(t("error.relayUsage", "无法确认公网中继用量，为避免费用，当前连接已停止。")));
      return;
    }
    state.relayMonitorTimer = setTimeout(tick, 60_000);
  };
  state.relayMonitorTimer = setTimeout(tick, 60_000);
}

async function makePeer(role) {
  if (state.peer) return state.peer;
  const peer = new RTCPeerConnection({ iceServers: await getIceConfiguration() });
  state.peer = peer;
  peer.addEventListener("icecandidate", event => {
    if (event.candidate) postSignal("candidate", event.candidate.toJSON()).catch(showConnectionError);
  });
  peer.addEventListener("connectionstatechange", () => {
    clearTimeout(state.disconnectTimer);
    if (state.transferAborted || state.transferComplete) return;
    if (peer.connectionState === "connected") updateConnectionPath(peer, role).catch(() => {});
    if (peer.connectionState === "connected" && role === "sender") {
      $("#sender-orb").classList.add("connected");
      $("#sender-kicker").textContent = t("sender.connectedKicker", "接收设备已连接");
      $("#sender-status").textContent = t("sender.waitAccept", "等待对方确认文件");
      $("#sender-detail").textContent = t("sender.encryptedNotStarted", "连接已加密，文件尚未开始传输");
      notifyTaskParent("connected");
    } else if (peer.connectionState === "failed") {
      showConnectionError(new Error(t("error.directFailed", "无法建立直连。请检查网络，或确认公网中继已经配置。")));
    } else if (peer.connectionState === "disconnected") {
      state.disconnectTimer = setTimeout(() => {
        if (peer.connectionState === "disconnected") showConnectionError(new Error(t("error.disconnected", "连接已中断，请重新传输。")));
      }, 5000);
    }
  });
  return peer;
}

function selectedCandidatePair(stats) {
  const reports = new Map();
  stats.forEach(report => reports.set(report.id, report));

  for (const report of reports.values()) {
    if (report.type === "transport" && report.selectedCandidatePairId) {
      const pair = reports.get(report.selectedCandidatePairId);
      if (pair) return { pair, reports };
    }
  }
  for (const report of reports.values()) {
    if (report.type === "candidate-pair" && report.state === "succeeded" && (report.selected || report.nominated)) {
      return { pair: report, reports };
    }
  }
  return null;
}

async function inspectConnectionPath(peer) {
  const result = selectedCandidatePair(await peer.getStats());
  if (!result) return null;
  const local = result.reports.get(result.pair.localCandidateId);
  const remote = result.reports.get(result.pair.remoteCandidateId);
  const types = [local?.candidateType, remote?.candidateType].filter(Boolean);
  if (types.includes("relay")) return "relay";
  if (types.length === 2 && types.every(type => type === "host")) return "lan";
  if (types.length) return "direct";
  return null;
}

function setConnectionRoute(role, path) {
  const element = $(`#${role}-route`);
  if (!element || !path) return;
  const labels = {
    lan: t("connection.lan", "局域网直连"),
    direct: t("connection.direct", "公网直连"),
    relay: t("connection.relay", "公网中继")
  };
  element.textContent = labels[path] || "";
  element.hidden = !labels[path];
}

async function updateConnectionPath(peer, role) {
  if (state.connectionPathPromise) return state.connectionPathPromise;
  state.connectionPathPromise = (async () => {
    let path = null;
    for (let attempt = 0; attempt < 8 && !path; attempt += 1) {
      try {
        path = await inspectConnectionPath(peer);
      } catch (_) {
        // RTC stats can be temporarily unavailable immediately after connecting.
      }
      if (!path) await new Promise(resolve => setTimeout(resolve, 250));
    }
    state.connectionPath = path;
    setConnectionRoute(role, path);
    if (role === "sender" && state.relayCredentialIssued) {
      if (path === "relay" || !path) startRelayMonitoring();
      else stopRelayMonitoring();
    }
    return path;
  })();
  return state.connectionPathPromise;
}

async function addCandidate(candidate) {
  if (!state.peer?.remoteDescription) {
    state.pendingCandidates.push(candidate);
    return;
  }
  await state.peer.addIceCandidate(candidate);
}

async function flushCandidates() {
  for (const candidate of state.pendingCandidates.splice(0)) await state.peer.addIceCandidate(candidate);
}

function startPolling(onSignal) {
  stopPolling();
  const tick = async () => {
    try {
      const result = await api(`/api/rooms/${encodeURIComponent(state.roomId)}/signals?after=${state.lastSignal}`);
      for (const message of result.messages) {
        state.lastSignal = Math.max(state.lastSignal, message.id);
        await onSignal(message);
      }
    } catch (error) {
      if (["room_not_found", "unauthorized"].includes(error.message)) {
        showConnectionError(new Error(t("error.entryExpired", "这个一次性入口已经失效。")));
        return;
      }
    }
    state.pollTimer = setTimeout(tick, 550);
  };
  tick();
}

function stopPolling() {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

function transferInProgress() {
  return !state.transferAborted && !state.transferComplete &&
    (state.role === "sender" ? state.sending : state.accepted);
}

function transferAbortError() {
  const error = new Error("transfer_aborted");
  error.code = "transfer_aborted";
  return error;
}

function isTransferAbortError(error) {
  return error?.code === "transfer_aborted" || error?.message === "transfer_aborted";
}

function assertTransferActive() {
  if (state.transferAborted) throw transferAbortError();
}

function setTransferActions(role, visible) {
  const element = $(`#${role}-transfer-actions`);
  if (element) element.classList.toggle("hidden", !visible);
}

async function abortReceiveSink() {
  const sink = state.sink;
  state.sink = null;
  state.metadata = null;
  state.receiveHasher = null;
  if (!sink?.abort) return;
  try {
    await sink.abort();
  } catch (_) {
    // A simultaneous write or peer disconnect may already have closed the sink.
  }
}

function renderTransferStopped(origin) {
  const title = origin === "local"
    ? t("transfer.stoppedByYou", "你已终止传输")
    : t("transfer.stoppedByPeer", "对方已终止传输");
  const detail = t("transfer.stoppedDetail", "未完成的文件已丢弃。");
  if (state.role === "receiver") {
    $("#receiver-animation").classList.remove("complete");
    $("#receiver-kicker").textContent = t("transfer.stoppedKicker", "传输已终止");
    $("#receiver-title").textContent = title;
    $("#receiver-message").textContent = detail;
    $("#receiver-error").textContent = "";
    $("#receiver-progress-label").textContent = title;
    $("#receiver-percent").textContent = "—";
  } else {
    $("#sender-orb").classList.remove("connected", "complete");
    $("#sender-kicker").textContent = t("transfer.stoppedKicker", "传输已终止");
    $("#sender-status").textContent = title;
    $("#sender-detail").textContent = detail;
    $("#sender-percent").textContent = "—";
  }
}

async function waitForTerminationNotice(channel, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (channel?.readyState === "open" && channel.bufferedAmount > 0 && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (channel?.readyState === "open") await new Promise(resolve => setTimeout(resolve, 100));
}

async function terminateTransfer(origin = "local", { confirmStop = true } = {}) {
  if (state.transferAborted || state.transferComplete) return false;
  if (origin === "local" && confirmStop && !window.confirm(
    t("transfer.stopConfirm", "确定终止本次传输吗？对方会收到通知，未完成的文件将被丢弃。")
  )) return false;

  state.transferAborted = true;
  state.sending = false;
  state.accepted = false;
  setTransferActions("sender", false);
  setTransferActions("receiver", false);
  renderTransferStopped(origin);
  notifyTaskParent("stopped");

  if (origin === "local" && state.channel?.readyState === "open") {
    try {
      await sendSecure("terminate", { reason: "user" });
      await waitForTerminationNotice(state.channel);
    } catch (_) {
      // The transfer still stops locally if the peer disconnects at the same time.
    }
  }

  await abortReceiveSink();
  stopRelayMonitoring();
  stopPolling();
  stopExpiryCountdown();
  await releaseTransferWakeLock();
  if (state.role === "sender") await deleteRoom().catch(() => {});
  state.channel?.close();
  state.peer?.close();
  return true;
}

async function handleStopTransfer(event) {
  const button = event.currentTarget;
  button.disabled = true;
  const stopped = await terminateTransfer("local");
  if (!stopped) button.disabled = false;
}

function wireSenderChannel(channel) {
  state.channel = channel;
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = 512 * 1024;
  channel.addEventListener("open", async () => {
    try {
      state.chunkSize = selectChunkSize(state.peer?.sctp?.maxMessageSize);
      if (state.receiverNeedsKey) {
        channel.send(JSON.stringify({ bootstrap: 1, key: state.transferKeyValue }));
      }
      await sendSecure("manifest", {
        files: state.files.map((file, index) => ({
          index,
          name: safeFilename(file.name),
          size: file.size,
          mime: file.type || "application/octet-stream"
        })),
        totalSize: totalSize(state.files),
        chunkSize: state.chunkSize
      });
    } catch (error) {
      showConnectionError(error);
    }
  });
  channel.addEventListener("message", event => {
    if (typeof event.data !== "string") return;
    decryptSecure(event.data).then(message => {
      if (message.type === "terminate") return terminateTransfer("remote", { confirmStop: false });
      if (message.type === "accept" && !state.sending && !state.transferAborted) return sendFiles();
      if (message.type === "file-received") {
        const index = message.payload?.index;
        if (Number.isInteger(index) && message.payload?.sha256 === state.sentHashes.get(index)) state.receivedAcks.add(index);
        if (state.receivedAcks.size === state.files.length) {
          state.sending = false;
          state.transferComplete = true;
          setTransferActions("sender", false);
          releaseTransferWakeLock();
          $("#sender-orb").classList.add("complete");
          $("#sender-kicker").textContent = t("sender.receivedKicker", "对方已完整接收");
          $("#sender-status").textContent = t("sender.filesVerified", `${state.files.length} 个文件均已校验`, { count: state.files.length });
          $("#sender-detail").textContent = t("sender.waitSave", "等待对方逐个点击保存，请暂时保持页面打开");
          notifyTaskParent("received");
        }
      }
      if (message.type === "save-clicked") {
        const index = message.payload?.index;
        if (Number.isInteger(index) && index >= 0 && index < state.files.length) state.savedAcks.add(index);
        $("#sender-kicker").textContent = t("sender.savedCount", `对方已点击保存 ${state.savedAcks.size} / ${state.files.length}`, { saved: state.savedAcks.size, total: state.files.length });
        if (state.savedAcks.size === state.files.length) {
          $("#sender-status").textContent = t("sender.canClose", "现在可以关闭页面");
          $("#sender-detail").textContent = t("sender.saveCaveat", "系统无法读取对方磁盘状态；这里只确认每个保存按钮均已点击");
          notifyTaskParent("complete");
          deleteRoom().catch(() => {});
        }
      }
    }).catch(error => {
      if (!state.transferAborted && !isTransferAbortError(error)) showConnectionError(error);
    });
  });
}

async function waitForBuffer(channel) {
  assertTransferActive();
  try {
    await waitForWritableBuffer(channel);
    assertTransferActive();
  } catch (error) {
    if (state.transferAborted || isTransferAbortError(error)) throw transferAbortError();
    if (error?.code === "channel_closed" || error?.message === "channel_closed") {
      throw new Error(t("error.channelClosed", "传输期间连接已关闭。"));
    }
    throw error;
  }
}

function formatRate(bytesPerSecond) {
  return `${formatBytes(bytesPerSecond)}/s`;
}

async function sendFiles() {
  state.transferAborted = false;
  state.transferComplete = false;
  state.sending = true;
  setTransferActions("sender", true);
  state.sendRateTracker = createRateTracker(performance.now(), 0);
  try {
    await acquireTransferWakeLock();
    assertTransferActive();
    const batchSize = totalSize(state.files);
    let batchOffset = 0;
    $("#sender-kicker").textContent = t("sender.transferring", "正在加密传输");
    $("#sender-detail").textContent = t("sender.transferDetail", `${state.files.length} 个文件 · ${formatBytes(batchSize)} · 请保持页面打开`, { count: state.files.length, size: formatBytes(batchSize) });
    notifyTaskParent("transferring", { percent: 0 });
    for (let fileIndex = 0; fileIndex < state.files.length; fileIndex += 1) {
      assertTransferActive();
      const file = state.files[fileIndex];
      const noncePrefix = crypto.getRandomValues(new Uint8Array(4));
      const hasher = new Sha256();
      let offset = 0;
      let chunkIndex = 0;
      $("#sender-status").textContent = `${fileIndex + 1} / ${state.files.length} · ${safeFilename(file.name)}`;
      await sendSecure("file-start", {
        index: fileIndex,
        name: safeFilename(file.name),
        size: file.size,
        mime: file.type || "application/octet-stream",
        chunkSize: state.chunkSize,
        noncePrefix: base64UrlEncode(noncePrefix)
      });
      while (offset < file.size) {
        assertTransferActive();
        if (state.channel.readyState !== "open") throw new Error(t("error.channelClosed", "连接已经关闭。"));
        await waitForBuffer(state.channel);
        const plain = new Uint8Array(await file.slice(offset, offset + state.chunkSize).arrayBuffer());
        assertTransferActive();
        hasher.update(plain);
        const encrypted = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: chunkIv(noncePrefix, chunkIndex), additionalData: roomAdditionalData() },
          state.cryptoKey,
          plain
        );
        assertTransferActive();
        state.channel.send(encrypted);
        offset += plain.byteLength;
        batchOffset += plain.byteLength;
        chunkIndex += 1;
        const bytesPerSecond = sampleRate(state.sendRateTracker, batchOffset, performance.now());
        if (bytesPerSecond !== null) {
          $("#sender-detail").textContent = t(
            "sender.transferLive",
            `${state.files.length} 个文件 · ${formatBytes(batchSize)} · ${formatRate(bytesPerSecond)} · 请保持页面打开`,
            {
              count: state.files.length,
              size: formatBytes(batchSize),
              speed: formatRate(bytesPerSecond)
            }
          );
        }
        const percent = batchSize ? Math.min(100, Math.round((batchOffset / batchSize) * 100)) : 100;
        $("#sender-progress").style.width = `${percent}%`;
        $("#sender-percent").textContent = `${percent}%`;
        if (percent === 100 || percent >= state.lastTaskProgress + 2) {
          state.lastTaskProgress = percent;
          notifyTaskParent("transferring", { percent });
        }
      }
      const hash = hasher.hex();
      state.sentHashes.set(fileIndex, hash);
      await waitForBuffer(state.channel);
      assertTransferActive();
      await sendSecure("file-end", { index: fileIndex, size: file.size, chunks: chunkIndex, sha256: hash });
    }
    assertTransferActive();
    $("#sender-progress").style.width = "100%";
    $("#sender-percent").textContent = "100%";
    $("#sender-kicker").textContent = t("sender.sentVerifying", "全部发送完毕，正在校验");
    $("#sender-status").textContent = t("sender.waitVerification", `等待确认 ${state.files.length} 个文件`, { count: state.files.length });
    $("#sender-detail").textContent = t("sender.hashDetail", "每个文件都通过 SHA-256 校验后，才会显示传输成功");
  } catch (error) {
    state.sending = false;
    if (state.transferAborted || isTransferAbortError(error)) return;
    setTransferActions("sender", false);
    showConnectionError(error);
  }
}

async function createRoom() {
  if (!state.files.length) return;
  const pickupName = normalizePickupName($("#pickup-name").value);
  if (!isValidPickupName(pickupName)) {
    $("#start-error").textContent = t("error.name", "请输入 4–6 位英文字母作为名字。");
    $("#pickup-name").focus();
    return;
  }
  $("#create-room").disabled = true;
  $("#start-error").textContent = "";
  notifyTaskParent("creating");
  try {
    const pickupCode = generatePickupCode(pickupName);
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const pickupCodeHash = await pickupLookupHash(pickupCode);
    state.transferKeyValue = base64UrlEncode(keyBytes);
    state.cryptoKey = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
    state.verificationRequired = $("#verification-required").checked;
    const room = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ pickupCodeHash, verificationRequired: state.verificationRequired })
    });
    state.role = "sender";
    state.roomId = room.roomId;
    state.authToken = room.senderToken;
    const receiverUrl = `${withLanguage(room.receiverBaseUrl)}#invite=${encodeURIComponent(room.inviteToken)}&key=${encodeURIComponent(state.transferKeyValue)}`;
    $("#receiver-link").textContent = receiverUrl;
    $("#pickup-url").textContent = withLanguage(room.pickupUrl);
    $("#pickup-url").href = withLanguage(room.pickupUrl);
    $("#pickup-code").textContent = formatPickupCode(pickupCode);
    notifyTaskParent("waiting", { pickupCode: formatPickupCode(pickupCode), fileCount: state.files.length });
    $("#share-instruction").textContent = state.verificationRequired
      ? t("share.verifyInstruction", "对方确认收到后才开始 20 分钟倒计时；再核对六位验证码，文件才会连接。")
      : t("share.autoInstruction", "对方确认收到后才开始 20 分钟倒计时，随后会自动建立加密连接。");
    $("#qr-image").src = await QRCode.toDataURL(receiverUrl, { width: 560, margin: 1, errorCorrectionLevel: "M", color: { dark: "#10201b", light: "#ffffff" } });
    showView("#sender-share");
    startPolling(handleSenderSignal);
  } catch (error) {
    showView("#sender-start");
    $("#start-error").textContent = error.message === "pickup_code_unavailable"
      ? t("error.codeConflict", "随机取件码发生冲突，请再点一次生成。")
      : t("error.create", "无法创建传输入口，请稍后重试。");
    refreshCreateButton();
    notifyTaskParent("error");
  }
}

async function handleSenderSignal(message) {
  if (message.type === "join") {
    state.receiverNeedsKey = message.data.pickup === true;
    state.pairingCode = message.data.code;
    $("#sender-kicker").textContent = t("sender.openedKicker", "有设备打开了链接");
    $("#sender-pairing").classList.add("hidden");
    $("#sender-status").textContent = t("sender.waitConfirmation", "等待对方确认收到");
    $("#sender-detail").textContent = t("sender.timerAfterConfirm", "对方点击确认后，20 分钟倒计时才开始");
    notifyTaskParent("opened");
  } else if (message.type === "confirmed") {
    state.receiptConfirmed = true;
    startExpiryCountdown(message.data.expiresAt);
    notifyTaskParent("confirmed");
    $("#sender-kicker").textContent = t("sender.confirmedKicker", "对方已确认收到");
    if (state.verificationRequired) {
      $("#sender-pair-code").textContent = formatCode(state.pairingCode);
      $("#sender-pairing").classList.remove("hidden");
      $("#sender-status").textContent = t("sender.checkCode", "请核对验证码");
      $("#sender-detail").textContent = t("sender.checkCodeDetail", "验证码一致后允许连接；倒计时已经开始");
    } else {
      $("#sender-pairing").classList.add("hidden");
      $("#sender-status").textContent = t("sender.autoConnecting", "正在自动建立连接");
      $("#sender-detail").textContent = t("sender.noExtraCode", "本次传输未启用额外验证码");
      await approveReceiver();
    }
  } else if (message.type === "answer") {
    await state.peer?.setRemoteDescription(message.data);
    await flushCandidates();
  } else if (message.type === "candidate") {
    await addCandidate(message.data);
  }
}

async function approveReceiver() {
  const button = $("#approve-receiver");
  button.disabled = true;
  try {
    const peer = await makePeer("sender");
    const channel = peer.createDataChannel("relay-file", { ordered: true });
    wireSenderChannel(channel);
    await postSignal("approved", null);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await postSignal("offer", peer.localDescription.toJSON());
    $("#sender-pairing").classList.add("hidden");
    $("#sender-kicker").textContent = t("sender.secureConnecting", "正在建立加密连接");
    $("#sender-status").textContent = t("common.wait", "请稍候");
    notifyTaskParent("connecting");
  } catch (error) {
    button.disabled = false;
    showConnectionError(error);
  }
}

async function createReceiveSink(meta) {
  if (navigator.storage?.getDirectory) {
    try {
      const root = await navigator.storage.getDirectory();
      const tempName = `relay-${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0]}`;
      const handle = await root.getFileHandle(tempName, { create: true });
      const writable = await handle.createWritable();
      return {
        mode: "disk",
        write: chunk => writable.write(chunk),
        finish: async () => {
          await writable.close();
          const stored = await handle.getFile();
          return { file: new File([stored], meta.name, { type: meta.mime, lastModified: Date.now() }), cleanup: () => root.removeEntry(tempName).catch(() => {}) };
        },
        abort: async () => {
          try {
            if (typeof writable.abort === "function") await writable.abort();
            else await writable.close();
          } catch (_) {
            // The stream may already be closed by a simultaneous write failure.
          }
          await root.removeEntry(tempName).catch(() => {});
        }
      };
    } catch (_) {
      // Private storage is optional; the memory fallback still works for smaller files.
    }
  }
  const chunks = [];
  return {
    mode: "memory",
    write: chunk => chunks.push(chunk),
    finish: async () => ({ file: new File(chunks, meta.name, { type: meta.mime, lastModified: Date.now() }), cleanup: () => {} }),
    abort: async () => { chunks.length = 0; }
  };
}

function wireReceiverChannel(channel) {
  state.channel = channel;
  channel.binaryType = "arraybuffer";
  channel.addEventListener("open", () => {
    $("#receiver-pairing").classList.add("hidden");
    $("#receiver-kicker").textContent = t("receiver.connectedKicker", "已建立端到端加密连接");
    $("#receiver-message").textContent = t("receiver.waitMetadata", "正在等待发送方提供文件信息。");
  });
  channel.addEventListener("message", event => {
    state.receiveQueue = state.receiveQueue.then(async () => {
      if (!state.cryptoKey) {
        if (typeof event.data !== "string") throw new Error(t("error.keyMissing", "尚未收到文件加密密钥。"));
        let bootstrap;
        try {
          bootstrap = JSON.parse(event.data);
        } catch (_) {
          throw new Error(t("error.keyInvalid", "收到的加密密钥无效。"));
        }
        if (bootstrap?.bootstrap !== 1 || typeof bootstrap.key !== "string") throw new Error(t("error.keyInvalid", "收到的加密密钥无效。"));
        state.cryptoKey = await importTransferKey(bootstrap.key);
        $("#receiver-kicker").textContent = t("receiver.keyReceived", "安全密钥已收到");
        $("#receiver-message").textContent = t("receiver.readMetadata", "正在读取发送方提供的文件信息。");
        return;
      }
      if (typeof event.data === "string") return handleReceiverControl(await decryptSecure(event.data));
      return receiveEncryptedChunk(event.data);
    }).catch(error => {
      if (!state.transferAborted && !isTransferAbortError(error)) showConnectionError(error);
    });
  });
}

async function handleReceiverControl(message) {
  if (message.type === "terminate") {
    await terminateTransfer("remote", { confirmStop: false });
    return;
  }
  if (message.type === "manifest") showIncomingFiles(message.payload);
  if (message.type === "file-start") await startIncomingFile(message.payload);
  if (message.type === "file-end") await finishIncomingFile(message.payload);
}

function validManifestFile(file, index) {
  return file && file.index === index && typeof file.name === "string" && file.name.length > 0 &&
    Number.isSafeInteger(file.size) && file.size >= 0 && typeof file.mime === "string";
}

function showIncomingFiles(manifest) {
  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > MAX_FILES ||
      !isValidChunkSize(manifest.chunkSize) || !manifest.files.every(validManifestFile)) {
    throw new Error(t("error.manifest", "收到的文件清单无效。"));
  }
  const files = manifest.files.map(file => ({ ...file, name: safeFilename(file.name) }));
  const calculatedSize = files.reduce((sum, file) => sum + file.size, 0);
  if (!Number.isSafeInteger(calculatedSize) || calculatedSize !== manifest.totalSize) throw new Error(t("error.manifestSize", "文件清单大小不一致。"));
  state.manifest = { files, totalSize: calculatedSize, chunkSize: manifest.chunkSize };
  $("#receiver-kicker").textContent = t("receiver.incomingKicker", `发送方想给你 ${files.length} 个文件`, { count: files.length });
  $("#receiver-title").innerHTML = t("receiver.incomingTitle", "检查待接收文件");
  $("#receiver-message").textContent = t("receiver.review", "确认名称、数量和总大小后再接收。Relay 不会自动打开文件。");
  $("#incoming-name").textContent = files.length === 1 ? files[0].name : t("receiver.fileCount", `${files.length} 个文件`, { count: files.length });
  $("#incoming-size").textContent = t("files.total", `${formatBytes(calculatedSize)} · 总大小`, { size: formatBytes(calculatedSize) });
  $("#incoming-list").textContent = fileNameSummary(files);
  $("#incoming-file").classList.remove("hidden");
  $("#accept-file").classList.remove("hidden");
  const dangerousCount = files.filter(file => DANGEROUS_EXTENSIONS.test(file.name)).length;
  if (dangerousCount) {
    $("#incoming-warning").textContent = t("receiver.danger", `安全提醒：其中 ${dangerousCount} 个是可执行或安装类文件。仅在你信任发送方且确实需要时接收。`, { count: dangerousCount });
    $("#incoming-warning").classList.remove("hidden");
  }
}

async function acceptFile() {
  const button = $("#accept-file");
  button.disabled = true;
  $("#receiver-error").textContent = "";
  try {
    state.transferAborted = false;
    state.transferComplete = false;
    await acquireTransferWakeLock();
    button.classList.add("hidden");
    $("#receiver-progress-wrap").classList.remove("hidden");
    $("#receiver-kicker").textContent = t("receiver.receivingKicker", "正在加密接收");
    $("#receiver-title").innerHTML = t("receiver.receivingTitle", "正在接收文件");
    $("#receiver-message").textContent = t("receiver.tempStorage", "文件会逐个写入浏览器临时存储，请保持页面打开。");
    state.accepted = true;
    setTransferActions("receiver", true);
    state.receiveRateTracker = createRateTracker(performance.now(), state.totalReceivedBytes);
    await sendSecure("accept", null);
  } catch (error) {
    if (state.transferAborted || isTransferAbortError(error)) return;
    releaseTransferWakeLock();
    state.accepted = false;
    setTransferActions("receiver", false);
    button.disabled = false;
    button.classList.remove("hidden");
    $("#receiver-error").textContent = t("error.storage", "无法准备本地临时存储。");
  }
}

async function startIncomingFile(metadata) {
  assertTransferActive();
  if (!state.accepted || !state.manifest || !metadata || !Number.isInteger(metadata.index) || metadata.index !== state.currentFileIndex + 1 ||
      !isValidChunkSize(metadata.chunkSize) || metadata.chunkSize !== state.manifest.chunkSize || !validManifestFile(metadata, metadata.index)) {
    throw new Error(t("error.fileInfo", "收到的文件信息无效。"));
  }
  const listed = state.manifest.files[metadata.index];
  const name = safeFilename(metadata.name);
  if (!listed || listed.name !== name || listed.size !== metadata.size || listed.mime !== metadata.mime) throw new Error(t("error.fileMismatch", "文件信息与清单不一致。"));
  const prefix = base64UrlDecode(metadata.noncePrefix);
  if (prefix.length !== 4) throw new Error(t("error.cryptoParams", "收到的加密参数无效。"));
  state.currentFileIndex = metadata.index;
  state.metadata = { ...metadata, name };
  state.noncePrefix = prefix;
  state.receivedBytes = 0;
  state.receivedChunks = 0;
  state.receiveHasher = new Sha256();
  const sink = await createReceiveSink(state.metadata);
  if (state.transferAborted) {
    await sink.abort?.();
    throw transferAbortError();
  }
  state.sink = sink;
  $("#receiver-progress-label").textContent = `${metadata.index + 1} / ${state.manifest.files.length} · ${name}`;
  $("#receiver-message").textContent = state.sink.mode === "disk"
    ? t("receiver.diskBuffer", "数据正写入浏览器私有临时存储，不会占满内存。")
    : t("receiver.memoryBuffer", "当前浏览器使用内存暂存，请保持页面打开。");
}

async function receiveEncryptedChunk(value) {
  assertTransferActive();
  if (!state.sink || !state.metadata) throw new Error(t("error.notAccepted", "文件尚未获得接收许可。"));
  const sink = state.sink;
  const metadata = state.metadata;
  const receiveHasher = state.receiveHasher;
  const noncePrefix = state.noncePrefix;
  const chunkIndex = state.receivedChunks;
  const encryptedSize = value instanceof Blob ? value.size : value?.byteLength;
  if (!Number.isSafeInteger(encryptedSize) || encryptedSize > metadata.chunkSize + AES_GCM_TAG_BYTES) {
    throw new Error(t("error.chunkSize", "收到的文件分片超过协商大小。"));
  }
  const encrypted = value instanceof Blob ? await value.arrayBuffer() : value;
  assertTransferActive();
  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: chunkIv(noncePrefix, chunkIndex), additionalData: roomAdditionalData() },
    state.cryptoKey,
    encrypted
  ));
  assertTransferActive();
  if (plain.byteLength > metadata.chunkSize || state.receivedBytes + plain.byteLength > metadata.size) {
    throw new Error(t("error.chunkSize", "收到的文件分片超过协商大小。"));
  }
  receiveHasher.update(plain);
  await sink.write(plain);
  assertTransferActive();
  state.receivedBytes += plain.byteLength;
  state.totalReceivedBytes += plain.byteLength;
  state.receivedChunks += 1;
  const percent = state.manifest.totalSize ? Math.min(100, Math.round((state.totalReceivedBytes / state.manifest.totalSize) * 100)) : 100;
  $("#receiver-progress").style.width = `${percent}%`;
  $("#receiver-percent").textContent = `${percent}%`;
  const bytesPerSecond = sampleRate(state.receiveRateTracker, state.totalReceivedBytes, performance.now());
  $("#receiver-bytes").textContent = `${formatBytes(state.totalReceivedBytes)} / ${formatBytes(state.manifest.totalSize)}${bytesPerSecond === null ? "" : ` · ${formatRate(bytesPerSecond)}`}`;
}

async function finishIncomingFile(expected) {
  assertTransferActive();
  if (!state.sink || !state.metadata || expected.index !== state.currentFileIndex) throw new Error(t("error.endMarker", "文件结束标记无效。"));
  const actualHash = state.receiveHasher.hex();
  if (state.receivedBytes !== state.metadata.size || expected.size !== state.metadata.size ||
      state.receivedChunks !== expected.chunks || actualHash !== expected.sha256) {
    throw new Error(t("error.integrity", "完整性校验失败，请不要保存，并重新传输。"));
  }
  const result = await state.sink.finish();
  assertTransferActive();
  const objectUrl = URL.createObjectURL(result.file);
  state.objectUrls.push(objectUrl);
  state.receiveCleanups.push(result.cleanup);
  addDownloadItem(state.currentFileIndex, state.metadata, objectUrl);
  await sendSecure("file-received", { index: state.currentFileIndex, sha256: actualHash });
  state.sink = null;
  state.metadata = null;
  if (state.currentFileIndex === state.manifest.files.length - 1) {
    state.accepted = false;
    state.transferComplete = true;
    setTransferActions("receiver", false);
    releaseTransferWakeLock();
    $("#receiver-progress-label").textContent = t("receiver.allVerified", "全部接收并校验完成");
    $("#receiver-percent").textContent = "100%";
    $("#receiver-kicker").textContent = t("receiver.intact", "所有文件完好无损");
    $("#receiver-title").innerHTML = t("receiver.saveTitle", "文件已接收");
    $("#receiver-message").textContent = t("receiver.saveMessage", "每点击一次保存，发送方都会看到状态；浏览器无法确认磁盘写入结果。");
    $("#receiver-animation").classList.add("complete");
  }
}

function addDownloadItem(index, metadata, objectUrl) {
  const item = document.createElement("div");
  item.className = "download-item";
  const copy = document.createElement("span");
  const name = document.createElement("strong");
  const size = document.createElement("small");
  name.textContent = metadata.name;
  size.textContent = formatBytes(metadata.size);
  copy.append(name, size);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = metadata.name;
  link.textContent = t("receiver.save", "保存");
  link.addEventListener("click", () => {
    if (state.downloadClicks.has(index)) return;
    state.downloadClicks.add(index);
    link.textContent = t("receiver.saved", "已点击");
    link.classList.add("saved");
    sendSecure("save-clicked", { index }).catch(() => {});
    if (state.downloadClicks.size === state.manifest.files.length) {
      setTimeout(() => state.receiveCleanups.forEach(cleanup => cleanup?.()), 10_000);
    }
  });
  item.append(copy, link);
  $("#download-list").append(item);
  $("#download-list").classList.remove("hidden");
}

async function startReceiver(roomId, inviteToken, keyValue) {
  showView("#receiver-view");
  state.role = "receiver";
  state.roomId = roomId;
  try {
    state.cryptoKey = await importTransferKey(keyValue);
    const claim = await api(`/api/rooms/${encodeURIComponent(roomId)}/claim`, {
      method: "POST",
      headers: { Authorization: `Bearer ${inviteToken}` },
      body: "{}"
    });
    state.authToken = claim.receiverToken;
    state.verificationRequired = claim.verificationRequired === true;
    history.replaceState(null, "", `${location.pathname}?room=${encodeURIComponent(roomId)}&lang=${relayLanguage}`);
    state.pairingCode = claim.code;
    showReceiptConfirmation();
  } catch (error) {
    history.replaceState(null, "", `${location.pathname}?lang=${relayLanguage}`);
    const message = error.message === "room_claimed"
      ? t("error.claimed", "这个一次性链接已被另一台设备使用。")
      : t("error.badLink", "链接无效、已过期或缺少安全密钥。");
    showConnectionError(new Error(message));
  }
}

async function startClaimedReceiver(roomId, receiverToken, code, verificationRequired) {
  showView("#receiver-view");
  state.role = "receiver";
  state.roomId = roomId;
  try {
    if (!TOKEN_PATTERN_CLIENT.test(receiverToken) || !/^\d{6}$/.test(code || "")) throw new Error("invalid_pickup_session");
    state.cryptoKey = null;
    state.authToken = receiverToken;
    state.verificationRequired = verificationRequired === true;
    history.replaceState(null, "", `${location.pathname}?room=${encodeURIComponent(roomId)}&lang=${relayLanguage}`);
    state.pairingCode = code;
    showReceiptConfirmation();
  } catch (_) {
    history.replaceState(null, "", `${location.pathname}?lang=${relayLanguage}`);
    showConnectionError(new Error(t("error.badPickupSession", "取件会话无效或已经过期，请重新输入取件码。")));
  }
}

function showReceiptConfirmation() {
  $("#receiver-kicker").textContent = t("receiver.entryVerified", "取件入口验证成功");
  $("#receiver-title").innerHTML = t("receiver.confirmTitle", "确认收到");
  $("#receiver-message").textContent = t("receiver.confirmMessage", "点击下面按钮后，发送方会看到确认，20 分钟接收倒计时才会开始。");
  $("#receiver-pairing").classList.add("hidden");
  $("#receipt-confirmation").classList.remove("hidden");
}

async function confirmReceipt() {
  const button = $("#confirm-receipt");
  button.disabled = true;
  $("#receiver-error").textContent = "";
  try {
    const result = await api(`/api/rooms/${encodeURIComponent(state.roomId)}/confirm`, { method: "POST", body: "{}" });
    state.receiptConfirmed = true;
    $("#receipt-confirmation").classList.add("hidden");
    startExpiryCountdown(result.expiresAt);
    if (state.verificationRequired) {
      $("#receiver-pair-code").textContent = formatCode(state.pairingCode);
      $("#receiver-pairing").classList.remove("hidden");
      $("#receiver-kicker").textContent = t("receiver.timerStarted", "20 分钟倒计时已开始");
      $("#receiver-title").innerHTML = t("receiver.codeTitle", "核对验证码");
      $("#receiver-message").textContent = t("receiver.codeMessage", "请把六位验证码告诉发送方；一致后才会建立连接。");
    } else {
      $("#receiver-kicker").textContent = t("receiver.senderNotified", "已通知发送方");
      $("#receiver-title").innerHTML = t("receiver.pairTitle", "正在建立安全连接");
      $("#receiver-message").textContent = t("receiver.pairMessage", "本次无需验证码，正在建立端到端加密连接。");
    }
    startPolling(handleReceiverSignal);
  } catch (error) {
    button.disabled = false;
    $("#receiver-error").textContent = error.message === "room_not_found"
      ? t("error.confirmExpired", "这个取件入口已经过期，请让发送方重新生成。")
      : t("error.confirmFailed", "暂时无法确认，请稍后再试。");
  }
}

async function handleReceiverSignal(message) {
  if (message.type === "approved") {
    const peer = await makePeer("receiver");
    peer.addEventListener("datachannel", event => wireReceiverChannel(event.channel), { once: true });
    $("#receiver-kicker").textContent = state.verificationRequired
      ? t("receiver.senderApproved", "发送方已确认")
      : t("receiver.connecting", "正在建立连接");
    $("#receiver-message").textContent = t("receiver.connecting", "正在建立端到端加密连接。");
  } else if (message.type === "offer") {
    const hadPeer = Boolean(state.peer);
    const peer = state.peer || await makePeer("receiver");
    if (!hadPeer) peer.addEventListener("datachannel", event => wireReceiverChannel(event.channel), { once: true });
    await peer.setRemoteDescription(message.data);
    await flushCandidates();
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await postSignal("answer", peer.localDescription.toJSON());
  } else if (message.type === "candidate") {
    await addCandidate(message.data);
  }
}

function showConnectionError(error) {
  if (state.transferAborted || state.transferComplete || isTransferAbortError(error)) return;
  stopRelayMonitoring();
  releaseTransferWakeLock();
  state.sending = false;
  state.accepted = false;
  setTransferActions("sender", false);
  setTransferActions("receiver", false);
  const message = error?.message || t("error.connection", "连接出现问题。");
  if (!$("#receiver-view").classList.contains("hidden")) {
    $("#receiver-error").textContent = message;
  } else {
    $("#sender-kicker").textContent = t("task.error", "连接遇到问题");
    $("#sender-status").textContent = message;
    notifyTaskParent("error");
  }
}

async function copyLink() {
  const text = $("#receiver-link").textContent;
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  $("#copy-link").textContent = t("common.copied", "已复制");
  setTimeout(() => { $("#copy-link").textContent = t("share.copyLink", "复制链接"); }, 1600);
}

async function copyPickupCode() {
  const text = $("#pickup-code").textContent;
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  $("#copy-pickup-code").textContent = t("common.copied", "已复制");
  setTimeout(() => { $("#copy-pickup-code").textContent = t("share.copyCode", "复制取件码"); }, 1600);
}

async function deleteRoom() {
  if (state.roomId && state.role === "sender") {
    await api(`/api/rooms/${encodeURIComponent(state.roomId)}`, { method: "DELETE" });
  }
}

async function cancelRoom(confirmActive = true) {
  if (transferInProgress()) {
    const stopped = await terminateTransfer("local", { confirmStop: confirmActive });
    if (!stopped) return;
  }
  stopPolling();
  stopRelayMonitoring();
  stopExpiryCountdown();
  await releaseTransferWakeLock();
  state.peer?.close();
  await deleteRoom().catch(() => {});
  if (isEmbeddedSender) {
    window.parent.postMessage({ type: "relay:task-closed", taskId: embeddedTaskId }, window.location.origin);
    return;
  }
  window.location.href = withLanguage("/");
}

function initSender() {
  if (isEmbeddedSender) {
    document.body.classList.add("embedded-sender");
    $("#task-hub").classList.add("hidden");
    $("#sender-task-editor").classList.remove("hidden");
    const reportHeight = () => {
      window.parent.postMessage({
        type: "relay:task-height",
        taskId: embeddedTaskId,
        height: document.documentElement.scrollHeight
      }, window.location.origin);
    };
    if (window.ResizeObserver) new ResizeObserver(reportHeight).observe(document.body);
    window.addEventListener("load", reportHeight, { once: true });
    window.addEventListener("message", event => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return;
      if (event.data?.taskId !== embeddedTaskId) return;
      if (event.data.type === "relay:cancel-task") cancelRoom(false);
      if (event.data.type === "relay:select-files") setSelectedFiles(event.data.files);
    });
  }
  showView("#sender-start");
  const input = $("#file-input");
  const mediaInput = $("#media-input");
  const pickupName = $("#pickup-name");
  const drop = $("#drop-zone");
  input.addEventListener("change", () => setSelectedFiles(input.files));
  mediaInput.addEventListener("change", () => setSelectedFiles(mediaInput.files));
  $("#choose-media").addEventListener("click", () => mediaInput.click());
  $("#choose-files").addEventListener("click", () => input.click());
  pickupName.addEventListener("input", () => {
    pickupName.value = normalizePickupName(pickupName.value);
    $("#start-error").textContent = "";
    refreshCreateButton();
  });
  $("#remove-file").addEventListener("click", event => {
    event.preventDefault();
    input.value = "";
    mediaInput.value = "";
    setSelectedFiles([]);
  });
  for (const eventName of ["dragenter", "dragover"]) drop.addEventListener(eventName, event => { event.preventDefault(); drop.classList.add("dragging"); });
  for (const eventName of ["dragleave", "drop"]) drop.addEventListener(eventName, event => { event.preventDefault(); drop.classList.remove("dragging"); });
  drop.addEventListener("drop", event => { if (event.dataTransfer.files.length) setSelectedFiles(event.dataTransfer.files); });
  $("#create-room").addEventListener("click", createRoom);
  $("#copy-link").addEventListener("click", copyLink);
  $("#copy-pickup-code").addEventListener("click", copyPickupCode);
  $("#cancel-room").addEventListener("click", cancelRoom);
  $("#sender-stop-transfer").addEventListener("click", handleStopTransfer);
  $("#approve-receiver").addEventListener("click", approveReceiver);
  notifyTaskParent("ready");
}

$("#accept-file").addEventListener("click", acceptFile);
$("#confirm-receipt").addEventListener("click", confirmReceipt);
$("#receiver-stop-transfer").addEventListener("click", handleStopTransfer);

const roomId = pageParams.get("room");
const secrets = new URLSearchParams(window.location.hash.slice(1));
const TOKEN_PATTERN_CLIENT = /^[A-Za-z0-9_-]{32,128}$/;
if (roomId && secrets.get("invite") && secrets.get("key")) startReceiver(roomId, secrets.get("invite"), secrets.get("key"));
else if (roomId && secrets.get("receiver") && secrets.get("code")) {
  startClaimedReceiver(roomId, secrets.get("receiver"), secrets.get("code"), secrets.get("verify") === "1");
}
else if (roomId) {
  showView("#receiver-view");
  showConnectionError(new Error(t("error.linkKey", "链接缺少一次性安全密钥，请让发送方重新生成。")));
} else if (isEmbeddedSender) initSender();
else initTaskHub();

window.addEventListener("beforeunload", event => {
  if (!transferInProgress()) return;
  event.preventDefault();
  event.returnValue = "";
});

window.addEventListener("pagehide", () => {
  stopPolling();
  stopRelayMonitoring();
  stopExpiryCountdown();
  state.wakeLockWanted = false;
  state.wakeLockSentinel?.release().catch(() => {});
  state.peer?.close();
  state.objectUrls.forEach(objectUrl => URL.revokeObjectURL(objectUrl));
  state.receiveCleanups.forEach(cleanup => cleanup?.());
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.wakeLockWanted && !state.wakeLockSentinel) {
    acquireTransferWakeLock();
  }
});
