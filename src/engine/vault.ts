import { createHash } from "node:crypto";
import {
  BPS_DENOM,
  DEFAULT_SUPPLY,
  DEV_LOCK_STEP_BPS,
  EngineError,
  GRACE_MS,
  MAX_DEADLINE_MS,
  MAX_DEV_BUY_BPS,
  MAX_PROMISES,
  PLATFORM_BPS,
  QUORUM_BPS,
  RUNWAY_BPS,
  VAULT_BPS,
  VOTE_WINDOW_MS,
  type FeedKind,
  type ProjectState,
  type PromiseState,
  type VoteSide,
} from "./types.js";

export type EngineEvent = {
  kind: FeedKind;
  atMs: number;
  mint: string;
  detail: Record<string, string | number | boolean>;
};

const n = (value: string) => BigInt(value);
const s = (value: bigint) => value.toString();

export const hashPromise = (text: string) =>
  createHash("sha256").update(text.trim()).digest("hex");

export const invariantHolds = (project: ProjectState) => {
  const left =
    n(project.released) +
    n(project.burned) +
    n(project.burnBucket) +
    n(project.balance);
  return left === n(project.accounted);
};

const assertInvariant = (project: ProjectState) => {
  if (!invariantHolds(project)) {
    throw new EngineError(
      "INVARIANT",
      "released + burned + burn bucket + balance must equal inflow",
    );
  }
};

const walletBalance = (project: ProjectState, wallet: string) =>
  n(project.balances[wallet] ?? "0");

const setBalance = (project: ProjectState, wallet: string, amount: bigint) => {
  if (amount === 0n) {
    delete project.balances[wallet];
    return;
  }
  project.balances[wallet] = s(amount);
};

const lastPromise = (project: ProjectState) =>
  project.promises[project.promises.length - 1];

const queuedAfter = (project: ProjectState, idx: number) =>
  project.promises.some(
    (item) => item.idx > idx && item.status === "pending",
  );

const stepDevLock = (project: ProjectState, burn: boolean) => {
  const remaining = n(project.devLock);
  const step = (remaining * BigInt(DEV_LOCK_STEP_BPS)) / BigInt(BPS_DENOM);
  project.devLock = s(remaining - step);
  if (burn) {
    return;
  }
  project.devUnlocked = s(n(project.devUnlocked) + step);
};

export const createProject = (input: {
  mint: string;
  name: string;
  symbol: string;
  builderWallet: string;
  xHandle: string;
  nowMs: number;
  promises: { text: string; deadlineMs: number }[];
  circulatingSupply?: bigint;
  devBuyBps?: number;
}): { project: ProjectState; events: EngineEvent[] } => {
  if (input.promises.length < 1) {
    throw new EngineError("NO_PROMISE", "Launch needs at least one promise");
  }
  if (input.promises.length > MAX_PROMISES) {
    throw new EngineError("TOO_MANY", "At most 20 promises can be queued");
  }

  const supply = input.circulatingSupply ?? DEFAULT_SUPPLY;
  const devBps = input.devBuyBps ?? 0;
  if (devBps < 0 || devBps > MAX_DEV_BUY_BPS) {
    throw new EngineError("DEV_BUY", "Dev buy can be at most 3 percent");
  }

  const promises: PromiseState[] = [];
  let previousDeadline = 0;
  for (let i = 0; i < input.promises.length; i += 1) {
    const raw = input.promises[i];
    const text = raw.text.trim();
    if (!text) {
      throw new EngineError("EMPTY_PROMISE", "A promise cannot be empty");
    }
    if (raw.deadlineMs <= input.nowMs) {
      throw new EngineError("DEADLINE", "Deadline must be in the future");
    }
    if (raw.deadlineMs > input.nowMs + MAX_DEADLINE_MS) {
      throw new EngineError(
        "DEADLINE",
        "Deadline must be within 14 days of posting",
      );
    }
    if (raw.deadlineMs <= previousDeadline) {
      throw new EngineError(
        "DEADLINE",
        "Each deadline must be after the previous one",
      );
    }
    previousDeadline = raw.deadlineMs;
    promises.push({
      idx: i,
      text,
      textHash: hashPromise(text),
      deadlineMs: raw.deadlineMs,
      postedAtMs: input.nowMs,
      status: "pending",
      quorumFails: 0,
    });
  }

  const devLock = (supply * BigInt(devBps)) / BigInt(BPS_DENOM);
  const builderFree = 0n;
  const project: ProjectState = {
    mint: input.mint,
    name: input.name.trim(),
    symbol: input.symbol.trim().toUpperCase(),
    builderWallet: input.builderWallet,
    xHandle: input.xHandle.replace(/^@/, "").toLowerCase(),
    status: "active",
    circulatingSupply: s(supply),
    accounted: "0",
    released: "0",
    burned: "0",
    burnBucket: "0",
    balance: "0",
    runwayPaid: "0",
    platformPaid: "0",
    builderReceived: "0",
    devLock: s(devLock),
    devUnlocked: s(builderFree),
    nextDueAtMs: null,
    promises,
    vote: null,
    balances: {},
  };

  if (devLock > 0n) {
    setBalance(project, input.builderWallet, 0n);
  }

  return {
    project,
    events: [
      {
        kind: "launch",
        atMs: input.nowMs,
        mint: project.mint,
        detail: { symbol: project.symbol, promises: promises.length },
      },
    ],
  };
};

export const creditFees = (
  project: ProjectState,
  creatorLamports: bigint,
  nowMs: number,
): EngineEvent[] => {
  if (project.status === "abandoned") {
    throw new EngineError("ABANDONED", "This project was abandoned");
  }
  if (creatorLamports <= 0n) {
    throw new EngineError("FEES", "Fee amount must be greater than zero");
  }

  const vaultShare =
    (creatorLamports * BigInt(VAULT_BPS)) / BigInt(BPS_DENOM);
  const runwayShare =
    (creatorLamports * BigInt(RUNWAY_BPS)) / BigInt(BPS_DENOM);
  const platformShare = creatorLamports - vaultShare - runwayShare;

  project.runwayPaid = s(n(project.runwayPaid) + runwayShare);
  project.platformPaid = s(n(project.platformPaid) + platformShare);
  project.accounted = s(n(project.accounted) + vaultShare);

  if (project.status === "lapsed") {
    project.burnBucket = s(n(project.burnBucket) + vaultShare);
  } else {
    project.balance = s(n(project.balance) + vaultShare);
  }

  assertInvariant(project);
  return [
    {
      kind: "inflow",
      atMs: nowMs,
      mint: project.mint,
      detail: {
        vault: s(vaultShare),
        runway: s(runwayShare),
        platform: s(platformShare),
        lapsed: project.status === "lapsed",
      },
    },
  ];
};

export const airdrop = (
  project: ProjectState,
  wallet: string,
  amount: bigint,
) => {
  if (amount <= 0n) {
    throw new EngineError("AIRDROP", "Airdrop must be greater than zero");
  }
  setBalance(project, wallet, walletBalance(project, wallet) + amount);
};

export const appendPromise = (
  project: ProjectState,
  text: string,
  deadlineMs: number,
  nowMs: number,
): EngineEvent[] => {
  if (project.status === "abandoned") {
    throw new EngineError("ABANDONED", "Abandoned projects cannot add promises");
  }
  if (project.promises.length >= MAX_PROMISES) {
    throw new EngineError("TOO_MANY", "At most 20 promises can be queued");
  }
  const trimmed = text.trim();
  if (!trimmed) {
    throw new EngineError("EMPTY_PROMISE", "A promise cannot be empty");
  }
  if (deadlineMs <= nowMs) {
    throw new EngineError("DEADLINE", "Deadline must be in the future");
  }
  if (deadlineMs > nowMs + MAX_DEADLINE_MS) {
    throw new EngineError(
      "DEADLINE",
      "Deadline must be within 14 days of posting",
    );
  }
  const previous = lastPromise(project);
  if (deadlineMs <= previous.deadlineMs) {
    throw new EngineError(
      "DEADLINE",
      "Each deadline must be after the previous one",
    );
  }

  const idx = previous.idx + 1;
  project.promises.push({
    idx,
    text: trimmed,
    textHash: hashPromise(trimmed),
    deadlineMs,
    postedAtMs: nowMs,
    status: "pending",
    quorumFails: 0,
  });

  if (project.status === "lapsed") {
    project.status = "active";
    project.nextDueAtMs = null;
  } else if (project.nextDueAtMs) {
    project.nextDueAtMs = null;
  }

  return [
    {
      kind: "promise",
      atMs: nowMs,
      mint: project.mint,
      detail: { idx, text: trimmed },
    },
  ];
};

export const openVote = (
  project: ProjectState,
  nowMs: number,
): EngineEvent[] => {
  if (project.status !== "active") {
    return [];
  }
  if (project.vote) {
    return [];
  }
  const next = project.promises.find(
    (item) =>
      (item.status === "pending" || item.status === "no_quorum") &&
      nowMs >= item.deadlineMs,
  );
  if (!next) {
    return [];
  }

  next.status = "vote_open";
  project.vote = {
    promiseIdx: next.idx,
    startMs: nowMs,
    endMs: nowMs + VOTE_WINDOW_MS,
    payWeight: "0",
    burnWeight: "0",
    locks: [],
  };

  return [
    {
      kind: "vote_open",
      atMs: nowMs,
      mint: project.mint,
      detail: { idx: next.idx },
    },
  ];
};

export const castVote = (
  project: ProjectState,
  wallet: string,
  side: VoteSide,
  amount: bigint,
) => {
  if (!project.vote) {
    throw new EngineError("NO_VOTE", "No vote is open");
  }
  if (amount <= 0n) {
    throw new EngineError("VOTE", "Vote amount must be greater than zero");
  }
  const available = walletBalance(project, wallet);
  if (amount > available) {
    throw new EngineError("VOTE", "Not enough coins to lock");
  }
  if (project.vote.locks.some((lock) => lock.wallet === wallet)) {
    throw new EngineError("VOTE", "This wallet already voted");
  }

  setBalance(project, wallet, available - amount);
  project.vote.locks.push({ wallet, amount: s(amount), side });
  if (side === "pay") {
    project.vote.payWeight = s(n(project.vote.payWeight) + amount);
  } else {
    project.vote.burnWeight = s(n(project.vote.burnWeight) + amount);
  }
};

const unlockVotes = (project: ProjectState) => {
  const vote = project.vote;
  if (!vote) {
    return;
  }
  for (const lock of vote.locks) {
    setBalance(
      project,
      lock.wallet,
      walletBalance(project, lock.wallet) + n(lock.amount),
    );
  }
};

const settleBurn = (project: ProjectState) => {
  const amount = n(project.balance);
  project.burnBucket = s(n(project.burnBucket) + amount);
  project.balance = "0";
  stepDevLock(project, true);
};

const settlePay = (project: ProjectState) => {
  const amount = n(project.balance);
  project.released = s(n(project.released) + amount);
  project.builderReceived = s(n(project.builderReceived) + amount);
  project.balance = "0";
  stepDevLock(project, false);
};

const afterVote = (project: ProjectState, promiseIdx: number, nowMs: number) => {
  project.vote = null;
  if (queuedAfter(project, promiseIdx)) {
    project.nextDueAtMs = null;
    return;
  }
  project.nextDueAtMs = nowMs + GRACE_MS;
};

export const finalizeVote = (
  project: ProjectState,
  nowMs: number,
): EngineEvent[] => {
  const vote = project.vote;
  if (!vote) {
    return [];
  }
  if (nowMs < vote.endMs) {
    throw new EngineError("VOTE", "The vote window is still open");
  }

  const promise = project.promises.find((item) => item.idx === vote.promiseIdx);
  if (!promise) {
    throw new EngineError("VOTE", "Missing promise for this vote");
  }

  const locked = n(vote.payWeight) + n(vote.burnWeight);
  const quorum =
    (n(project.circulatingSupply) * BigInt(QUORUM_BPS)) / BigInt(BPS_DENOM);

  unlockVotes(project);

  if (locked < quorum) {
    promise.quorumFails += 1;
    if (promise.quorumFails < 2) {
      promise.status = "no_quorum";
      project.vote = null;
      return [
        {
          kind: "no_quorum",
          atMs: nowMs,
          mint: project.mint,
          detail: { idx: promise.idx, retry: true },
        },
      ];
    }
    promise.status = "burned";
    settleBurn(project);
    afterVote(project, promise.idx, nowMs);
    assertInvariant(project);
    return [
      {
        kind: "vote_burn",
        atMs: nowMs,
        mint: project.mint,
        detail: { idx: promise.idx, reason: "no_quorum" },
      },
    ];
  }

  const pay = n(vote.payWeight);
  const burn = n(vote.burnWeight);
  const isPay = pay > burn;
  if (isPay) {
    promise.status = "paid";
    settlePay(project);
  } else {
    promise.status = "burned";
    settleBurn(project);
  }
  afterVote(project, promise.idx, nowMs);
  assertInvariant(project);
  return [
    {
      kind: isPay ? "vote_pay" : "vote_burn",
      atMs: nowMs,
      mint: project.mint,
      detail: {
        idx: promise.idx,
        pay: s(pay),
        burn: s(burn),
        tie: pay === burn,
      },
    },
  ];
};

export const finalizeFromNet = (
  project: ProjectState,
  nowMs: number,
  payWins: boolean,
): EngineEvent[] => {
  const vote = project.vote;
  if (!vote || nowMs < vote.endMs) {
    return [];
  }
  const promise = project.promises.find((item) => item.idx === vote.promiseIdx);
  if (!promise) {
    throw new EngineError("VOTE", "Missing promise for this vote");
  }
  unlockVotes(project);
  if (payWins) {
    promise.status = "paid";
    settlePay(project);
  } else {
    promise.status = "burned";
    settleBurn(project);
  }
  afterVote(project, promise.idx, nowMs);
  assertInvariant(project);
  return [
    {
      kind: payWins ? "vote_pay" : "vote_burn",
      atMs: nowMs,
      mint: project.mint,
      detail: { idx: promise.idx, net: payWins ? "up" : "down" },
    },
  ];
};

export const executeBuybackBurn = (
  project: ProjectState,
  nowMs: number,
): EngineEvent[] => {
  const amount = n(project.burnBucket);
  if (amount === 0n) {
    return [];
  }
  project.burned = s(n(project.burned) + amount);
  project.burnBucket = "0";
  assertInvariant(project);
  return [
    {
      kind: "burn",
      atMs: nowMs,
      mint: project.mint,
      detail: { amount: s(amount) },
    },
  ];
};

export const lapse = (project: ProjectState, nowMs: number): EngineEvent[] => {
  if (project.status !== "active") {
    return [];
  }
  if (project.vote) {
    return [];
  }
  if (!project.nextDueAtMs || nowMs < project.nextDueAtMs) {
    return [];
  }
  const last = lastPromise(project);
  if (queuedAfter(project, last.idx)) {
    return [];
  }
  if (last.status === "pending" || last.status === "vote_open" || last.status === "no_quorum") {
    return [];
  }

  project.status = "lapsed";
  project.burnBucket = s(n(project.burnBucket) + n(project.balance));
  project.balance = "0";
  project.devLock = "0";
  assertInvariant(project);
  return [
    {
      kind: "lapse",
      atMs: nowMs,
      mint: project.mint,
      detail: {},
    },
  ];
};

export const abandon = (project: ProjectState, nowMs: number): EngineEvent[] => {
  if (project.status === "abandoned") {
    throw new EngineError("ABANDONED", "Already abandoned");
  }
  unlockVotes(project);
  project.vote = null;
  project.status = "abandoned";
  project.nextDueAtMs = null;
  project.burnBucket = s(n(project.burnBucket) + n(project.balance));
  project.balance = "0";
  project.devLock = "0";
  assertInvariant(project);
  return [
    {
      kind: "abandon",
      atMs: nowMs,
      mint: project.mint,
      detail: {},
    },
  ];
};

export const crank = (project: ProjectState, nowMs: number): EngineEvent[] => {
  const events: EngineEvent[] = [];
  events.push(...openVote(project, nowMs));
  if (project.vote && nowMs >= project.vote.endMs) {
    events.push(...finalizeVote(project, nowMs));
  }
  events.push(...lapse(project, nowMs));
  events.push(...executeBuybackBurn(project, nowMs));
  return events;
};
