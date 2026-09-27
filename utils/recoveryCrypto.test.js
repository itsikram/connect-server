const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("crypto");
const recoveryCrypto = require("./recoveryCrypto");

const withKey = (key, fn) => {
  const previous = process.env.RECOVERY_DATA_KEY;
  if (key === undefined) delete process.env.RECOVERY_DATA_KEY;
  else process.env.RECOVERY_DATA_KEY = key;
  recoveryCrypto.resetKeyCache();
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.RECOVERY_DATA_KEY;
    else process.env.RECOVERY_DATA_KEY = previous;
    recoveryCrypto.resetKeyCache();
  }
};

test("round-trips Bangla and English text with the configured key", () => {
  withKey(crypto.randomBytes(32).toString("base64"), () => {
    const plain = "আজ খুব ইচ্ছে করছিল, but I called my brother instead.";
    const stored = recoveryCrypto.encryptText(plain);
    assert.match(stored, /^v1:/);
    assert.equal(stored.includes("ইচ্ছে"), false);
    assert.equal(recoveryCrypto.decryptText(stored), plain);
  });
});

test("uses a fresh IV so equal text never produces equal ciphertext", () => {
  withKey(crypto.randomBytes(32).toString("hex"), () => {
    assert.notEqual(recoveryCrypto.encryptText("same"), recoveryCrypto.encryptText("same"));
  });
});

test("detects tampering and returns an empty string", () => {
  withKey(crypto.randomBytes(32).toString("base64"), () => {
    const stored = recoveryCrypto.encryptText("private note");
    const parts = stored.split(":");
    const data = Buffer.from(parts[3], "base64");
    data[0] ^= 0xff;
    parts[3] = data.toString("base64");
    assert.equal(recoveryCrypto.decryptText(parts.join(":")), "");
  });
});

test("falls back to a derived key and still reads v0 values after a key is added", () => {
  const stored = withKey(undefined, () => recoveryCrypto.encryptText("dev note"));
  assert.match(stored, /^v0:/);
  withKey(crypto.randomBytes(32).toString("base64"), () => {
    assert.equal(recoveryCrypto.decryptText(stored), "dev note");
    assert.match(recoveryCrypto.encryptText("new note"), /^v1:/);
  });
});

test("handles empty values, legacy plain text and JSON", () => {
  withKey(crypto.randomBytes(32).toString("base64"), () => {
    assert.equal(recoveryCrypto.encryptText(""), "");
    assert.equal(recoveryCrypto.encryptText(null), "");
    assert.equal(recoveryCrypto.decryptText(""), "");
    assert.equal(recoveryCrypto.decryptText("legacy plain text"), "legacy plain text");
    const plan = { ifThen: [{ trigger: "stress", action: "breathe" }] };
    assert.deepEqual(recoveryCrypto.decryptJson(recoveryCrypto.encryptJson(plan)), plan);
    assert.equal(recoveryCrypto.decryptJson("", "fallback"), "fallback");
  });
});
