import { createRequire } from "node:module";
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { creditVaultInflow } from "./engine/vault.js";
import type { ProjectState } from "./engine/types.js";
import { rpcUrl } from "./chain.js";
import { logger } from "./logger.js";
import { payCuts } from "./settle.js";
import type { ShipStore } from "./store/memory.js";
import { treasury } from "./wallets.js";

const require = createRequire(import.meta.url);
const pump = require("@pump-fun/pump-sdk") as {
  OnlinePumpSdk: new (connection: Connection) => {
    getMinimumDistributableFee: (mint: PublicKey) => Promise<{ canDistribute: boolean }>;
    buildDistributeCreatorFeesInstructions: (mint: PublicKey) => Promise<{ instructions: TransactionInstruction[] }>;
  };
};

export const claimAbandonedFees = async (projects: ProjectState[]) => {
  const { vaultSigner } = treasury();
  const url = rpcUrl();
  if (!vaultSigner || !url) {
    return 0;
  }
  const abandoned = projects.filter((project) => project.status === "abandoned" && project.demo === false);
  if (!abandoned.length) {
    return 0;
  }
  const connection = new Connection(url, "confirmed");
  const online = new pump.OnlinePumpSdk(connection);
  const payer = Keypair.fromSecretKey(vaultSigner.secretKey);
  let claimed = 0;
  for (const project of abandoned) {
    try {
      const mint = new PublicKey(project.mint);
      const minimum = await online.getMinimumDistributableFee(mint);
      if (!minimum.canDistribute) {
        continue;
      }
      const built = await online.buildDistributeCreatorFeesInstructions(mint);
      if (!built.instructions.length) {
        continue;
      }
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      const tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: payer.publicKey,
          recentBlockhash: blockhash,
          instructions: built.instructions,
        }).compileToV0Message(),
      );
      tx.sign([payer]);
      const signature = await connection.sendTransaction(tx);
      await connection.confirmTransaction(signature, "confirmed");
      claimed += 1;
      logger.info("claimed abandoned creator fees", { mint: project.mint, signature });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("abandoned fee claim waiting", { mint: project.mint, message });
    }
  }
  return claimed;
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
    if (!project || project.demo !== false) {
      if (!project) {
        logger.warn("vault inflow with no mint", { signature, lamports: inflow.toString() });
      }
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
      runwaySent: project.chain?.runwaySent ?? "0",
      platformSent: project.chain?.platformSent ?? "0",
      lastInflowSig: signature,
    };
    events.push(...(await payCuts(project, nowMs)));
    await store.saveProject(builder.id, project);
    await store.appendEvents(events);
    credited += 1;
    logger.info("vault inflow", { mint: project.mint, lamports: inflow.toString(), signature });
  }
  return credited;
};
