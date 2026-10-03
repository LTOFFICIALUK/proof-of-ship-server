import { query } from "../db.js";
import type { EngineEvent } from "../engine/vault.js";
import type { ProjectState } from "../engine/types.js";
import type { BuilderRow, ChatRow, FeedRow, HolderVoteRow, ShipStore } from "./memory.js";

type BuilderDb = { id: string; wallet: string; x_handle: string };
type ProjectDb = { mint: string; builder_id: string; state: ProjectState };
type EventDb = {
  id: string;
  mint: string;
  kind: string;
  detail: Record<string, string | number | boolean>;
  at_ms: string;
};

export const createPgStore = (): ShipStore => ({
  upsertBuilder: async (wallet, xHandle) => {
    const handle = xHandle.replace(/^@/, "").toLowerCase();
    const existing = await query<BuilderDb>(
      "SELECT id, wallet, x_handle FROM builders WHERE wallet = $1",
      [wallet],
    );
    if (existing.rowCount) {
      const row = existing.rows[0];
      await query("UPDATE builders SET x_handle = $1 WHERE id = $2", [
        handle,
        row.id,
      ]);
      return { id: row.id, wallet: row.wallet, xHandle: handle };
    }
    const inserted = await query<BuilderDb>(
      "INSERT INTO builders (wallet, x_handle) VALUES ($1, $2) RETURNING id, wallet, x_handle",
      [wallet, handle],
    );
    const row = inserted.rows[0];
    return { id: row.id, wallet: row.wallet, xHandle: row.x_handle };
  },
  getBuilderByHandle: async (handle) => {
    const result = await query<BuilderDb>(
      "SELECT id, wallet, x_handle FROM builders WHERE x_handle = $1",
      [handle.replace(/^@/, "").toLowerCase()],
    );
    const row = result.rows[0];
    return row
      ? { id: row.id, wallet: row.wallet, xHandle: row.x_handle }
      : null;
  },
  getBuilderByWallet: async (wallet) => {
    const result = await query<BuilderDb>(
      "SELECT id, wallet, x_handle FROM builders WHERE wallet = $1",
      [wallet],
    );
    const row = result.rows[0];
    return row
      ? { id: row.id, wallet: row.wallet, xHandle: row.x_handle }
      : null;
  },
  getProject: async (mint) => {
    const result = await query<ProjectDb>(
      "SELECT mint, builder_id, state FROM projects WHERE mint = $1",
      [mint],
    );
    return result.rows[0]?.state ?? null;
  },
  listProjectsByBuilder: async (builderId) => {
    const result = await query<ProjectDb>(
      "SELECT mint, builder_id, state FROM projects WHERE builder_id = $1 ORDER BY created_at DESC",
      [builderId],
    );
    return result.rows.map((row) => row.state);
  },
  saveProject: async (builderId, project) => {
    await query(
      `INSERT INTO projects (mint, builder_id, name, symbol, status, state)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (mint) DO UPDATE SET
         name = EXCLUDED.name,
         symbol = EXCLUDED.symbol,
         status = EXCLUDED.status,
         state = EXCLUDED.state`,
      [
        project.mint,
        builderId,
        project.name,
        project.symbol,
        project.status,
        JSON.stringify(project),
      ],
    );
  },
  appendEvents: async (events: EngineEvent[]) => {
    for (const event of events) {
      await query(
        "INSERT INTO feed_events (mint, kind, detail, at_ms) VALUES ($1, $2, $3::jsonb, $4)",
        [event.mint, event.kind, JSON.stringify(event.detail), event.atMs],
      );
    }
  },
  listFeed: async (limit, kinds) => {
    const result = await query<EventDb>(
      `SELECT id::text, mint, kind, detail, at_ms
       FROM feed_events
       WHERE ($2::text[] IS NULL OR kind = ANY($2::text[]))
       ORDER BY id DESC
       LIMIT $1`,
      [limit, kinds?.length ? kinds : null],
    );
    return result.rows.map((row): FeedRow => ({
      id: row.id,
      mint: row.mint,
      kind: row.kind,
      detail: row.detail,
      atMs: Number(row.at_ms),
    }));
  },
  listProjects: async () => {
    const result = await query<ProjectDb>(
      "SELECT mint, builder_id, state FROM projects",
    );
    return result.rows.map((row) => row.state);
  },
  listMessages: async (mint, limit) => {
    const result = await query<{
      id: string;
      mint: string;
      wallet: string;
      body: string;
      at_ms: string;
    }>(
      `SELECT id::text, mint, wallet, body, at_ms
       FROM (
         SELECT id, mint, wallet, body, at_ms
         FROM chat_messages
         WHERE mint = $1
         ORDER BY id DESC
         LIMIT $2
       ) recent
       ORDER BY id ASC`,
      [mint, limit],
    );
    return result.rows.map((row): ChatRow => ({
      id: row.id,
      mint: row.mint,
      wallet: row.wallet,
      text: row.body,
      atMs: Number(row.at_ms),
    }));
  },
  addMessage: async (mint, wallet, text, atMs) => {
    const result = await query<{ id: string }>(
      "INSERT INTO chat_messages (mint, wallet, body, at_ms) VALUES ($1, $2, $3, $4) RETURNING id::text",
      [mint, wallet, text, atMs],
    );
    return { id: result.rows[0].id, mint, wallet, text, atMs };
  },
  listVotesByWallet: async (wallet) => {
    const result = await query<{
      mint: string;
      promise_idx: number;
      wallet: string;
      side: "up" | "down";
      reason: string | null;
      message: string | null;
      signature: string | null;
    }>(
      `SELECT mint, promise_idx, wallet, side, reason, message, signature
       FROM holder_votes WHERE wallet = $1
       ORDER BY updated_at DESC`,
      [wallet],
    );
    return result.rows.map((row): HolderVoteRow => ({
      mint: row.mint,
      promiseIdx: Number(row.promise_idx),
      wallet: row.wallet,
      side: row.side === "down" ? "down" : "up",
      reason: row.reason ?? "",
      message: row.message ?? "",
      signature: row.signature ?? "",
    }));
  },
  listHolderVotes: async (mint) => {
    const result = await query<{
      mint: string;
      promise_idx: number;
      wallet: string;
      side: "up" | "down";
      reason: string | null;
      message: string | null;
      signature: string | null;
    }>(
      `SELECT mint, promise_idx, wallet, side, reason, message, signature
       FROM holder_votes WHERE mint = $1`,
      [mint],
    );
    return result.rows.map((row): HolderVoteRow => ({
      mint: row.mint,
      promiseIdx: Number(row.promise_idx),
      wallet: row.wallet,
      side: row.side === "down" ? "down" : "up",
      reason: row.reason ?? "",
      message: row.message ?? "",
      signature: row.signature ?? "",
    }));
  },
  upsertHolderVote: async (row) => {
    await query(
      `INSERT INTO holder_votes (mint, promise_idx, wallet, side, reason, message, signature)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (mint, promise_idx, wallet) DO UPDATE SET
         side = EXCLUDED.side,
         reason = EXCLUDED.reason,
         message = EXCLUDED.message,
         signature = EXCLUDED.signature,
         updated_at = now()`,
      [row.mint, row.promiseIdx, row.wallet, row.side, row.reason, row.message, row.signature],
    );
  },
});
