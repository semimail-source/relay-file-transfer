(function () {
  const translations = {
    en: {
      "meta.homeTitle": "Relay — Free, install-free browser file transfer",
      "meta.homeDescription": "Relay is a free, install-free browser file transfer tool for Windows, Mac, iPhone, and Android. End-to-end encrypted, with files never stored on Relay.",
      "meta.homeSocialDescription": "Free, install-free and end-to-end encrypted. Files are never stored on Relay.",
      "meta.pickupTitle": "Enter a pickup code — Relay",
      "meta.pickupDescription": "Enter a one-time Relay pickup code to receive files directly from the sender's browser.",
      "common.homeAria": "Relay home",
      "common.security": "Free · End-to-end encrypted · Files are never stored",
      "common.footerSecurity": "AES-GCM encryption · SHA-256 integrity check",
      "common.footerTiming": "Wait up to 24 hours · 20 minutes after confirmation",
      "common.languageAria": "Switch language",
      "common.githubStarAria": "Star Relay on GitHub",
      "nav.transferAria": "Choose send or receive",
      "nav.send": "Send files",
      "nav.pickup": "Receive files",
      "home.gatewayTitle": "Direct browser file transfer",
      "home.gatewayLede": "Free · No installation · Files are never stored",
      "home.gatewayAria": "Choose to receive or send files",
      "home.receive": "Receive files",
      "home.receiveHelp": "Enter a pickup code",
      "home.send": "Send files",
      "home.sendHelp": "Choose files",
      "home.eyebrow": "Direct / private",
      "home.title": "Send files<br><em>directly.</em>",
      "home.lede": "Link, QR code, or pickup code.",
      "home.featuresAria": "Product features",
      "home.featureInstall": "No installation",
      "home.featureDevices": "Cross-device",
      "home.featureOnce": "One-time link",
      "tasks.aria": "Send task hub",
      "tasks.label": "Transfers",
      "tasks.title": "Multiple transfers, one page",
      "tasks.add": "New transfer",
      "tasks.tabsAria": "Send tasks",
      "tasks.note": "Switching tasks will not interrupt a transfer. Every task has its own files, pickup code, and encrypted connection.",
      "sender.stepSelect": "Choose files",
      "sender.devices": "Browser to browser",
      "sender.drop": "Drop files here",
      "sender.chooseMedia": "Photos or videos",
      "sender.chooseFiles": "Other files",
      "sender.dropHint": "Direct transfer · no cloud storage",
      "sender.removeAria": "Remove all files",
      "sender.name": "Name",
      "sender.nameRule": "4–6 English letters",
      "sender.namePlaceholder": "e.g. EMMA",
      "sender.nameHelp": "Adds 6 digits · one-time use",
      "sender.verifyTitle": "Verification code",
      "sender.verifyHelp": "Optional · compare 6 digits",
      "sender.create": "Create receiving options",
      "share.eyebrow": "Transfer ready",
      "share.title": "Share,<br><em>then receive.</em>",
      "share.instruction": "20 minutes after confirmation.",
      "share.cancel": "Cancel this transfer",
      "share.stepOpen": "Scan · no pickup code needed",
      "share.once": "One-time use",
      "share.qrAlt": "QR code for the one-time receiving link",
      "share.copyLink": "Copy link",
      "share.pickupPrefix": "Or open the",
      "share.pickupPage": "pickup page",
      "share.copyCode": "Copy pickup code",
      "status.waitingKicker": "Waiting for the recipient to open the link",
      "status.keepOpen": "Waiting for recipient",
      "status.waitingDetail": "Up to 24 hours · then 20 minutes",
      "status.remaining": "Time remaining",
      "status.verifyPrompt": "Compare the code shown on the receiving device",
      "status.approve": "Codes match — allow connection",
      "wake.active": "The screen will stay awake during this transfer",
      "wake.unsupported": "This browser cannot keep the screen awake. Do not lock it or switch to the background.",
      "wake.denied": "Screen wake could not be enabled. Keep this page in the foreground.",
      "receiver.from": "From Relay",
      "receiver.linkKicker": "Using a one-time link",
      "receiver.initialTitle": "Creating a<br><em>secure connection</em>",
      "receiver.initialMessage": "Keep this page open until saved.",
      "receiver.confirm": "Received · start 20 minutes",
      "receiver.confirmHelp": "The timer starts after confirmation",
      "receiver.codePrompt": "Tell this code to the sender",
      "receiver.codeHelp": "The connection starts only after the sender confirms a match.",
      "receiver.accept": "Receive these files",
      "receiver.progress": "Receiving and verifying",
      "receiver.downloadAria": "Files ready to save",
      "pickup.eyebrow": "Relay pickup",
      "pickup.title": "Enter a pickup code",
      "pickup.message": "Name + 6 digits. Both devices stay online.",
      "pickup.label": "Pickup code",
      "pickup.placeholder": "e.g. EMMA-482731",
      "pickup.help": "4–6 letters + 6 digits · not case-sensitive",
      "pickup.submit": "Collect files",
      "pickup.back": "I want to send files",
      "pickup.footer": "Pickup codes expire automatically after 24 hours if unconfirmed",

      "task.ready": "Waiting for files",
      "task.selected": "{count} file(s) selected",
      "task.creating": "Creating entry",
      "task.waiting": "Waiting for recipient",
      "task.opened": "Waiting for confirmation",
      "task.confirmed": "Recipient confirmed",
      "task.connecting": "Connecting",
      "task.connected": "Waiting for acceptance",
      "task.transferring": "Transferring {percent}%",
      "task.received": "Received; waiting to save",
      "task.complete": "Complete",
      "task.error": "Connection problem",
      "task.default": "Send task",
      "task.closeConfirm": "Closing this task will stop the transfer and invalidate its pickup entry. Close it?",
      "task.limit": "Keep up to {count} send tasks at once",
      "task.addTitle": "Add another send task on this page",
      "task.number": "Task {number}",
      "task.closeAria": "Close task {number}",
      "task.frameTitle": "Send task {number}",
      "error.expiredWindow": "The 20-minute receiving window has ended. Ask the sender to create a new one.",
      "files.more": "{names}, and more ({count} files total)",
      "files.limit": "Choose no more than {count} files at once.",
      "files.selected": "{count} files selected",
      "files.total": "{size} · total",
      "error.channelClosed": "The connection is closed.",
      "error.invalidEncryptedMessage": "An invalid encrypted message was received.",
      "relay.notConfigured": "Relay is not configured. Same-network transfers often work, but different networks may not connect.",
      "relay.environmentDisabled": "The public relay safety switch is off. A direct same-network connection may still work.",
      "relay.manualDisabled": "The public relay was disabled by the administrator. A direct same-network connection may still work.",
      "relay.monitorMissing": "Usage protection is not configured, so the public relay remains off.",
      "relay.checkFailed": "Relay usage could not be confirmed, so public relaying was paused to prevent charges.",
      "relay.quotaReached": "The monthly relay safety limit has been reached, so public relaying is off.",
      "relay.unavailable": "The public relay is temporarily unavailable. A direct same-network connection may still work.",
      "error.relayStopped": "Public relay safety protection was triggered, so this connection stopped. Try again next month or after relaying is enabled.",
      "error.relayUsage": "Relay usage could not be confirmed. This connection stopped to prevent charges.",
      "sender.connectedKicker": "Receiving device connected",
      "sender.waitAccept": "Waiting for the recipient to accept",
      "sender.encryptedNotStarted": "The connection is encrypted; file transfer has not started",
      "error.directFailed": "A direct connection could not be established. Check the network or make sure the public relay is configured.",
      "error.disconnected": "The connection was interrupted. Please start again.",
      "error.entryExpired": "This one-time entry is no longer valid.",
      "sender.receivedKicker": "Recipient received everything",
      "sender.filesVerified": "All {count} file(s) verified",
      "sender.waitSave": "Waiting for the recipient to click save for each file. Keep this page open for now.",
      "sender.savedCount": "Recipient clicked save for {saved} / {total}",
      "sender.canClose": "You can close this page now",
      "sender.saveCaveat": "Browsers cannot read the recipient's disk status; this only confirms that every save button was clicked.",
      "error.bufferTimeout": "The send buffer timed out.",
      "sender.transferring": "Encrypting and transferring",
      "sender.transferDetail": "{count} file(s) · {size} · keep this page open",
      "sender.sentVerifying": "Everything sent; verifying",
      "sender.waitVerification": "Waiting to verify {count} file(s)",
      "sender.hashDetail": "Success appears only after every file passes SHA-256 verification.",
      "error.name": "Enter 4–6 English letters as the name.",
      "share.verifyInstruction": "The 20-minute timer starts after the recipient confirms. Then compare the six-digit code before connecting.",
      "share.autoInstruction": "The 20-minute timer starts after the recipient confirms, then the encrypted connection begins automatically.",
      "error.codeConflict": "The random pickup code collided. Click create once more.",
      "error.create": "The transfer entry could not be created. Try again shortly.",
      "sender.openedKicker": "A device opened the entry",
      "sender.waitConfirmation": "Waiting for the recipient to confirm",
      "sender.timerAfterConfirm": "The 20-minute timer starts only after the recipient confirms.",
      "sender.confirmedKicker": "Recipient confirmed receipt",
      "sender.checkCode": "Compare the verification code",
      "sender.checkCodeDetail": "Allow the connection after the codes match. The timer has started.",
      "sender.autoConnecting": "Connecting automatically",
      "sender.noExtraCode": "Extra verification was not enabled for this transfer.",
      "sender.secureConnecting": "Establishing an encrypted connection",
      "common.wait": "One moment",
      "receiver.connectedKicker": "End-to-end encrypted connection established",
      "receiver.waitMetadata": "Waiting for the sender's file details.",
      "error.keyMissing": "The file encryption key has not arrived yet.",
      "error.keyInvalid": "The received encryption key is invalid.",
      "receiver.keyReceived": "Secure key received",
      "receiver.readMetadata": "Reading file details from the sender.",
      "error.manifest": "The received file list is invalid.",
      "error.manifestSize": "The file list size does not match.",
      "receiver.incomingKicker": "The sender wants to give you {count} file(s)",
      "receiver.incomingTitle": "Review the files",
      "receiver.review": "Check the names, count, and total size before receiving. Relay never opens files automatically.",
      "receiver.fileCount": "{count} files",
      "receiver.danger": "Security notice: {count} file(s) are executable or installer files. Receive them only if you trust the sender and expect these files.",
      "receiver.receivingKicker": "Receiving encrypted files",
      "receiver.receivingTitle": "Receiving files",
      "receiver.tempStorage": "Files are written one by one to temporary browser storage. Keep this page open.",
      "error.storage": "Temporary local storage could not be prepared.",
      "error.fileInfo": "The received file details are invalid.",
      "error.fileMismatch": "The file details do not match the file list.",
      "error.cryptoParams": "The received encryption parameters are invalid.",
      "receiver.diskBuffer": "Data is being written to private browser storage and will not fill memory.",
      "receiver.memoryBuffer": "This browser is temporarily holding data in memory. Keep this page open.",
      "error.notAccepted": "The file has not been approved for receiving.",
      "error.endMarker": "The file ending marker is invalid.",
      "error.integrity": "Integrity verification failed. Do not save this file; transfer it again.",
      "receiver.allVerified": "All files received and verified",
      "receiver.intact": "Every file passed verification",
      "receiver.saveTitle": "Files are ready to save",
      "receiver.saveMessage": "Each save click updates the sender. Browsers cannot confirm whether a file was written to disk.",
      "receiver.save": "Save",
      "receiver.saved": "Clicked",
      "error.claimed": "This one-time link has already been used by another device.",
      "error.badLink": "The link is invalid, expired, or missing its security key.",
      "error.badPickupSession": "The pickup session is invalid or expired. Enter the pickup code again.",
      "receiver.entryVerified": "Pickup entry verified",
      "receiver.confirmTitle": "Confirm receipt",
      "receiver.confirmMessage": "After you click below, the sender will see your confirmation and the 20-minute receiving timer will start.",
      "receiver.timerStarted": "20-minute timer started",
      "receiver.codeTitle": "Verify the connection",
      "receiver.codeMessage": "Tell the six-digit code to the sender. The connection starts only after it matches.",
      "receiver.senderNotified": "Sender notified",
      "receiver.pairTitle": "Establishing a secure connection",
      "receiver.pairMessage": "No verification code is required. Establishing an end-to-end encrypted connection.",
      "error.confirmExpired": "This pickup entry expired. Ask the sender to create a new one.",
      "error.confirmFailed": "Unable to confirm right now. Try again shortly.",
      "receiver.senderApproved": "Sender confirmed",
      "receiver.connecting": "Establishing an end-to-end encrypted connection.",
      "error.connection": "There is a connection problem.",
      "common.copied": "Copied",
      "error.linkKey": "The link is missing its one-time security key. Ask the sender to create a new one.",
      "pickup.invalid": "Enter the complete English name and 6 digits.",
      "pickup.searching": "Looking for files",
      "pickup.notFound": "The pickup code is wrong, expired, or not yet created. Check with the sender.",
      "pickup.claimed": "These files have already been claimed by another device.",
      "pickup.rateLimited": "Too many attempts. Try again in 10 minutes.",
      "pickup.failed": "Unable to collect files right now. Try again shortly."
    }
  };

  function resolveLanguage() {
    const requested = new URLSearchParams(location.search).get("lang");
    if (requested === "zh" || requested === "en") return requested;
    const saved = localStorage.getItem("relay-language");
    if (saved === "zh" || saved === "en") return saved;
    return (navigator.languages || [navigator.language || "en"]).some(value => String(value).toLowerCase().startsWith("zh")) ? "zh" : "en";
  }

  const lang = resolveLanguage();

  function interpolate(value, variables) {
    return String(value).replace(/\{(\w+)\}/g, (_, key) => variables[key] ?? "");
  }

  function t(key, variables = {}) {
    const value = lang === "en" ? translations.en[key] : null;
    return interpolate(value || variables.zh || key, variables);
  }

  function withLang(value) {
    const url = new URL(value, location.origin);
    url.searchParams.set("lang", lang);
    return url.toString();
  }

  function applyTranslations() {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    for (const element of document.querySelectorAll("[data-i18n]")) element.textContent = t(element.dataset.i18n, { zh: element.textContent });
    for (const element of document.querySelectorAll("[data-i18n-html]")) element.innerHTML = t(element.dataset.i18nHtml, { zh: element.innerHTML });
    for (const element of document.querySelectorAll("[data-i18n-content]")) element.content = t(element.dataset.i18nContent, { zh: element.content });
    for (const element of document.querySelectorAll("[data-i18n-placeholder]")) element.placeholder = t(element.dataset.i18nPlaceholder, { zh: element.placeholder });
    for (const element of document.querySelectorAll("[data-i18n-aria]")) element.setAttribute("aria-label", t(element.dataset.i18nAria, { zh: element.getAttribute("aria-label") || "" }));
    for (const element of document.querySelectorAll("[data-i18n-alt]")) element.alt = t(element.dataset.i18nAlt, { zh: element.alt || "" });
    for (const element of document.querySelectorAll("a[data-language-link]")) element.href = withLang(element.getAttribute("href"));
    const canonical = document.querySelector('link[rel="canonical"]');
    const openGraphUrl = document.querySelector('meta[property="og:url"]');
    const openGraphLocale = document.querySelector('meta[property="og:locale"]');
    if (canonical && location.pathname === "/") canonical.href = `https://relay.xueai.pro/?lang=${lang}`;
    if (openGraphUrl) openGraphUrl.content = `https://relay.xueai.pro/?lang=${lang}`;
    if (openGraphLocale) openGraphLocale.content = lang === "zh" ? "zh_CN" : "en_US";
    const toggle = document.querySelector("#language-toggle");
    if (toggle) {
      toggle.textContent = lang === "zh" ? "English" : "中文";
      toggle.setAttribute("aria-label", t("common.languageAria", { zh: "切换语言" }));
      toggle.addEventListener("click", () => {
        const next = lang === "zh" ? "en" : "zh";
        localStorage.setItem("relay-language", next);
        const url = new URL(location.href);
        url.searchParams.set("lang", next);
        location.assign(url.toString());
      });
    }
  }

  window.RelayI18n = { lang, t, withLang, applyTranslations };
  applyTranslations();
})();
