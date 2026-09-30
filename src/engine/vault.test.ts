import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
  finalizeVote,
  invariantHolds,
  lapse,
  openVote,
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
  it("pays the full unallocated vault when pay beats burn and quorum is met", () => {
    const project = launch();
    creditFees(project, 10_000n, t0);
    const voter = "Voter11111111111111111111111111111111111111";
    airdrop(project, voter, quorumAmount() + 1n);
    crank(project, t0 + 3 * DAY);
    assert.equal(project.vote?.promiseIdx, 0);
    castVote(project, voter, "pay", quorumAmount() + 1n);
    crank(project, t0 + 3 * DAY + VOTE_WINDOW_MS);
    assert.equal(project.promises[0].status, "paid");
    assert.equal(project.released, "7500");
    assert.equal(project.balance, "0");
    assert.equal(project.builderReceived, "7500");
    assert.equal(project.balances[voter], String(quorumAmount() + 1n));
    assert.equal(invariantHolds(project), true);
  });
});

describe("burn vote", () => {
  it("moves the vault to the burn bucket when burn wins or ties", () => {
    const project = launch();
    creditFees(project, 10_000n, t0);
    const voter = "Voter22222222222222222222222222222222222222";
    airdrop(project, voter, quorumAmount());
    openVote(project, t0 + 3 * DAY);
    castVote(project, voter, "burn", quorumAmount());
    finalizeVote(project, t0 + 3 * DAY + VOTE_WINDOW_MS);
    assert.equal(project.promises[0].status, "burned");
    assert.equal(project.burnBucket, "7500");
    executeBuybackBurn(project, t0);
    assert.equal(project.burned, "7500");
    assert.equal(project.burnBucket, "0");
    assert.equal(invariantHolds(project), true);
  });
});

describe("quorum", () => {
  it("does not pay on the first failed quorum", () => {
    const project = launch();
    creditFees(project, 10_000n, t0);
    const voter = "Voter33333333333333333333333333333333333333";
    airdrop(project, voter, 1n);
    openVote(project, t0 + 3 * DAY);
    castVote(project, voter, "pay", 1n);
    finalizeVote(project, t0 + 3 * DAY + VOTE_WINDOW_MS);
    assert.equal(project.promises[0].status, "no_quorum");
    assert.equal(project.balance, "7500");
    assert.equal(project.released, "0");
  });

  it("burns on the second failed quorum", () => {
    const project = launch();
    creditFees(project, 10_000n, t0);
    const voter = "Voter44444444444444444444444444444444444444";
    airdrop(project, voter, 1n);
    openVote(project, t0 + 3 * DAY);
    castVote(project, voter, "pay", 1n);
    finalizeVote(project, t0 + 3 * DAY + VOTE_WINDOW_MS);
    openVote(project, t0 + 3 * DAY + VOTE_WINDOW_MS + 1);
    castVote(project, voter, "pay", 1n);
    finalizeVote(project, t0 + 3 * DAY + 2 * VOTE_WINDOW_MS + 1);
    assert.equal(project.promises[0].status, "burned");
    assert.equal(project.burnBucket, "7500");
  });
});

describe("lapse", () => {
  it("burns leftover vault if the next promise is not posted in 7 days", () => {
    const project = launch();
    creditFees(project, 10_000n, t0);
    const voter = "Voter55555555555555555555555555555555555555";
    airdrop(project, voter, quorumAmount());
    openVote(project, t0 + 3 * DAY);
    castVote(project, voter, "pay", quorumAmount());
    finalizeVote(project, t0 + 3 * DAY + VOTE_WINDOW_MS);
    creditFees(project, 10_000n, t0 + 4 * DAY);
    assert.equal(project.balance, "7500");
    const events = lapse(project, t0 + 3 * DAY + VOTE_WINDOW_MS + GRACE_MS);
    assert.equal(events[0]?.kind, "lapse");
    assert.equal(project.status, "lapsed");
    assert.equal(project.balance, "0");
    assert.equal(project.burnBucket, "7500");
  });

  it("sends new fees to burn while lapsed, then vaults again after a new promise", () => {
    const project = launch();
    const voter = "Voter66666666666666666666666666666666666666";
    airdrop(project, voter, quorumAmount());
    openVote(project, t0 + 3 * DAY);
    castVote(project, voter, "pay", quorumAmount());
    finalizeVote(project, t0 + 3 * DAY + VOTE_WINDOW_MS);
    lapse(project, t0 + 3 * DAY + VOTE_WINDOW_MS + GRACE_MS);
    executeBuybackBurn(project, t0);
    creditFees(project, 10_000n, t0 + 20 * DAY);
    assert.equal(project.burnBucket, "7500");
    appendPromise(
      project,
      "Next build",
      t0 + 20 * DAY + 2 * DAY,
      t0 + 20 * DAY,
    );
    assert.equal(project.status, "active");
    creditFees(project, 10_000n, t0 + 20 * DAY);
    assert.equal(project.balance, "7500");
    assert.equal(invariantHolds(project), true);
  });

  it("does not lapse if the next promise is already queued", () => {
    const project = launch({
      promises: [
        { text: "first", deadlineMs: t0 + 2 * DAY },
        { text: "second", deadlineMs: t0 + 8 * DAY },
      ],
    });
    const voter = "Voter77777777777777777777777777777777777777";
    airdrop(project, voter, quorumAmount());
    openVote(project, t0 + 2 * DAY);
    castVote(project, voter, "pay", quorumAmount());
    finalizeVote(project, t0 + 2 * DAY + VOTE_WINDOW_MS);
    assert.equal(project.nextDueAtMs, null);
    const events = lapse(project, t0 + 2 * DAY + VOTE_WINDOW_MS + GRACE_MS);
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

describe("tie", () => {
  it("burns when pay and burn weights are equal", () => {
    const project = launch();
    creditFees(project, 10_000n, t0);
    const a = "TiePay111111111111111111111111111111111111";
    const b = "TieBurn11111111111111111111111111111111111";
    const half = quorumAmount() / 2n;
    airdrop(project, a, half);
    airdrop(project, b, half);
    openVote(project, t0 + 3 * DAY);
    castVote(project, a, "pay", half);
    castVote(project, b, "burn", half);
    finalizeVote(project, t0 + 3 * DAY + VOTE_WINDOW_MS);
    assert.equal(project.promises[0].status, "burned");
    assert.equal(project.burnBucket, "7500");
  });
});

void VAULT_BPS;
