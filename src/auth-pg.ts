import { query } from "./db.js";
import type { AuthStore, OauthPending, XLink } from "./auth.js";

export const createPgAuth = (): AuthStore => ({
  putNonce: async (nonce, expiresAt) => {
    await query(
      "INSERT INTO auth_nonces (nonce, expires_at) VALUES ($1, to_timestamp($2 / 1000.0))",
      [nonce, expiresAt],
    );
  },
  takeNonce: async (nonce, now) => {
    const result = await query<{ nonce: string }>(
      "DELETE FROM auth_nonces WHERE nonce = $1 AND expires_at > to_timestamp($2 / 1000.0) RETURNING nonce",
      [nonce, now],
    );
    return Boolean(result.rowCount);
  },
  putSession: async (id, wallet, expiresAt) => {
    await query(
      `INSERT INTO auth_sessions (id, wallet, expires_at)
       VALUES ($1, $2, to_timestamp($3 / 1000.0))
       ON CONFLICT (id) DO UPDATE SET wallet = EXCLUDED.wallet, expires_at = EXCLUDED.expires_at`,
      [id, wallet, expiresAt],
    );
  },
  getSession: async (id, now) => {
    const result = await query<{ wallet: string }>(
      "SELECT wallet FROM auth_sessions WHERE id = $1 AND expires_at > to_timestamp($2 / 1000.0)",
      [id, now],
    );
    return result.rows[0]?.wallet ?? null;
  },
  deleteSession: async (id) => {
    await query("DELETE FROM auth_sessions WHERE id = $1", [id]);
  },
  linkX: async (wallet, xUserId, xHandle) => {
    const handle = xHandle.replace(/^@/, "");
    const taken = await query<{ wallet: string }>(
      "SELECT wallet FROM x_links WHERE wallet <> $1 AND (x_user_id = $2 OR x_handle = $3)",
      [wallet, xUserId, handle],
    );
    if (taken.rowCount) {
      throw new Error("X account already linked");
    }
    await query(
      `INSERT INTO x_links (wallet, x_user_id, x_handle)
       VALUES ($1, $2, $3)
       ON CONFLICT (wallet) DO UPDATE SET x_user_id = EXCLUDED.x_user_id, x_handle = EXCLUDED.x_handle`,
      [wallet, xUserId, handle],
    );
  },
  getX: async (wallet) => {
    const result = await query<XLink & { x_user_id: string; x_handle: string }>(
      "SELECT x_user_id, x_handle FROM x_links WHERE wallet = $1",
      [wallet],
    );
    const row = result.rows[0];
    return row ? { xUserId: row.x_user_id, xHandle: row.x_handle } : null;
  },
  putOauth: async (state, pending) => {
    await query(
      `INSERT INTO oauth_states (state, wallet, verifier, expires_at)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))`,
      [state, pending.wallet, pending.verifier, pending.expiresAt],
    );
  },
  takeOauth: async (state, now) => {
    const result = await query<{ wallet: string; verifier: string }>(
      `DELETE FROM oauth_states
       WHERE state = $1 AND expires_at > to_timestamp($2 / 1000.0)
       RETURNING wallet, verifier`,
      [state, now],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const pending: OauthPending = { wallet: row.wallet, verifier: row.verifier, expiresAt: now + 1 };
    return pending;
  },
});
