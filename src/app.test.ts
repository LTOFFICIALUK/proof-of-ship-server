import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { createMemoryAuth, signInMessage, verifyWalletSignature } from "./auth.js";
import { DEFAULT_SUPPLY, QUORUM_BPS, VOTE_WINDOW_MS } from "./engine/types.js";
import { buildApp } from "./app.js";
import { setPosQuoter } from "./pos.js";
import { createMemoryStore } from "./store/memory.js";

type App = Awaited<ReturnType<typeof buildApp>>;

const pair = () => {
  const keys = nacl.sign.keyPair();
  return { publicKey: bs58.encode(keys.publicKey), secretKey: keys.secretKey };
};

const sign = (message: string, secretKey: Uint8Array) =>
  Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), secretKey)).toString("base64");

const signIn = async (app: App, publicKey: string, secretKey: Uint8Array) => {
  const nonce = (await app.inject({ method: "GET", url: "/v1/auth/nonce" })).json().nonce as string;
  const message = signInMessage(publicKey, nonce, new Date().toISOString());
  const verified = await app.inject({
    method: "POST",
    url: "/v1/auth/verify",
    payload: { message, signature: sign(message, secretKey) },
  });
  assert.equal(verified.statusCode, 200);
  const cookie = verified.cookies.find((item) => item.name === "pos_session");
  assert.ok(cookie);
  return `pos_session=${cookie.value}`;
};

const vote = async (
  app: App,
  cookie: string,
  secretKey: Uint8Array,
  mint: string,
  side: "pay" | "burn",
  reason?: string,
) => {
  const prompt = await app.inject({
    method: "GET",
    url: `/v1/coins/${mint}/promises/0/vote-message?side=${side}`,
    headers: { cookie },
  });
  assert.equal(prompt.statusCode, 200);
  const { message, nonce } = prompt.json() as { message: string; nonce: string };
  return app.inject({
    method: "POST",
    url: `/v1/coins/${mint}/promises/0/vote`,
    headers: { cookie },
    payload: { side, reason, nonce, signature: sign(message, secretKey) },
  });
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const t0 = 1_800_000_000_000;
let clock = t0;

const quorum = () => (DEFAULT_SUPPLY * BigInt(QUORUM_BPS)) / 10_000n;

const launchBody = (title: string, deadlineMs: number) => ({
  name: `${title} Coin`,
  symbol: title.slice(0, 4).toUpperCase(),
  description: "Test coin",
  website: "https://example.com",
  devBuyBps: 100,
  promise: { title, doneLooksLike: "A public link works", proofType: "link", deadlineMs },
});

describe("http e2e", () => {
  let app: App;
  let auth: ReturnType<typeof createMemoryAuth>;

  const launch = async (handle: string, title: string, deadlineMs: number) => {
    const builder = pair();
    await auth.linkX(builder.publicKey, handle, handle);
    const session = await signIn(app, builder.publicKey, builder.secretKey);
    const launched = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: session },
      payload: launchBody(title, deadlineMs),
    });
    assert.equal(launched.statusCode, 200, launched.body);
    return { builder, session, mint: launched.json().mint as string };
  };

  const airdrop = (mint: string, wallet: string, amount: bigint) =>
    app.inject({
      method: "POST",
      url: "/v1/sim/airdrop",
      payload: { mint, wallet, amount: String(amount) },
    });

  const ship = (mint: string, session: string) =>
    app.inject({
      method: "POST",
      url: `/v1/projects/${mint}/promises/0/proof`,
      headers: { cookie: session },
      payload: { url: "https://github.com/proof", note: "done" },
    });

  before(async () => {
    setPosQuoter(async () => {
      throw new Error("not tradable");
    });
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

  it("launches, ships, takes a signed vote, pays, and publishes the tally", async () => {
    const { session, mint } = await launch("shipdev", "Public demo", t0 + 4 * DAY);
    const holder = pair();
    const holderSession = await signIn(app, holder.publicKey, holder.secretKey);

    const coin = (await app.inject({ method: "GET", url: `/v1/projects/${mint}` })).json();
    assert.equal(coin.verified, true);
    assert.equal(coin.profile.website, "https://example.com");
    assert.equal(coin.promises[0].doneLooksLike, "A public link works");
    assert.equal(coin.chain.vault, "");

    const fees = await app.inject({
      method: "POST",
      url: "/v1/sim/fees",
      payload: { mint, lamports: "1000000000" },
    });
    assert.equal(fees.json().vault.balance, "750000000");
    await airdrop(mint, holder.publicKey, quorum());

    const early = await vote(app, holderSession, holder.secretKey, mint, "pay").catch(() => null);
    assert.equal(early, null);

    assert.equal((await ship(mint, session)).statusCode, 200);
    assert.equal((await ship(mint, session)).statusCode, 400);

    const builderVote = await app.inject({
      method: "GET",
      url: `/v1/coins/${mint}/promises/0/vote-message?side=pay`,
      headers: { cookie: session },
    });
    const builderMessage = builderVote.json() as { message: string; nonce: string };
    const builderTry = await app.inject({
      method: "POST",
      url: `/v1/coins/${mint}/promises/0/vote`,
      headers: { cookie: session },
      payload: { side: "pay", nonce: builderMessage.nonce, signature: "x".repeat(88) },
    });
    assert.equal(builderTry.statusCode, 400);

    const cast = await vote(app, holderSession, holder.secretKey, mint, "pay");
    assert.equal(cast.statusCode, 200, cast.body);
    const live = cast.json();
    assert.equal(live.promises[0].netPct, null);
    assert.equal(live.promises[0].upPct, null);
    assert.equal(live.promises[0].turnoutPct, QUORUM_BPS / 100);
    assert.equal(live.promises[0].yourSide, "pay");
    assert.equal(live.viewer.weight, quorum().toString());

    const openTally = (
      await app.inject({ method: "GET", url: `/v1/coins/${mint}/promises/0/tally` })
    ).json();
    assert.equal(openTally.open, true);
    assert.equal(openTally.votes, undefined);

    clock = t0 + 2 * DAY + VOTE_WINDOW_MS;
    await app.inject({ method: "POST", url: "/v1/crank" });

    const page = (await app.inject({ method: "GET", url: `/v1/projects/${mint}` })).json();
    assert.equal(page.promises[0].status, "paid");
    assert.equal(page.vault.posBucket, "450000000");
    assert.equal(page.vault.released, "0");
    assert.equal(page.vault.posMint, "H49xNgg1hMV6LqXK6if2g8CYnrvp7CxQ5SJTnDRwPoS");
    assert.ok(page.promises[0].upPct > 0);

    const tally = await app.inject({
      method: "GET",
      url: `/v1/coins/${mint}/promises/0/tally?download=1`,
    });
    assert.match(String(tally.headers["content-disposition"]), /tally-publ-0\.json/);
    const closed = tally.json();
    assert.equal(closed.open, false);
    assert.equal(closed.votes.length, 1);
    const row = closed.votes[0];
    assert.equal(row.wallet, holder.publicKey);
    assert.equal(verifyWalletSignature(row.wallet, row.message, row.signature), true);

    const passport = (await app.inject({ method: "GET", url: "/v1/builders/shipdev" })).json();
    assert.equal(passport.stats.shipped, 1);
    assert.equal(passport.stats.onTimePct, 100);
    assert.equal(passport.timeline[0].status, "paid");

    const badge = await app.inject({ method: "GET", url: "/v1/builders/shipdev/badge.svg" });
    assert.equal(badge.headers["content-type"], "image/svg+xml");
    assert.match(badge.body, /1 shipped, 100% on time/);
    const coinBadge = await app.inject({ method: "GET", url: `/v1/badge/${mint}.svg` });
    assert.match(coinBadge.body, /\$PUBL/);

    const shippedFeed = (
      await app.inject({ method: "GET", url: "/v1/feed?scope=demo&filter=shipped" })
    ).json();
    assert.ok(shippedFeed.events.every((event: { kind: string }) => event.kind === "vote_pay"));
    const paidEvent = shippedFeed.events.find((event: { mint: string }) => event.mint === mint);
    assert.equal(paidEvent.symbol, "PUBL");
    assert.equal(paidEvent.amountSol, 0.45);
    assert.equal(paidEvent.sig, null);

    const shippedCoins = (
      await app.inject({ method: "GET", url: "/v1/coins?scope=demo&filter=shipped" })
    ).json();
    assert.ok(shippedCoins.coins.some((card: { mint: string }) => card.mint === mint));
    assert.deepEqual(
      shippedCoins.coins.find((card: { mint: string }) => card.mint === mint).record,
      ["paid"],
    );
    const publicCoins = (await app.inject({ method: "GET", url: "/v1/coins" })).json();
    assert.equal(publicCoins.total, 0);

    const stats = (await app.inject({ method: "GET", url: "/v1/stats?scope=demo" })).json();
    assert.ok(stats.shipped >= 1);
    assert.ok(stats.paidSol >= 0.45);

    const slugged = await app.inject({ method: "GET", url: `/v1/coins/${page.slug}` });
    assert.equal(slugged.json().mint, mint);

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
    const stranger = pair();
    const strangerSession = await signIn(app, stranger.publicKey, stranger.secretKey);
    const empty = await app.inject({
      method: "POST",
      url: `/v1/projects/${mint}/messages`,
      headers: { cookie: strangerSession },
      payload: { text: "no coins" },
    });
    assert.equal(empty.statusCode, 400);
  });

  it("weights by the lowest balance and keeps burn reasons", async () => {
    const { session, mint } = await launch("paydev", "Ship the demo", clock + 10 * DAY);
    const upVoter = pair();
    const downVoter = pair();
    const late = pair();
    const upSession = await signIn(app, upVoter.publicKey, upVoter.secretKey);
    const downSession = await signIn(app, downVoter.publicKey, downVoter.secretKey);
    const lateSession = await signIn(app, late.publicKey, late.secretKey);
    const two = (DEFAULT_SUPPLY * 200n) / 10_000n;
    const one = (DEFAULT_SUPPLY * 100n) / 10_000n;
    await airdrop(mint, upVoter.publicKey, two);
    await airdrop(mint, downVoter.publicKey, one);
    assert.equal((await ship(mint, session)).statusCode, 200);
    await airdrop(mint, late.publicKey, two);
    await airdrop(mint, upVoter.publicKey, two);

    const lateVote = await vote(app, lateSession, late.secretKey, mint, "burn");
    assert.equal(lateVote.statusCode, 400);
    assert.match(lateVote.json().error.message, /bought after/);

    const up = await vote(app, upSession, upVoter.secretKey, mint, "pay");
    assert.equal(up.statusCode, 200);
    assert.equal(up.json().viewer.weight, two.toString());
    const down = await vote(app, downSession, downVoter.secretKey, mint, "burn", "Demo link is dead");
    assert.equal(down.statusCode, 200);

    clock += VOTE_WINDOW_MS;
    await app.inject({ method: "POST", url: "/v1/crank" });
    const closed = (await app.inject({ method: "GET", url: `/v1/projects/${mint}` })).json();
    assert.equal(closed.promises[0].status, "paid");
    assert.equal(closed.promises[0].netPct, 1);
    const tally = (
      await app.inject({ method: "GET", url: `/v1/coins/${mint}/promises/0/tally` })
    ).json();
    const burnRow = tally.votes.find((row: { side: string }) => row.side === "burn");
    assert.equal(burnRow.reason, "Demo link is dead");
    assert.equal(tally.payWeight, two.toString());
  });

  it("rejects a forged vote and a replayed nonce", async () => {
    const { session, mint } = await launch("forgedev", "Forge test", clock + 5 * DAY);
    const holder = pair();
    const other = pair();
    const holderSession = await signIn(app, holder.publicKey, holder.secretKey);
    await airdrop(mint, holder.publicKey, quorum());
    await ship(mint, session);
    const prompt = (
      await app.inject({
        method: "GET",
        url: `/v1/coins/${mint}/promises/0/vote-message?side=pay`,
        headers: { cookie: holderSession },
      })
    ).json() as { message: string; nonce: string };
    const forged = await app.inject({
      method: "POST",
      url: `/v1/coins/${mint}/promises/0/vote`,
      headers: { cookie: holderSession },
      payload: { side: "pay", nonce: prompt.nonce, signature: sign(prompt.message, other.secretKey) },
    });
    assert.equal(forged.statusCode, 401);
    const swapped = await app.inject({
      method: "POST",
      url: `/v1/coins/${mint}/promises/0/vote`,
      headers: { cookie: holderSession },
      payload: { side: "burn", nonce: prompt.nonce, signature: sign(prompt.message, holder.secretKey) },
    });
    assert.equal(swapped.statusCode, 401);
    const good = {
      side: "pay",
      nonce: prompt.nonce,
      signature: sign(prompt.message, holder.secretKey),
    };
    const first = await app.inject({
      method: "POST",
      url: `/v1/coins/${mint}/promises/0/vote`,
      headers: { cookie: holderSession },
      payload: good,
    });
    assert.equal(first.statusCode, 200);
    const replay = await app.inject({
      method: "POST",
      url: `/v1/coins/${mint}/promises/0/vote`,
      headers: { cookie: holderSession },
      payload: good,
    });
    assert.equal(replay.statusCode, 401);
  });

  it("lets the builder post the next promise after a close and blocks overlap", async () => {
    const { session, mint } = await launch("nextdev", "First ship", clock + 4 * DAY);
    const overlap = await app.inject({
      method: "POST",
      url: `/v1/coins/${mint}/promises`,
      headers: { cookie: session },
      payload: { title: "Too soon", deadlineMs: clock + 6 * DAY },
    });
    assert.equal(overlap.statusCode, 400);
    clock += 5 * DAY;
    await app.inject({ method: "POST", url: "/v1/crank" });
    const missed = (await app.inject({ method: "GET", url: `/v1/projects/${mint}` })).json();
    assert.equal(missed.promises[0].status, "missed");
    assert.ok(missed.nextDueAtMs > clock);
    const next = await app.inject({
      method: "POST",
      url: `/v1/coins/${mint}/promises`,
      headers: { cookie: session },
      payload: {
        title: "Second ship",
        doneLooksLike: "Live on mainnet",
        proofType: "app",
        deadlineMs: clock + 5 * DAY,
      },
    });
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(next.json().promises[1].proofType, "app");
    const burned = (await app.inject({ method: "GET", url: "/v1/coins?scope=demo&filter=due" })).json();
    assert.ok(burned.coins.some((card: { mint: string }) => card.mint === mint));
  });

  it("rejects bad launches", async () => {
    const builder = pair();
    await auth.linkX(builder.publicKey, "3", "nopdev");
    const session = await signIn(app, builder.publicKey, builder.secretKey);
    const noPromise = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: session },
      payload: { name: "Nope", symbol: "NOPE" },
    });
    assert.equal(noPromise.statusCode, 400);
    const longTitle = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: session },
      payload: launchBody("x".repeat(81), clock + 4 * DAY),
    });
    assert.equal(longTitle.statusCode, 400);
    const badLink = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: session },
      payload: { ...launchBody("Links", clock + 4 * DAY), website: "javascript:alert(1)" },
    });
    assert.equal(badLink.statusCode, 400);
    const bigDevBuy = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: session },
      payload: { ...launchBody("Dev", clock + 4 * DAY), devBuyBps: 400 },
    });
    assert.equal(bigDevBuy.statusCode, 400);
  });

  it("accepts a dropped image data URL", async () => {
    const builder = pair();
    await auth.linkX(builder.publicKey, "imgdev", "imgdev");
    const session = await signIn(app, builder.publicKey, builder.secretKey);
    const pixel =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const ok = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: session },
      payload: { ...launchBody("Image", clock + 4 * DAY), image: pixel },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().profile.image, pixel);
    const bad = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: session },
      payload: { ...launchBody("Badimg", clock + 4 * DAY), image: "data:text/html;base64,PHNjcmlwdD4=" },
    });
    assert.equal(bad.statusCode, 400);
  });

  it("builds launch steps, submits a demo launch, and serves badges", async () => {
    const builder = pair();
    await auth.linkX(builder.publicKey, "launchdev", "launchdev");
    const session = await signIn(app, builder.publicKey, builder.secretKey);
    const unsigned = await app.inject({
      method: "POST",
      url: "/v1/launch/build",
      payload: launchBody("Wizard", clock + 4 * DAY),
    });
    assert.equal(unsigned.statusCode, 401);
    const built = await app.inject({
      method: "POST",
      url: "/v1/launch/build",
      headers: { cookie: session },
      payload: launchBody("Wizard", clock + 4 * DAY),
    });
    assert.equal(built.statusCode, 200, built.body);
    assert.equal(built.json().mode, "demo");
    assert.equal(built.json().steps.length, 5);
    const submitted = await app.inject({
      method: "POST",
      url: "/v1/launch/submit",
      headers: { cookie: session },
      payload: launchBody("Wizard", clock + 4 * DAY),
    });
    assert.equal(submitted.statusCode, 200, submitted.body);
    const mint = submitted.json().mint as string;
    const status = await app.inject({ method: "GET", url: `/v1/launch/${mint}/status` });
    assert.equal(status.json().listed, true);
    const card = await app.inject({ method: "GET", url: `/v1/coins/${mint}/card.svg` });
    assert.equal(card.statusCode, 200);
    assert.match(card.headers["content-type"] ?? "", /svg/);
    const badge = await app.inject({ method: "GET", url: "/v1/builders/launchdev/badge.svg" });
    assert.equal(badge.statusCode, 200);
    assert.match(badge.body, /@launchdev/);
  });

  it("rejects a write with no session and a signature for the wrong wallet", async () => {
    const open = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: launchBody("Open", t0 + DAY),
    });
    assert.equal(open.statusCode, 401);

    const real = pair();
    const other = pair();
    const nonce = (await app.inject({ method: "GET", url: "/v1/auth/nonce" })).json().nonce as string;
    const message = signInMessage(other.publicKey, nonce, new Date().toISOString());
    const forged = await app.inject({
      method: "POST",
      url: "/v1/auth/verify",
      payload: { message, signature: sign(message, real.secretKey) },
    });
    assert.equal(forged.statusCode, 401);
  });
});
