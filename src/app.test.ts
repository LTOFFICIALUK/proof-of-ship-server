import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { createMemoryAuth, signInMessage } from "./auth.js";
import { DEFAULT_SUPPLY, QUORUM_BPS, VOTE_WINDOW_MS } from "./engine/types.js";
import { buildApp } from "./app.js";
import { createMemoryStore } from "./store/memory.js";

const pair = () => {
  const keys = nacl.sign.keyPair();
  return { publicKey: bs58.encode(keys.publicKey), secretKey: keys.secretKey };
};

const signIn = async (
  app: Awaited<ReturnType<typeof buildApp>>,
  publicKey: string,
  secretKey: Uint8Array,
) => {
  const nonce = (await app.inject({ method: "GET", url: "/v1/auth/nonce" })).json().nonce as string;
  const message = signInMessage(publicKey, nonce, new Date().toISOString());
  const signature = Buffer.from(
    nacl.sign.detached(new TextEncoder().encode(message), secretKey),
  ).toString("base64");
  const verified = await app.inject({
    method: "POST",
    url: "/v1/auth/verify",
    payload: { message, signature },
  });
  assert.equal(verified.statusCode, 200);
  const cookie = verified.cookies.find((item) => item.name === "pos_session");
  assert.ok(cookie);
  return `pos_session=${cookie.value}`;
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const t0 = 1_800_000_000_000;
let clock = t0;

const quorum = () => (DEFAULT_SUPPLY * BigInt(QUORUM_BPS)) / 10_000n;

describe("http e2e", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let auth: ReturnType<typeof createMemoryAuth>;

  before(async () => {
    clock = t0;
    auth = createMemoryAuth();
    app = await buildApp({
      store: createMemoryStore(),
      allowSim: true,
      frontendOrigin: "*",
      now: () => clock,
      auth,
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("launches, credits fees, votes pay, and serves the ship page", async () => {
    const builder = pair();
    const holder = pair();
    await auth.linkX(builder.publicKey, "1", "shipdev");
    const session = await signIn(app, builder.publicKey, builder.secretKey);
    const holderSession = await signIn(app, holder.publicKey, holder.secretKey);
    const launched = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: session },
      payload: {
        name: "Ship Coin",
        symbol: "SHIP",
        promises: [
          {
            text: "Public demo",
            deadlineMs: t0 + 2 * DAY,
          },
        ],
      },
    });
    assert.equal(launched.statusCode, 200);
    const body = launched.json();
    assert.equal(body.symbol, "SHIP");
    assert.equal(body.promises.length, 1);
    const mint = body.mint;

    const fees = await app.inject({
      method: "POST",
      url: "/v1/sim/fees",
      payload: { mint, lamports: "1000000000" },
    });
    assert.equal(fees.statusCode, 200);
    assert.equal(fees.json().vault.balance, "750000000");

    await app.inject({
      method: "POST",
      url: "/v1/sim/airdrop",
      payload: { mint, wallet: holder.publicKey, amount: String(quorum()) },
    });

    const vote = await app.inject({
      method: "POST",
      url: `/v1/projects/${mint}/promises/0/vote`,
      headers: { cookie: holderSession },
      payload: { side: "up" },
    });
    assert.equal(vote.statusCode, 200);

    clock = t0 + 2 * DAY;
    await app.inject({ method: "POST", url: "/v1/crank" });
    clock = t0 + 2 * DAY + VOTE_WINDOW_MS;
    await app.inject({ method: "POST", url: "/v1/crank" });

    const page = await app.inject({ method: "GET", url: `/v1/projects/${mint}` });
    assert.equal(page.json().promises[0].status, "paid");
    assert.equal(page.json().vault.released, "750000000");

    const passport = await app.inject({
      method: "GET",
      url: "/v1/builders/shipdev",
    });
    assert.equal(passport.json().stats.paid, 1);

    const feed = await app.inject({ method: "GET", url: "/v1/feed?scope=demo" });
    assert.ok(feed.json().events.length >= 2);

    const coins = await app.inject({ method: "GET", url: "/v1/projects?scope=demo" });
    assert.equal(coins.statusCode, 200);
    const slug = coins.json().projects.find((item: { mint: string }) => item.mint === mint).slug;
    const coin = await app.inject({ method: "GET", url: `/v1/coins/${slug}` });
    assert.equal(coin.statusCode, 200);
    assert.equal(coin.json().mint, mint);

    const lockedChat = await app.inject({
      method: "POST",
      url: `/v1/projects/${mint}/messages`,
      payload: { text: "hello" },
    });
    assert.equal(lockedChat.statusCode, 401);

    const chat = await app.inject({
      method: "POST",
      url: `/v1/projects/${mint}/messages`,
      headers: { cookie: holderSession },
      payload: { text: "holders only" },
    });
    assert.equal(chat.statusCode, 200);
    const thread = await app.inject({
      method: "GET",
      url: `/v1/projects/${mint}/messages`,
    });
    assert.equal(thread.json().messages.at(-1).text, "holders only");
    const stranger = pair();
    const strangerSession = await signIn(app, stranger.publicKey, stranger.secretKey);
    const empty = await app.inject({
      method: "POST",
      url: `/v1/projects/${mint}/messages`,
      headers: { cookie: strangerSession },
      payload: { text: "no coins" },
    });
    assert.equal(empty.statusCode, 400);

    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.json().ok, true);
  });

  it("weights holder votes by supply", async () => {
    const builder = pair();
    const upVoter = pair();
    const downVoter = pair();
    await auth.linkX(builder.publicKey, "2", "paydev");
    const session = await signIn(app, builder.publicKey, builder.secretKey);
    const upSession = await signIn(app, upVoter.publicKey, upVoter.secretKey);
    const downSession = await signIn(app, downVoter.publicKey, downVoter.secretKey);
    const launched = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: session },
      payload: {
        name: "Pay Coin",
        symbol: "PAY",
        promises: [{ text: "Ship the demo", deadlineMs: t0 + 10 * DAY }],
      },
    });
    assert.equal(launched.statusCode, 200);
    const mint = launched.json().mint;
    const two = (DEFAULT_SUPPLY * 200n) / 10_000n;
    const one = (DEFAULT_SUPPLY * 100n) / 10_000n;
    await app.inject({
      method: "POST",
      url: "/v1/sim/airdrop",
      payload: { mint, wallet: upVoter.publicKey, amount: String(two) },
    });
    await app.inject({
      method: "POST",
      url: "/v1/sim/airdrop",
      payload: { mint, wallet: downVoter.publicKey, amount: String(one) },
    });
    const up = await app.inject({
      method: "POST",
      url: `/v1/projects/${mint}/promises/0/vote`,
      headers: { cookie: upSession },
      payload: { side: "up" },
    });
    assert.equal(up.statusCode, 200);
    const down = await app.inject({
      method: "POST",
      url: `/v1/projects/${mint}/promises/0/vote`,
      headers: { cookie: downSession },
      payload: { side: "down" },
    });
    assert.equal(down.statusCode, 200);
    assert.equal(down.json().promises[0].netPct, 1);
  });

  it("rejects a launch with no promises", async () => {
    const builder = pair();
    await auth.linkX(builder.publicKey, "3", "nopdev");
    const session = await signIn(app, builder.publicKey, builder.secretKey);
    const res = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: session },
      payload: {
        name: "Nope",
        symbol: "NOPE",
        promises: [],
      },
    });
    assert.equal(res.statusCode, 400);
  });

  it("rejects a write with no session and a signature for the wrong wallet", async () => {
    const open = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "Nope", symbol: "NO", promises: [{ text: "x", deadlineMs: t0 + DAY }] },
    });
    assert.equal(open.statusCode, 401);

    const real = pair();
    const other = pair();
    const nonce = (await app.inject({ method: "GET", url: "/v1/auth/nonce" })).json().nonce as string;
    const message = signInMessage(other.publicKey, nonce, new Date().toISOString());
    const signature = Buffer.from(
      nacl.sign.detached(new TextEncoder().encode(message), real.secretKey),
    ).toString("base64");
    const forged = await app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { message, signature },
    });
    assert.equal(forged.statusCode, 401);
  });
});
