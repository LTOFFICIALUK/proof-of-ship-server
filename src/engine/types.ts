export const VAULT_BPS = 7_500;
export const RUNWAY_BPS = 1_500;
export const PLATFORM_BPS = 1_000;
export const BPS_DENOM = 10_000;
export const QUORUM_BPS = 200;
export const DEV_LOCK_STEP_BPS = 2_000;
export const MAX_PROMISES = 20;
export const MAX_DEV_BUY_BPS = 300;
export const DEFAULT_SUPPLY = 1_000_000_000_000_000n;
export const VOTE_WINDOW_MS = 48 * 60 * 60 * 1000;
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_DEADLINE_MS = 14 * 24 * 60 * 60 * 1000;

export type ProjectStatus = "active" | "lapsed" | "abandoned";
export type PromiseStatus =
  | "pending"
  | "vote_open"
  | "paid"
  | "burned"
  | "no_quorum";
export type VoteSide = "pay" | "burn";
export type FeedKind =
  | "launch"
  | "promise"
  | "vote_open"
  | "vote_pay"
  | "vote_burn"
  | "no_quorum"
  | "lapse"
  | "abandon"
  | "inflow"
  | "release"
  | "burn";

export type VoteLock = {
  wallet: string;
  amount: string;
  side: VoteSide;
};

export type VoteState = {
  promiseIdx: number;
  startMs: number;
  endMs: number;
  payWeight: string;
  burnWeight: string;
  locks: VoteLock[];
};

export type PromiseState = {
  idx: number;
  text: string;
  textHash: string;
  deadlineMs: number;
  postedAtMs: number;
  status: PromiseStatus;
  quorumFails: number;
  resultNet?: number;
};

export type ProjectState = {
  mint: string;
  name: string;
  symbol: string;
  builderWallet: string;
  xHandle: string;
  status: ProjectStatus;
  circulatingSupply: string;
  accounted: string;
  released: string;
  burned: string;
  burnBucket: string;
  balance: string;
  runwayPaid: string;
  platformPaid: string;
  builderReceived: string;
  devLock: string;
  devUnlocked: string;
  nextDueAtMs: number | null;
  promises: PromiseState[];
  vote: VoteState | null;
  balances: Record<string, string>;
  demo?: boolean;
};

export class EngineError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
