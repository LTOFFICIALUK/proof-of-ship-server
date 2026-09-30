import assert from "node:assert/strict";
import {
  DEFAULT_SUPPLY,
  GRACE_MS,
  QUORUM_BPS,
  VOTE_WINDOW_MS,
} from "../src/engine/types.js";
import { nowMs, setNowMs } from "../src/clock.js";
import { buildApp } from "../src/app.js";
import { createMemoryStore } from "../src/store/memory.js";

const DAY = 24 * 60 * 60 * 1000;
const QUORUM = (DEFAULT_SUPPLY * BigInt(QUORUM_BPS)) / 10_000n;

type Body = Record<string, unknown>;

type Client = {
  setClock: (at: number) => void;
  get: (url: string) => Promise<{ status: number; json: () => Body }>;
  post: (url: string, payload?: Body) => Promise<{ status: number; json: () => Body }>;
};

const wallet = (tag: string) => {
  const clean = tag.replace(/[^1-9A-HJ-NP-Za-km-z]/g, "2");
  return (`2${clean}2222222222222222222222222222222222222222`).slice(0, 44);
};

let n = 0;
const handle = () => {
  n += 1;
  return `e2e${Date.now().toString(36)}${n}`.slice(0, 32);
};

const expect = (status: number, got: number, label: string) => {
  assert.equal(got, status, `${label}: expected ${status} got ${got}`);
};

const crankMint = (client: Client, mint: string) =>
  client.post("/v1/crank", { mint });

const runSuite = async (client: Client, t0: number) => {
  const builder = wallet(`b${t0}`);
  const voter = wallet(`v${t0}`);
  const voter2 = wallet(`w${t0}`);
  client.setClock(t0);

  const rejected = await client.post("/v1/projects", {
    wallet: builder,
    xHandle: handle(),
    name: "Nope",
    symbol: "NOPE",
    promises: [],
  });
  expect(400, rejected.status, "empty promises");

  const launched = await client.post("/v1/projects", {
    wallet: builder,
    xHandle: handle(),
    name: "Pay Coin",
    symbol: "PAY",
    promises: [{ text: "Ship the demo", deadlineMs: t0 + 2 * DAY }],
  });
  expect(200, launched.status, "launch pay coin");
  const payMint = String(launched.json().mint);

  const fees = await client.post("/v1/sim/fees", {
    mint: payMint,
    lamports: "1000000000",
  });
  expect(200, fees.status, "credit fees");
  const vault = fees.json().vault as Body;
  assert.equal(vault.balance, "750000000", "75 percent vault");
  assert.equal(vault.runwaySol, 0.15, "15 percent runway");
  assert.equal(vault.platformSol, 0.1, "10 percent platform");

  await client.post("/v1/sim/airdrop", {
    mint: payMint,
    wallet: voter,
    amount: String(QUORUM),
  });
  client.setClock(t0 + 2 * DAY);
  await crankMint(client, payMint);
  const open = await client.get(`/v1/projects/${payMint}`);
  assert.ok(open.json().vote, "vote should be open");

  expect(
    200,
    (
      await client.post(`/v1/projects/${payMint}/vote`, {
        wallet: voter,
        side: "pay",
        amount: String(QUORUM),
      })
    ).status,
    "cast pay vote",
  );

  client.setClock(t0 + 2 * DAY + VOTE_WINDOW_MS);
  await crankMint(client, payMint);
  const paid = await client.get(`/v1/projects/${payMint}`);
  const promises = paid.json().promises as Body[];
  assert.equal(promises[0].status, "paid", "pay vote should pay the builder");
  assert.equal((paid.json().vault as Body).released, "750000000");

  const passport = await client.get(`/v1/builders/${String(paid.json().xHandle)}`);
  expect(200, passport.status, "passport");
  assert.equal((passport.json().stats as Body).paid, 1);

  client.setClock(t0);
  const burnBuilder = wallet(`bb${t0}`);
  const burnLaunch = await client.post("/v1/projects", {
    wallet: burnBuilder,
    xHandle: handle(),
    name: "Burn Coin",
    symbol: "BRN",
    promises: [{ text: "Miss this", deadlineMs: t0 + 2 * DAY }],
  });
  const burnMint = String(burnLaunch.json().mint);
  await client.post("/v1/sim/fees", { mint: burnMint, lamports: "1000000000" });
  await client.post("/v1/sim/airdrop", {
    mint: burnMint,
    wallet: voter2,
    amount: String(QUORUM),
  });
  client.setClock(t0 + 2 * DAY);
  await crankMint(client, burnMint);
  await client.post(`/v1/projects/${burnMint}/vote`, {
    wallet: voter2,
    side: "burn",
    amount: String(QUORUM),
  });
  client.setClock(t0 + 2 * DAY + VOTE_WINDOW_MS);
  await crankMint(client, burnMint);
  const burned = await client.get(`/v1/projects/${burnMint}`);
  assert.equal((burned.json().promises as Body[])[0].status, "burned");
  assert.equal((burned.json().vault as Body).burned, "750000000");

  client.setClock(t0);
  const qBuilder = wallet(`q${t0}`);
  const qVoter = wallet(`qv${t0}`);
  const qLaunch = await client.post("/v1/projects", {
    wallet: qBuilder,
    xHandle: handle(),
    name: "Quorum Coin",
    symbol: "QRM",
    promises: [{ text: "Need turnout", deadlineMs: t0 + 2 * DAY }],
  });
  const qMint = String(qLaunch.json().mint);
  await client.post("/v1/sim/fees", { mint: qMint, lamports: "1000000000" });
  await client.post("/v1/sim/airdrop", {
    mint: qMint,
    wallet: qVoter,
    amount: "1",
  });
  client.setClock(t0 + 2 * DAY);
  await crankMint(client, qMint);
  await client.post(`/v1/projects/${qMint}/vote`, {
    wallet: qVoter,
    side: "pay",
    amount: "1",
  });
  client.setClock(t0 + 2 * DAY + VOTE_WINDOW_MS);
  await crankMint(client, qMint);
  const firstFail = await client.get(`/v1/projects/${qMint}`);
  assert.equal((firstFail.json().promises as Body[])[0].status, "no_quorum");
  assert.equal((firstFail.json().vault as Body).balance, "750000000");

  await crankMint(client, qMint);
  await client.post(`/v1/projects/${qMint}/vote`, {
    wallet: qVoter,
    side: "pay",
    amount: "1",
  });
  client.setClock(t0 + 2 * DAY + 2 * VOTE_WINDOW_MS + 1);
  await crankMint(client, qMint);
  const secondFail = await client.get(`/v1/projects/${qMint}`);
  assert.equal((secondFail.json().promises as Body[])[0].status, "burned");
  assert.equal((secondFail.json().vault as Body).burned, "750000000");

  client.setClock(t0);
  const lapseBuilder = wallet(`l${t0}`);
  const lapseVoter = wallet(`lv${t0}`);
  const lapseLaunch = await client.post("/v1/projects", {
    wallet: lapseBuilder,
    xHandle: handle(),
    name: "Lapse Coin",
    symbol: "LPS",
    promises: [{ text: "Only one", deadlineMs: t0 + 2 * DAY }],
  });
  const lapseMint = String(lapseLaunch.json().mint);
  await client.post("/v1/sim/fees", { mint: lapseMint, lamports: "1000000000" });
  await client.post("/v1/sim/airdrop", {
    mint: lapseMint,
    wallet: lapseVoter,
    amount: String(QUORUM),
  });
  client.setClock(t0 + 2 * DAY);
  await crankMint(client, lapseMint);
  await client.post(`/v1/projects/${lapseMint}/vote`, {
    wallet: lapseVoter,
    side: "pay",
    amount: String(QUORUM),
  });
  client.setClock(t0 + 2 * DAY + VOTE_WINDOW_MS);
  await crankMint(client, lapseMint);
  await client.post("/v1/sim/fees", { mint: lapseMint, lamports: "1000000000" });
  client.setClock(t0 + 2 * DAY + VOTE_WINDOW_MS + GRACE_MS);
  await crankMint(client, lapseMint);
  const lapsed = await client.get(`/v1/projects/${lapseMint}`);
  assert.equal(lapsed.json().status, "lapsed");
  const more = await client.post("/v1/sim/fees", {
    mint: lapseMint,
    lamports: "1000000000",
  });
  assert.equal((more.json().vault as Body).balance, "0");
  assert.ok(Number((more.json().vault as Body).burned) >= 750000000);

  const resumeAt = t0 + 2 * DAY + VOTE_WINDOW_MS + GRACE_MS + DAY;
  client.setClock(resumeAt);
  const appended = await client.post(`/v1/projects/${lapseMint}/promises`, {
    wallet: lapseBuilder,
    text: "Back to work",
    deadlineMs: resumeAt + 2 * DAY,
  });
  expect(200, appended.status, "append after lapse");
  assert.equal(appended.json().status, "active");
  const after = await client.post("/v1/sim/fees", {
    mint: lapseMint,
    lamports: "1000000000",
  });
  assert.equal((after.json().vault as Body).balance, "750000000");

  client.setClock(t0);
  const abBuilder = wallet(`a${t0}`);
  const abLaunch = await client.post("/v1/projects", {
    wallet: abBuilder,
    xHandle: handle(),
    name: "Abandon Coin",
    symbol: "ABD",
    promises: [{ text: "Walking away", deadlineMs: t0 + 2 * DAY }],
  });
  const abMint = String(abLaunch.json().mint);
  await client.post("/v1/sim/fees", { mint: abMint, lamports: "1000000000" });
  const abandoned = await client.post(`/v1/projects/${abMint}/abandon`, {
    wallet: abBuilder,
  });
  expect(200, abandoned.status, "abandon");
  assert.equal(abandoned.json().status, "abandoned");
  assert.equal((abandoned.json().vault as Body).burned, "750000000");

  client.setClock(t0);
  const queuedBuilder = wallet(`qq${t0}`);
  const queuedVoter = wallet(`qqv${t0}`);
  const queued = await client.post("/v1/projects", {
    wallet: queuedBuilder,
    xHandle: handle(),
    name: "Queued Coin",
    symbol: "QUE",
    promises: [
      { text: "First", deadlineMs: t0 + 2 * DAY },
      { text: "Second", deadlineMs: t0 + 8 * DAY },
    ],
  });
  const queuedMint = String(queued.json().mint);
  await client.post("/v1/sim/airdrop", {
    mint: queuedMint,
    wallet: queuedVoter,
    amount: String(QUORUM),
  });
  client.setClock(t0 + 2 * DAY);
  await crankMint(client, queuedMint);
  await client.post(`/v1/projects/${queuedMint}/vote`, {
    wallet: queuedVoter,
    side: "pay",
    amount: String(QUORUM),
  });
  client.setClock(t0 + 2 * DAY + VOTE_WINDOW_MS + GRACE_MS);
  await crankMint(client, queuedMint);
  const stillActive = await client.get(`/v1/projects/${queuedMint}`);
  assert.equal(
    stillActive.json().status,
    "active",
    "queued next promise should not lapse",
  );

  const feed = await client.get("/v1/feed");
  expect(200, feed.status, "feed");
  assert.ok(Array.isArray(feed.json().events));
  expect(200, (await client.get("/health")).status, "health");
};

const httpClient = (base: string, start: number): Client => {
  let clock = start;
  const send = async (method: "GET" | "POST", url: string, payload?: Body) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-sim-now": String(clock),
      },
      body: method === "GET" ? undefined : JSON.stringify(payload ?? {}),
    });
    const data = (await response.json()) as Body;
    return { status: response.status, json: () => data };
  };
  return {
    setClock: (at) => {
      clock = at;
    },
    get: (url) => send("GET", url),
    post: (url, payload) => send("POST", url, payload),
  };
};

const checkSite = async (origin: string) => {
  const pages = ["/", "/launch", "/how", "/feed"];
  for (const path of pages) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, `site ${path}`);
    const html = await response.text();
    assert.ok(html.includes("Proof of Ship"), `site ${path} should render`);
  }
  const feed = await fetch(`${origin}/api/v1/feed`);
  assert.equal(feed.status, 200, "site feed proxy");
};

const main = async () => {
  const api = process.env.API_URL;
  const site = process.env.SITE_URL;
  const t0 = 1_900_000_000_000;

  console.log("local memory simulation");
  setNowMs(null);
  const app = await buildApp({
    store: createMemoryStore(),
    allowSim: true,
    frontendOrigin: "*",
    now: nowMs,
  });
  await app.ready();
  let clock = t0;
  const local: Client = {
    setClock: (at) => {
      clock = at;
    },
    get: async (url) => {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { "x-sim-now": String(clock) },
      });
      return { status: res.statusCode, json: () => res.json() as Body };
    },
    post: async (url, payload) => {
      const res = await app.inject({
        method: "POST",
        url,
        payload: payload ?? {},
        headers: { "x-sim-now": String(clock) },
      });
      return { status: res.statusCode, json: () => res.json() as Body };
    },
  };
  await runSuite(local, t0);
  await app.close();
  setNowMs(null);
  console.log("local memory simulation passed");

  if (api) {
    console.log("live API simulation", api);
    await runSuite(httpClient(api.replace(/\/$/, ""), t0 + DAY), t0 + DAY);
    console.log("live API simulation passed");
  }

  if (site) {
    console.log("live site checks", site);
    await checkSite(site.replace(/\/$/, ""));
    console.log("live site checks passed");
  }
};

main().catch((error) => {
  setNowMs(null);
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
