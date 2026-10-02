import { creditVaultInflow } from "./engine/vault.js";
import type { ProjectState } from "./engine/types.js";
import { logger } from "./logger.js";
import type { ShipStore } from "./store/memory.js";
import { treasury } from "./wallets.js";

const rpcUrl = () => {
  const key = process.env.HELIUS_API_KEY;
  return key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : "";
};

const rpc = async (method: string, params: unknown[]) => {
  const url = rpcUrl();
  if (!url) {
    throw new Error("RPC missing");
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (!response.ok || body.error) {
    throw new Error(body.error?.message || "RPC failed");
  }
  return body.result;
};

const matchMint = (keys: string[], mints: Map<string, ProjectState>) => {
  for (const key of keys) {
    const project = mints.get(key);
    if (project) {
      return project;
    }
  }
  return null;
};

export const ingestVaultInflows = async (store: ShipStore, nowMs: number) => {
  const { vault } = treasury();
  if (!vault || !rpcUrl()) {
    return 0;
  }
  const projects = await store.listProjects();
  const byMint = new Map(projects.map((project) => [project.mint, project]));
  const seen = new Set(
    projects.map((project) => project.chain?.lastInflowSig).filter((sig): sig is string => Boolean(sig)),
  );
  const sigs = (await rpc("getSignaturesForAddress", [vault, { limit: 40 }])) as {
    signature?: string;
  }[];
  let credited = 0;
  for (const row of sigs) {
    const signature = row.signature;
    if (!signature || seen.has(signature)) {
      continue;
    }
    const tx = (await rpc("getTransaction", [
      signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ])) as {
      meta?: { postBalances?: number[]; preBalances?: number[] };
      transaction?: { message?: { accountKeys?: { pubkey?: string }[] | string[] } };
    } | null;
    if (!tx) {
      continue;
    }
    const accounts = (tx.transaction?.message?.accountKeys ?? []).map((item) =>
      typeof item === "string" ? item : item.pubkey ?? "",
    );
    const vaultIndex = accounts.indexOf(vault);
    if (vaultIndex < 0) {
      continue;
    }
    const pre = BigInt(tx.meta?.preBalances?.[vaultIndex] ?? 0);
    const post = BigInt(tx.meta?.postBalances?.[vaultIndex] ?? 0);
    const inflow = post - pre;
    if (inflow <= 0n) {
      continue;
    }
    const project = matchMint(accounts, byMint);
    if (!project) {
      logger.warn("vault inflow with no mint", { signature, lamports: inflow.toString() });
      continue;
    }
    const builder = await store.getBuilderByWallet(project.builderWallet);
    if (!builder) {
      continue;
    }
    const events = creditVaultInflow(project, inflow, nowMs);
    project.chain = {
      vault,
      platform: project.chain?.platform ?? "",
      crank: project.chain?.crank ?? "",
      feeConfig: project.chain?.feeConfig ?? "",
      revokeSig: project.chain?.revokeSig ?? "",
      paid: project.chain?.paid ?? "0",
      posSpent: project.chain?.posSpent ?? "0",
      burnSpent: project.chain?.burnSpent ?? "0",
      lastInflowSig: signature,
    };
    await store.saveProject(builder.id, project);
    await store.appendEvents(events);
    credited += 1;
    logger.info("vault inflow", { mint: project.mint, lamports: inflow.toString(), signature });
  }
  return credited;
};
