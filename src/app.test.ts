import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { DEFAULT_SUPPLY, QUORUM_BPS, VOTE_WINDOW_MS } from "./engine/types.js";
import { buildApp } from "./app.js";
import { createMemoryStore } from "./store/memory.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const t0 = 1_800_000_000_000;
let clock = t0;

const wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const voter = "9xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

const quorum = () => (DEFAULT_SUPPLY * BigInt(QUORUM_BPS)) / 10_000n;

describe("http e2e", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  before(async () => {
    clock = t0;
    app = await buildApp({
      store: createMemoryStore(),
      allowSim: true,
      frontendOrigin: "*",
      now: () => clock,
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it("launches, credits fees, votes pay, and serves the ship page", async () => {
    const launched = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        wallet,
        xHandle: "shipdev",
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
      payload: { mint, wallet: voter, amount: String(quorum()) },
    });

    clock = t0 + 2 * DAY;
    await app.inject({ method: "POST", url: "/v1/crank" });

    const vote = await app.inject({
      method: "POST",
      url: `/v1/projects/${mint}/vote`,
      payload: { wallet: voter, side: "pay", amount: String(quorum()) },
    });
    assert.equal(vote.statusCode, 200);
    assert.ok(vote.json().vote);

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

    const feed = await app.inject({ method: "GET", url: "/v1/feed" });
    assert.ok(feed.json().events.length >= 2);

    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.json().ok, true);
  });

  it("rejects a launch with no promises", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        wallet,
        xHandle: "shipdev",
        name: "Nope",
        symbol: "NOPE",
        promises: [],
      },
    });
    assert.equal(res.statusCode, 400);
  });
});
