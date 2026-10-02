import { randomBytes } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { z } from "zod";
import {
  codeChallenge,
  createMemoryAuth,
  newNonce,
  newSessionId,
  verifySignIn,
  type AuthStore,
} from "./auth.js";
import { EngineError } from "./engine/types.js";
import {
  abandon,
  airdrop,
  appendPromise,
  crank,
  createProject,
  creditFees,
  markShipped,
} from "./engine/vault.js";
import { getNowMs, setNowMs } from "./clock.js";
import { HttpError, badRequest, notFound, unauthorized } from "./lib/errors.js";
import { balanceOf, loadHoldings, tallyVotes } from "./holdings.js";
import { loadMarket } from "./market.js";
import { coinSlug, presentBuilder, presentFeed, presentProject } from "./presenters.js";
import { advanceProject } from "./settle.js";
import type { ShipStore } from "./store/memory.js";

const walletSchema = z
  .string()
  .min(32)
  .max(44)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/);

const promiseSchema = z.object({
  text: z.string().min(1).max(280),
  deadlineMs: z.number().int().positive(),
});

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const fakeMint = () => {
  const bytes = randomBytes(32);
  let out = "";
  for (let i = 0; i < 44; i += 1) {
    out += BASE58[bytes[i % 32] % BASE58.length];
  }
  return out;
};

const loadProject = async (store: ShipStore, mint: string) => {
  const project = await store.getProject(mint);
  if (!project) {
    throw notFound("No coin with that mint");
  }
  return project;
};

const presentLive = async (
  store: ShipStore,
  project: Awaited<ReturnType<ShipStore["getProject"]>> & object,
  nowMs: number,
  viewer?: string,
) => {
  const view = presentProject(project, nowMs);
  const votes = await store.listHolderVotes(project.mint);
  const holdings = await loadHoldings(
    project,
    [...new Set(votes.map((row) => row.wallet))],
  );
  const market = await loadMarket(project.mint);
  return {
    ...view,
    market,
    promises: view.promises.map((item) => {
      const rows = votes.filter((row) => row.promiseIdx === item.idx);
      const tally = holdings.ok
        ? tallyVotes(rows, holdings.balances, holdings.supply)
        : { upPct: 0, downPct: 0, netPct: 0 };
      return {
        ...item,
        upPct: item.status === "vote_open" ? null : tally.upPct,
        downPct: item.status === "vote_open" ? null : tally.downPct,
        turnoutPct: tally.upPct + tally.downPct,
        netPct:
          item.status === "vote_open"
            ? null
            : rows.length
              ? holdings.ok
                ? tally.netPct
                : null
              : item.resultNet ?? (holdings.ok ? tally.netPct : null),
        yourSide: rows.find((row) => row.wallet === viewer)?.side ?? null,
      };
    }),
  };
};

const persist = async (
  store: ShipStore,
  builderId: string,
  project: ReturnType<typeof createProject>["project"],
  events: Parameters<ShipStore["appendEvents"]>[0],
) => {
  await store.saveProject(builderId, project);
  if (events.length) {
    await store.appendEvents(events);
  }
};

export type AppOptions = {
  store: ShipStore;
  allowSim: boolean;
  frontendOrigin: string;
  now?: () => number;
  auth?: AuthStore;
};

export const buildApp = async (opts: AppOptions) => {
  const now = opts.now ?? (() => Date.now());
  const at = (request: FastifyRequest) => {
    if (opts.allowSim) {
      const header = request.headers["x-sim-now"];
      const raw = Array.isArray(header) ? header[0] : header;
      const value = raw ? Number(raw) : NaN;
      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    }
    return now();
  };
  const auth = opts.auth ?? createMemoryAuth();
  const lastChat = new Map<string, number>();
  const reports = new Set<string>();
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  await app.register(cookie);
  await app.register(cors, {
    origin:
      opts.frontendOrigin === "*"
        ? true
        : opts.frontendOrigin.split(",").map((item) => item.trim()),
    credentials: true,
  });

  const sessionWallet = async (request: FastifyRequest) => {
    const id = request.cookies.pos_session;
    if (!id) {
      return null;
    }
    return auth.getSession(id, Date.now());
  };

  const requireWallet = async (request: FastifyRequest) => {
    const wallet = await sessionWallet(request);
    if (!wallet) {
      throw unauthorized();
    }
    return wallet;
  };

  const setSession = async (reply: FastifyReply, wallet: string) => {
    const id = newSessionId();
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    await auth.putSession(id, wallet, expiresAt);
    reply.setCookie("pos_session", id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 24 * 60 * 60,
      secure: process.env.NODE_ENV === "production",
    });
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }
    if (error instanceof EngineError) {
      return reply.status(400).send({
        error: { code: error.code, message: error.message },
      });
    }
    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        error: { code: "BAD_REQUEST", message: error.issues[0]?.message ?? "Bad request" },
      });
    }
    const message = error instanceof Error ? error.message : "Internal server error";
    return reply.status(500).send({
      error: { code: "INTERNAL", message },
    });
  });

  app.get("/health", async () => ({
    ok: true,
    service: "proof-of-ship-server",
    time: new Date().toISOString(),
  }));

  app.get("/v1/auth/nonce", async () => {
    const nonce = newNonce();
    await auth.putNonce(nonce, Date.now() + 10 * 60 * 1000);
    return { nonce };
  });

  app.post("/v1/auth/verify", async (request, reply) => {
    const body = z
      .object({
        message: z.string().min(1).max(500),
        signature: z.string().min(1),
      })
      .parse(request.body);
    const parsed = verifySignIn(body.message, body.signature);
    if (!parsed || !(await auth.takeNonce(parsed.nonce, Date.now()))) {
      throw unauthorized("That sign in could not be verified");
    }
    await setSession(reply, parsed.wallet);
    const link = await auth.getX(parsed.wallet);
    return { wallet: parsed.wallet, xHandle: link?.xHandle ?? null, xUserId: link?.xUserId ?? null };
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const id = request.cookies.pos_session;
    if (id) {
      await auth.deleteSession(id);
    }
    reply.clearCookie("pos_session", { path: "/" });
    return { ok: true };
  });

  app.get("/v1/me", async (request) => {
    const wallet = await sessionWallet(request);
    if (!wallet) {
      return { wallet: null, xHandle: null, xUserId: null };
    }
    const link = await auth.getX(wallet);
    return { wallet, xHandle: link?.xHandle ?? null, xUserId: link?.xUserId ?? null };
  });

  app.get("/v1/x/connect", async (request) => {
    const wallet = await requireWallet(request);
    const clientId = process.env.X_CLIENT_ID;
    const redirectUri = process.env.X_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      throw new HttpError(503, "X_UNAVAILABLE", "X sign in is not configured yet");
    }
    const state = newNonce();
    const verifier = newNonce() + newNonce();
    await auth.putOauth(state, { wallet, verifier, expiresAt: Date.now() + 10 * 60 * 1000 });
    const url = new URL("https://twitter.com/i/oauth2/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "users.read tweet.read");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return { url: url.toString() };
  });

  app.get("/v1/x/callback", async (request, reply) => {
    const query = z
      .object({
        code: z.string().min(1),
        state: z.string().min(1),
      })
      .parse(request.query);
    const pending = await auth.takeOauth(query.state, Date.now());
    const clientId = process.env.X_CLIENT_ID;
    const clientSecret = process.env.X_CLIENT_SECRET;
    const redirectUri = process.env.X_REDIRECT_URI;
    const origin = opts.frontendOrigin === "*" ? "/" : opts.frontendOrigin.split(",")[0]?.trim();
    if (!pending || !clientId || !clientSecret || !redirectUri) {
      return reply.redirect(`${origin || "/"}/launch?x=failed`);
    }
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code: query.code,
      redirect_uri: redirectUri,
      code_verifier: pending.verifier,
      client_id: clientId,
    });
    const token = await fetch("https://api.twitter.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: tokenBody,
    });
    if (!token.ok) {
      return reply.redirect(`${origin}/launch?x=failed`);
    }
    const tokenJson = (await token.json()) as { access_token?: string };
    const profile = await fetch("https://api.twitter.com/2/users/me", {
      headers: { authorization: `Bearer ${tokenJson.access_token ?? ""}` },
    });
    if (!profile.ok) {
      return reply.redirect(`${origin}/launch?x=failed`);
    }
    const profileJson = (await profile.json()) as { data?: { id?: string; username?: string } };
    const xUserId = profileJson.data?.id;
    const xHandle = profileJson.data?.username;
    if (!xUserId || !xHandle) {
      return reply.redirect(`${origin}/launch?x=failed`);
    }
    try {
      await auth.linkX(pending.wallet, xUserId, xHandle);
    } catch {
      return reply.redirect(`${origin}/launch?x=failed`);
    }
    return reply.redirect(`${origin}/launch?x=linked`);
  });

  app.post("/v1/builders", async (request) => {
    const wallet = await requireWallet(request);
    const link = await auth.getX(wallet);
    if (!link) {
      throw badRequest("Link your X account before you launch");
    }
    try {
      const builder = await opts.store.upsertBuilder(wallet, link.xHandle);
      return builder;
    } catch {
      throw badRequest("That X handle is already in use", "HANDLE_TAKEN");
    }
  });

  app.post("/v1/projects", async (request) => {
    const wallet = await requireWallet(request);
    const link = await auth.getX(wallet);
    if (!link) {
      throw badRequest("Link your X account before you launch");
    }
    const body = z
      .object({
        name: z.string().min(1).max(32),
        symbol: z.string().min(1).max(10),
        promises: z.array(promiseSchema).min(1).max(20),
      })
      .parse(request.body);

    let builder;
    try {
      builder = await opts.store.upsertBuilder(wallet, link.xHandle);
    } catch {
      throw badRequest("That X account is already linked to a launch", "HANDLE_TAKEN");
    }
    const existing = await opts.store.listProjectsByBuilder(builder.id);
    if (existing.some((project) => project.status === "active" && project.demo !== false)) {
      throw badRequest("You already have an active launch", "ACTIVE_LAUNCH");
    }

    const created = createProject({
      mint: fakeMint(),
      name: body.name,
      symbol: body.symbol,
      builderWallet: wallet,
      xHandle: link.xHandle,
      nowMs: at(request),
      promises: body.promises,
    });
    await persist(opts.store, builder.id, created.project, created.events);
    return presentProject(created.project, at(request));
  });

  app.get("/v1/projects", async (request) => {
    const scope = (request.query as { scope?: string }).scope;
    const projects = (await opts.store.listProjects()).filter((project) =>
      scope === "demo" ? project.demo !== false : project.demo === false,
    );
    return {
      projects: projects
        .slice()
        .sort((a, b) => (b.promises[0]?.postedAtMs ?? 0) - (a.promises[0]?.postedAtMs ?? 0))
        .map((project) => ({
          mint: project.mint,
          slug: coinSlug(project),
          name: project.name,
          symbol: project.symbol,
          status: project.status,
          xHandle: project.xHandle,
          builderWallet: project.builderWallet,
          promise: project.promises[0]?.text ?? "",
          balanceSol: Number(project.balance) / 1_000_000_000,
          releasedSol: Number(project.released) / 1_000_000_000,
          burnedSol: Number(project.burned) / 1_000_000_000,
        })),
    };
  });

  app.get("/v1/coins/:slug", async (request) => {
    const { slug } = request.params as { slug: string };
    const projects = await opts.store.listProjects();
    const project = projects.find((item) => coinSlug(item) === slug);
    if (!project) {
      throw notFound("No coin with that page");
    }
    const viewer = await sessionWallet(request);
    return presentLive(opts.store, project, at(request), viewer ?? undefined);
  });

  app.post("/v1/projects/:mint/promises/:idx/proof", async (request) => {
    const wallet = await requireWallet(request);
    const { mint, idx } = request.params as { mint: string; idx: string };
    const body = z
      .object({
        url: z.string().min(1).max(300),
        note: z.string().max(500).optional(),
      })
      .parse(request.body);
    const project = await loadProject(opts.store, mint);
    if (project.builderWallet !== wallet) {
      throw badRequest("Only the builder can mark this as shipped");
    }
    const promise = project.promises.find((item) => item.idx === Number(idx));
    if (!promise) {
      throw notFound("No promise with that number");
    }
    const builder = await opts.store.getBuilderByWallet(wallet);
    if (!builder) {
      throw notFound("Builder missing");
    }
    const events = markShipped(project, body.url, body.note ?? "", at(request));
    await persist(opts.store, builder.id, project, events);
    return presentLive(opts.store, project, at(request), wallet);
  });

  app.post("/v1/projects/:mint/promises/:idx/vote", async (request) => {
    const wallet = await requireWallet(request);
    const { mint, idx } = request.params as { mint: string; idx: string };
    const body = z
      .object({
        side: z.enum(["up", "down"]),
        reason: z.string().max(140).optional(),
      })
      .parse(request.body);
    const promiseIdx = Number(idx);
    const project = await loadProject(opts.store, mint);
    const promise = project.promises.find((item) => item.idx === promiseIdx);
    if (!promise || promise.status !== "vote_open") {
      throw badRequest("That promise is not open for votes");
    }
    if (wallet === project.builderWallet) {
      throw badRequest("Builders cannot vote on their own coins");
    }
    const held = await balanceOf(project, wallet);
    if (!held.ok) {
      throw badRequest("Could not read your balance");
    }
    if (held.amount <= 0n) {
      throw badRequest("You need to hold this coin to vote");
    }
    await opts.store.upsertHolderVote(mint, promiseIdx, wallet, body.side);
    return presentLive(opts.store, project, at(request), wallet);
  });

  app.get("/v1/projects/:mint/messages", async (request) => {
    const { mint } = request.params as { mint: string };
    const project = await loadProject(opts.store, mint);
    const viewer = await sessionWallet(request);
    const messages = await opts.store.listMessages(mint, 80);
    if (!viewer) {
      return { messages, holds: false };
    }
    const held = await balanceOf(project, viewer);
    return { messages, holds: held.ok ? held.amount > 0n : null };
  });

  app.post("/v1/projects/:mint/messages", async (request) => {
    const wallet = await requireWallet(request);
    const { mint } = request.params as { mint: string };
    const body = z
      .object({
        text: z.string().trim().min(1).max(280),
      })
      .parse(request.body);
    const project = await loadProject(opts.store, mint);
    const previous = lastChat.get(wallet) ?? 0;
    if (at(request) - previous < 10_000) {
      throw new HttpError(429, "RATE_LIMIT", "Wait a moment before sending again");
    }
    const held = await balanceOf(project, wallet);
    if (!held.ok) {
      throw badRequest("Could not read your balance");
    }
    if (held.amount <= 0n) {
      throw badRequest("Hold some supply to send");
    }
    lastChat.set(wallet, at(request));
    const message = await opts.store.addMessage(mint, wallet, body.text, at(request));
    return { message };
  });

  app.post("/v1/projects/:mint/messages/:id/report", async (request) => {
    await requireWallet(request);
    const { mint, id } = request.params as { mint: string; id: string };
    await loadProject(opts.store, mint);
    reports.add(`${mint}:${id}`);
    return { ok: true };
  });

  app.get("/v1/projects/:mint", async (request) => {
    const { mint } = request.params as { mint: string };
    const project = await loadProject(opts.store, mint);
    const viewer = await sessionWallet(request);
    return presentLive(opts.store, project, at(request), viewer ?? undefined);
  });

  app.get("/v1/builders/:handle", async (request) => {
    const { handle } = request.params as { handle: string };
    const builder = await opts.store.getBuilderByHandle(handle);
    if (!builder) {
      throw notFound("No builder with that handle");
    }
    const projects = await opts.store.listProjectsByBuilder(builder.id);
    return presentBuilder(builder.xHandle, builder.wallet, projects);
  });

  app.get("/v1/feed", async (request) => {
    const scope = (request.query as { scope?: string }).scope;
    const projects = await opts.store.listProjects();
    const allowed = new Set(
      projects
        .filter((project) => (scope === "demo" ? project.demo !== false : project.demo === false))
        .map((project) => project.mint),
    );
    const rows = (await opts.store.listFeed(80)).filter(
      (row) => allowed.has(row.mint) && row.atMs <= at(request),
    );
    return { events: presentFeed(rows).slice(0, 50) };
  });

  app.get("/v1/badge/:mint.svg", async (request, reply) => {
    const { mint } = request.params as { mint: string };
    const project = await loadProject(opts.store, mint);
    const last = [...project.promises].reverse().find((item) =>
      ["paid", "burned"].includes(item.status),
    );
    const label = last
      ? last.status === "paid"
        ? "Last vote: Pay"
        : "Last vote: Burn"
      : "Vote pending";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="36"><rect width="220" height="36" rx="6" fill="#111"/><text x="12" y="24" fill="#f4f0e6" font-family="ui-sans-serif" font-size="14">${project.symbol} · ${label}</text></svg>`;
    return reply.type("image/svg+xml").send(svg);
  });

  app.post("/v1/projects/:mint/promises", async (request) => {
    const wallet = await requireWallet(request);
    const { mint } = request.params as { mint: string };
    const body = z
      .object({
        text: z.string().min(1).max(280),
        deadlineMs: z.number().int().positive(),
      })
      .parse(request.body);
    const project = await loadProject(opts.store, mint);
    if (project.builderWallet !== wallet) {
      throw badRequest("Only the builder can add a promise", "FORBIDDEN");
    }
    const builder = await opts.store.getBuilderByWallet(wallet);
    if (!builder) {
      throw notFound("Builder missing");
    }
    const events = appendPromise(project, body.text, body.deadlineMs, at(request));
    await persist(opts.store, builder.id, project, events);
    return presentProject(project, at(request));
  });

  app.post("/v1/projects/:mint/abandon", async (request) => {
    const wallet = await requireWallet(request);
    const { mint } = request.params as { mint: string };
    const project = await loadProject(opts.store, mint);
    if (project.builderWallet !== wallet) {
      throw badRequest("Only the builder can abandon", "FORBIDDEN");
    }
    const builder = await opts.store.getBuilderByWallet(wallet);
    if (!builder) {
      throw notFound("Builder missing");
    }
    const events = abandon(project, at(request));
    events.push(...crank(project, at(request)));
    await persist(opts.store, builder.id, project, events);
    return presentProject(project, at(request));
  });

  app.post("/v1/crank", async (request) => {
    const body = z
      .object({ mint: z.string().optional() })
      .parse(request.body && typeof request.body === "object" ? request.body : {});
    const projects = (await opts.store.listProjects()).filter(
      (project) => !body.mint || project.mint === body.mint,
    );
    let count = 0;
    for (const project of projects) {
      const builder = await opts.store.getBuilderByWallet(project.builderWallet);
      if (!builder) {
        continue;
      }
      const events = await advanceProject(opts.store, project, at(request));
      if (events.length) {
        count += events.length;
        await persist(opts.store, builder.id, project, events);
      } else {
        await persist(opts.store, builder.id, project, []);
      }
    }
    return { ok: true, events: count };
  });

  if (opts.allowSim) {
    app.post("/v1/sim/fees", async (request) => {
      const body = z
        .object({
          mint: z.string(),
          lamports: z.string().regex(/^[0-9]+$/),
        })
        .parse(request.body);
      const project = await loadProject(opts.store, body.mint);
      const builder = await opts.store.getBuilderByWallet(project.builderWallet);
      if (!builder) {
        throw notFound("Builder missing");
      }
      const events = creditFees(project, BigInt(body.lamports), at(request));
      events.push(...crank(project, at(request)));
      await persist(opts.store, builder.id, project, events);
      return presentProject(project, at(request));
    });

    app.post("/v1/sim/airdrop", async (request) => {
      const body = z
        .object({
          mint: z.string(),
          wallet: walletSchema,
          amount: z.string().regex(/^[0-9]+$/),
        })
        .parse(request.body);
      const project = await loadProject(opts.store, body.mint);
      const builder = await opts.store.getBuilderByWallet(project.builderWallet);
      if (!builder) {
        throw notFound("Builder missing");
      }
      airdrop(project, body.wallet, BigInt(body.amount));
      await persist(opts.store, builder.id, project, []);
      return presentProject(project, at(request));
    });

    app.get("/v1/sim/clock", async (request) => ({
      nowMs: at(request),
      override: getNowMs(),
    }));

    app.post("/v1/sim/clock", async (request) => {
      const body = z
        .object({
          nowMs: z.number().int().positive().nullable(),
        })
        .parse(request.body);
      setNowMs(body.nowMs);
      return { nowMs: now(), override: getNowMs() };
    });
  }

  return app;
};
