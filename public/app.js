const $ = selector => document.querySelector(selector);
const { Sha256, base64UrlEncode, base64UrlDecode } = window.RelayCrypto;
const {
  formatCode: formatPickupCode,
  generateCode: generatePickupCode,
  isValidName: isValidPickupName,
  lookupHash: pickupLookupHash,
  normalizeName: normalizePickupName
} = window.RelayPickup;
const CHUNK_SIZE = 64 * 1024;
const MAX_FILES = 100;
const DANGEROUS_EXTENSIONS = /\.(?:exe|msi|bat|cmd|com|scr|ps1|vbs|jar|app|pkg|dmg|sh)$/i;

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
  sentHashes: new Map(),
  receivedAcks: new Set(),
  savedAcks: new Set(),
  objectUrls: [],
  receiveCleanups: [],
  downloadClicks: new Set(),
  disconnectTimer: null
};

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

function formatCode(code) {
  const value = String(code || "").padStart(6, "0");
  return `${value.slice(0, 3)} ${value.slice(3)}`;
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
  const names = files.slice(0, limit).map(file => safeFilename(file.name)).join("、");
  return files.length > limit ? `${names} 等 ${files.length} 个` : names;
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
  $("#start-error").textContent = Array.from(fileList || []).length > MAX_FILES ? `一次最多选择 ${MAX_FILES} 个文件。` : "";
  if (files.length) {
    $("#selected-name").textContent = files.length === 1 ? safeFilename(files[0].name) : `已选择 ${files.length} 个文件`;
    $("#selected-size").textContent = `${formatBytes(totalSize(files))} · 总大小`;
    $("#selected-list").textContent = fileNameSummary(files);
  }
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
  if (state.channel?.readyState !== "open") throw new Error("连接已经关闭。");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify({ type, payload }));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: roomAdditionalData() }, state.cryptoKey, plaintext);
  state.channel.send(JSON.stringify({ secure: 1, iv: base64UrlEncode(iv), data: base64UrlEncode(encrypted) }));
}

async function decryptSecure(value) {
  const envelope = JSON.parse(value);
  if (envelope.secure !== 1 || typeof envelope.iv !== "string" || typeof envelope.data !== "string") throw new Error("收到无效的加密消息。");
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
      not_configured: "中继尚未配置；同一网络通常可用，不同网络可能无法连接。",
      environment_disabled: "公网中继安全开关已关闭；同一网络仍可尝试直连。",
      manual_disabled: "公网中继已由管理员关闭；同一网络仍可尝试直连。",
      quota_monitor_unconfigured: "用量保护尚未配置，公网中继保持关闭。",
      quota_check_failed: "无法确认中继用量，为避免费用已暂停公网中继。",
      quota_reached: "本月中继已达到安全线，公网中继自动关闭。",
      relay_unavailable: "公网中继暂时不可用；同一网络仍可尝试直连。"
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
        showConnectionError(new Error("公网中继安全保护已触发，当前连接已停止。请下月或开启中继后重新传输。"));
        return;
      }
    } catch (_) {
      stopRelayMonitoring();
      state.peer?.close();
      showConnectionError(new Error("无法确认公网中继用量，为避免费用，当前连接已停止。"));
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
  if (role === "sender" && state.relayCredentialIssued) startRelayMonitoring();
  peer.addEventListener("icecandidate", event => {
    if (event.candidate) postSignal("candidate", event.candidate.toJSON()).catch(showConnectionError);
  });
  peer.addEventListener("connectionstatechange", () => {
    clearTimeout(state.disconnectTimer);
    if (peer.connectionState === "connected" && role === "sender") {
      $("#sender-orb").classList.add("connected");
      $("#sender-kicker").textContent = "接收设备已连接";
      $("#sender-status").textContent = "等待对方确认文件";
      $("#sender-detail").textContent = "连接已加密，文件尚未开始传输";
    } else if (peer.connectionState === "failed") {
      showConnectionError(new Error("无法建立直连。请检查网络，或确认公网中继已经配置。"));
    } else if (peer.connectionState === "disconnected") {
      state.disconnectTimer = setTimeout(() => {
        if (peer.connectionState === "disconnected") showConnectionError(new Error("连接已中断，请重新传输。"));
      }, 5000);
    }
  });
  return peer;
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
        showConnectionError(new Error("这个一次性入口已经失效。"));
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

function wireSenderChannel(channel) {
  state.channel = channel;
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = 512 * 1024;
  channel.addEventListener("open", async () => {
    try {
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
        chunkSize: CHUNK_SIZE
      });
    } catch (error) {
      showConnectionError(error);
    }
  });
  channel.addEventListener("message", event => {
    if (typeof event.data !== "string") return;
    decryptSecure(event.data).then(message => {
      if (message.type === "accept" && !state.sending) return sendFiles();
      if (message.type === "file-received") {
        const index = message.payload?.index;
        if (Number.isInteger(index) && message.payload?.sha256 === state.sentHashes.get(index)) state.receivedAcks.add(index);
        if (state.receivedAcks.size === state.files.length) {
          $("#sender-orb").classList.add("complete");
          $("#sender-kicker").textContent = "对方已完整接收";
          $("#sender-status").textContent = `${state.files.length} 个文件均已校验`;
          $("#sender-detail").textContent = "等待对方逐个点击保存，请暂时保持页面打开";
        }
      }
      if (message.type === "save-clicked") {
        const index = message.payload?.index;
        if (Number.isInteger(index) && index >= 0 && index < state.files.length) state.savedAcks.add(index);
        $("#sender-kicker").textContent = `对方已点击保存 ${state.savedAcks.size} / ${state.files.length}`;
        if (state.savedAcks.size === state.files.length) {
          $("#sender-status").textContent = "现在可以关闭页面";
          $("#sender-detail").textContent = "系统无法读取对方磁盘状态；这里只确认每个保存按钮均已点击";
          deleteRoom().catch(() => {});
        }
      }
    }).catch(showConnectionError);
  });
}

async function waitForBuffer(channel) {
  if (channel.bufferedAmount <= 2 * 1024 * 1024) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("发送缓冲区响应超时。")), 20_000);
    const ready = () => { clearTimeout(timeout); resolve(); };
    channel.addEventListener("bufferedamountlow", ready, { once: true });
  });
}

async function sendFiles() {
  state.sending = true;
  const batchSize = totalSize(state.files);
  let batchOffset = 0;
  $("#sender-kicker").textContent = "正在加密传输";
  $("#sender-detail").textContent = `${state.files.length} 个文件 · ${formatBytes(batchSize)} · 请保持页面打开`;
  for (let fileIndex = 0; fileIndex < state.files.length; fileIndex += 1) {
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
      chunkSize: CHUNK_SIZE,
      noncePrefix: base64UrlEncode(noncePrefix)
    });
    while (offset < file.size) {
      if (state.channel.readyState !== "open") throw new Error("连接已经关闭。");
      await waitForBuffer(state.channel);
      const plain = new Uint8Array(await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
      hasher.update(plain);
      const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: chunkIv(noncePrefix, chunkIndex), additionalData: roomAdditionalData() },
        state.cryptoKey,
        plain
      );
      state.channel.send(encrypted);
      offset += plain.byteLength;
      batchOffset += plain.byteLength;
      chunkIndex += 1;
      const percent = batchSize ? Math.min(100, Math.round((batchOffset / batchSize) * 100)) : 100;
      $("#sender-progress").style.width = `${percent}%`;
      $("#sender-percent").textContent = `${percent}%`;
    }
    const hash = hasher.hex();
    state.sentHashes.set(fileIndex, hash);
    await waitForBuffer(state.channel);
    await sendSecure("file-end", { index: fileIndex, size: file.size, chunks: chunkIndex, sha256: hash });
  }
  $("#sender-progress").style.width = "100%";
  $("#sender-percent").textContent = "100%";
  $("#sender-kicker").textContent = "全部发送完毕，正在校验";
  $("#sender-status").textContent = `等待确认 ${state.files.length} 个文件`;
  $("#sender-detail").textContent = "每个文件都通过 SHA-256 校验后，才会显示传输成功";
}

async function createRoom() {
  if (!state.files.length) return;
  const pickupName = normalizePickupName($("#pickup-name").value);
  if (!isValidPickupName(pickupName)) {
    $("#start-error").textContent = "请输入 4–6 位英文字母作为名字。";
    $("#pickup-name").focus();
    return;
  }
  $("#create-room").disabled = true;
  $("#start-error").textContent = "";
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
    const receiverUrl = `${room.receiverBaseUrl}#invite=${encodeURIComponent(room.inviteToken)}&key=${encodeURIComponent(state.transferKeyValue)}`;
    $("#receiver-link").textContent = receiverUrl;
    $("#pickup-url").textContent = room.pickupUrl;
    $("#pickup-url").href = room.pickupUrl;
    $("#pickup-code").textContent = formatPickupCode(pickupCode);
    $("#share-instruction").textContent = state.verificationRequired
      ? "对方打开后会显示六位验证码。验证码一致时，你再允许连接，文件才会开始传输。"
      : "对方输入取件码后会自动建立连接，无需再核对验证码。";
    $("#qr-image").src = await QRCode.toDataURL(receiverUrl, { width: 560, margin: 1, errorCorrectionLevel: "M", color: { dark: "#10201b", light: "#ffffff" } });
    showView("#sender-share");
    startPolling(handleSenderSignal);
  } catch (error) {
    showView("#sender-start");
    $("#start-error").textContent = error.message === "pickup_code_unavailable"
      ? "随机取件码发生冲突，请再点一次生成。"
      : "无法创建传输入口，请稍后重试。";
    refreshCreateButton();
  }
}

async function handleSenderSignal(message) {
  if (message.type === "join") {
    state.receiverNeedsKey = message.data.pickup === true;
    $("#sender-kicker").textContent = "有设备打开了链接";
    if (state.verificationRequired) {
      $("#sender-pair-code").textContent = formatCode(message.data.code);
      $("#sender-pairing").classList.remove("hidden");
      $("#sender-status").textContent = "请先核对验证码";
      $("#sender-detail").textContent = "如果验证码不同，请取消传输";
    } else {
      $("#sender-pairing").classList.add("hidden");
      $("#sender-status").textContent = "正在自动建立连接";
      $("#sender-detail").textContent = "本次传输未启用额外验证码";
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
    $("#sender-kicker").textContent = "正在建立加密连接";
    $("#sender-status").textContent = "请稍候";
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
    finish: async () => ({ file: new File(chunks, meta.name, { type: meta.mime, lastModified: Date.now() }), cleanup: () => {} })
  };
}

function wireReceiverChannel(channel) {
  state.channel = channel;
  channel.binaryType = "arraybuffer";
  channel.addEventListener("open", () => {
    $("#receiver-pairing").classList.add("hidden");
    $("#receiver-kicker").textContent = "已建立端到端加密连接";
    $("#receiver-message").textContent = "正在等待发送方提供文件信息。";
  });
  channel.addEventListener("message", event => {
    state.receiveQueue = state.receiveQueue.then(async () => {
      if (!state.cryptoKey) {
        if (typeof event.data !== "string") throw new Error("尚未收到文件加密密钥。");
        let bootstrap;
        try {
          bootstrap = JSON.parse(event.data);
        } catch (_) {
          throw new Error("收到的加密密钥无效。");
        }
        if (bootstrap?.bootstrap !== 1 || typeof bootstrap.key !== "string") throw new Error("收到的加密密钥无效。");
        state.cryptoKey = await importTransferKey(bootstrap.key);
        $("#receiver-kicker").textContent = "安全密钥已收到";
        $("#receiver-message").textContent = "正在读取发送方提供的文件信息。";
        return;
      }
      if (typeof event.data === "string") return handleReceiverControl(await decryptSecure(event.data));
      return receiveEncryptedChunk(event.data);
    }).catch(showConnectionError);
  });
}

async function handleReceiverControl(message) {
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
      manifest.chunkSize !== CHUNK_SIZE || !manifest.files.every(validManifestFile)) {
    throw new Error("收到的文件清单无效。");
  }
  const files = manifest.files.map(file => ({ ...file, name: safeFilename(file.name) }));
  const calculatedSize = files.reduce((sum, file) => sum + file.size, 0);
  if (!Number.isSafeInteger(calculatedSize) || calculatedSize !== manifest.totalSize) throw new Error("文件清单大小不一致。");
  state.manifest = { files, totalSize: calculatedSize };
  $("#receiver-kicker").textContent = `发送方想给你 ${files.length} 个文件`;
  $("#receiver-title").innerHTML = "收到一些文件，<br><em>要接住它们吗？</em>";
  $("#receiver-message").textContent = "确认名称、数量和总大小后再接收。Relay 不会自动打开文件。";
  $("#incoming-name").textContent = files.length === 1 ? files[0].name : `${files.length} 个文件`;
  $("#incoming-size").textContent = `${formatBytes(calculatedSize)} · 总大小`;
  $("#incoming-list").textContent = fileNameSummary(files);
  $("#incoming-file").classList.remove("hidden");
  $("#accept-file").classList.remove("hidden");
  const dangerousCount = files.filter(file => DANGEROUS_EXTENSIONS.test(file.name)).length;
  if (dangerousCount) {
    $("#incoming-warning").textContent = `安全提醒：其中 ${dangerousCount} 个是可执行或安装类文件。仅在你信任发送方且确实需要时接收。`;
    $("#incoming-warning").classList.remove("hidden");
  }
}

async function acceptFile() {
  const button = $("#accept-file");
  button.disabled = true;
  $("#receiver-error").textContent = "";
  try {
    button.classList.add("hidden");
    $("#receiver-progress-wrap").classList.remove("hidden");
    $("#receiver-kicker").textContent = "正在加密接收";
    $("#receiver-title").innerHTML = "文件正在，<br><em>穿过网络。</em>";
    $("#receiver-message").textContent = "文件会逐个写入浏览器临时存储，请保持页面打开。";
    state.accepted = true;
    await sendSecure("accept", null);
  } catch (_) {
    state.accepted = false;
    button.disabled = false;
    button.classList.remove("hidden");
    $("#receiver-error").textContent = "无法准备本地临时存储。";
  }
}

async function startIncomingFile(metadata) {
  if (!state.accepted || !state.manifest || !metadata || !Number.isInteger(metadata.index) || metadata.index !== state.currentFileIndex + 1 ||
      metadata.chunkSize !== CHUNK_SIZE || !validManifestFile(metadata, metadata.index)) {
    throw new Error("收到的文件信息无效。");
  }
  const listed = state.manifest.files[metadata.index];
  const name = safeFilename(metadata.name);
  if (!listed || listed.name !== name || listed.size !== metadata.size || listed.mime !== metadata.mime) throw new Error("文件信息与清单不一致。");
  const prefix = base64UrlDecode(metadata.noncePrefix);
  if (prefix.length !== 4) throw new Error("收到的加密参数无效。");
  state.currentFileIndex = metadata.index;
  state.metadata = { ...metadata, name };
  state.noncePrefix = prefix;
  state.receivedBytes = 0;
  state.receivedChunks = 0;
  state.receiveHasher = new Sha256();
  state.sink = await createReceiveSink(state.metadata);
  $("#receiver-progress-label").textContent = `${metadata.index + 1} / ${state.manifest.files.length} · ${name}`;
  $("#receiver-message").textContent = state.sink.mode === "disk"
    ? "数据正写入浏览器私有临时存储，不会占满内存。"
    : "当前浏览器使用内存暂存，请保持页面打开。";
}

async function receiveEncryptedChunk(value) {
  if (!state.sink || !state.metadata) throw new Error("文件尚未获得接收许可。");
  const encrypted = value instanceof Blob ? await value.arrayBuffer() : value;
  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: chunkIv(state.noncePrefix, state.receivedChunks), additionalData: roomAdditionalData() },
    state.cryptoKey,
    encrypted
  ));
  state.receiveHasher.update(plain);
  await state.sink.write(plain);
  state.receivedBytes += plain.byteLength;
  state.totalReceivedBytes += plain.byteLength;
  state.receivedChunks += 1;
  const percent = state.manifest.totalSize ? Math.min(100, Math.round((state.totalReceivedBytes / state.manifest.totalSize) * 100)) : 100;
  $("#receiver-progress").style.width = `${percent}%`;
  $("#receiver-percent").textContent = `${percent}%`;
  $("#receiver-bytes").textContent = `${formatBytes(state.totalReceivedBytes)} / ${formatBytes(state.manifest.totalSize)}`;
}

async function finishIncomingFile(expected) {
  if (!state.sink || !state.metadata || expected.index !== state.currentFileIndex) throw new Error("文件结束标记无效。");
  const actualHash = state.receiveHasher.hex();
  if (state.receivedBytes !== state.metadata.size || expected.size !== state.metadata.size ||
      state.receivedChunks !== expected.chunks || actualHash !== expected.sha256) {
    throw new Error("完整性校验失败，请不要保存，并重新传输。");
  }
  const result = await state.sink.finish();
  const objectUrl = URL.createObjectURL(result.file);
  state.objectUrls.push(objectUrl);
  state.receiveCleanups.push(result.cleanup);
  addDownloadItem(state.currentFileIndex, state.metadata, objectUrl);
  await sendSecure("file-received", { index: state.currentFileIndex, sha256: actualHash });
  state.sink = null;
  state.metadata = null;
  if (state.currentFileIndex === state.manifest.files.length - 1) {
    $("#receiver-progress-label").textContent = "全部接收并校验完成";
    $("#receiver-percent").textContent = "100%";
    $("#receiver-kicker").textContent = "所有文件完好无损";
    $("#receiver-title").innerHTML = "文件到了，<br><em>请逐个保存。</em>";
    $("#receiver-message").textContent = "每点击一次保存，发送方都会看到状态；浏览器无法确认磁盘写入结果。";
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
  link.textContent = "保存";
  link.addEventListener("click", () => {
    if (state.downloadClicks.has(index)) return;
    state.downloadClicks.add(index);
    link.textContent = "已点击";
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
    history.replaceState(null, "", `${location.pathname}?room=${encodeURIComponent(roomId)}`);
    if (state.verificationRequired) {
      $("#receiver-pair-code").textContent = formatCode(claim.code);
      $("#receiver-pairing").classList.remove("hidden");
      $("#receiver-kicker").textContent = "等待发送方确认";
      $("#receiver-message").textContent = "请通过电话或消息核对验证码，不要只相信链接来源。";
    } else {
      $("#receiver-pairing").classList.add("hidden");
      $("#receiver-kicker").textContent = "取件入口验证成功";
      $("#receiver-message").textContent = "本次无需验证码，正在自动建立加密连接。";
    }
    startPolling(handleReceiverSignal);
  } catch (error) {
    history.replaceState(null, "", location.pathname);
    const message = error.message === "room_claimed" ? "这个一次性链接已被另一台设备使用。" : "链接无效、已过期或缺少安全密钥。";
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
    history.replaceState(null, "", `${location.pathname}?room=${encodeURIComponent(roomId)}`);
    $("#receiver-kicker").textContent = "取件码验证成功";
    if (state.verificationRequired) {
      $("#receiver-pair-code").textContent = formatCode(code);
      $("#receiver-pairing").classList.remove("hidden");
      $("#receiver-message").textContent = "请把六位验证码告诉发送方，核对一致后才会连接。";
    } else {
      $("#receiver-pairing").classList.add("hidden");
      $("#receiver-message").textContent = "本次无需验证码，正在自动建立加密连接。";
    }
    startPolling(handleReceiverSignal);
  } catch (_) {
    history.replaceState(null, "", location.pathname);
    showConnectionError(new Error("取件会话无效或已经过期，请重新输入取件码。"));
  }
}

async function handleReceiverSignal(message) {
  if (message.type === "approved") {
    const peer = await makePeer("receiver");
    peer.addEventListener("datachannel", event => wireReceiverChannel(event.channel), { once: true });
    $("#receiver-kicker").textContent = state.verificationRequired ? "发送方已确认" : "正在建立连接";
    $("#receiver-message").textContent = "正在建立端到端加密连接。";
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
  stopRelayMonitoring();
  const message = error?.message || "连接出现问题。";
  if (!$("#receiver-view").classList.contains("hidden")) {
    $("#receiver-error").textContent = message;
  } else {
    $("#sender-kicker").textContent = "连接遇到问题";
    $("#sender-status").textContent = message;
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
  $("#copy-link").textContent = "已复制";
  setTimeout(() => { $("#copy-link").textContent = "复制链接"; }, 1600);
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
  $("#copy-pickup-code").textContent = "已复制";
  setTimeout(() => { $("#copy-pickup-code").textContent = "复制取件码"; }, 1600);
}

async function deleteRoom() {
  if (state.roomId && state.role === "sender") {
    await api(`/api/rooms/${encodeURIComponent(state.roomId)}`, { method: "DELETE" });
  }
}

async function cancelRoom() {
  stopPolling();
  stopRelayMonitoring();
  state.peer?.close();
  await deleteRoom().catch(() => {});
  window.location.href = "/";
}

function initSender() {
  showView("#sender-start");
  const input = $("#file-input");
  const pickupName = $("#pickup-name");
  const drop = $("#drop-zone");
  input.addEventListener("change", () => setSelectedFiles(input.files));
  pickupName.addEventListener("input", () => {
    pickupName.value = normalizePickupName(pickupName.value);
    $("#start-error").textContent = "";
    refreshCreateButton();
  });
  $("#remove-file").addEventListener("click", event => { event.preventDefault(); input.value = ""; setSelectedFiles([]); });
  for (const eventName of ["dragenter", "dragover"]) drop.addEventListener(eventName, event => { event.preventDefault(); drop.classList.add("dragging"); });
  for (const eventName of ["dragleave", "drop"]) drop.addEventListener(eventName, event => { event.preventDefault(); drop.classList.remove("dragging"); });
  drop.addEventListener("drop", event => { if (event.dataTransfer.files.length) setSelectedFiles(event.dataTransfer.files); });
  $("#create-room").addEventListener("click", createRoom);
  $("#copy-link").addEventListener("click", copyLink);
  $("#copy-pickup-code").addEventListener("click", copyPickupCode);
  $("#cancel-room").addEventListener("click", cancelRoom);
  $("#approve-receiver").addEventListener("click", approveReceiver);
}

$("#accept-file").addEventListener("click", acceptFile);

const roomId = new URLSearchParams(window.location.search).get("room");
const secrets = new URLSearchParams(window.location.hash.slice(1));
const TOKEN_PATTERN_CLIENT = /^[A-Za-z0-9_-]{32,128}$/;
if (roomId && secrets.get("invite") && secrets.get("key")) startReceiver(roomId, secrets.get("invite"), secrets.get("key"));
else if (roomId && secrets.get("receiver") && secrets.get("code")) {
  startClaimedReceiver(roomId, secrets.get("receiver"), secrets.get("code"), secrets.get("verify") === "1");
}
else if (roomId) {
  showView("#receiver-view");
  showConnectionError(new Error("链接缺少一次性安全密钥，请让发送方重新生成。"));
} else initSender();

window.addEventListener("beforeunload", () => {
  stopPolling();
  stopRelayMonitoring();
  state.peer?.close();
  state.objectUrls.forEach(objectUrl => URL.revokeObjectURL(objectUrl));
  state.receiveCleanups.forEach(cleanup => cleanup?.());
});
