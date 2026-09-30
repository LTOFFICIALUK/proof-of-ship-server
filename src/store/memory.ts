import { randomUUID } from "node:crypto";
import type { EngineEvent } from "../engine/vault.js";
import type { ProjectState } from "../engine/types.js";

export type BuilderRow = {
  id: string;
  wallet: string;
  xHandle: string;
};

export type FeedRow = {
  id: string;
  mint: string;
  kind: string;
  detail: Record<string, string | number | boolean>;
  atMs: number;
};

export type ChatRow = {
  id: string;
  mint: string;
  wallet: string;
  text: string;
  atMs: number;
};

export type HolderVoteRow = {
  mint: string;
  promiseIdx: number;
  wallet: string;
  side: "up" | "down";
};

export type ShipStore = {
  upsertBuilder: (wallet: string, xHandle: string) => Promise<BuilderRow>;
  getBuilderByHandle: (handle: string) => Promise<BuilderRow | null>;
  getBuilderByWallet: (wallet: string) => Promise<BuilderRow | null>;
  getProject: (mint: string) => Promise<ProjectState | null>;
  listProjectsByBuilder: (builderId: string) => Promise<ProjectState[]>;
  saveProject: (builderId: string, project: ProjectState) => Promise<void>;
  appendEvents: (events: EngineEvent[]) => Promise<void>;
  listFeed: (limit: number) => Promise<FeedRow[]>;
  listProjects: () => Promise<ProjectState[]>;
  listMessages: (mint: string, limit: number) => Promise<ChatRow[]>;
  addMessage: (mint: string, wallet: string, text: string, atMs: number) => Promise<ChatRow>;
  listHolderVotes: (mint: string) => Promise<HolderVoteRow[]>;
  upsertHolderVote: (
    mint: string,
    promiseIdx: number,
    wallet: string,
    side: "up" | "down",
  ) => Promise<void>;
};

export const createMemoryStore = (): ShipStore => {
  const builders = new Map<string, BuilderRow>();
  const byHandle = new Map<string, string>();
  const byWallet = new Map<string, string>();
  const projects = new Map<string, { builderId: string; project: ProjectState }>();
  const feed: FeedRow[] = [];
  let feedId = 1;
  const messages: ChatRow[] = [];
  let messageId = 1;
  const holderVotes: HolderVoteRow[] = [];

  return {
    upsertBuilder: async (wallet, xHandle) => {
      const handle = xHandle.replace(/^@/, "").toLowerCase();
      const existing = byWallet.get(wallet);
      if (existing) {
        const row = builders.get(existing)!;
        if (row.xHandle !== handle && byHandle.has(handle) && byHandle.get(handle) !== row.id) {
          throw new Error("Handle already in use");
        }
        byHandle.delete(row.xHandle);
        row.xHandle = handle;
        byHandle.set(handle, row.id);
        return row;
      }
      if (byHandle.has(handle)) {
        throw new Error("Handle already in use");
      }
      const row = { id: randomUUID(), wallet, xHandle: handle };
      builders.set(row.id, row);
      byHandle.set(handle, row.id);
      byWallet.set(wallet, row.id);
      return row;
    },
    getBuilderByHandle: async (handle) => {
      const id = byHandle.get(handle.replace(/^@/, "").toLowerCase());
      return id ? builders.get(id) ?? null : null;
    },
    getBuilderByWallet: async (wallet) => {
      const id = byWallet.get(wallet);
      return id ? builders.get(id) ?? null : null;
    },
    getProject: async (mint) => projects.get(mint)?.project ?? null,
    listProjectsByBuilder: async (builderId) =>
      [...projects.values()]
        .filter((row) => row.builderId === builderId)
        .map((row) => row.project),
    saveProject: async (builderId, project) => {
      projects.set(project.mint, {
        builderId,
        project: structuredClone(project),
      });
    },
    appendEvents: async (events) => {
      for (const event of events) {
        feed.unshift({
          id: String(feedId),
          mint: event.mint,
          kind: event.kind,
          detail: event.detail,
          atMs: event.atMs,
        });
        feedId += 1;
      }
    },
    listFeed: async (limit) => feed.slice(0, limit),
    listProjects: async () => [...projects.values()].map((row) => row.project),
    listMessages: async (mint, limit) =>
      messages.filter((row) => row.mint === mint).slice(-limit),
    addMessage: async (mint, wallet, text, atMs) => {
      const row = { id: String(messageId), mint, wallet, text, atMs };
      messageId += 1;
      messages.push(row);
      return row;
    },
    listHolderVotes: async (mint) => holderVotes.filter((row) => row.mint === mint),
    upsertHolderVote: async (mint, promiseIdx, wallet, side) => {
      const existing = holderVotes.find(
        (row) => row.mint === mint && row.promiseIdx === promiseIdx && row.wallet === wallet,
      );
      if (existing) {
        existing.side = side;
        return;
      }
      holderVotes.push({ mint, promiseIdx, wallet, side });
    },
  };
};
