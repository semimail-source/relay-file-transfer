const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { webcrypto } = require("node:crypto");
const vm = require("node:vm");

const window = { crypto: webcrypto };
const context = vm.createContext({ TextEncoder, Uint32Array, window });
vm.runInContext(readFileSync(require.resolve("../public/pickup-crypto.js"), "utf8"), context);
const pickup = window.RelayPickup;

test("generates a six-digit suffix for a valid English name", () => {
  const code = pickup.generateCode("Emma");
  assert.match(code, /^EMMA\d{6}$/);
  assert.equal(pickup.isValidCode(code), true);
  assert.match(pickup.formatCode(code), /^EMMA-\d{6}$/);
});

test("normalizes pickup codes without case or separator sensitivity", async () => {
  assert.equal(pickup.normalizeName("em-ma!"), "EMMA");
  assert.equal(pickup.isValidName("Emma"), true);
  assert.equal(pickup.isValidName("Amy"), false);
  assert.equal(pickup.normalizeCode("emma-482731"), "EMMA482731");
  assert.equal(pickup.formatCode("emma482731"), "EMMA-482731");
  assert.equal(await pickup.lookupHash("emma-482731"), await pickup.lookupHash("EMMA482731"));
});
