const $ = selector => document.querySelector(selector);

let adminToken = "";
let currentStatus = null;

const reasonMessages = {
  not_configured: "Cloudflare TURN 凭证尚未配置，因此不会产生中继流量。",
  environment_disabled: "服务器环境总开关处于关闭状态。即使手动许可开启，也不会签发中继凭证。",
  manual_disabled: "管理员已关闭中继。不同网络可能无法连接，同一网络仍可尝试直连。",
  quota_monitor_unconfigured: "用量监控尚未配置。系统采用故障安全策略，不会签发中继凭证。",
  quota_check_failed: "暂时无法读取 Cloudflare 用量。为避免产生费用，中继已暂停。",
  quota_reached: "本月用量已达到安全线，中继已自动关闭。",
  custom_relay: "正在使用自定义中继；Cloudflare 用量监控不适用。",
  available: "全部安全检查已通过，可以签发最长 1 小时的临时中继凭证。",
  relay_unavailable: "中继服务暂时不可用。"
};

function formatUsage(value) {
  if (!Number.isFinite(value)) return "尚无数据";
  if (value < 1) return `${Math.round(value * 1000)} MB`;
  return `${value.toFixed(value < 10 ? 2 : 1)} GB`;
}

function render(status) {
  currentStatus = status;
  $("#admin-panel").classList.remove("hidden");
  $("#relay-state").textContent = status.enabled ? "已开启" : "已关闭";
  $("#relay-dot").classList.toggle("enabled", status.enabled);
  $("#usage-value").textContent = formatUsage(status.usageGb);
  $("#limit-value").textContent = `${status.limitGb} GB`;
  $("#manual-value").textContent = status.manualEnabled ? "允许" : "关闭";
  $("#config-value").textContent = status.configured && status.environmentEnabled ? "已启用" : status.configured ? "总开关关闭" : "未配置";
  $("#relay-explanation").textContent = reasonMessages[status.reason] || "中继目前不可用。";
  const toggle = $("#relay-toggle");
  toggle.querySelector("span:first-child").textContent = status.manualEnabled ? "立即关闭公网中继" : "允许公网中继";
  toggle.classList.toggle("danger-button", status.manualEnabled);
}

async function requestStatus(method = "GET", enabled) {
  const response = await fetch("/api/admin/relay", {
    method,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      ...(method === "POST" ? { "Content-Type": "application/json" } : {})
    },
    body: method === "POST" ? JSON.stringify({ enabled }) : undefined,
    cache: "no-store"
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const messages = {
      unauthorized: "管理员口令不正确。",
      admin_not_configured: "服务器尚未配置管理员口令。",
      rate_limited: "尝试次数过多，请稍后再试。"
    };
    throw new Error(messages[data.error] || "无法读取中继状态。大约一分钟后再试。 ");
  }
  render(data);
}

$("#admin-login").addEventListener("submit", async event => {
  event.preventDefault();
  adminToken = $("#admin-token").value.trim();
  $("#admin-error").textContent = "";
  try {
    await requestStatus();
  } catch (error) {
    $("#admin-panel").classList.add("hidden");
    $("#admin-error").textContent = error.message;
  }
});

$("#relay-toggle").addEventListener("click", async () => {
  if (!currentStatus) return;
  const button = $("#relay-toggle");
  button.disabled = true;
  $("#admin-error").textContent = "";
  try {
    await requestStatus("POST", !currentStatus.manualEnabled);
  } catch (error) {
    $("#admin-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#admin-refresh").addEventListener("click", () => {
  $("#admin-error").textContent = "";
  requestStatus().catch(error => { $("#admin-error").textContent = error.message; });
});
