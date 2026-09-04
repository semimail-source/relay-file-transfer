(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RelayChunking = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const AES_GCM_TAG_BYTES = 16;
  const MIN_CHUNK_SIZE = 16 * 1024;
  const SAFE_CHUNK_SIZE = (64 * 1024) - AES_GCM_TAG_BYTES;
  const PREFERRED_CHUNK_SIZE = (256 * 1024) - AES_GCM_TAG_BYTES;
  const CHUNK_SIZE_PRESETS = Object.freeze([
    PREFERRED_CHUNK_SIZE,
    (128 * 1024) - AES_GCM_TAG_BYTES,
    SAFE_CHUNK_SIZE
  ]);

  function selectChunkSize(maxMessageSize) {
    if (maxMessageSize === Infinity) return PREFERRED_CHUNK_SIZE;
    if (!Number.isFinite(maxMessageSize) || maxMessageSize <= AES_GCM_TAG_BYTES) return SAFE_CHUNK_SIZE;

    const availablePlaintextBytes = Math.floor(maxMessageSize) - AES_GCM_TAG_BYTES;
    for (const chunkSize of CHUNK_SIZE_PRESETS) {
      if (chunkSize <= availablePlaintextBytes) return chunkSize;
    }

    if (availablePlaintextBytes >= MIN_CHUNK_SIZE) return availablePlaintextBytes;
    throw new RangeError("negotiated_message_size_too_small");
  }

  function isValidChunkSize(chunkSize) {
    return Number.isSafeInteger(chunkSize) && chunkSize >= MIN_CHUNK_SIZE && chunkSize <= PREFERRED_CHUNK_SIZE;
  }

  return {
    AES_GCM_TAG_BYTES,
    MIN_CHUNK_SIZE,
    SAFE_CHUNK_SIZE,
    PREFERRED_CHUNK_SIZE,
    CHUNK_SIZE_PRESETS,
    selectChunkSize,
    isValidChunkSize
  };
});
