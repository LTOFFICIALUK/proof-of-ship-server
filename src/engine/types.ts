export const VAULT_BPS = 7_500;
export const RUNWAY_BPS = 1_500;
export const PLATFORM_BPS = 1_000;
export const BPS_DENOM = 10_000;
export const QUORUM_BPS = 200;
export const DEV_LOCK_STEP_BPS = 2_000;
export const MAX_PROMISES = 20;
export const MAX_DEV_BUY_BPS = 500;
export const DEFAULT_SUPPLY = 1_000_000_000_000_000n;
export const VOTE_WINDOW_MS = 48 * 60 * 60 * 1000;
export const EXTEND_MS = 24 * 60 * 60 * 1000;
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_DEADLINE_MS = 30 * 60 * 1000;
export const MAX_DEADLINE_MS = 30 * 24 * 60 * 60 * 1000;
export const SLICE_BPS = 6_000;

export type ProjectStatus = "active" | "lapsed" | "abandoned";
export type PromiseStatus =
  | "pending"
  | "vote_open"
  | "paid"
  | "burned"
  | "rolled"
  | "missed"
  | "no_quorum";
export type VoteSide = "pay" | "burn";
export type FeedKind =
  | "launch"
  | "promise"
  | "vote_open"
  | "vote_pay"
  | "vote_burn"
  | "vote_roll"
  | "miss"
  | "no_quorum"
  | "lapse"
  | "abandon"
  | "inflow"
  | "release"
  | "burn"
  | "pos";

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
  extended?: boolean;
};

export type TallyRow = {
  wallet: string;
  side: VoteSide;
  weight: string;
  reason: string;
  message: string;
  signature: string;
};

export type ProofType = "link" | "repo" | "program" | "app" | "video";

export type PromiseState = {
  idx: number;
  text: string;
  doneLooksLike?: string;
  proofType?: ProofType | "";
  tally?: TallyRow[];
  eligibleAtClose?: string;
  closedAtMs?: number;
  proofAtMs?: number;
  textHash: string;
  deadlineMs: number;
  postedAtMs: number;
  status: PromiseStatus;
  quorumFails: number;
  resultNet?: number;
  proofUrl?: string;
  proofNote?: string;
  postedBalances?: Record<string, string>;
  proofBalances?: Record<string, string>;
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
  posBucket: string;
  posBought: string;
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
  rolloverStreak?: number;
  excludedWallets?: string[];
  verified?: boolean;
  profile?: {
    description: string;
    website: string;
    github: string;
    image: string;
    devBuyBps: number;
  };
  chain?: {
    vault: string;
    platform?: string;
    crank?: string;
    feeConfig: string;
    revokeSig: string;
    paid?: string;
    posSpent?: string;
    burnSpent?: string;
    runwaySent?: string;
    platformSent?: string;
    lastInflowSig?: string;
    posUnburned?: string;
  } | null;
};

export class EngineError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
