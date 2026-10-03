import type { ProjectState, PromiseState } from "./engine/types.js";
import { loadHoldings } from "./holdings.js";
import type { HolderVoteRow } from "./store/memory.js";

const smaller = (a: bigint, b: bigint) => (a < b ? a : b);

const isExcluded = (project: ProjectState, wallet: string) =>
  wallet === project.builderWallet || Boolean(project.excludedWallets?.includes(wallet));

const checkpoint = (snapshot: Record<string, string> | undefined, wallet: string) => {
  if (!snapshot) {
    return null;
  }
  const raw = snapshot[wallet];
  return raw === undefined ? 0n : BigInt(raw);
};

export const voteWeight = (
  project: ProjectState,
  promise: PromiseState,
  wallet: string,
  current: bigint,
) => {
  if (isExcluded(project, wallet)) {
    return 0n;
  }
  let weight = current;
  for (const snapshot of [promise.postedBalances, promise.proofBalances]) {
    const value = checkpoint(snapshot, wallet);
    if (value !== null) {
      weight = smaller(weight, value);
    }
  }
  return weight > 0n ? weight : 0n;
};

export type WeighedVote = HolderVoteRow & { weight: bigint };

export const weighVotes = async (
  project: ProjectState,
  promise: PromiseState,
  votes: HolderVoteRow[],
) => {
  const excluded = [project.builderWallet, ...(project.excludedWallets ?? [])];
  const wallets = [...new Set([...votes.map((row) => row.wallet), ...excluded])];
  const holdings = await loadHoldings(project, wallets, true);
  let excludedBalance = 0n;
  for (const wallet of new Set(excluded)) {
    excludedBalance += holdings.balances.get(wallet) ?? 0n;
  }
  const eligible = holdings.supply > excludedBalance ? holdings.supply - excludedBalance : 0n;
  const rows: WeighedVote[] = votes.map((row) => ({
    ...row,
    weight: voteWeight(project, promise, row.wallet, holdings.balances.get(row.wallet) ?? 0n),
  }));
  let pay = 0n;
  let burn = 0n;
  for (const row of rows) {
    if (row.side === "down") {
      burn += row.weight;
    } else {
      pay += row.weight;
    }
  }
  return { ok: holdings.ok, rows, pay, burn, eligible };
};

export const pctOf = (amount: bigint, supply: bigint) =>
  supply > 0n ? Number((amount * 10_000n) / supply) / 100 : 0;
