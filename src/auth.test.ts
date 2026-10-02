import assert from "node:assert/strict";
import { describe, it } from "node:test";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { parseSignIn, signInMessage, simpleSignInMessage, verifySignIn } from "./auth.js";

const pair = () => {
  const keys = nacl.sign.keyPair();
  return { publicKey: bs58.encode(keys.publicKey), secretKey: keys.secretKey };
};

const sign = (message: string, secretKey: Uint8Array) =>
  Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), secretKey)).toString("base64");

describe("sign in messages", () => {
  it("parses SIWS from localhost and the live host", () => {
    const wallet = "11111111111111111111111111111111";
    const issued = new Date().toISOString();
    const live = signInMessage(wallet, "abc", issued);
    const local = signInMessage(wallet, "abc", issued, "localhost:3456", "http://localhost:3456");
    assert.equal(parseSignIn(live)?.wallet, wallet);
    assert.equal(parseSignIn(live)?.nonce, "abc");
    assert.equal(parseSignIn(local)?.nonce, "abc");
    assert.match(local, /^localhost:3456 wants you to sign in/);
  });

  it("parses the plain fallback and verifies a signature", () => {
    const keys = pair();
    const issued = new Date().toISOString();
    const message = simpleSignInMessage(keys.publicKey, "nonce1", issued);
    assert.equal(parseSignIn(message)?.nonce, "nonce1");
    const verified = verifySignIn(message, sign(message, keys.secretKey));
    assert.equal(verified?.wallet, keys.publicKey);
  });

  it("still reads the old Issued line", () => {
    const wallet = "11111111111111111111111111111111";
    const message = `proofofship.fun wants you to sign in with your Solana account:\n${wallet}\n\nNonce: zzz\nIssued: 2026-10-02T21:00:00.000Z`;
    assert.equal(parseSignIn(message)?.nonce, "zzz");
  });
});
