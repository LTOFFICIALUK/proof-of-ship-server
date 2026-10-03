import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectState } from "./engine/types.js";
import { presentProfile } from "./presenters.js";
import type { HolderVoteRow } from "./store/memory.js";

const now = 1_800_000_000_000;
const wallet = "Builder11111111111111111111111111111111";

const project = (patch: Partial<ProjectState> = {}): ProjectState => ({
  mint: "Mint1111111111111111111111111111111111",
  name: "Alpha",
  symbol: "ALPH",
  builderWallet: wallet,
  xHandle: "ada",
  status: "active",
  circulatingSupply: "1000000000000000",
  accounted: "0",
  released: "0",
  burned: "0",
  burnBucket: "0",
  balance: "2000000000",
  posBucket: "0",
  posBought: "0",
  runwayPaid: "1000000000",
  platformPaid: "0",
  builderReceived: "5000000000",
  devLock: "1000000",
  devUnlocked: "0",
  nextDueAtMs: null,
  promises: [
    {
      idx: 0,
      text: "Ship the app",
      textHash: "x",
      deadlineMs: now + 86_400_000,
      postedAtMs: now,
      status: "pending",
      quorumFails: 0,
    },
  ],
  vote: null,
  balances: {},
  ...patch,
});

describe("presentProfile", () => {
  it("sums earnings and lists the open promise", () => {
    const profile = presentProfile(wallet, "ada", true, [project()], [], now);
    assert.equal(profile.stats.earnedSol, 5);
    assert.equal(profile.stats.runwaySol, 1);
    assert.equal(profile.stats.vaultSol, 2);
    assert.equal(profile.stats.launches, 1);
    assert.equal(profile.attention[0]?.text, 'Post proof for "Ship the app".');
    assert.equal(profile.projects[0]?.paidSol, 5);
    assert.equal(profile.timeline[0]?.text, "Ship the app");
  });

  it("includes holder votes from the vote table and from a tally", () => {
    const other = project({
      mint: "Mint2222222222222222222222222222222222",
      name: "Beta",
      symbol: "BETA",
      builderWallet: "Holder22222222222222222222222222222222",
      promises: [
        {
          idx: 1,
          text: "Publish the audit",
          textHash: "y",
          deadlineMs: now,
          postedAtMs: now,
          status: "paid",
          quorumFails: 0,
          tally: [
            {
              wallet,
              side: "burn",
              weight: "1",
              reason: "Late",
              message: "",
              signature: "",
            },
          ],
        },
      ],
    });
    const stored: HolderVoteRow = {
      mint: other.mint,
      promiseIdx: 1,
      wallet,
      side: "down",
      reason: "Late",
      message: "",
      signature: "",
    };
    const profile = presentProfile(wallet, "", false, [project(), other], [stored], now);
    assert.equal(profile.votes.length, 1);
    assert.equal(profile.votes[0]?.side, "burn");
    assert.equal(profile.votes[0]?.text, "Publish the audit");
    assert.equal(profile.attention.some((item) => item.kind === "verify"), true);
  });
});
