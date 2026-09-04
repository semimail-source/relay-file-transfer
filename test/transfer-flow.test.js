const test = require("node:test");
const assert = require("node:assert/strict");

const {
  waitForWritableBuffer,
  createRateTracker,
  sampleRate
} = require("../public/transfer-flow.js");

function fakeChannel(bufferedAmount, readyState = "open") {
  const listeners = new Map();
  return {
    bufferedAmount,
    readyState,
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    removeEventListener(name, listener) {
      listeners.get(name)?.delete(listener);
    },
    emit(name) {
      for (const listener of listeners.get(name) || []) listener();
    }
  };
}

test("buffer wait returns immediately below the high water mark", async () => {
  await waitForWritableBuffer(fakeChannel(1024), { highWaterMark: 2048 });
});

test("buffer wait recovers when bufferedamountlow was missed", async () => {
  const channel = fakeChannel(4096);
  const waiting = waitForWritableBuffer(channel, {
    highWaterMark: 2048,
    lowWaterMark: 1024,
    pollIntervalMs: 5
  });
  setTimeout(() => { channel.bufferedAmount = 512; }, 8);
  await waiting;
});

test("buffer wait rejects when the data channel closes", async () => {
  const channel = fakeChannel(4096);
  const waiting = waitForWritableBuffer(channel, {
    highWaterMark: 2048,
    lowWaterMark: 1024,
    pollIntervalMs: 5
  });
  setTimeout(() => {
    channel.readyState = "closed";
    channel.emit("close");
  }, 5);
  await assert.rejects(waiting, /channel_closed/);
});

test("rate tracker reports bytes per second", () => {
  const tracker = createRateTracker(1000, 0);
  assert.equal(sampleRate(tracker, 1000, 1200), null);
  assert.equal(sampleRate(tracker, 2000, 2000), 2000);
});
