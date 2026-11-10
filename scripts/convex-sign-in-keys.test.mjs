import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { test } from "node:test";
import { signInKeys } from "./convex-sign-in-keys.mjs";

test("creates a matching key pair in the form Convex Auth stores", () => {
  const keys = signInKeys();
  assert.ok(!keys.JWT_PRIVATE_KEY.includes("\n"));
  assert.match(keys.JWT_PRIVATE_KEY, /^-----BEGIN PRIVATE KEY----- .+ -----END PRIVATE KEY-----$/u);
  const jwks = JSON.parse(keys.JWKS);
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0].use, "sig");
  assert.equal(jwks.keys[0].kty, "RSA");
  const pem = keys.JWT_PRIVATE_KEY.replace(/ (?!(PRIVATE|KEY))/gu, "\n");
  const signature = sign("sha256", Buffer.from("leaflogue"), createPrivateKey(pem));
  assert.ok(verify("sha256", Buffer.from("leaflogue"), createPublicKey({ key: jwks.keys[0], format: "jwk" }), signature));
});
