import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allocateFees } from "./creator-fees.js";

describe("allocateFees", () => {
  it("gives each coin its own unspent creator fees", () => {
    const rows = allocateFees(
      [
        { mint: "posdog", earned: 32_965_398n, spent: 0n },
        { mint: "orders", earned: 20_855_602n, spent: 0n },
      ],
      53_821_000n,
    );
    const byMint = new Map(rows.map((row) => [row.mint, row.amount]));
    assert.equal(byMint.get("posdog"), 32_965_398n);
    assert.equal(byMint.get("orders"), 20_855_602n);
  });

  it("does not spend fees already assigned", () => {
    const rows = allocateFees(
      [
        { mint: "posdog", earned: 40_000n, spent: 40_000n },
        { mint: "orders", earned: 10_000n, spent: 0n },
      ],
      50_000n,
    );
    assert.deepEqual(rows, [{ mint: "orders", amount: 10_000n }]);
  });

  it("scales down when the vault holds less than the fees earned", () => {
    const rows = allocateFees(
      [
        { mint: "posdog", earned: 30n, spent: 0n },
        { mint: "orders", earned: 10n, spent: 0n },
      ],
      20n,
    );
    const total = rows.reduce((sum, row) => sum + row.amount, 0n);
    assert.equal(total, 20n);
    assert.equal(rows.find((row) => row.mint === "posdog")?.amount, 15n);
    assert.equal(rows.find((row) => row.mint === "orders")?.amount, 5n);
  });
});
