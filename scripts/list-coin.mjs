import { createProject } from "../dist/engine/vault.js";
import { createPgStore } from "../dist/store/pg.js";
import { destinations } from "../dist/wallets.js";
import { markMintUsed } from "../dist/mint-bank.js";
import { pool } from "../dist/db.js";

const mint = "gaZFXHXgMtPiCEqhYDGpZACDbxupARTdciaXU8JsPoS";
const wallet = "9Yf4PRtrcXFMR5jjmJcJmfQ3yqDC22hbHW4N9nKWtmGa";
const postedAtMs = Date.parse("2026-10-03T01:22:43.000Z");
const image = "https://gateway.pinata.cloud/ipfs/bafkreifhkj5rqdigoyxhitvqz3fz7rjieeg63iutkkg37vzalib2vn3mza";

const store = createPgStore();
const existing = await store.getProject(mint);
if (existing) {
  console.log("already listed", existing.symbol);
  await pool.end();
  process.exit(0);
}

const builder = await store.upsertBuilder(wallet, "ir3tail");
const created = createProject({
  mint,
  name: "test",
  symbol: "TEST",
  builderWallet: wallet,
  xHandle: "ir3tail",
  nowMs: postedAtMs,
  devBuyBps: 10,
  promises: [{ text: "test", deadlineMs: postedAtMs + 7 * 24 * 60 * 60 * 1000, proofType: "link" }],
});
created.project.verified = true;
created.project.demo = false;
created.project.chain = destinations();
created.project.profile = {
  description: "test",
  website: "",
  github: "",
  image,
  devBuyBps: 10,
};
await store.saveProject(builder.id, created.project);
await store.appendEvents(created.events);
await markMintUsed(mint);
console.log("listed", mint);
await pool.end();
