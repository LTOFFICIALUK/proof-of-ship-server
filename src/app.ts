import { randomBytes } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { EngineError } from "./engine/types.js";
import {
  abandon,
  airdrop,
  appendPromise,
  castVote,
  crank,
  createProject,
  creditFees,
} from "./engine/vault.js";
import { getNowMs, setNowMs } from "./clock.js";
import { HttpError, badRequest, notFound } from "./lib/errors.js";
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
        upPct: tally.upPct,
        downPct: tally.downPct,
        netPct: holdings.ok ? tally.netPct : null,
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
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  await app.register(cors, {
    origin:
      opts.frontendOrigin === "*"
        ? true
        : opts.frontendOrigin.split(",").map((item) => item.trim()),
  });

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

  app.post("/v1/builders", async (request) => {
    const body = z
      .object({
        wallet: walletSchema,
        xHandle: z.string().min(1).max(32),
      })
      .parse(request.body);
    try {
      const builder = await opts.store.upsertBuilder(body.wallet, body.xHandle);
      return builder;
    } catch {
      throw badRequest("That X handle is already in use", "HANDLE_TAKEN");
    }
  });

  app.post("/v1/projects", async (request) => {
    const body = z
      .object({
        wallet: walletSchema,
        xHandle: z.string().min(1).max(32),
        name: z.string().min(1).max(32),
        symbol: z.string().min(1).max(10),
        promises: z.array(promiseSchema).min(1).max(20),
      })
      .parse(request.body);

    const builder = await opts.store.upsertBuilder(body.wallet, body.xHandle);
    const existing = await opts.store.listProjectsByBuilder(builder.id);
    if (existing.some((project) => project.status === "active")) {
      throw badRequest("You already have an active launch", "ACTIVE_LAUNCH");
    }

    const created = createProject({
      mint: fakeMint(),
      name: body.name,
      symbol: body.symbol,
      builderWallet: body.wallet,
      xHandle: body.xHandle,
      nowMs: at(request),
      promises: body.promises,
    });
    await persist(opts.store, builder.id, created.project, created.events);
    return presentProject(created.project, at(request));
  });

  app.get("/v1/projects", async () => {
    const projects = await opts.store.listProjects();
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
          balanceSol: Number(project.balance) / 1_000_000_000,
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
    const viewer = (request.query as { wallet?: string }).wallet;
    return presentLive(opts.store, project, at(request), viewer);
  });

  app.post("/v1/projects/:mint/promises/:idx/vote", async (request) => {
    const { mint, idx } = request.params as { mint: string; idx: string };
    const body = z
      .object({
        wallet: walletSchema,
        side: z.enum(["up", "down"]),
      })
      .parse(request.body);
    const promiseIdx = Number(idx);
    const project = await loadProject(opts.store, mint);
    const promise = project.promises.find((item) => item.idx === promiseIdx);
    if (!promise || !["pending", "vote_open", "no_quorum"].includes(promise.status)) {
      throw badRequest("That promise is not open for votes");
    }
    const held = await balanceOf(project, body.wallet);
    if (!held.ok) {
      throw badRequest("Could not read your balance");
    }
    if (held.amount <= 0n) {
      throw badRequest("You need to hold this coin to vote");
    }
    await opts.store.upsertHolderVote(mint, promiseIdx, body.wallet, body.side);
    return presentLive(opts.store, project, at(request), body.wallet);
  });

  app.get("/v1/projects/:mint/messages", async (request) => {
    const { mint } = request.params as { mint: string };
    const project = await loadProject(opts.store, mint);
    const viewer = (request.query as { wallet?: string }).wallet;
    const messages = await opts.store.listMessages(mint, 80);
    if (!viewer) {
      return { messages, holds: false };
    }
    const held = await balanceOf(project, viewer);
    return { messages, holds: held.ok ? held.amount > 0n : null };
  });

  app.post("/v1/projects/:mint/messages", async (request) => {
    const { mint } = request.params as { mint: string };
    const body = z
      .object({
        wallet: walletSchema,
        text: z.string().trim().min(1).max(280),
      })
      .parse(request.body);
    const project = await loadProject(opts.store, mint);
    const held = await balanceOf(project, body.wallet);
    if (!held.ok) {
      throw badRequest("Could not read your balance");
    }
    if (held.amount <= 0n) {
      throw badRequest("Hold some supply to send");
    }
    const message = await opts.store.addMessage(mint, body.wallet, body.text, at(request));
    return { message };
  });

  app.get("/v1/projects/:mint", async (request) => {
    const { mint } = request.params as { mint: string };
    const project = await loadProject(opts.store, mint);
    const viewer = (request.query as { wallet?: string }).wallet;
    return presentLive(opts.store, project, at(request), viewer);
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

  app.get("/v1/feed", async () => {
    const rows = await opts.store.listFeed(50);
    return { events: presentFeed(rows) };
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
    const { mint } = request.params as { mint: string };
    const body = z
      .object({
        wallet: walletSchema,
        text: z.string().min(1).max(280),
        deadlineMs: z.number().int().positive(),
      })
      .parse(request.body);
    const project = await loadProject(opts.store, mint);
    if (project.builderWallet !== body.wallet) {
      throw badRequest("Only the builder can add a promise", "FORBIDDEN");
    }
    const builder = await opts.store.getBuilderByWallet(body.wallet);
    if (!builder) {
      throw notFound("Builder missing");
    }
    const events = appendPromise(project, body.text, body.deadlineMs, at(request));
    await persist(opts.store, builder.id, project, events);
    return presentProject(project, at(request));
  });

  app.post("/v1/projects/:mint/vote", async (request) => {
    const { mint } = request.params as { mint: string };
    const body = z
      .object({
        wallet: walletSchema,
        side: z.enum(["pay", "burn"]),
        amount: z.string().regex(/^[0-9]+$/),
      })
      .parse(request.body);
    const project = await loadProject(opts.store, mint);
    const builder = await opts.store.getBuilderByWallet(project.builderWallet);
    if (!builder) {
      throw notFound("Builder missing");
    }
    crank(project, at(request));
    castVote(project, body.wallet, body.side, BigInt(body.amount));
    await persist(opts.store, builder.id, project, []);
    return presentProject(project, at(request));
  });

  app.post("/v1/projects/:mint/abandon", async (request) => {
    const { mint } = request.params as { mint: string };
    const body = z.object({ wallet: walletSchema }).parse(request.body);
    const project = await loadProject(opts.store, mint);
    if (project.builderWallet !== body.wallet) {
      throw badRequest("Only the builder can abandon", "FORBIDDEN");
    }
    const builder = await opts.store.getBuilderByWallet(body.wallet);
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
