import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { query } from "./db.js";
import { logger } from "./logger.js";
import { MINT_BANK_TARGET, MINT_SUFFIX } from "./wallets.js";

export type MintKey = {
  publicKey: string;
  secretKey: string;
};

const memory: MintKey[] = [];
const memoryReserved: { key: MintKey; wallet: string; at: number }[] = [];
const used = new Map<string, MintKey>();

export class MintBankEmptyError extends Error {
  constructor() {
    super("Mint bank is still filling. Try again in a minute.");
  }
}

const grindInline = (suffix: string) =>
  new Promise<MintKey>((resolve, reject) => {
    const step = () => {
      try {
        for (let i = 0; i < 32; i += 1) {
          const keys = nacl.sign.keyPair();
          const publicKey = bs58.encode(keys.publicKey);
          if (publicKey.endsWith(suffix)) {
            resolve({ publicKey, secretKey: bs58.encode(keys.secretKey) });
            return;
          }
        }
        setImmediate(step);
      } catch (error) {
        reject(error);
      }
    };
    step();
  });
let useMemory = !process.env.DATABASE_URL;
let refillTimer: ReturnType<typeof setInterval> | null = null;
let grinding = false;

export const mintEndsWithPos = (publicKey: string) => publicKey.endsWith(MINT_SUFFIX);

const keygenBin = () => {
  if (process.env.SOLANA_KEYGEN && existsSync(process.env.SOLANA_KEYGEN)) {
    return process.env.SOLANA_KEYGEN;
  }
  const bundled = path.resolve(process.cwd(), "bin", "solana-keygen");
  if (existsSync(bundled)) {
    return bundled;
  }
  return "solana-keygen";
};

const grindNative = async (suffix: string): Promise<MintKey> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pos-mint-"));
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        keygenBin(),
        ["grind", "--ends-with", `${suffix}:1`, "--num-threads", String(Math.max(1, os.availableParallelism()))],
        { cwd: dir, timeout: 10 * 60 * 1000 },
        (error) => (error ? reject(error) : resolve()),
      );
    });
    const file = (await readdir(dir)).find((name) => name.endsWith(".json"));
    if (!file) {
      throw new Error("Mint grind did not write a key.");
    }
    const bytes = Uint8Array.from(JSON.parse(await readFile(path.join(dir, file), "utf8")) as number[]);
    const publicKey = bs58.encode(bytes.subarray(32));
    if (!publicKey.endsWith(suffix)) {
      throw new Error("Mint grind returned the wrong suffix.");
    }
    return { publicKey, secretKey: bs58.encode(bytes) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const grindJs = (suffix: string): Promise<MintKey> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const workers: Worker[] = [];
    const stop = () => {
      for (const worker of workers) {
        void worker.terminate();
      }
    };
    const finish = (key: MintKey) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stop();
      resolve(key);
    };
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stop();
      reject(error);
    };
    const width = Math.max(1, Math.min(os.availableParallelism(), 8));
    const timer = setTimeout(() => fail(new Error("Mint grind timed out")), 30 * 60 * 1000);
    let failed = 0;
    for (let i = 0; i < width; i += 1) {
      let worker: Worker;
      try {
        worker = new Worker(new URL("./mint-grind-worker.js", import.meta.url), { workerData: { suffix } });
      } catch {
        grindInline(suffix).then(finish, fail);
        return;
      }
      workers.push(worker);
      worker.once("message", (message: MintKey) => finish(message));
      worker.once("error", () => {
        failed += 1;
        if (failed < workers.length) {
          return;
        }
        grindInline(suffix).then(finish, fail);
      });
    }
  });

export const grindMint = async (suffix = MINT_SUFFIX): Promise<MintKey> => {
  try {
    return await grindNative(suffix);
  } catch (error) {
    const missing = error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
    if (!missing) {
      throw error;
    }
    logger.warn("solana-keygen is not installed, using the slow grinder");
    return grindJs(suffix);
  }
};

export const useMemoryMintBank = () => {
  useMemory = true;
};

export const depositMint = async (key: MintKey) => {
  if (!mintEndsWithPos(key.publicKey)) {
    throw new Error(`Mint must end in ${MINT_SUFFIX}`);
  }
  if (useMemory) {
    if (!memory.some((item) => item.publicKey === key.publicKey)) {
      memory.push(key);
    }
    return;
  }
  await query(
    `INSERT INTO mint_bank (public_key, secret_key, status)
     VALUES ($1, $2, 'ready')
     ON CONFLICT (public_key) DO NOTHING`,
    [key.publicKey, key.secretKey],
  );
};

export const seedMintFixtures = async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, "mint-bank.fixtures.json");
  try {
    const body = JSON.parse(readFileSync(file, "utf8")) as { keys?: MintKey[] };
    for (const key of body.keys ?? []) {
      await depositMint(key);
    }
  } catch {
    return 0;
  }
  return readyCount();
};

export const readyCount = async () => {
  if (useMemory) {
    return memory.length;
  }
  const result = await query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM mint_bank WHERE status = 'ready'",
  );
  return Number(result.rows[0]?.count ?? 0);
};

const keepUsed = (key: MintKey) => {
  used.set(key.publicKey, key);
};

const claimMemory = async (): Promise<MintKey> => {
  const next = memory.shift();
  if (next) {
    keepUsed(next);
    return next;
  }
  const fresh = await grindMint();
  keepUsed(fresh);
  logger.warn("mint bank empty, ground one now", { mint: fresh.publicKey });
  return fresh;
};

const claimPg = async (): Promise<MintKey> => {
  const result = await query<{ public_key: string; secret_key: string }>(
    `UPDATE mint_bank
     SET status = 'used', used_at = now()
     WHERE public_key = (
       SELECT public_key FROM mint_bank
       WHERE status = 'ready'
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING public_key, secret_key`,
  );
  const row = result.rows[0];
  if (!row) {
    void refillMintBank();
    throw new MintBankEmptyError();
  }
  const key = { publicKey: row.public_key, secretKey: row.secret_key };
  keepUsed(key);
  void refillMintBank();
  return key;
};

const expireReserved = async () => {
  if (useMemory) {
    const cutoff = Date.now() - 20 * 60 * 1000;
    for (let i = memoryReserved.length - 1; i >= 0; i -= 1) {
      const item = memoryReserved[i];
      if (item && item.at < cutoff) {
        memoryReserved.splice(i, 1);
        keepUsed(item.key);
      }
    }
    return;
  }
  await query(
    `UPDATE mint_bank
     SET status = 'used', used_at = now(), reserved_wallet = NULL
     WHERE status = 'reserved' AND reserved_at < now() - interval '20 minutes'`,
  );
};

export const reserveMint = async (wallet: string): Promise<MintKey> => {
  await expireReserved();
  if (useMemory) {
    for (let i = memoryReserved.length - 1; i >= 0; i -= 1) {
      const item = memoryReserved[i];
      if (item?.wallet === wallet) {
        memoryReserved.splice(i, 1);
        keepUsed(item.key);
      }
    }
    const next = memory.shift();
    if (!next) {
      void refillMintBank();
      throw new MintBankEmptyError();
    }
    memoryReserved.push({ key: next, wallet, at: Date.now() });
    void refillMintBank();
    return next;
  }
  await query(
    `UPDATE mint_bank
     SET status = 'used', used_at = now(), reserved_wallet = NULL
     WHERE status = 'reserved' AND reserved_wallet = $1`,
    [wallet],
  );
  const result = await query<{ public_key: string; secret_key: string }>(
    `UPDATE mint_bank
     SET status = 'reserved', reserved_wallet = $1, reserved_at = now()
     WHERE public_key = (
       SELECT public_key FROM mint_bank
       WHERE status = 'ready'
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING public_key, secret_key`,
    [wallet],
  );
  const row = result.rows[0];
  if (!row) {
    void refillMintBank();
    throw new MintBankEmptyError();
  }
  void refillMintBank();
  return { publicKey: row.public_key, secretKey: row.secret_key };
};

export const reservedFor = async (wallet: string): Promise<MintKey | null> => {
  await expireReserved();
  if (useMemory) {
    return memoryReserved.find((item) => item.wallet === wallet)?.key ?? null;
  }
  const result = await query<{ public_key: string; secret_key: string }>(
    `SELECT public_key, secret_key FROM mint_bank
     WHERE status = 'reserved' AND reserved_wallet = $1
     ORDER BY reserved_at DESC
     LIMIT 1`,
    [wallet],
  );
  const row = result.rows[0];
  return row ? { publicKey: row.public_key, secretKey: row.secret_key } : null;
};

export const releaseMint = async (publicKey: string) => {
  if (useMemory) {
    const index = memoryReserved.findIndex((item) => item.key.publicKey === publicKey);
    if (index >= 0) {
      const [item] = memoryReserved.splice(index, 1);
      if (item) {
        memory.push(item.key);
      }
    }
    return;
  }
  await query(
    `UPDATE mint_bank
     SET status = 'ready', reserved_wallet = NULL, reserved_at = NULL
     WHERE public_key = $1 AND status = 'reserved'`,
    [publicKey],
  );
};

export const markMintUsed = async (publicKey: string) => {
  if (useMemory) {
    const index = memoryReserved.findIndex((item) => item.key.publicKey === publicKey);
    if (index >= 0) {
      const [item] = memoryReserved.splice(index, 1);
      if (item) {
        keepUsed(item.key);
      }
    }
    return;
  }
  await query(
    `UPDATE mint_bank
     SET status = 'used', used_at = now(), reserved_wallet = NULL
     WHERE public_key = $1`,
    [publicKey],
  );
};

export const getMintSecret = async (publicKey: string) => {
  const cached = used.get(publicKey);
  if (cached) {
    return cached;
  }
  if (useMemory) {
    return null;
  }
  const result = await query<{ public_key: string; secret_key: string }>(
    "SELECT public_key, secret_key FROM mint_bank WHERE public_key = $1",
    [publicKey],
  );
  const row = result.rows[0];
  return row ? { publicKey: row.public_key, secretKey: row.secret_key } : null;
};

export const claimMint = async (): Promise<MintKey> => {
  const key = useMemory ? await claimMemory() : await claimPg();
  if (!mintEndsWithPos(key.publicKey)) {
    throw new Error(`Mint bank returned an address that does not end in ${MINT_SUFFIX}`);
  }
  return key;
};

export const refillMintBank = async () => {
  if (grinding) {
    return;
  }
  grinding = true;
  try {
    logger.info("mint bank refill started", { ready: await readyCount(), target: MINT_BANK_TARGET });
    while ((await readyCount()) < MINT_BANK_TARGET) {
      const key = await grindMint();
      await depositMint(key);
      logger.info("mint bank refilled", { mint: key.publicKey, ready: await readyCount() });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("mint bank refill failed", { message });
  } finally {
    grinding = false;
  }
};

export const startMintBank = () => {
  void refillMintBank();
  if (refillTimer) {
    return refillTimer;
  }
  refillTimer = setInterval(() => {
    void refillMintBank();
  }, 15_000);
  return refillTimer;
};
