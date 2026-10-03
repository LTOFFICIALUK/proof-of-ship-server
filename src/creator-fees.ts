import { createRequire } from "node:module";
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { rpcUrl, sendSolFromPlatform } from "./chain.js";
import { creditFees } from "./engine/vault.js";
import type { ProjectState } from "./engine/types.js";
import { logger } from "./logger.js";
import type { ShipStore } from "./store/memory.js";
import { treasury } from "./wallets.js";

const require = createRequire(import.meta.url);
const pump = require("@pump-fun/pump-sdk") as {
  PUMP_SDK: {
    decodeTradeEventBc: (data: Buffer) => { mint: PublicKey; creatorFee: { toString: () => string } };
  };
  OnlinePumpSdk: new (connection: Connection) => {
    fetchBondingCurve: (mint: PublicKey) => Promise<{ creator: PublicKey }>;
    getCreatorVaultBalance: (creator: PublicKey) => Promise<{ toString: () => string }>;
    collectCoinCreatorFeeInstructions: (creator: PublicKey, payer?: PublicKey) => Promise<TransactionInstruction[]>;
  };
  bondingCurvePda: (mint: PublicKey) => PublicKey;
};

const n = (value: string | undefined) => BigInt(value || "0");

export const allocateFees = (
  rows: { mint: string; earned: bigint; spent: bigint }[],
  collected: bigint,
) => {
  const open = rows
    .map((row) => ({
      mint: row.mint,
      unspent: row.earned > row.spent ? row.earned - row.spent : 0n,
    }))
    .filter((row) => row.unspent > 0n);
  const total = open.reduce((sum, row) => sum + row.unspent, 0n);
  if (total === 0n || collected <= 0n) {
    return [] as { mint: string; amount: bigint }[];
  }
  const pot = collected < total ? collected : total;
  const amounts = open.map((row) => ({
    mint: row.mint,
    unspent: row.unspent,
    amount: (pot * row.unspent) / total,
  }));
  let rest = pot - amounts.reduce((sum, row) => sum + row.amount, 0n);
  const order = [...amounts].sort((a, b) => (a.unspent === b.unspent ? 0 : a.unspent > b.unspent ? -1 : 1));
  for (const row of order) {
    if (rest === 0n) {
      break;
    }
    const room = row.unspent - row.amount;
    const add = room < rest ? room : rest;
    row.amount += add;
    rest -= add;
  }
  return amounts.filter((row) => row.amount > 0n).map(({ mint, amount }) => ({ mint, amount }));
};

const creatorFeeFromLogs = (logs: string[], mint: string) => {
  let fees = 0n;
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) {
      continue;
    }
    const buf = Buffer.from(line.slice("Program data: ".length), "base64");
    if (buf.length < 80) {
      continue;
    }
    try {
      const decoded = pump.PUMP_SDK.decodeTradeEventBc(buf.subarray(8));
      if (decoded.mint.toBase58() !== mint) {
        continue;
      }
      fees += BigInt(decoded.creatorFee.toString());
    } catch {
      continue;
    }
  }
  return fees;
};

const scanEarned = async (connection: Connection, project: ProjectState) => {
  const mint = new PublicKey(project.mint);
  const curve = pump.bondingCurvePda(mint);
  const cursor = project.creatorFeesCursor || "";
  const fresh: string[] = [];
  let before: string | undefined;
  let reached = false;
  while (!reached) {
    const page = await connection.getSignaturesForAddress(curve, { limit: 100, before });
    if (!page.length) {
      break;
    }
    for (const row of page) {
      if (row.signature === cursor) {
        reached = true;
        break;
      }
      if (!row.err) {
        fresh.push(row.signature);
      }
    }
    before = page[page.length - 1]?.signature;
    if (page.length < 100) {
      break;
    }
  }
  let added = 0n;
  for (const signature of fresh) {
    const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 1 });
    added += creatorFeeFromLogs(tx?.meta?.logMessages ?? [], project.mint);
  }
  project.creatorFeesEarned = (n(project.creatorFeesEarned) + added).toString();
  if (fresh.length) {
    project.creatorFeesCursor = fresh[0]!;
  }
  return added;
};

const collectToPlatform = async (connection: Connection, creator: PublicKey) => {
  const { platformSigner } = treasury();
  if (!platformSigner) {
    throw new Error("Platform signer missing");
  }
  const online = new pump.OnlinePumpSdk(connection);
  const instructions = await online.collectCoinCreatorFeeInstructions(creator, new PublicKey(platformSigner.publicKey));
  const pumpOnly = instructions.slice(0, 1);
  if (!pumpOnly.length) {
    return;
  }
  const payer = Keypair.fromSecretKey(platformSigner.secretKey);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
          instructions: pumpOnly,
    }).compileToV0Message(),
  );
  tx.sign([payer]);
  const signature = await connection.sendTransaction(tx);
  await connection.confirmTransaction(signature, "confirmed");
  logger.info("collected shared creator fees", { creator: creator.toBase58(), signature });
};

export const syncTradingFees = async (store: ShipStore) => {
  const url = rpcUrl();
  const keys = treasury();
  if (!url || !keys.platformSigner || !keys.vault) {
    return 0;
  }
  const connection = new Connection(url, "confirmed");
  const projects = (await store.listProjects()).filter((project) => project.demo === false);
  const groups = new Map<string, ProjectState[]>();
  for (const project of projects) {
    try {
      const added = await scanEarned(connection, project);
      if (added > 0n) {
        logger.info("trading fees earned", { mint: project.mint, added: added.toString(), earned: project.creatorFeesEarned });
      }
      const curve = await new pump.OnlinePumpSdk(connection).fetchBondingCurve(new PublicKey(project.mint));
      const creator = curve.creator.toBase58();
      const group = groups.get(creator) ?? [];
      group.push(project);
      groups.set(creator, group);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("trading fee scan waiting", { mint: project.mint, message });
    }
  }

  let moved = 0;
  for (const [creator, group] of groups) {
    const online = new pump.OnlinePumpSdk(connection);
    const creatorKey = new PublicKey(creator);
    const available = BigInt((await online.getCreatorVaultBalance(creatorKey)).toString());
    const rows = group.map((project) => ({
      mint: project.mint,
      earned: n(project.creatorFeesEarned),
      spent: n(project.creatorFeesSpent),
    }));
    const planned = allocateFees(rows, available);
    if (!planned.length) {
      continue;
    }
    const before = BigInt(await connection.getBalance(creatorKey));
    try {
      await collectToPlatform(connection, creatorKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("creator fee collect waiting", { creator, message });
      continue;
    }
    const after = BigInt(await connection.getBalance(creatorKey));
    const gained = after > before ? after - before : 0n;
    const allocations = allocateFees(rows, gained);
    const total = allocations.reduce((sum, row) => sum + row.amount, 0n);
    if (total <= 0n) {
      continue;
    }
    try {
      await sendSolFromPlatform(keys.vault, total);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("creator fee transfer waiting", { creator, message });
      continue;
    }
    const byMint = new Map(allocations.map((row) => [row.mint, row.amount]));
    for (const project of group) {
      const amount = byMint.get(project.mint) ?? 0n;
      if (amount <= 0n) {
        continue;
      }
      const events = creditFees(project, amount, Date.now());
      project.creatorFeesSpent = (n(project.creatorFeesSpent) + amount).toString();
      await store.appendEvents(events);
      const builder = await store.getBuilderByWallet(project.builderWallet);
      if (builder) {
        await store.saveProject(builder.id, project);
      }
      moved += 1;
      logger.info("assigned trading fees", { mint: project.mint, amount: amount.toString(), status: project.status });
    }
  }

  for (const project of projects) {
    const builder = await store.getBuilderByWallet(project.builderWallet);
    if (builder) {
      await store.saveProject(builder.id, project);
    }
  }
  return moved;
};
