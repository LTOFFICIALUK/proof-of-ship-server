import type { ProjectState } from "./engine/types.js";
import type { HolderVoteRow } from "./store/memory.js";

export type Tally = {
  upPct: number;
  downPct: number;
  netPct: number;
};

const pct = (amount: bigint, supply: bigint) => {
  if (supply <= 0n) {
    return 0;
  }
  return Number((amount * 10_000n) / supply) / 100;
};

export const tallyVotes = (
  votes: Pick<HolderVoteRow, "wallet" | "side">[],
  balances: Map<string, bigint>,
  supply: bigint,
): Tally => {
  let up = 0n;
  let down = 0n;
  for (const vote of votes) {
    const balance = balances.get(vote.wallet) ?? 0n;
    if (balance <= 0n) {
      continue;
    }
    if (vote.side === "up") {
      up += balance;
    } else {
      down += balance;
    }
  }
  return {
    upPct: pct(up, supply),
    downPct: pct(down, supply),
    netPct: pct(up, supply) - pct(down, supply),
  };
};

type CacheEntry = {
  at: number;
  supply: bigint;
  byOwner: Map<string, bigint>;
};

const cache = new Map<string, CacheEntry>();
const CACHE_MS = 15_000;

const heliusUrl = () => {
  const key = process.env.HELIUS_API_KEY;
  if (!key) {
    return null;
  }
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
};

const rpc = async (method: string, params: unknown) => {
  const url = heliusUrl();
  if (!url) {
    throw new Error("RPC missing");
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (!response.ok || body.error) {
    throw new Error(body.error?.message || "RPC failed");
  }
  return body.result;
};

const asBig = (value: unknown) => {
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return BigInt(value);
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return BigInt(Math.floor(value));
  }
  return 0n;
};

const loadChain = async (mint: string) => {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return hit;
  }
  const supplyResult = (await rpc("getTokenSupply", [mint])) as {
    value?: { amount?: string };
  };
  const supply = asBig(supplyResult.value?.amount);
  const byOwner = new Map<string, bigint>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const params: { mint: string; limit: number; cursor?: string } = { mint, limit: 1000 };
    if (cursor) {
      params.cursor = cursor;
    }
    const result = (await rpc("getTokenAccounts", params)) as {
      token_accounts?: { owner?: string; amount?: unknown }[];
      cursor?: string;
    };
    const accounts = result.token_accounts ?? [];
    for (const account of accounts) {
      if (!account.owner) {
        continue;
      }
      const next = (byOwner.get(account.owner) ?? 0n) + asBig(account.amount);
      if (next > 0n) {
        byOwner.set(account.owner, next);
      }
    }
    if (!result.cursor || accounts.length === 0) {
      break;
    }
    cursor = result.cursor;
  }
  const entry = { at: Date.now(), supply, byOwner };
  cache.set(mint, entry);
  return entry;
};

const simHoldings = (project: ProjectState, wallets: string[]) => {
  const balances = new Map<string, bigint>();
  for (const wallet of wallets) {
    balances.set(wallet, BigInt(project.balances[wallet] ?? "0"));
  }
  return { ok: true as const, supply: BigInt(project.circulatingSupply), balances };
};

export const loadHoldings = async (project: ProjectState, wallets: string[]) => {
  if (!wallets.length) {
    return simHoldings(project, wallets);
  }
  if (heliusUrl()) {
    try {
      const chain = await loadChain(project.mint);
      const balances = new Map<string, bigint>();
      for (const wallet of wallets) {
        balances.set(wallet, chain.byOwner.get(wallet) ?? 0n);
      }
      return { ok: true, supply: chain.supply, balances };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("could not find account")) {
        return simHoldings(project, wallets);
      }
      return {
        ok: false,
        supply: BigInt(project.circulatingSupply),
        balances: new Map<string, bigint>(),
      };
    }
  }

  return simHoldings(project, wallets);
};

export const snapshotBalances = async (
  project: ProjectState,
): Promise<Record<string, string>> => {
  if (project.demo !== false || !heliusUrl()) {
    return { ...project.balances };
  }
  try {
    const chain = await loadChain(project.mint);
    return Object.fromEntries(
      [...chain.byOwner.entries()].map(([wallet, amount]) => [wallet, amount.toString()]),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("could not find account")) {
      return {};
    }
    throw new Error("Could not read holders. Try again");
  }
};

export const balanceOf = async (project: ProjectState, wallet: string) => {
  const holdings = await loadHoldings(project, [wallet]);
  return { ok: holdings.ok, amount: holdings.balances.get(wallet) ?? 0n };
};
