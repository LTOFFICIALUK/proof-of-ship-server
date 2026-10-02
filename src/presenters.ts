import type { ProjectState } from "./engine/types.js";
import { QUORUM_BPS } from "./engine/types.js";
import type { FeedRow } from "./store/memory.js";

const lamportsToSol = (lamports: string) => Number(lamports) / 1_000_000_000;

export const coinSlug = (project: Pick<ProjectState, "symbol" | "mint">) => {
  const base = project.symbol.toLowerCase().replace(/[^a-z0-9]+/g, "") || "coin";
  return `${base}-${project.mint.slice(0, 6).toLowerCase()}`;
};

export const presentProject = (project: ProjectState, nowMs: number) => {
  const circulating = BigInt(project.circulatingSupply);
  const quorum = (circulating * BigInt(QUORUM_BPS)) / 10_000n;
  const locked = project.vote
    ? BigInt(project.vote.payWeight) + BigInt(project.vote.burnWeight)
    : 0n;
  return {
    mint: project.mint,
    slug: coinSlug(project),
    name: project.name,
    symbol: project.symbol,
    builderWallet: project.builderWallet,
    xHandle: project.xHandle,
    status: project.status,
    nowMs,
    vault: {
      accountedSol: lamportsToSol(project.accounted),
      releasedSol: lamportsToSol(project.released),
      burnedSol: lamportsToSol(project.burned),
      burnBucketSol: lamportsToSol(project.burnBucket),
      balanceSol: lamportsToSol(project.balance),
      runwaySol: lamportsToSol(project.runwayPaid),
      platformSol: lamportsToSol(project.platformPaid),
      builderReceivedSol: lamportsToSol(project.builderReceived),
      accounted: project.accounted,
      released: project.released,
      burned: project.burned,
      burnBucket: project.burnBucket,
      balance: project.balance,
    },
    devLock: project.devLock,
    nextDueAtMs: project.nextDueAtMs,
    promises: project.promises.map((item) => ({
      idx: item.idx,
      text: item.text,
      deadlineMs: item.deadlineMs,
      status: item.status,
      quorumFails: item.quorumFails,
      resultNet: item.resultNet ?? null,
      proofUrl: item.proofUrl ?? "",
      proofNote: item.proofNote ?? "",
    })),
    vote: project.vote
      ? {
          promiseIdx: project.vote.promiseIdx,
          startMs: project.vote.startMs,
          endMs: project.vote.endMs,
          payWeight: project.vote.payWeight,
          burnWeight: project.vote.burnWeight,
          locked: locked.toString(),
          quorum: quorum.toString(),
          turnoutBps: circulating === 0n ? 0 : Number((locked * 10_000n) / circulating),
        }
      : null,
  };
};

export const presentBuilder = (
  handle: string,
  wallet: string,
  projects: ProjectState[],
) => {
  const votes = projects.flatMap((project) => project.promises);
  const paid = votes.filter((item) => item.status === "paid").length;
  const burned = votes.filter((item) => item.status === "burned").length;
  const abandoned = projects.filter((project) => project.status === "abandoned").length;
  const earned = projects.reduce(
    (sum, project) => sum + BigInt(project.builderReceived),
    0n,
  );
  return {
    handle,
    wallet,
    stats: {
      paid,
      burned,
      abandoned,
      launches: projects.length,
      earnedSol: Number(earned) / 1_000_000_000,
    },
    projects: projects.map((project) => ({
      mint: project.mint,
      name: project.name,
      symbol: project.symbol,
      status: project.status,
    })),
  };
};

export const presentFeed = (rows: FeedRow[]) =>
  rows.map((row) => ({
    id: row.id,
    mint: row.mint,
    kind: row.kind,
    detail: row.detail,
    atMs: row.atMs,
  }));
