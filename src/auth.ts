import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";

const PREFIX = "proofofship.fun wants you to sign in with your Solana account:";
const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type XLink = {
  xUserId: string;
  xHandle: string;
};

export type OauthPending = {
  wallet: string;
  verifier: string;
  expiresAt: number;
};

export type AuthStore = {
  putNonce: (nonce: string, expiresAt: number) => Promise<void>;
  takeNonce: (nonce: string, now: number) => Promise<boolean>;
  putSession: (id: string, wallet: string, expiresAt: number) => Promise<void>;
  getSession: (id: string, now: number) => Promise<string | null>;
  deleteSession: (id: string) => Promise<void>;
  linkX: (wallet: string, xUserId: string, xHandle: string) => Promise<void>;
  getX: (wallet: string) => Promise<XLink | null>;
  putOauth: (state: string, pending: OauthPending) => Promise<void>;
  takeOauth: (state: string, now: number) => Promise<OauthPending | null>;
};

export const signInMessage = (wallet: string, nonce: string, issued: string) =>
  `${PREFIX}\n${wallet}\n\nNonce: ${nonce}\nIssued: ${issued}`;

export const parseSignIn = (message: string) => {
  const lines = message.split("\n");
  if (lines[0] !== PREFIX) {
    return null;
  }
  const wallet = lines[1] ?? "";
  const nonce = lines.find((line) => line.startsWith("Nonce: "))?.slice("Nonce: ".length) ?? "";
  const issued = lines.find((line) => line.startsWith("Issued: "))?.slice("Issued: ".length) ?? "";
  if (!WALLET.test(wallet) || !nonce || !issued) {
    return null;
  }
  return { wallet, nonce, issued };
};

export const verifySignIn = (message: string, signatureB64: string, now = Date.now()) => {
  const parsed = parseSignIn(message);
  if (!parsed) {
    return null;
  }
  const issuedMs = Date.parse(parsed.issued);
  if (!Number.isFinite(issuedMs) || Math.abs(now - issuedMs) > 10 * 60 * 1000) {
    return null;
  }
  let signature: Uint8Array;
  let publicKey: Uint8Array;
  try {
    signature = new Uint8Array(Buffer.from(signatureB64, "base64"));
    publicKey = bs58.decode(parsed.wallet);
  } catch {
    return null;
  }
  if (signature.length !== 64 || publicKey.length !== 32) {
    return null;
  }
  const ok = nacl.sign.detached.verify(new TextEncoder().encode(message), signature, publicKey);
  return ok ? parsed : null;
};

export const newNonce = () => randomBytes(16).toString("hex");
export const newSessionId = () => randomBytes(32).toString("hex");

export const codeChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

export const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
};

export const createMemoryAuth = (): AuthStore => {
  const nonces = new Map<string, number>();
  const sessions = new Map<string, { wallet: string; expiresAt: number }>();
  const links = new Map<string, XLink>();
  const oauth = new Map<string, OauthPending>();

  return {
    putNonce: async (nonce, expiresAt) => {
      nonces.set(nonce, expiresAt);
    },
    takeNonce: async (nonce, now) => {
      const expiresAt = nonces.get(nonce);
      nonces.delete(nonce);
      return Boolean(expiresAt && expiresAt > now);
    },
    putSession: async (id, wallet, expiresAt) => {
      sessions.set(id, { wallet, expiresAt });
    },
    getSession: async (id, now) => {
      const row = sessions.get(id);
      if (!row || row.expiresAt <= now) {
        sessions.delete(id);
        return null;
      }
      return row.wallet;
    },
    deleteSession: async (id) => {
      sessions.delete(id);
    },
    linkX: async (wallet, xUserId, xHandle) => {
      links.set(wallet, { xUserId, xHandle: xHandle.replace(/^@/, "") });
    },
    getX: async (wallet) => links.get(wallet) ?? null,
    putOauth: async (state, pending) => {
      oauth.set(state, pending);
    },
    takeOauth: async (state, now) => {
      const row = oauth.get(state);
      oauth.delete(state);
      if (!row || row.expiresAt <= now) {
        return null;
      }
      return row;
    },
  };
};
