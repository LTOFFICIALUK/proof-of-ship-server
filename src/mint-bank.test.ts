import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claimMint, depositMint, mintEndsWithPos, readyCount, useMemoryMintBank } from "./mint-bank.js";
import { MINT_SUFFIX } from "./wallets.js";

describe("mint bank", () => {
  it("only accepts addresses that end in PoS", async () => {
    useMemoryMintBank();
    await assert.rejects(
      () => depositMint({ publicKey: "NotAVanityMint111111111111111111111111111", secretKey: "x" }),
      /PoS/,
    );
  });

  it("hands out a ready mint instantly", async () => {
    useMemoryMintBank();
    const key = {
      publicKey: "TestMintBankAddress111111111111111111111PoS",
      secretKey: "test-secret",
    };
    await depositMint(key);
    const before = await readyCount();
    const claimed = await claimMint();
    assert.equal(claimed.publicKey, key.publicKey);
    assert.equal(mintEndsWithPos(claimed.publicKey), true);
    assert.equal(claimed.publicKey.endsWith(MINT_SUFFIX), true);
    assert.equal(await readyCount(), before - 1);
  });
});
