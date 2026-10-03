import { logger } from "./logger.js";
import { POS_MINT } from "./pos.js";
import { treasury } from "./wallets.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

export const rpcUrl = () => {
  const key = process.env.HELIUS_API_KEY;
  return key ? `https://mainnet.helius-rpc.com/?api-key=${key}` : process.env.RPC_URL || "";
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

export const vaultBalance = async () => {
  const { vault } = treasury();
  if (!vault) {
    return 0n;
  }
  const result = (await rpc("getBalance", [vault])) as { value?: number };
  return BigInt(result.value ?? 0);
};

const sendTransaction = async (secretKey: Uint8Array, to: string, lamports: bigint) => {
  const { Keypair, PublicKey, SystemProgram, Transaction, Connection } = await import("@solana/web3.js");
  const url = rpcUrl();
  if (!url) {
    throw new Error("RPC missing");
  }
  const connection = new Connection(url, "confirmed");
  const from = Keypair.fromSecretKey(secretKey);
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: new PublicKey(to),
      lamports: Number(lamports),
    }),
  );
  const sig = await connection.sendTransaction(tx, [from]);
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
};

export const sendSolFromVault = async (to: string, lamports: bigint) => {
  const { vaultSigner } = treasury();
  if (!vaultSigner) {
    throw new Error("Vault signer missing");
  }
  if (lamports <= 0n) {
    return "";
  }
  const sig = await sendTransaction(vaultSigner.secretKey, to, lamports);
  logger.info("vault sent SOL", { to, lamports: lamports.toString(), sig });
  return sig;
};

export const sendSolFromPlatform = async (to: string, lamports: bigint) => {
  const { platformSigner } = treasury();
  if (!platformSigner) {
    throw new Error("Platform signer missing");
  }
  if (lamports <= 0n) {
    return "";
  }
  const sig = await sendTransaction(platformSigner.secretKey, to, lamports);
  logger.info("platform sent SOL", { to, lamports: lamports.toString(), sig });
  return sig;
};

type FeeSigner = { publicKey: string; secretKey: Uint8Array };

const jupiterSwap = async (inputMint: string, outputMint: string, amount: bigint, signer?: FeeSigner) => {
  const owner = signer ?? treasury().vaultSigner;
  if (!owner) {
    throw new Error("Vault signer missing");
  }
  const quoteUrl = new URL("https://lite-api.jup.ag/swap/v1/quote");
  quoteUrl.searchParams.set("inputMint", inputMint);
  quoteUrl.searchParams.set("outputMint", outputMint);
  quoteUrl.searchParams.set("amount", amount.toString());
  quoteUrl.searchParams.set("slippageBps", "100");
  const quoteRes = await fetch(quoteUrl, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
  if (!quoteRes.ok) {
    throw new Error("Swap quote failed");
  }
  const quote = await quoteRes.json();
  const swapRes = await fetch("https://lite-api.jup.ag/swap/v1/swap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: owner.publicKey,
      wrapAndUnwrapSol: true,
    }),
  });
  if (!swapRes.ok) {
    throw new Error("Swap build failed");
  }
  const swap = (await swapRes.json()) as { swapTransaction?: string };
  if (!swap.swapTransaction) {
    throw new Error("Swap build failed");
  }
  const { Keypair, VersionedTransaction, Connection } = await import("@solana/web3.js");
  const url = rpcUrl();
  if (!url) {
    throw new Error("RPC missing");
  }
  const connection = new Connection(url, "confirmed");
  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
  tx.sign([Keypair.fromSecretKey(owner.secretKey)]);
  const sig = await connection.sendTransaction(tx);
  await connection.confirmTransaction(sig, "confirmed");
  const out =
    typeof (quote as { outAmount?: unknown }).outAmount === "string"
      ? BigInt((quote as { outAmount: string }).outAmount)
      : 0n;
  return { sig, out };
};

export const buyPos = async (lamports: bigint) => jupiterSwap(SOL_MINT, POS_MINT, lamports);

export const sellTokenForSol = async (mint: string, amount: bigint) => {
  const { platformSigner } = treasury();
  if (!platformSigner) {
    throw new Error("Platform signer missing");
  }
  if (amount <= 0n) {
    throw new Error("Nothing to sell");
  }
  const { Connection, Keypair, PublicKey } = await import("@solana/web3.js");
  const { getAssociatedTokenAddress, getAccount } = await import("@solana/spl-token");
  const url = rpcUrl();
  if (!url) {
    throw new Error("RPC missing");
  }
  const connection = new Connection(url, "confirmed");
  const mintKey = new PublicKey(mint);
  const mintInfo = await connection.getAccountInfo(mintKey);
  if (!mintInfo) {
    throw new Error("Mint is missing");
  }
  const owner = Keypair.fromSecretKey(platformSigner.secretKey);
  const ata = await getAssociatedTokenAddress(mintKey, owner.publicKey, false, mintInfo.owner);
  let held = 0n;
  try {
    held = (await getAccount(connection, ata, "confirmed", mintInfo.owner)).amount;
  } catch {
    held = 0n;
  }
  const sell = held < amount ? held : amount;
  if (sell <= 0n) {
    throw new Error("Locked tokens are not in the platform wallet");
  }
  const before = BigInt(await connection.getBalance(owner.publicKey));
  const swap = await jupiterSwap(mint, SOL_MINT, sell, platformSigner);
  const after = BigInt(await connection.getBalance(owner.publicKey));
  const gained = after > before ? after - before : 0n;
  const sol = gained > 0n ? gained : swap.out;
  return { sig: swap.sig, sol, tokens: sell };
};

export const buyPosFromPlatform = async (lamports: bigint) => {
  const { platformSigner } = treasury();
  if (!platformSigner) {
    throw new Error("Platform signer missing");
  }
  return jupiterSwap(SOL_MINT, POS_MINT, lamports, platformSigner);
};

export const burnHeld = async (mintAddress: string, amount: bigint, signer: FeeSigner) => {
  if (amount <= 0n) {
    return "";
  }
  const { getAssociatedTokenAddress, createBurnInstruction, getAccount } = await import("@solana/spl-token");
  const { Keypair, PublicKey, Transaction, Connection } = await import("@solana/web3.js");
  const url = rpcUrl();
  if (!url) {
    throw new Error("RPC missing");
  }
  const connection = new Connection(url, "confirmed");
  const mint = new PublicKey(mintAddress);
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) {
    throw new Error("Mint is missing");
  }
  const owner = Keypair.fromSecretKey(signer.secretKey);
  const ata = await getAssociatedTokenAddress(mint, owner.publicKey, false, mintInfo.owner);
  const held = await getAccount(connection, ata, "confirmed", mintInfo.owner);
  const burnAmount = held.amount < amount ? held.amount : amount;
  if (burnAmount <= 0n) {
    throw new Error("Token balance is empty");
  }
  const tx = new Transaction().add(
    createBurnInstruction(ata, mint, owner.publicKey, burnAmount, [], mintInfo.owner),
  );
  const sig = await connection.sendTransaction(tx, [owner]);
  await connection.confirmTransaction(sig, "confirmed");
  logger.info("burned tokens", { mint: mintAddress, amount: burnAmount.toString(), sig });
  return sig;
};

export const burnPos = async (amount: bigint) => {
  if (amount <= 0n) {
    return "";
  }
  const { vaultSigner } = treasury();
  if (!vaultSigner) {
    throw new Error("Vault signer missing");
  }
  const { getAssociatedTokenAddress, createBurnInstruction, getAccount } = await import("@solana/spl-token");
  const { Keypair, PublicKey, Transaction, Connection } = await import("@solana/web3.js");
  const url = rpcUrl();
  if (!url) {
    throw new Error("RPC missing");
  }
  const connection = new Connection(url, "confirmed");
  const mint = new PublicKey(POS_MINT);
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) {
    throw new Error("POS mint is missing");
  }
  const owner = Keypair.fromSecretKey(vaultSigner.secretKey);
  const ata = await getAssociatedTokenAddress(mint, owner.publicKey, false, mintInfo.owner);
  const held = await getAccount(connection, ata, "confirmed", mintInfo.owner);
  const burnAmount = held.amount < amount ? held.amount : amount;
  if (burnAmount <= 0n) {
    throw new Error("POS balance is empty");
  }
  const tx = new Transaction().add(
    createBurnInstruction(ata, mint, owner.publicKey, burnAmount, [], mintInfo.owner),
  );
  const sig = await connection.sendTransaction(tx, [owner]);
  await connection.confirmTransaction(sig, "confirmed");
  logger.info("burned POS", { amount: burnAmount.toString(), sig });
  return sig;
};

export const buybackBurn = async (mint: string, lamports: bigint) => {
  const bought = await jupiterSwap(SOL_MINT, mint, lamports);
  try {
    const { vaultSigner } = treasury();
    if (!vaultSigner) {
      return bought;
    }
    const { getAssociatedTokenAddress, createBurnInstruction, TOKEN_PROGRAM_ID } = await import(
      "@solana/spl-token"
    );
    const { Keypair, PublicKey, Transaction, Connection } = await import("@solana/web3.js");
    const url = rpcUrl();
    if (!url || bought.out <= 0n) {
      return bought;
    }
    const owner = Keypair.fromSecretKey(vaultSigner.secretKey);
    const ata = await getAssociatedTokenAddress(new PublicKey(mint), owner.publicKey);
    const tx = new Transaction().add(
      createBurnInstruction(ata, new PublicKey(mint), owner.publicKey, bought.out, [], TOKEN_PROGRAM_ID),
    );
    const connection = new Connection(url, "confirmed");
    const sig = await connection.sendTransaction(tx, [owner]);
    await connection.confirmTransaction(sig, "confirmed");
    return { ...bought, burnSig: sig };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("token burn waiting", { mint, message });
    return bought;
  }
};
