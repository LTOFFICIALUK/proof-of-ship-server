import nacl from "tweetnacl";
import bs58 from "bs58";

export const MINT_SUFFIX = "PoS";
export const MINT_BANK_TARGET = Number(process.env.MINT_BANK_TARGET || 24);

const asSecret = (value: string | undefined) => {
  if (!value) {
    return null;
  }
  try {
    const bytes = bs58.decode(value);
    if (bytes.length === 64) {
      return bytes;
    }
  } catch {
    return null;
  }
  return null;
};

export const loadSigner = (secret: string | undefined) => {
  const bytes = asSecret(secret);
  if (!bytes) {
    return null;
  }
  return {
    publicKey: bs58.encode(bytes.slice(32)),
    secretKey: bytes,
  };
};

export const treasury = () => {
  const vault = loadSigner(process.env.VAULT_SECRET);
  const platform = loadSigner(process.env.PLATFORM_SECRET);
  const crank = loadSigner(process.env.CRANK_SECRET);
  return {
    vault: vault?.publicKey || process.env.VAULT_WALLET || "",
    platform: platform?.publicKey || process.env.PLATFORM_WALLET || "",
    crank: crank?.publicKey || process.env.CRANK_WALLET || "",
    vaultSigner: vault,
    platformSigner: platform,
    crankSigner: crank,
  };
};

export const destinations = () => {
  const keys = treasury();
  return {
    vault: keys.vault,
    platform: keys.platform,
    crank: keys.crank,
    feeConfig: "",
    revokeSig: "",
    paid: "0",
    posSpent: "0",
    burnSpent: "0",
    lastInflowSig: "",
  };
};

export const publicKeyOf = (secretKey: Uint8Array) => bs58.encode(secretKey.slice(32));

export const keypairFromSecret = (secret: string) => {
  const signer = loadSigner(secret);
  if (!signer) {
    throw new Error("Bad secret key");
  }
  return signer;
};

export const randomKeypair = () => {
  const keys = nacl.sign.keyPair();
  return {
    publicKey: bs58.encode(keys.publicKey),
    secretKey: bs58.encode(keys.secretKey),
    secretBytes: keys.secretKey,
  };
};
