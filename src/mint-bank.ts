import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const used = new Map<string, MintKey>();
let useMemory = !process.env.DATABASE_URL;
let refillTimer: ReturnType<typeof setInterval> | null = null;
let grinding = false;

export const mintEndsWithPos = (publicKey: string) => publicKey.endsWith(MINT_SUFFIX);

export const grindMint = (suffix = MINT_SUFFIX, yieldEvery = 25_000): Promise<MintKey> =>
  new Promise((resolve, reject) => {
    const step = () => {
      try {
        for (let i = 0; i < yieldEvery; i += 1) {
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
  if (row) {
    const key = { publicKey: row.public_key, secretKey: row.secret_key };
    keepUsed(key);
    void refillMintBank();
    return key;
  }
  const fresh = await grindMint();
  await query(
    `INSERT INTO mint_bank (public_key, secret_key, status, used_at)
     VALUES ($1, $2, 'used', now())
     ON CONFLICT (public_key) DO UPDATE SET status = 'used', used_at = now()`,
    [fresh.publicKey, fresh.secretKey],
  );
  keepUsed(fresh);
  logger.warn("mint bank empty, ground one now", { mint: fresh.publicKey });
  void refillMintBank();
  return fresh;
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
