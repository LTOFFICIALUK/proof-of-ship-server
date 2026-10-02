import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fillPos } from "../settle.js";
import { setPosQuoter } from "../pos.js";
import {
  DEFAULT_SUPPLY,
  GRACE_MS,
  MAX_DEADLINE_MS,
  QUORUM_BPS,
  VAULT_BPS,
  VOTE_WINDOW_MS,
} from "./types.js";
import {
  abandon,
  airdrop,
  appendPromise,
  castVote,
  crank,
  createProject,
  creditFees,
  executeBuybackBurn,
  executePosBuy,
  finalizeVote,
  invariantHolds,
  lapse,
  markShipped,
} from "./vault.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const t0 = 1_700_000_000_000;

const launch = (extra?: { promises?: { text: string; deadlineMs: number }[] }) => {
  const { project } = createProject({
    mint: "Mint111111111111111111111111111111111111111",
    name: "Ship Coin",
    symbol: "SHIP",
    builderWallet: "Builder111111111111111111111111111111111111",
    xHandle: "shipdev",
    nowMs: t0,
    promises: extra?.promises ?? [
      { text: "Public demo at ship.example", deadlineMs: t0 + 3 * DAY },
    ],
    circulatingSupply: DEFAULT_SUPPLY,
    devBuyBps: 300,
  });
  return project;
};

const quorumAmount = () =>
  (DEFAULT_SUPPLY * BigInt(QUORUM_BPS)) / 10_000n;

describe("createProject", () => {
  it("rejects zero promises", () => {
    assert.throws(
      () =>
        createProject({
          mint: "m",
          name: "n",
          symbol: "n",
          builderWallet: "w",
          xHandle: "x",
          nowMs: t0,
          promises: [],
        }),
      /at least one promise/i,
    );
  });

  it("rejects a deadline past 14 days", () => {
    assert.throws(
      () =>
        launch({
          promises: [
            { text: "too late", deadlineMs: t0 + MAX_DEADLINE_MS + 1 },
          ],
        }),
      /14 days/i,
    );
  });
});

describe("fee split and invariant", () => {
  it("splits 75 15 10 and keeps the vault invariant", () => {
    const project = launch();
    creditFees(project, 10_000n, t0);
    assert.equal(project.balance, "7500");
    assert.equal(project.runwayPaid, "1500");
    assert.equal(project.platformPaid, "1000");
    assert.equal(invariantHolds(project), true);
  });
});

describe("pay vote", () => {
  it("queues 60 percent of the vault to buy POS when pay beats burn and quorum is met", () => {
    const project = launch();
    creditFees(project, 10_000n, t0);
    const voter = "Voter11111111111111111111111111111111111111";
    airdrop(project, voter, quorumAmount() + 1n);
    markShipped(project, "https://github.com/proof", "done", t0 + DAY);
    assert.equal(project.vote?.promiseIdx, 0);
    const lockedBefore = project.devLock;
    castVote(project, voter, "pay", quorumAmount() + 1n);
    crank(project, t0 + DAY + VOTE_WINDOW_MS);
    assert.equal(project.promises[0].status, "paid");
    assert.equal(project.posBucket, "4500");
    assert.equal(project.released, "0");
    assert.equal(project.balance, "3000");
    assert.equal(project.builderReceived, "0");
    assert.equal(project.devLock, ((BigInt(lockedBefore) * 8_000n) / 10_000n).toString());
    assert.equal(project.devUnlocked, ((BigInt(lockedBefore) * 2_000n) / 10_000n).toString());
    const events = executePosBuy(project, t0 + DAY + VOTE_WINDOW_MS, 9_000n);
    assert.equal(events[0]?.kind, "pos");
    assert.equal(project.posBucket, "0");
    assert.equal(project.posBought, "9000");
    assert.equal(project.released, "4500");
    assert.equal(project.builderReceived, "4500");
    assert.equal(project.balances[voter], String(quorumAmount() + 1n));
    assert.equal(invariantHolds(project), true);
  });

  it("keeps the POS bucket queued when a quote is not a swap", async () => {
    setPosQuoter(async (lamports) => lamports * 2n);
    const project = launch();
    creditFees(project, 10_000n, t0);
    const voter = "VoterPos111111111111111111111111111111111111";
    airdrop(project, voter, quorumAmount());
    markShipped(project, "https://github.com/proof", "done", t0 + DAY);
    castVote(project, voter, "pay", quorumAmount());
    finalizeVote(project, t0 + DAY + VOTE_WINDOW_MS);
    const events = await fillPos(project, t0 + DAY + VOTE_WINDOW_MS);
    assert.equal(events.length, 0);
    assert.equal(project.posBucket, "4500");
    assert.equal(project.posBought, "0");
    assert.equal(project.released, "0");
    setPosQuoter(async () => {
      throw new Error("not tradable");
    });
  });
});

describe("burn vote", () => {
  it("burns 60 percent of the vault when burn wins", () => {
    const project = launch();
    creditFees(project, 10_000n, t0);
    const voter = "Voter22222222222222222222222222222222222222";
    airdrop(project, voter, quorumAmount());
    markShipped(project, "https://github.com/proof", "done", t0 + DAY);
    castVote(project, voter, "burn", quorumAmount());
    finalizeVote(project, t0 + DAY + VOTE_WINDOW_MS);
    assert.equal(project.promises[0].status, "burned");
    assert.equal(project.burnBucket, "4500");
    assert.equal(project.balance, "3000");
    executeBuybackBurn(project, t0);
    assert.equal(project.burned, "4500");
    assert.equal(project.burnBucket, "0");
    assert.equal(invariantHolds(project), true);
  });
});

describe("quorum", () => {
  it("extends once when quorum is missed", () => {
    const project = launch();
    creditFees(project, 10_000n, t0);
    const voter = "Voter33333333333333333333333333333333333333";
    airdrop(project, voter, 1n);
    markShipped(project, "https://github.com/proof", "done", t0 + DAY);
    castVote(project, voter, "pay", 1n);
    const end = t0 + DAY + VOTE_WINDOW_MS;
    finalizeVote(project, end);
    assert.equal(project.promises[0].status, "vote_open");
    assert.equal(project.balance, "7500");
    assert.equal(project.vote?.endMs, end + 24 * HOUR);
  });

  it("rolls over when quorum is still missed", () => {
    const project = launch();
    creditFees(project, 10_000n, t0);
    const voter = "Voter44444444444444444444444444444444444444";
    airdrop(project, voter, 1n);
    markShipped(project, "https://github.com/proof", "done", t0 + DAY);
    castVote(project, voter, "pay", 1n);
    const end = t0 + DAY + VOTE_WINDOW_MS;
    finalizeVote(project, end);
    finalizeVote(project, end + 24 * HOUR);
    assert.equal(project.promises[0].status, "rolled");
    assert.equal(project.balance, "7500");
    assert.equal(project.burnBucket, "0");
  });
});

describe("lapse", () => {
  it("burns leftover vault if the next promise is not posted in 7 days", () => {
    const project = launch();
    creditFees(project, 10_000n, t0);
    const voter = "Voter55555555555555555555555555555555555555";
    airdrop(project, voter, quorumAmount());
    markShipped(project, "https://github.com/proof", "done", t0 + DAY);
    castVote(project, voter, "pay", quorumAmount());
    finalizeVote(project, t0 + DAY + VOTE_WINDOW_MS);
    creditFees(project, 10_000n, t0 + 4 * DAY);
    assert.equal(project.balance, "10500");
    const events = lapse(project, t0 + DAY + VOTE_WINDOW_MS + GRACE_MS);
    assert.equal(events[0]?.kind, "lapse");
    assert.equal(project.status, "lapsed");
    assert.equal(project.balance, "0");
    assert.equal(project.burnBucket, "10500");
  });

  it("sends new fees to burn while lapsed, then vaults again after a new promise", () => {
    const project = launch();
    const voter = "Voter66666666666666666666666666666666666666";
    airdrop(project, voter, quorumAmount());
    markShipped(project, "https://github.com/proof", "done", t0 + DAY);
    castVote(project, voter, "pay", quorumAmount());
    finalizeVote(project, t0 + DAY + VOTE_WINDOW_MS);
    lapse(project, t0 + DAY + VOTE_WINDOW_MS + GRACE_MS);
    executeBuybackBurn(project, t0);
    creditFees(project, 10_000n, t0 + 20 * DAY);
    assert.equal(project.burnBucket, "7500");
    appendPromise(
      project,
      "Next build",
      t0 + 20 * DAY + 3 * DAY,
      t0 + 20 * DAY,
    );
    assert.equal(project.status, "active");
    creditFees(project, 10_000n, t0 + 20 * DAY);
    assert.equal(project.balance, "7500");
    assert.equal(invariantHolds(project), true);
  });

  it("does not lapse if the next promise is already posted", () => {
    const project = launch();
    const voter = "Voter77777777777777777777777777777777777777";
    airdrop(project, voter, quorumAmount());
    markShipped(project, "https://github.com/proof", "done", t0 + DAY);
    castVote(project, voter, "pay", quorumAmount());
    finalizeVote(project, t0 + DAY + VOTE_WINDOW_MS);
    appendPromise(project, "second", t0 + DAY + VOTE_WINDOW_MS + 4 * DAY, t0 + DAY + VOTE_WINDOW_MS);
    assert.equal(project.nextDueAtMs, null);
    const events = lapse(project, t0 + DAY + VOTE_WINDOW_MS + GRACE_MS);
    assert.equal(events.length, 0);
    assert.equal(project.status, "active");
  });
});

describe("abandon", () => {
  it("burns remaining vault and lock", () => {
    const project = launch();
    creditFees(project, 10_000n, t0);
    abandon(project, t0);
    executeBuybackBurn(project, t0);
    assert.equal(project.status, "abandoned");
    assert.equal(project.burned, "7500");
    assert.equal(project.devLock, "0");
  });
});

describe("two rollovers", () => {
  it("burns the vault after two rollovers in a row", () => {
    const project = launch();
    creditFees(project, 10_000n, t0);
    const voter = "Roll11111111111111111111111111111111111111";
    airdrop(project, voter, 1n);
    markShipped(project, "https://github.com/proof", "done", t0 + DAY);
    castVote(project, voter, "pay", 1n);
    const end = t0 + DAY + VOTE_WINDOW_MS;
    finalizeVote(project, end);
    finalizeVote(project, end + 24 * HOUR);
    assert.equal(project.promises[0].status, "rolled");
    appendPromise(project, "again", end + 24 * HOUR + 4 * DAY, end + 24 * HOUR);
    markShipped(project, "https://github.com/proof", "done", end + 24 * HOUR + HOUR);
    castVote(project, voter, "pay", 1n);
    const end2 = end + 24 * HOUR + HOUR + VOTE_WINDOW_MS;
    finalizeVote(project, end2);
    finalizeVote(project, end2 + 24 * HOUR);
    assert.equal(project.promises[1].status, "rolled");
    assert.equal(project.balance, "0");
    assert.equal(project.burnBucket, "7500");
  });
});

describe("tie", () => {
  it("rolls the slice over when pay and burn weights are equal", () => {
    const project = launch();
    creditFees(project, 10_000n, t0);
    const a = "TiePay111111111111111111111111111111111111";
    const b = "TieBurn11111111111111111111111111111111111";
    const half = quorumAmount() / 2n;
    airdrop(project, a, half);
    airdrop(project, b, half);
    markShipped(project, "https://github.com/proof", "done", t0 + DAY);
    castVote(project, a, "pay", half);
    castVote(project, b, "burn", half);
    finalizeVote(project, t0 + DAY + VOTE_WINDOW_MS);
    assert.equal(project.promises[0].status, "rolled");
    assert.equal(project.balance, "7500");
    assert.equal(project.burnBucket, "0");
  });
});

void VAULT_BPS;
