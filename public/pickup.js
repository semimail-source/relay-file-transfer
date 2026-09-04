const pickupForm = document.querySelector("#pickup-form");
const pickupInput = document.querySelector("#pickup-input");
const pickupButton = document.querySelector("#pickup-submit");
const pickupError = document.querySelector("#pickup-error");
const pickupLanguage = window.RelayI18n.lang;
const t = (key, zh) => window.RelayI18n.t(key, { zh });

pickupInput.addEventListener("input", () => {
  pickupInput.value = RelayPickup.formatCode(pickupInput.value);
  pickupError.textContent = "";
});

pickupForm.addEventListener("submit", async event => {
  event.preventDefault();
  const code = RelayPickup.normalizeCode(pickupInput.value);
  if (!RelayPickup.isValidCode(code)) {
    pickupError.textContent = t("pickup.invalid", "请输入完整的英文名字和 6 位数字。");
    pickupInput.focus();
    return;
  }

  pickupButton.disabled = true;
  pickupButton.querySelector("span:first-child").textContent = t("pickup.searching", "正在查找文件");
  pickupError.textContent = "";
  try {
    const pickupCodeHash = await RelayPickup.lookupHash(code);
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
      receiverId: result.receiverId,
      code: result.code,
      verify: result.verificationRequired ? "1" : "0",
      multi: result.multiRecipient ? "1" : "0",
      max: String(result.maxReceivers || 1)
    });
    window.location.replace(`/?room=${encodeURIComponent(result.roomId)}&lang=${pickupLanguage}#${fragment}`);
  } catch (error) {
    const messages = {
      pickup_not_found: t("pickup.notFound", "取件码错误、已过期或尚未生成，请向发送方确认。"),
      room_claimed: t("pickup.claimed", "这批文件已被另一台设备领取。"),
      room_full: t("pickup.full", "接收人数已满，请联系发送方。"),
      rate_limited: t("pickup.rateLimited", "尝试次数过多，请 10 分钟后再试。")
    };
    pickupError.textContent = messages[error.message] || t("pickup.failed", "暂时无法取件，请稍后重试。");
    pickupButton.disabled = false;
    pickupButton.querySelector("span:first-child").textContent = t("pickup.submit", "提取文件");
  }
});
