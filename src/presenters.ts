import type { ProjectState, PromiseState } from "./engine/types.js";
import { QUORUM_BPS } from "./engine/types.js";
import { POS_MINT } from "./pos.js";
import type { FeedRow, HolderVoteRow } from "./store/memory.js";

const lamportsToSol = (lamports: string) => Number(lamports) / 1_000_000_000;

export const coinSlug = (project: Pick<ProjectState, "symbol" | "mint">) => {
  const base = project.symbol.toLowerCase().replace(/[^a-z0-9]+/g, "") || "coin";
  return `${base}-${project.mint.slice(0, 6).toLowerCase()}`;
};

const CLOSED = ["paid", "burned", "missed", "rolled"];

export const currentPromise = (project: ProjectState) =>
  project.promises.find((item) => item.status === "vote_open" || item.status === "pending") ??
  project.promises[project.promises.length - 1];

export const lastClosed = (project: ProjectState) =>
  [...project.promises].reverse().find((item) => CLOSED.includes(item.status));

const presentPromise = (item: PromiseState) => ({
  idx: item.idx,
  text: item.text,
  doneLooksLike: item.doneLooksLike ?? "",
  proofType: item.proofType ?? "",
  postedAtMs: item.postedAtMs,
  deadlineMs: item.deadlineMs,
  status: item.status,
  quorumFails: item.quorumFails,
  resultNet: item.resultNet ?? null,
  proofUrl: item.proofUrl ?? "",
  proofNote: item.proofNote ?? "",
  proofAtMs: item.proofAtMs ?? null,
  closedAtMs: item.closedAtMs ?? null,
});

export const presentProject = (project: ProjectState, nowMs: number) => {
  const circulating = BigInt(project.circulatingSupply);
  const quorum = (circulating * BigInt(QUORUM_BPS)) / 10_000n;
  return {
    mint: project.mint,
    slug: coinSlug(project),
    name: project.name,
    symbol: project.symbol,
    builderWallet: project.builderWallet,
    xHandle: project.xHandle,
    verified: project.verified === true,
    demo: project.demo === true,
    status: project.status,
    nowMs,
    profile: {
      description: project.profile?.description ?? "",
      website: project.profile?.website ?? "",
      github: project.profile?.github ?? "",
      image: publicImage(project.profile?.image ?? ""),
      devBuyBps: project.profile?.devBuyBps ?? 0,
    },
    chain: {
      vault: project.chain?.vault ?? "",
      platform: project.chain?.platform ?? "",
      crank: project.chain?.crank ?? "",
      feeConfig: project.chain?.feeConfig ?? "",
      revokeSig: project.chain?.revokeSig ?? "",
    },
    rolloverStreak: project.rolloverStreak ?? 0,
    vault: {
      accountedSol: lamportsToSol(project.accounted),
      releasedSol: lamportsToSol(project.released),
      burnedSol: lamportsToSol(project.burned),
      burnBucketSol: lamportsToSol(project.burnBucket),
      balanceSol: lamportsToSol(project.balance),
      posBucketSol: lamportsToSol(project.posBucket ?? "0"),
      posBought: project.posBought ?? "0",
      posMint: POS_MINT,
      runwaySol: lamportsToSol(project.runwayPaid),
      platformSol: lamportsToSol(project.platformPaid),
      builderReceivedSol: lamportsToSol(project.builderReceived),
      accounted: project.accounted,
      released: project.released,
      burned: project.burned,
      burnBucket: project.burnBucket,
      balance: project.balance,
      posBucket: project.posBucket ?? "0",
    },
    devLock: project.devLock,
    devUnlocked: project.devUnlocked,
    nextDueAtMs: project.nextDueAtMs,
    promises: project.promises.map(presentPromise),
    vote: project.vote
      ? {
          promiseIdx: project.vote.promiseIdx,
          startMs: project.vote.startMs,
          endMs: project.vote.endMs,
          extended: project.vote.extended === true,
          quorum: quorum.toString(),
        }
      : null,
  };
};

export const publicImage = (value: string) => {
  const match = value.trim().match(/^(?:ipfs:\/+|https?:\/\/[^/]+\/ipfs\/)([1-9A-HJ-NP-Za-km-z]+)(.*)$/);
  if (!match) {
    return value;
  }
  return `https://gateway.pinata.cloud/ipfs/${match[1]}${match[2] ?? ""}`;
};

export const presentCard = (project: ProjectState) => {
  const current = currentPromise(project);
  return {
    mint: project.mint,
    slug: coinSlug(project),
    name: project.name,
    symbol: project.symbol,
    status: project.status,
    xHandle: project.xHandle,
    verified: project.verified === true,
    image: publicImage(project.profile?.image ?? ""),
    builderWallet: project.builderWallet,
    promise: current?.text ?? "",
    current: current
      ? {
          idx: current.idx,
          text: current.text,
          status: current.status,
          deadlineMs: current.deadlineMs,
          voteEndMs: project.vote?.promiseIdx === current.idx ? project.vote.endMs : null,
        }
      : null,
    record: project.promises.map((item) => item.status),
    balanceSol: lamportsToSol(project.balance),
    releasedSol: lamportsToSol(project.released),
    burnedSol: lamportsToSol(project.burned),
    launchedAtMs: project.promises[0]?.postedAtMs ?? 0,
    closedAtMs: lastClosed(project)?.closedAtMs ?? 0,
  };
};

export type CoinFilter = "voting" | "due" | "shipped" | "burned" | "all";

export const filterCoins = (projects: ProjectState[], filter: CoinFilter) => {
  const byLaunch = (a: ProjectState, b: ProjectState) =>
    (b.promises[0]?.postedAtMs ?? 0) - (a.promises[0]?.postedAtMs ?? 0);
  const byClosed = (a: ProjectState, b: ProjectState) =>
    (lastClosed(b)?.closedAtMs ?? 0) - (lastClosed(a)?.closedAtMs ?? 0);
  if (filter === "voting") {
    return projects
      .filter((project) => project.vote)
      .sort((a, b) => (a.vote?.endMs ?? 0) - (b.vote?.endMs ?? 0));
  }
  if (filter === "due") {
    return projects
      .filter((project) => !project.vote && project.promises.some((item) => item.status === "pending"))
      .sort((a, b) => (currentPromise(a)?.deadlineMs ?? 0) - (currentPromise(b)?.deadlineMs ?? 0));
  }
  if (filter === "shipped") {
    return projects.filter((project) => lastClosed(project)?.status === "paid").sort(byClosed);
  }
  if (filter === "burned") {
    return projects
      .filter((project) => ["burned", "missed"].includes(lastClosed(project)?.status ?? ""))
      .sort(byClosed);
  }
  return projects.slice().sort(byLaunch);
};

export const builderRecord = (projects: ProjectState[]) => {
  const promises = projects.flatMap((project) => project.promises);
  const count = (status: string) => promises.filter((item) => item.status === status).length;
  const shipped = count("paid");
  const missed = count("missed");
  const burned = count("burned");
  const rolled = count("rolled");
  const resolved = shipped + missed + burned + rolled;
  const onTime = promises.filter(
    (item) => CLOSED.includes(item.status) && item.proofAtMs !== undefined && item.proofAtMs <= item.deadlineMs,
  ).length;
  const sum = (pick: (project: ProjectState) => string) =>
    projects.reduce((total, project) => total + BigInt(pick(project)), 0n);
  return {
    shipped,
    missed,
    burned,
    rolled,
    resolved,
    onTimePct: resolved ? Math.round((onTime / resolved) * 100) : null,
    earnedSol: Number(sum((project) => project.builderReceived)) / 1_000_000_000,
    posBought: sum((project) => project.posBought ?? "0").toString(),
    burnedSol: Number(sum((project) => project.burned) + sum((project) => project.burnBucket)) / 1_000_000_000,
    launches: projects.length,
    abandoned: projects.filter((project) => project.status === "abandoned").length,
  };
};

export type ProfileAttention = {
  kind: "verify" | "coin";
  mint: string;
  name: string;
  symbol: string;
  text: string;
  dueMs: number | null;
};

const sideOf = (side: string) => (side === "down" || side === "burn" ? "burn" : "pay");

export const presentProfile = (
  wallet: string,
  handle: string,
  verified: boolean,
  projects: ProjectState[],
  votes: HolderVoteRow[],
  nowMs: number,
) => {
  const mine = projects.filter((project) => project.builderWallet === wallet);
  const record = builderRecord(mine);
  const sumLamports = (pick: (project: ProjectState) => string) =>
    Number(mine.reduce((total, project) => total + BigInt(pick(project) || "0"), 0n)) / 1_000_000_000;
  const sumRaw = (pick: (project: ProjectState) => string) =>
    mine.reduce((total, project) => total + BigInt(pick(project) || "0"), 0n).toString();
  const byMint = new Map(projects.map((project) => [project.mint, project]));
  const seen = new Set<string>();
  const cast: {
    mint: string;
    name: string;
    symbol: string;
    promiseIdx: number;
    text: string;
    side: "pay" | "burn";
    reason: string;
  }[] = [];
  const pushVote = (mint: string, idx: number, side: string, reason: string) => {
    const key = `${mint}:${idx}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const project = byMint.get(mint);
    cast.push({
      mint,
      name: project?.name ?? "",
      symbol: project?.symbol ?? "",
      promiseIdx: idx,
      text: project?.promises.find((item) => item.idx === idx)?.text ?? "",
      side: sideOf(side),
      reason,
    });
  };
  for (const vote of votes) {
    if (vote.wallet === wallet) {
      pushVote(vote.mint, vote.promiseIdx, vote.side, vote.reason);
    }
  }
  for (const project of projects) {
    for (const promise of project.promises) {
      const row = promise.tally?.find((item) => item.wallet === wallet);
      if (row) {
        pushVote(project.mint, promise.idx, row.side, row.reason ?? "");
      }
    }
    const lock = project.vote?.locks.find((item) => item.wallet === wallet);
    if (project.vote && lock) {
      pushVote(project.mint, project.vote.promiseIdx, lock.side, "");
    }
  }

  const attention: ProfileAttention[] = [];
  if (!verified) {
    attention.push({
      kind: "verify",
      mint: "",
      name: "",
      symbol: "",
      text: handle ? "Verify X so the tick shows on your coins." : "Verify X before you launch.",
      dueMs: null,
    });
  }
  for (const project of mine) {
    if (project.status === "lapsed") {
      attention.push({
        kind: "coin",
        mint: project.mint,
        name: project.name,
        symbol: project.symbol,
        text: "This coin lapsed. Fees buy and burn $POS.",
        dueMs: null,
      });
    }
    if (project.status === "abandoned") {
      attention.push({
        kind: "coin",
        mint: project.mint,
        name: project.name,
        symbol: project.symbol,
        text: "This coin is abandoned. The vault buys and burns $POS.",
        dueMs: null,
      });
    }
    const open = project.promises.find((item) => item.status === "pending" || item.status === "vote_open");
    if (open?.status === "pending") {
      attention.push({
        kind: "coin",
        mint: project.mint,
        name: project.name,
        symbol: project.symbol,
        text:
          open.deadlineMs < nowMs
            ? `Proof was due for "${open.text}".`
            : `Post proof for "${open.text}".`,
        dueMs: open.deadlineMs,
      });
    }
    if (open?.status === "vote_open") {
      attention.push({
        kind: "coin",
        mint: project.mint,
        name: project.name,
        symbol: project.symbol,
        text: `Holders are voting on "${open.text}".`,
        dueMs: project.vote?.endMs ?? null,
      });
    }
    if (!open && project.nextDueAtMs && project.status === "active") {
      attention.push({
        kind: "coin",
        mint: project.mint,
        name: project.name,
        symbol: project.symbol,
        text: "Post the next promise.",
        dueMs: project.nextDueAtMs,
      });
    }
  }
  attention.sort((a, b) => (a.dueMs ?? Number.MAX_SAFE_INTEGER) - (b.dueMs ?? Number.MAX_SAFE_INTEGER));

  const timeline = mine
    .flatMap((project) =>
      project.promises.map((item) => ({
        mint: project.mint,
        name: project.name,
        symbol: project.symbol,
        idx: item.idx,
        text: item.text,
        status: item.status,
        deadlineMs: item.deadlineMs,
        postedAtMs: item.postedAtMs,
        closedAtMs: item.closedAtMs ?? null,
        proofUrl: item.proofUrl ?? "",
      })),
    )
    .sort((a, b) => (b.closedAtMs ?? b.postedAtMs) - (a.closedAtMs ?? a.postedAtMs));

  return {
    wallet,
    handle,
    verified,
    nowMs,
    stats: {
      ...record,
      runwaySol: sumLamports((project) => project.runwayPaid),
      vaultSol: sumLamports((project) => project.balance),
      devLock: sumRaw((project) => project.devLock),
      devUnlocked: sumRaw((project) => project.devUnlocked),
    },
    attention,
    projects: mine
      .map((project) => ({
        ...presentCard(project),
        paidSol: lamportsToSol(project.builderReceived),
        runwaySol: lamportsToSol(project.runwayPaid),
        nextDueAtMs: project.nextDueAtMs,
      }))
      .sort((a, b) => b.launchedAtMs - a.launchedAtMs),
    timeline,
    votes: cast,
  };
};

export const presentBuilder = (
  handle: string,
  wallet: string,
  projects: ProjectState[],
) => {
  const record = builderRecord(projects);
  const timeline = projects
    .flatMap((project) =>
      project.promises.map((item) => ({
        mint: project.mint,
        name: project.name,
        symbol: project.symbol,
        idx: item.idx,
        text: item.text,
        status: item.status,
        deadlineMs: item.deadlineMs,
        postedAtMs: item.postedAtMs,
        closedAtMs: item.closedAtMs ?? null,
        proofUrl: item.proofUrl ?? "",
      })),
    )
    .sort((a, b) => (b.closedAtMs ?? b.postedAtMs) - (a.closedAtMs ?? a.postedAtMs));
  return {
    handle,
    wallet,
    verified: projects.some((project) => project.verified === true),
    stats: {
      ...record,
      paid: record.shipped,
    },
    projects: projects.map(presentCard),
    timeline,
  };
};

const FEED_GROUPS: Record<string, string[]> = {
  shipped: ["vote_pay"],
  burned: ["vote_burn", "pos", "miss", "burn", "lapse", "abandon"],
  coins: ["launch"],
  promises: ["promise", "vote_open"],
};

export const feedMatches = (kind: string, filter: string | undefined) => {
  const group = filter ? FEED_GROUPS[filter] : undefined;
  return group ? group.includes(kind) : true;
};

export const presentFeed = (rows: FeedRow[], projects: Map<string, ProjectState>) =>
  rows.map((row) => {
    const project = projects.get(row.mint);
    const raw = row.detail.amount ?? row.detail.vault;
    const idx = typeof row.detail.idx === "number" ? row.detail.idx : null;
    const sig = typeof row.detail.sig === "string" ? row.detail.sig : null;
    const slot = typeof row.detail.slot === "number" ? row.detail.slot : null;
    return {
      id: row.id,
      mint: row.mint,
      name: project?.name ?? "",
      symbol: project?.symbol ?? "",
      xHandle: project?.xHandle ?? "",
      kind: row.kind,
      promise: idx !== null ? project?.promises.find((item) => item.idx === idx)?.text ?? "" : "",
      amountSol: typeof raw === "string" && /^[0-9]+$/.test(raw) ? lamportsToSol(raw) : null,
      detail: row.detail,
      atMs: row.atMs,
      sig,
      slot,
    };
  });

export const siteStats = (projects: ProjectState[]) => {
  const promises = projects.flatMap((project) => project.promises);
  const sum = (pick: (project: ProjectState) => string) =>
    Number(projects.reduce((total, project) => total + BigInt(pick(project)), 0n)) / 1_000_000_000;
  return {
    launched: projects.length,
    lockedSol: sum((project) => project.balance),
    paidSol: sum((project) => project.released),
    burnedSol: sum((project) => project.burned) + sum((project) => project.burnBucket),
    shipped: promises.filter((item) => item.status === "paid").length,
    missed: promises.filter((item) => item.status === "missed" || item.status === "burned").length,
  };
};
