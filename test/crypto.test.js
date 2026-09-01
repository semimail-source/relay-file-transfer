const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Sha256 } = require("../public/crypto");

test("incremental SHA-256 matches Node across chunk boundaries", () => {
  const input = crypto.randomBytes(1024 * 1024 + 37);
  const hash = new Sha256();
  for (let offset = 0; offset < input.length; offset += 7919) hash.update(input.subarray(offset, offset + 7919));
  assert.equal(hash.hex(), crypto.createHash("sha256").update(input).digest("hex"));
});

test("SHA-256 handles an empty file", () => {
  assert.equal(new Sha256().hex(), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});
