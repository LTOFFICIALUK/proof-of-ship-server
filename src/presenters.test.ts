import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectState } from "./engine/types.js";
import { POS_MINT } from "./pos.js";
import { presentBurns } from "./presenters.js";
import type { FeedRow } from "./store/memory.js";

const project = {
  mint: "Mint1111111111111111111111111111111111",
  name: "Alpha",
  symbol: "ALP",
  promises: [{ idx: 0, text: "Ship the site" }],
} as ProjectState;

const projects = new Map([[project.mint, project]]);

const row = (
  id: string,
  kind: string,
  detail: FeedRow["detail"],
): FeedRow => ({
  id,
  mint: project.mint,
  kind,
  detail,
  atMs: Number(id) * 1000,
});

describe("presentBurns", () => {
  it("ties a POS buy to the holder vote and keeps the buy signature", () => {
    const burns = presentBurns(
      [
        row("2", "pos", { amount: "1000000000", sig: "buySig", pos: "2500000" }),
        row("1", "vote_burn", { idx: 0, amount: "1000000000" }),
      ],
      projects,
    );
    assert.equal(burns.length, 1);
    assert.equal(burns[0]?.reason, "Holders voted not to pay. Promise: Ship the site.");
    assert.equal(burns[0]?.amountSol, 1);
    assert.equal(burns[0]?.tokenMint, POS_MINT);
    assert.equal(burns[0]?.tokenSymbol, "POS");
    assert.equal(burns[0]?.tokens, "2500000");
    assert.equal(burns[0]?.buySig, "buySig");
    assert.equal(burns[0]?.burnSig, null);
  });

  it("keeps separate reasons for a miss burn and a vote buy", () => {
    const burns = presentBurns(
      [
        row("1", "vote_burn", { idx: 0, amount: "500" }),
        row("2", "lapse", {}),
        row("3", "burn", { amount: "900", buySig: "bought", burnSig: "burned", tokens: "10" }),
        row("4", "pos", { amount: "500", buySig: "posBuy", burnSig: "posBurn", tokens: "4" }),
      ],
      projects,
    );
    assert.deepEqual(
      burns.map((item) => item.reason),
      ["Holders voted not to pay. Promise: Ship the site.", "No new promise in 7 days."],
    );
    assert.equal(burns[0]?.tokenSymbol, "POS");
    assert.equal(burns[0]?.burnSig, "posBurn");
    assert.equal(burns[1]?.tokenSymbol, "ALP");
    assert.equal(burns[1]?.buySig, "bought");
    assert.equal(burns[1]?.burnSig, "burned");
  });

  it("ignores a rollover that did not burn, then records the second rollover", () => {
    const burns = presentBurns(
      [
        row("1", "vote_roll", { idx: 0, amount: "0" }),
        row("2", "vote_roll", { idx: 0, amount: "700" }),
        row("3", "burn", { amount: "700", sig: "swap" }),
      ],
      projects,
    );
    assert.equal(burns.length, 1);
    assert.equal(burns[0]?.reason, "Vote rolled over twice. Promise: Ship the site.");
    assert.equal(burns[0]?.buySig, "swap");
  });

  it("keeps the abandon reason on later buys", () => {
    const burns = presentBurns(
      [
        row("1", "pos", { amount: "10", sig: "early" }),
        row("2", "abandon", {}),
        row("3", "pos", { amount: "20", sig: "next" }),
        row("4", "pos", { amount: "30", sig: "later", burnSig: "laterBurn" }),
      ],
      projects,
    );
    assert.deepEqual(
      burns.map((item) => item.reason),
      ["Builder abandoned the coin.", "Builder abandoned the coin.", "Buy and burn."],
    );
    assert.equal(burns[0]?.burnSig, "laterBurn");
  });

  it("moves a queued miss onto the abandon buy", () => {
    const burns = presentBurns(
      [
        row("1", "miss", { idx: 0, amount: "40" }),
        row("2", "abandon", {}),
        row("3", "pos", { amount: "40", sig: "abandonBuy", burnSig: "abandonBurn" }),
      ],
      projects,
    );
    assert.equal(
      burns[0]?.reason,
      "Missed the deadline. Promise: Ship the site. Builder abandoned the coin.",
    );
    assert.equal(burns[0]?.burnSig, "abandonBurn");
  });
});
