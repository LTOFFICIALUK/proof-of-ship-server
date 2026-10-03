import { createRequire } from "node:module";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount, type TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { rpcUrl } from "./chain.js";
import { logger } from "./logger.js";
import type { MintKey } from "./mint-bank.js";
import { treasury } from "./wallets.js";

const LAUNCH_LOOKUP_TABLE = new PublicKey("9JKxba9ybJZ69kVxyL8KVjjuFYR6TknwBDYUbkB3nQ1X");
const SHARING_ACCOUNT_BYTES = 1024;
const CREATE_COST_LAMPORTS = 20_000_000n;

const require = createRequire(import.meta.url);
const sdk = require("@pump-fun/pump-sdk") as {
  PUMP_SDK: {
    createV2Instruction: (input: Record<string, unknown>) => Promise<TransactionInstruction>;
    createV2AndBuyInstructions: (input: Record<string, unknown>) => Promise<TransactionInstruction[]>;
    createFeeSharingConfig: (input: Record<string, unknown>) => Promise<TransactionInstruction>;
    updateFeeSharesV2: (input: Record<string, unknown>) => Promise<TransactionInstruction>;
    buyV2Instructions: (input: Record<string, unknown>) => Promise<TransactionInstruction[]>;
    decodeSharingConfig: (accountInfo: { data: Buffer }) => {
      adminRevoked: boolean;
      shareholders: { address: PublicKey; shareBps: number }[];
    };
  };
  OnlinePumpSdk: new (connection: Connection) => {
    fetchGlobal: () => Promise<unknown>;
    fetchFeeConfig: () => Promise<unknown>;
    fetchBuyState: (mint: PublicKey, user: PublicKey) => Promise<{
      quoteTokenProgram: PublicKey;
      bondingCurveAccountInfo: unknown;
      bondingCurve: unknown;
      associatedUserAccountInfo: unknown;
    }>;
  };
  feeSharingConfigPda: (mint: PublicKey) => PublicKey;
  getBuySolAmountFromTokenAmount: (input: Record<string, unknown>) => { toString: () => string };
  getBuyTokenAmountFromSolAmount: (input: Record<string, unknown>) => { toString: () => string };
};
const BN = require("bn.js") as new (value: string | number) => {
  mul: (other: InstanceType<typeof BN>) => InstanceType<typeof BN>;
  muln: (value: number) => InstanceType<typeof BN>;
  divn: (value: number) => InstanceType<typeof BN>;
};

export type LaunchDraft = {
  name: string;
  symbol: string;
  description: string;
  image: string;
  website: string;
  twitter: string;
  devBuyBps: number;
};

const connectionOf = () => {
  const url = rpcUrl();
  if (!url) {
    throw new Error("RPC is not configured.");
  }
  return new Connection(url, "confirmed");
};

const imageFile = async (image: string) => {
  if (image.startsWith("data:image/")) {
    const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(image);
    if (!match?.[1] || !match[2]) {
      throw new Error("Add a coin image.");
    }
    const type = match[1] === "image/jpg" ? "image/jpeg" : match[1];
    return { type, bytes: Buffer.from(match[2], "base64") };
  }
  if (image.startsWith("https://")) {
    const response = await fetch(image, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) {
      throw new Error("Could not read that image.");
    }
    const type = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
    if (!type.startsWith("image/")) {
      throw new Error("Add a coin image.");
    }
    return { type, bytes: Buffer.from(await response.arrayBuffer()) };
  }
  throw new Error("Add a coin image.");
};

const uploadMetadata = async (draft: LaunchDraft) => {
  const file = await imageFile(draft.image);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.type }), "coin");
  form.append("name", draft.name);
  form.append("symbol", draft.symbol);
  form.append("description", draft.description || draft.name);
  form.append("twitter", draft.twitter ? `https://x.com/${draft.twitter.replace(/^@/, "")}` : "");
  form.append("website", draft.website);
  form.append("showName", "true");
  const response = await fetch("https://pump.fun/api/ipfs", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  const payload = (await response.json().catch(() => null)) as { metadataUri?: string } | null;
  if (!response.ok || !payload?.metadataUri) {
    throw new Error("Could not upload the coin image.");
  }
  return payload.metadataUri;
};

const pack = (
  instructions: TransactionInstruction[],
  feePayer: PublicKey,
  blockhash: string,
  signers: Keypair[],
  lookupTables: AddressLookupTableAccount[] = [],
) => {
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);
  const tx = new VersionedTransaction(message);
  if (signers.length) {
    tx.sign(signers);
  }
  return Buffer.from(tx.serialize()).toString("base64");
};

const platformKey = () => {
  const keys = treasury();
  if (!keys.platformSigner || !keys.vault) {
    throw new Error("Platform wallet is not configured.");
  }
  return {
    vault: new PublicKey(keys.vault),
    platform: Keypair.fromSecretKey(keys.platformSigner.secretKey),
  };
};

const devBuyLamports = async (draft: LaunchDraft) => {
  if (draft.devBuyBps <= 0) {
    return 0n;
  }
  const online = new sdk.OnlinePumpSdk(connectionOf());
  const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
  const supply = new BN(1_000_000_000).mul(new BN(1_000_000));
  const tokens = supply.muln(draft.devBuyBps).divn(10_000);
  const sol = sdk.getBuySolAmountFromTokenAmount({
    global,
    feeConfig,
    mintSupply: null,
    bondingCurve: null,
    amount: tokens,
    quoteMint: NATIVE_MINT,
  });
  return BigInt(sol.toString());
};

export const buildLaunchPayment = async (draft: LaunchDraft, userWallet: string) => {
  const { platform } = platformKey();
  const buy = await devBuyLamports(draft);
  const total = CREATE_COST_LAMPORTS + buy;
  const user = new PublicKey(userWallet);
  const connection = connectionOf();
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const transaction = pack(
    [SystemProgram.transfer({ fromPubkey: user, toPubkey: platform.publicKey, lamports: Number(total) })],
    user,
    blockhash,
    [],
  );
  return { transaction, totalLamports: total, platformWallet: platform.publicKey.toBase58() };
};

const sendEncoded = async (encoded: string) => {
  const connection = connectionOf();
  const tx = VersionedTransaction.deserialize(Buffer.from(encoded, "base64"));
  let signature = "";
  try {
    signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/already been processed|already processed/i.test(message)) {
      const existing = tx.signatures[0];
      if (!existing || existing.every((byte) => byte === 0)) {
        throw new Error("The payment was already sent.");
      }
      signature = bs58.encode(existing);
    } else if (/blockhash not found|expired/i.test(message)) {
      throw new Error("That confirmation expired. Start the launch again.");
    } else {
      throw new Error(message || "The payment was rejected.");
    }
  }
  const confirmed = await connection.confirmTransaction(signature, "confirmed");
  if (confirmed.value.err) {
    throw new Error("The payment failed on chain.");
  }
  return signature;
};

const paidTransfer = (encoded: string, user: PublicKey, platform: PublicKey, expected: bigint) => {
  const tx = VersionedTransaction.deserialize(Buffer.from(encoded, "base64"));
  const keys = tx.message.staticAccountKeys;
  if (!keys[0]?.equals(user)) {
    throw new Error("The payment is signed by the wrong wallet.");
  }
  const message = tx.message.serialize();
  const userSig = tx.signatures[0];
  if (!userSig || !nacl.sign.detached.verify(message, userSig, user.toBytes())) {
    throw new Error("The payment signature is invalid.");
  }
  const system = SystemProgram.programId;
  for (const ix of tx.message.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (!program?.equals(system)) {
      continue;
    }
    const data = Buffer.from(ix.data);
    if (data.length < 12 || data.readUInt32LE(0) !== 2) {
      continue;
    }
    const lamports = data.readBigUInt64LE(4);
    const from = keys[ix.accountKeyIndexes[0] ?? -1];
    const to = keys[ix.accountKeyIndexes[1] ?? -1];
    if (from?.equals(user) && to?.equals(platform) && lamports >= expected) {
      return tx;
    }
  }
  throw new Error("The payment does not cover the launch.");
};

const refundPayment = async (platform: Keypair, user: PublicKey, lamports: bigint) => {
  const connection = connectionOf();
  const balance = BigInt(await connection.getBalance(platform.publicKey));
  const keep = 5_000_000n;
  const send = balance > lamports + keep ? lamports : balance > keep ? balance - keep : 0n;
  if (send <= 0n) {
    return;
  }
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const encoded = pack(
    [SystemProgram.transfer({ fromPubkey: platform.publicKey, toPubkey: user, lamports: Number(send) })],
    platform.publicKey,
    blockhash,
    [platform],
  );
  await sendEncoded(encoded);
};

const rememberLaunch = async (save: () => Promise<void>) => {
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await save();
      return;
    } catch (error) {
      last = error;
      logger.error("could not save the launch", {
        attempt,
        message: error instanceof Error ? error.message : "",
      });
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw last instanceof Error ? last : new Error("The coin is live but it could not be listed.");
};

export const settlePaidLaunch = async (
  encoded: string,
  draft: LaunchDraft,
  mint: MintKey,
  userWallet: string,
  expected: bigint,
  onCreated: () => Promise<void>,
) => {
  const { platform, vault } = platformKey();
  const user = new PublicKey(userWallet);
  paidTransfer(encoded, user, platform.publicKey, expected);
  await sendEncoded(encoded);
  const mintKey = Keypair.fromSecretKey(bs58.decode(mint.secretKey));
  try {
    const uri = await uploadMetadata(draft);
    const connection = connectionOf();
    const online = new sdk.OnlinePumpSdk(connection);
    const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
    const createIxs = await createInstructions(draft, mintKey.publicKey, platform.publicKey, uri, global, feeConfig);
    const lookup = await connection.getAddressLookupTable(LAUNCH_LOOKUP_TABLE);
    if (!lookup.value) {
      throw new Error("Launch lookup table is not ready.");
    }
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const launchTx = pack(
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...createIxs],
      platform.publicKey,
      blockhash,
      [platform, mintKey],
      [lookup.value],
    );
    await sendEncoded(launchTx);
    await rememberLaunch(onCreated);
    const shareIx = await sdk.PUMP_SDK.createFeeSharingConfig({
      creator: platform.publicKey,
      mint: mintKey.publicKey,
      pool: null,
    });
    const updateIx = await sdk.PUMP_SDK.updateFeeSharesV2({
      authority: platform.publicKey,
      mint: mintKey.publicKey,
      currentShareholders: [platform.publicKey],
      newShareholders: [{ address: vault, shareBps: 10_000 }],
      quoteMint: NATIVE_MINT,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    });
    const { blockhash: lockHash } = await connection.getLatestBlockhash("confirmed");
    const lockTx = pack(
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), shareIx, updateIx],
      platform.publicKey,
      lockHash,
      [platform],
      [lookup.value],
    );
    await sendEncoded(lockTx);
    await assertFeeLock(mint.publicKey);
  } catch (error) {
    const created = await connectionOf().getAccountInfo(mintKey.publicKey).catch(() => null);
    if (!created) {
      await refundPayment(platform, user, expected).catch((refundError) => {
        logger.error("launch refund failed", { message: refundError instanceof Error ? refundError.message : "" });
      });
      throw error;
    }
    await rememberLaunch(onCreated).catch((saveError) => {
      logger.error("coin exists but listing failed", {
        mint: mint.publicKey,
        message: saveError instanceof Error ? saveError.message : "",
      });
    });
    logger.error("coin is listed but a follow up step failed", {
      mint: mint.publicKey,
      message: error instanceof Error ? error.message : "",
    });
  }
};

export const buildLaunchTransactions = async (draft: LaunchDraft, mint: MintKey, userWallet: string) => {
  const keys = treasury();
  if (!keys.vault) {
    throw new Error("Vault wallet is not configured.");
  }
  if (!draft.image) {
    throw new Error("Add a coin image.");
  }
  const uri = await uploadMetadata(draft);
  const user = new PublicKey(userWallet);
  const mintKey = new PublicKey(mint.publicKey);
  const vault = new PublicKey(keys.vault);
  const connection = connectionOf();
  const online = new sdk.OnlinePumpSdk(connection);
  const [global, feeConfig] = await Promise.all([online.fetchGlobal(), online.fetchFeeConfig()]);
  if (!keys.platformSigner) {
    throw new Error("Platform wallet is not configured.");
  }
  const platform = Keypair.fromSecretKey(keys.platformSigner.secretKey);
  const rent = await connection.getMinimumBalanceForRentExemption(SHARING_ACCOUNT_BYTES);
  if ((await connection.getBalance(platform.publicKey)) < rent) {
    throw new Error("The platform wallet cannot cover fee rent right now.");
  }
  const createIxs = await createInstructions(draft, mintKey, user, uri, global, feeConfig);
  const shareIx = await sdk.PUMP_SDK.createFeeSharingConfig({
    creator: user,
    mint: mintKey,
    pool: null,
  });
  const updateIx = await sdk.PUMP_SDK.updateFeeSharesV2({
    authority: user,
    mint: mintKey,
    currentShareholders: [user],
    newShareholders: [{ address: vault, shareBps: 10_000 }],
    quoteMint: NATIVE_MINT,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
  });
  const lookup = await connection.getAddressLookupTable(LAUNCH_LOOKUP_TABLE);
  if (!lookup.value) {
    throw new Error("Launch lookup table is not ready.");
  }
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const launchTx = pack(
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...createIxs],
    user,
    blockhash,
    [],
    [lookup.value],
  );
  const preview = VersionedTransaction.deserialize(Buffer.from(launchTx, "base64"));
  const simulated = await connection.simulateTransaction(preview, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  if (simulated.value.err) {
    logger.error("create simulation failed", { err: simulated.value.err, logs: simulated.value.logs });
    throw new Error("The launch transaction failed simulation. Nothing was sent.");
  }
  const lockTx = pack(
    [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      SystemProgram.transfer({ fromPubkey: platform.publicKey, toPubkey: user, lamports: rent }),
      shareIx,
      updateIx,
    ],
    user,
    blockhash,
    [],
    [lookup.value],
  );
  return [launchTx, lockTx];
};

const createInstructions = async (
  draft: LaunchDraft,
  mint: PublicKey,
  user: PublicKey,
  uri: string,
  global: unknown,
  feeConfig: unknown,
) => {
  if (draft.devBuyBps <= 0) {
    return [
      await sdk.PUMP_SDK.createV2Instruction({
        mint,
        name: draft.name,
        symbol: draft.symbol,
        uri,
        creator: user,
        user,
        mayhemMode: false,
      }),
    ];
  }
  const supply = new BN(1_000_000_000).mul(new BN(1_000_000));
  const tokens = supply.muln(draft.devBuyBps).divn(10_000);
  const sol = sdk.getBuySolAmountFromTokenAmount({
    global,
    feeConfig,
    mintSupply: null,
    bondingCurve: null,
    amount: tokens,
    quoteMint: NATIVE_MINT,
  });
  return sdk.PUMP_SDK.createV2AndBuyInstructions({
    global,
    mint,
    name: draft.name,
    symbol: draft.symbol,
    uri,
    creator: user,
    user,
    amount: tokens,
    solAmount: sol,
    mayhemMode: false,
  });
};

const addKeypairSignature = (tx: VersionedTransaction, signer: Keypair) => {
  const keys = tx.message.staticAccountKeys;
  const required = tx.message.header.numRequiredSignatures;
  const index = keys.findIndex((key, i) => i < required && key.equals(signer.publicKey));
  if (index < 0) {
    return;
  }
  const existing = tx.signatures[index];
  if (existing?.some((byte) => byte !== 0)) {
    return;
  }
  tx.sign([signer]);
};

const launchSigners = (mint: MintKey) => {
  const keys = treasury();
  if (!keys.platformSigner) {
    throw new Error("Platform wallet is not configured.");
  }
  return [
    Keypair.fromSecretKey(bs58.decode(mint.secretKey)),
    Keypair.fromSecretKey(keys.platformSigner.secretKey),
  ];
};

const sendSigned = async (encoded: string, user: PublicKey, mint: PublicKey, signers: Keypair[]) => {
  const tx = VersionedTransaction.deserialize(Buffer.from(encoded, "base64"));
  for (const signer of signers) {
    addKeypairSignature(tx, signer);
  }
  const keys = tx.message.staticAccountKeys;
  if (!keys[0]?.equals(user)) {
    throw new Error("The launch is signed by the wrong wallet.");
  }
  if (!keys.some((key) => key.equals(mint))) {
    throw new Error("The launch transaction does not use the reserved address.");
  }
  const message = tx.message.serialize();
  const required = tx.message.header.numRequiredSignatures;
  for (let i = 0; i < required; i += 1) {
    const sig = tx.signatures[i];
    const key = keys[i];
    if (!sig || !key || !nacl.sign.detached.verify(message, sig, key.toBytes())) {
      throw new Error("The launch signature is invalid.");
    }
  }
  const connection = connectionOf();
  let signature = "";
  try {
    signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/already been processed|already processed/i.test(message)) {
      const existing = tx.signatures[0];
      if (!existing || existing.every((byte) => byte === 0)) {
        throw new Error("The launch transaction was already sent.");
      }
      signature = bs58.encode(existing);
    } else if (/blockhash not found|expired/i.test(message)) {
      throw new Error("That confirmation expired. Start the launch again.");
    } else {
      throw new Error(message || "The launch transaction was rejected.");
    }
  }
  const confirmed = await connection.confirmTransaction(signature, "confirmed");
  if (confirmed.value.err) {
    throw new Error("The launch transaction failed on chain.");
  }
  return signature;
};

export const assertFeeLock = async (mintAddress: string) => {
  const keys = treasury();
  if (!keys.vault) {
    throw new Error("Vault wallet is not configured.");
  }
  const mint = new PublicKey(mintAddress);
  const vault = new PublicKey(keys.vault);
  const info = await connectionOf().getAccountInfo(sdk.feeSharingConfigPda(mint));
  if (!info) {
    throw new Error("Fees were not locked to the vault. The coin was not listed.");
  }
  const config = sdk.PUMP_SDK.decodeSharingConfig(info);
  const locked = config.shareholders.length === 1 && config.shareholders[0]?.address.equals(vault) && config.shareholders[0]?.shareBps === 10_000;
  if (!locked || !config.adminRevoked) {
    logger.warn("fee lock mismatch", {
      mint: mintAddress,
      adminRevoked: config.adminRevoked,
      shares: config.shareholders.map((item) => ({ address: item.address.toBase58(), shareBps: item.shareBps })),
    });
    throw new Error("Fees were not locked to the vault. The coin was not listed.");
  }
};

export const relayLaunchTransaction = async (encoded: string, mint: MintKey, userWallet: string) =>
  sendSigned(encoded, new PublicKey(userWallet), new PublicKey(mint.publicKey), launchSigners(mint));

export const broadcastLaunch = async (encoded: string[], mint: MintKey, userWallet: string) => {
  if (encoded.length < 2) {
    throw new Error("Sign both launch transactions. Nothing was sent.");
  }
  const user = new PublicKey(userWallet);
  const signers = launchSigners(mint);
  const signatures: string[] = [];
  for (const item of encoded) {
    signatures.push(await sendSigned(item, user, signers[0]!.publicKey, signers));
  }
  await assertFeeLock(mint.publicKey);
  return signatures;
};

export const buildDevBuy = async (mintAddress: string, userWallet: string, devBuyBps: number) => {
  if (devBuyBps <= 0) {
    return "";
  }
  const connection = connectionOf();
  const online = new sdk.OnlinePumpSdk(connection);
  const user = new PublicKey(userWallet);
  const mint = new PublicKey(mintAddress);
  const [global, feeConfig, state] = await Promise.all([
    online.fetchGlobal(),
    online.fetchFeeConfig(),
    online.fetchBuyState(mint, user),
  ]);
  const supply = new BN(1_000_000_000).mul(new BN(1_000_000));
  const tokens = supply.muln(devBuyBps).divn(10_000);
  const sol = sdk.getBuySolAmountFromTokenAmount({
    global,
    feeConfig,
    mintSupply: null,
    bondingCurve: state.bondingCurve,
    amount: tokens,
    quoteMint: NATIVE_MINT,
  });
  const amount = sdk.getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: null,
    bondingCurve: state.bondingCurve,
    amount: sol,
    quoteMint: NATIVE_MINT,
  });
  const instructions = await sdk.PUMP_SDK.buyV2Instructions({
    global,
    bondingCurveAccountInfo: state.bondingCurveAccountInfo,
    bondingCurve: state.bondingCurve,
    associatedUserAccountInfo: state.associatedUserAccountInfo,
    mint,
    user,
    amount,
    quoteAmount: sol,
    slippage: 10,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    quoteTokenProgram: state.quoteTokenProgram,
  });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  return pack([ComputeBudgetProgram.setComputeUnitLimit({ units: 350_000 }), ...instructions], user, blockhash, []);
};

export const broadcastBuy = async (encoded: string, mintAddress: string, userWallet: string) =>
  sendSigned(encoded, new PublicKey(userWallet), new PublicKey(mintAddress), []);
