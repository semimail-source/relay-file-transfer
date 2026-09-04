(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RelayTransferFlow = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULT_HIGH_WATER_MARK = 2 * 1024 * 1024;
  const DEFAULT_LOW_WATER_MARK = 512 * 1024;
  const DEFAULT_POLL_INTERVAL_MS = 200;

  function channelClosedError() {
    const error = new Error("channel_closed");
    error.code = "channel_closed";
    return error;
  }

  function waitForWritableBuffer(channel, options = {}) {
    const highWaterMark = options.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
    const lowWaterMark = Math.min(options.lowWaterMark ?? DEFAULT_LOW_WATER_MARK, highWaterMark);
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    if (!channel || channel.readyState !== "open") return Promise.reject(channelClosedError());
    if (channel.bufferedAmount <= highWaterMark) return Promise.resolve();

    return new Promise((resolve, reject) => {
      let timer = null;
      let settled = false;

      const cleanup = () => {
        if (timer !== null) clearInterval(timer);
        channel.removeEventListener?.("bufferedamountlow", check);
        channel.removeEventListener?.("close", onClose);
      };
      const finish = error => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onClose = () => finish(channelClosedError());
      function check() {
        if (channel.readyState !== "open") return finish(channelClosedError());
        if (channel.bufferedAmount <= lowWaterMark) finish();
      }

      channel.addEventListener?.("bufferedamountlow", check);
      channel.addEventListener?.("close", onClose);
      timer = setInterval(check, pollIntervalMs);

      // A browser may drain the buffer just before the listener is attached.
      // Rechecking here avoids waiting forever for an event that already fired.
      check();
    });
  }

  function createRateTracker(now = Date.now(), initialBytes = 0) {
    return { lastAt: now, lastBytes: initialBytes, bps: 0 };
  }

  function sampleRate(tracker, totalBytes, now = Date.now(), minIntervalMs = 350) {
    if (!tracker || !Number.isFinite(totalBytes) || !Number.isFinite(now)) return null;
    const elapsed = now - tracker.lastAt;
    if (elapsed < minIntervalMs) return null;

    const bytes = Math.max(0, totalBytes - tracker.lastBytes);
    const current = (bytes * 1000) / Math.max(1, elapsed);
    tracker.bps = tracker.bps > 0 ? tracker.bps * 0.65 + current * 0.35 : current;
    tracker.lastAt = now;
    tracker.lastBytes = totalBytes;
    return tracker.bps;
  }

  return {
    DEFAULT_HIGH_WATER_MARK,
    DEFAULT_LOW_WATER_MARK,
    waitForWritableBuffer,
    createRateTracker,
    sampleRate
  };
});
