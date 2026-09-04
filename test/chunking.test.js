const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AES_GCM_TAG_BYTES,
  SAFE_CHUNK_SIZE,
  PREFERRED_CHUNK_SIZE,
  selectChunkSize,
  isValidChunkSize
} = require("../public/chunking.js");

test("uses the preferred chunk size when the negotiated limit supports it", () => {
  assert.equal(selectChunkSize(256 * 1024), PREFERRED_CHUNK_SIZE);
  assert.equal(PREFERRED_CHUNK_SIZE + AES_GCM_TAG_BYTES, 256 * 1024);
  assert.equal(selectChunkSize(Infinity), PREFERRED_CHUNK_SIZE);
});

test("automatically steps down to a compatible preset", () => {
  assert.equal(selectChunkSize(128 * 1024), (128 * 1024) - AES_GCM_TAG_BYTES);
  assert.equal(selectChunkSize(100_000), SAFE_CHUNK_SIZE);
  assert.equal(selectChunkSize(64 * 1024), SAFE_CHUNK_SIZE);
});

test("uses the safe fallback when the browser does not expose a limit", () => {
  assert.equal(selectChunkSize(undefined), SAFE_CHUNK_SIZE);
  assert.equal(selectChunkSize(0), SAFE_CHUNK_SIZE);
});

test("respects unusually small negotiated limits", () => {
  assert.equal(selectChunkSize(20_000), 20_000 - AES_GCM_TAG_BYTES);
  assert.throws(() => selectChunkSize(8_000), /negotiated_message_size_too_small/);
});

test("validates advertised plaintext chunk sizes", () => {
  assert.equal(isValidChunkSize(SAFE_CHUNK_SIZE), true);
  assert.equal(isValidChunkSize(PREFERRED_CHUNK_SIZE), true);
  assert.equal(isValidChunkSize(PREFERRED_CHUNK_SIZE + 1), false);
  assert.equal(isValidChunkSize(8 * 1024), false);
  assert.equal(isValidChunkSize(64.5), false);
});
