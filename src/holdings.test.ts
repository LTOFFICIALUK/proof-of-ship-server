import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SUPPLY } from "./engine/types.js";
import { tallyVotes } from "./holdings.js";

describe("tallyVotes", () => {
  it("nets supply share and ignores a sold wallet", () => {
    const two = (DEFAULT_SUPPLY * 200n) / 10_000n;
    const one = (DEFAULT_SUPPLY * 100n) / 10_000n;
    const balances = new Map<string, bigint>([
      ["up", two],
      ["down", one],
    ]);
    const live = tallyVotes(
      [
        { wallet: "up", side: "up" },
        { wallet: "down", side: "down" },
      ],
      balances,
      DEFAULT_SUPPLY,
    );
    assert.equal(live.netPct, 1);

    balances.set("up", 0n);
    const sold = tallyVotes(
      [
        { wallet: "up", side: "up" },
        { wallet: "down", side: "down" },
      ],
      balances,
      DEFAULT_SUPPLY,
    );
    assert.equal(sold.upPct, 0);
    assert.equal(sold.netPct, -1);
  });
});
