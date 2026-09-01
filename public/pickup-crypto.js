(function exposePickupCrypto(global) {
  "use strict";

  function normalizeName(value) {
    return String(value || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6);
  }

  function isValidName(value) {
    return /^[A-Z]{4,6}$/.test(normalizeName(value));
  }

  function normalizeCode(value) {
    const raw = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const name = (raw.match(/^[A-Z]{0,6}/) || [""])[0];
    const digits = raw.slice(name.length).replace(/\D/g, "").slice(0, 6);
    return `${name}${digits}`;
  }

  function isValidCode(value) {
    return /^[A-Z]{4,6}\d{6}$/.test(normalizeCode(value));
  }

  function formatCode(value) {
    const normalized = normalizeCode(value);
    const name = (normalized.match(/^[A-Z]{0,6}/) || [""])[0];
    const digits = normalized.slice(name.length);
    return digits ? `${name}-${digits}` : name;
  }

  function generateCode(name) {
    const normalized = normalizeName(name);
    if (!isValidName(normalized)) throw new Error("invalid_pickup_name");
    const random = global.crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
    return `${normalized}${String(random).padStart(6, "0")}`;
  }

  async function digest(label, code) {
    const normalized = normalizeCode(code);
    if (!isValidCode(normalized)) throw new Error("invalid_pickup_code");
    return new Uint8Array(await global.crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${label}:${normalized}`)));
  }

  async function lookupHash(code) {
    const bytes = await digest("relay-pickup-lookup-v1", code);
    return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  global.RelayPickup = {
    formatCode,
    generateCode,
    isValidCode,
    isValidName,
    lookupHash,
    normalizeCode,
    normalizeName
  };
})(window);
