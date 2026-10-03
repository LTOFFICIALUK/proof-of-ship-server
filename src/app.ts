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
  verifyWalletSignature,
  voteMessage,
  type AuthStore,
} from "./auth.js";
import { EngineError, type ProjectState } from "./engine/types.js";
import {
  abandon,
  airdrop,
  appendPromise,
  createProject,
  creditFees,
  markShipped,
  setHolding,
} from "./engine/vault.js";
import { getNowMs, setNowMs } from "./clock.js";
import { HttpError, badRequest, notFound, unauthorized } from "./lib/errors.js";
import { balanceOf, snapshotBalances } from "./holdings.js";
import { loadMarket } from "./market.js";
import {
  builderRecord,
  coinSlug,
  currentPromise,
  feedMatches,
  filterCoins,
  lastClosed,
  presentBuilder,
  presentCard,
  presentFeed,
  presentProfile,
  presentProject,
  siteStats,
  type CoinFilter,
} from "./presenters.js";
import { claimMint, depositMint, markMintUsed, MintBankEmptyError, readyCount, releaseMint, reserveMint, reservedFor } from "./mint-bank.js";
import { broadcastBuy, buildLaunchPayment, relayLaunchTransaction, settlePaidLaunch, type LaunchDraft } from "./pump-launch.js";
import { logger } from "./logger.js";
import { advanceProject } from "./settle.js";
import type { ShipStore } from "./store/memory.js";
import { destinations, MINT_SUFFIX, pumpFeeShares, treasury } from "./wallets.js";
import { pctOf, voteWeight, weighVotes } from "./weights.js";

const walletSchema = z
  .string()
  .min(32)
  .max(44)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/);

const linkSchema = z
  .string()
  .trim()
  .max(200)
  .refine((value) => value === "" || /^https:\/\/[^\s]+$/.test(value), "Links must start with https://")
  .optional();

const imageSchema = z
  .string()
  .trim()
  .max(700_000, "Use a smaller image")
  .refine((value) => {
    if (!value) {
      return true;
    }
    if (/^https:\/\/[^\s]+$/.test(value)) {
      return true;
    }
    return /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value);
  }, "Drop an image or paste an https image link")
  .optional();

const promiseSchema = z.object({
  title: z.string().trim().min(1, "Add a promise title").max(80, "Keep the title under 80 characters"),
  doneLooksLike: z.string().trim().max(500, "Keep it under 500 characters").optional(),
  proofType: z.enum(["link", "repo", "program", "app", "video"]).optional(),
  deadlineMs: z.number().int().positive(),
});

const PAGE_SIZE = 24;

const escapeXml = (value: string) =>
  value.replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);

const badgeSvg = (left: string, right: string) => {
  const width = Math.max(180, 44 + (left.length + right.length) * 7.4);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="28" role="img" aria-label="${escapeXml(`${left}. ${right}`)}"><rect width="100%" height="28" rx="6" fill="#111112"/><rect x="10" y="9" width="5" height="10" fill="#f3f3f1"/><rect x="17" y="9" width="5" height="10" fill="#17803f"/><text x="30" y="18.5" fill="#f3f3f1" font-family="Geist, ui-sans-serif, system-ui" font-size="12" font-weight="600">${escapeXml(left)}</text><text x="${Math.round(36 + left.length * 7.4)}" y="18.5" fill="#a3a3a0" font-family="Geist, ui-sans-serif, system-ui" font-size="12">${escapeXml(right)}</text></svg>`;
};

const scoped = (projects: ProjectState[], scope: unknown) => {
  if (scope === "demo") {
    return projects.filter((project) => project.demo !== false);
  }
  if (scope === "all") {
    return projects;
  }
  return projects.filter((project) => project.demo === false);
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
  const market = await loadMarket(project.mint);
  const promises = await Promise.all(
    view.promises.map(async (item) => {
      const state = project.promises.find((entry) => entry.idx === item.idx)!;
      const rows = votes.filter((row) => row.promiseIdx === item.idx);
      const mine = rows.find((row) => row.wallet === viewer);
      const signedSide = mine ? (mine.side === "down" ? "burn" : "pay") : null;
      if (item.status === "vote_open") {
        const weighed = await weighVotes(project, state, rows);
        const mineWeight = weighed.rows.find((row) => row.wallet === viewer)?.weight ?? 0n;
        return {
          ...item,
          upPct: null,
          downPct: null,
          netPct: null,
          turnoutPct: weighed.ok ? pctOf(weighed.pay + weighed.burn, weighed.eligible) : null,
          voters: weighed.rows.filter((row) => row.weight > 0n).length,
          yourSide: mineWeight > 0n ? signedSide : null,
        };
      }
      if (state.tally) {
        const base = BigInt(state.eligibleAtClose ?? project.circulatingSupply);
        const pay = state.tally
          .filter((row) => row.side === "pay")
          .reduce((sum, row) => sum + BigInt(row.weight), 0n);
        const burn = state.tally
          .filter((row) => row.side === "burn")
          .reduce((sum, row) => sum + BigInt(row.weight), 0n);
        const counted = state.tally.find((row) => row.wallet === viewer);
        return {
          ...item,
          upPct: pctOf(pay, base),
          downPct: pctOf(burn, base),
          netPct: item.resultNet,
          turnoutPct: pctOf(pay + burn, base),
          voters: state.tally.filter((row) => BigInt(row.weight) > 0n).length,
          yourSide: counted && BigInt(counted.weight) > 0n ? (counted.side === "burn" ? "burn" : "pay") : null,
        };
      }
      return {
        ...item,
        upPct: null,
        downPct: null,
        netPct: item.resultNet,
        turnoutPct: null,
        voters: rows.length,
        yourSide: signedSide,
      };
    }),
  );
  let viewerView = null;
  if (viewer) {
    const current = currentPromise(project);
    const held = await balanceOf(project, viewer);
    const weight = current && held.ok ? voteWeight(project, current, viewer, held.amount) : 0n;
    viewerView = {
      wallet: viewer,
      isBuilder: viewer === project.builderWallet,
      excluded: viewer === project.builderWallet || Boolean(project.excludedWallets?.includes(viewer)),
      balance: held.ok ? held.amount.toString() : null,
      weight: weight.toString(),
      weightPct: pctOf(weight, BigInt(project.circulatingSupply)),
    };
  }
  return {
    ...view,
    market,
    promises,
    viewer: viewerView,
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
  const launchDrafts = new Map<string, z.infer<typeof launchSchema>>();
  const launchQuotes = new Map<string, { lamports: bigint; draft: LaunchDraft }>();
  const reports = new Set<string>();
  const app = Fastify({ logger: false, bodyLimit: 2_000_000 });

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
        message: z.string().min(1).max(2000),
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
      throw badRequest("Verify your X account before you launch");
    }
    try {
      const builder = await opts.store.upsertBuilder(wallet, link.xHandle);
      return builder;
    } catch {
      throw badRequest("That X handle is already in use", "HANDLE_TAKEN");
    }
  });

  const launchSchema = z.object({
    name: z.string().trim().min(1, "Add a coin name").max(32),
    symbol: z.string().trim().min(1, "Add a ticker").max(10),
    description: z.string().trim().max(500).optional(),
    image: imageSchema,
    website: linkSchema,
    github: linkSchema,
    devBuyBps: z.number().int().min(0).max(500).optional(),
    promise: promiseSchema,
  });

  const launchSteps = (body: z.infer<typeof launchSchema>) => {
    const keys = treasury();
    return [
      {
        title: "Take a mint from the bank",
        detail: `The contract address ends in ${MINT_SUFFIX}. The bank hands one over and starts grinding a replacement.`,
      },
      { title: "You stay the creator", detail: "Your wallet is the pump.fun creator. Creator fees do not land in it." },
      {
        title: "Fees go to the vault we control",
        detail: `pump.fun pays 100 percent of creator fees to ${keys.vault || "Pending"}. We then send you 15 percent as runway, send 10 percent to the platform, and hold 75 percent for holder votes.`,
      },
      {
        title: "Dev buy",
        detail:
          (body.devBuyBps ?? 0) === 0
            ? "No extra buy at launch."
            : `Buy ${(body.devBuyBps ?? 0) / 100}% of supply. Builders still cannot vote.`,
      },
      { title: "Track the vault", detail: "Every fee, payout, and burn is written to the ledger and sent from the vault wallet." },
    ];
  };

  const createLaunch = async (wallet: string, body: z.infer<typeof launchSchema>, nowMs: number, mintAddress?: string) => {
    const link = await auth.getX(wallet);
    if (!link) {
      throw badRequest("Verify your X account before you launch");
    }
    let builder;
    try {
      builder = await opts.store.upsertBuilder(wallet, link.xHandle);
    } catch {
      throw badRequest("That X account is already linked to a launch", "HANDLE_TAKEN");
    }
    const existing = await opts.store.listProjectsByBuilder(builder.id);
    if (existing.some((project) => project.status === "active")) {
      throw badRequest("You already have an active launch", "ACTIVE_LAUNCH");
    }
    const minted = mintAddress ? null : await claimMint();
    const mint = mintAddress ?? minted?.publicKey;
    if (!mint) {
      throw new MintBankEmptyError();
    }
    let created;
    try {
      created = createProject({
        mint,
        name: body.name,
        symbol: body.symbol,
        builderWallet: wallet,
        xHandle: link.xHandle,
        nowMs,
        devBuyBps: body.devBuyBps ?? 0,
        promises: [
          {
            text: body.promise.title,
            doneLooksLike: body.promise.doneLooksLike,
            proofType: body.promise.proofType,
            deadlineMs: body.promise.deadlineMs,
          },
        ],
      });
    } catch (error) {
      if (minted) {
        await depositMint(minted);
      }
      throw error;
    }
    created.project.verified = true;
    created.project.demo = false;
    created.project.chain = destinations();
    created.project.profile = {
      description: body.description ?? "",
      website: body.website ?? "",
      github: body.github ?? "",
      image: body.image ?? "",
      devBuyBps: body.devBuyBps ?? 0,
    };
    await persist(opts.store, builder.id, created.project, created.events);
    return created.project;
  };

  app.post("/v1/launch/build", async (request) => {
    const wallet = await requireWallet(request);
    const link = await auth.getX(wallet);
    if (!link) {
      throw badRequest("Verify your X account before you launch");
    }
    const body = launchSchema.parse(request.body);
    const keys = treasury();
    return {
      mode: "live",
      listed: false,
      suffix: MINT_SUFFIX,
      readyMints: await readyCount(),
      destinations: { vault: keys.vault, platform: keys.platform, crank: keys.crank, runway: wallet },
      pumpShares: pumpFeeShares(),
      steps: launchSteps(body),
      rules: [
        "The fee split cannot be changed by you or by us.",
        "You cannot withdraw the vault.",
        "Creator fees land in the vault wallet we control. We send you 15 percent as runway. We hold 75 percent until holders vote. A pay vote pays 60 percent of the vault to you in SOL. A burn vote spends 60 percent to buy $POS.",
      ],
    };
  });

  const launchMessage = (error: unknown) => {
    if (error instanceof MintBankEmptyError) {
      return error.message;
    }
    if (error instanceof HttpError) {
      return error.message;
    }
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return "Could not launch.";
  };

  app.post("/v1/launch/prepare", async (request) => {
    const wallet = await requireWallet(request);
    const link = await auth.getX(wallet);
    if (!link) {
      throw badRequest("Verify your X account before you launch");
    }
    const body = launchSchema.parse(request.body);
    if (!body.image) {
      throw badRequest("Add a coin image.");
    }
    if (opts.allowSim) {
      return { mode: "sim", mint: "", transactions: [] as string[] };
    }
    let reserved;
    try {
      reserved = await reserveMint(wallet);
    } catch (error) {
      if (error instanceof MintBankEmptyError) {
        throw new HttpError(503, "MINT_BANK", error.message);
      }
      throw error;
    }
    try {
      const draft: LaunchDraft = {
        name: body.name,
        symbol: body.symbol,
        description: body.description ?? "",
        image: body.image,
        website: body.website ?? "",
        twitter: link.xHandle,
        devBuyBps: body.devBuyBps ?? 0,
      };
      const payment = await buildLaunchPayment(draft, wallet);
      launchDrafts.set(wallet, body);
      launchQuotes.set(wallet, { lamports: payment.totalLamports, draft });
      return {
        mode: "live",
        mint: reserved.publicKey,
        transactions: [payment.transaction],
        lamports: payment.totalLamports.toString(),
        platformWallet: payment.platformWallet,
      };
    } catch (error) {
      await releaseMint(reserved.publicKey).catch(() => undefined);
      throw badRequest(launchMessage(error));
    }
  });

  app.post("/v1/launch/relay", async (request) => {
    const wallet = await requireWallet(request);
    const body = z.object({ transaction: z.string().min(1) }).parse(request.body);
    const reserved = await reservedFor(wallet);
    if (!reserved) {
      throw badRequest("That launch expired. Start again.");
    }
    try {
      const signature = await relayLaunchTransaction(body.transaction, reserved, wallet);
      const draft = launchDrafts.get(wallet);
      const existing = await opts.store.getProject(reserved.publicKey);
      if (!existing && draft) {
        try {
          await createLaunch(wallet, draft, at(request), reserved.publicKey);
        } catch (error) {
          logger.warn("could not list the coin after create", { mint: reserved.publicKey, message: launchMessage(error) });
        }
      }
      const listed = Boolean(await opts.store.getProject(reserved.publicKey));
      return { ok: true, signature, mint: reserved.publicKey, listed };
    } catch (error) {
      throw badRequest(launchMessage(error));
    }
  });

  app.post("/v1/launch/submit", async (request) => {
    const wallet = await requireWallet(request);
    const body = launchSchema
      .extend({
        transactions: z.array(z.string().min(1)).max(3).optional(),
      })
      .parse(request.body);
    if (opts.allowSim && !body.transactions?.length) {
      const project = await createLaunch(wallet, body, at(request));
      return { mode: "live", listed: true, mint: project.mint, project: presentProject(project, at(request)), buyTransaction: null };
    }
    const reserved = await reservedFor(wallet);
    if (!reserved) {
      throw badRequest("That launch expired. Start again.");
    }
    const quote = launchQuotes.get(wallet);
    const signed = body.transactions?.[0];
    if (!quote || !signed) {
      throw badRequest("Start the launch again.");
    }
    let landed = false;
    try {
      await settlePaidLaunch(signed, quote.draft, reserved, wallet, quote.lamports);
      launchQuotes.delete(wallet);
      landed = true;
      const project = (await opts.store.getProject(reserved.publicKey)) ?? (await createLaunch(wallet, body, at(request), reserved.publicKey));
      launchDrafts.delete(wallet);
      await markMintUsed(reserved.publicKey);
      const buyTransaction = null;
      return {
        mode: "live",
        listed: true,
        mint: project.mint,
        project: presentProject(project, at(request)),
        buyTransaction,
      };
    } catch (error) {
      if (landed) {
        await markMintUsed(reserved.publicKey).catch(() => undefined);
      }
      throw badRequest(launchMessage(error));
    }
  });

  app.post("/v1/launch/:mint/buy", async (request) => {
    const wallet = await requireWallet(request);
    const { mint } = request.params as { mint: string };
    const body = z.object({ transaction: z.string().min(1) }).parse(request.body);
    const project = await loadProject(opts.store, mint);
    if (project.builderWallet !== wallet) {
      throw badRequest("Only the builder can buy at launch.");
    }
    try {
      const signature = await broadcastBuy(body.transaction, mint, wallet);
      return { ok: true, signature };
    } catch (error) {
      throw badRequest(launchMessage(error));
    }
  });

  app.get("/v1/launch/:mint/status", async (request) => {
    const { mint } = request.params as { mint: string };
    const project = await loadProject(opts.store, mint);
    return {
      mint: project.mint,
      listed: true,
      mode: "live",
      chain: project.chain ?? destinations(),
      project: presentProject(project, at(request)),
    };
  });

  app.get("/v1/treasury", async () => {
    const keys = treasury();
    return {
      suffix: MINT_SUFFIX,
      readyMints: await readyCount(),
      vault: keys.vault,
      platform: keys.platform,
      crank: keys.crank,
      pumpShares: pumpFeeShares(),
      split: { vaultBps: 7500, runwayBps: 1500, platformBps: 1000 },
      note: "pump.fun pays 100 percent of creator fees to the vault. We then send runway and platform cuts from that wallet.",
    };
  });

  app.post("/v1/projects", async (request) => {
    const wallet = await requireWallet(request);
    const body = launchSchema.parse(request.body);
    return presentProject(await createLaunch(wallet, body, at(request)), at(request));
  });

  app.get("/v1/projects", async (request) => {
    const scope = (request.query as { scope?: string }).scope;
    const projects = filterCoins(scoped(await opts.store.listProjects(), scope), "all");
    return { projects: projects.map(presentCard) };
  });

  app.get("/v1/coins", async (request) => {
    const query = z
      .object({
        filter: z.enum(["voting", "due", "shipped", "burned", "all"]).optional(),
        scope: z.string().optional(),
        page: z.coerce.number().int().min(1).max(500).optional(),
      })
      .parse(request.query);
    const filter: CoinFilter = query.filter ?? "all";
    const page = query.page ?? 1;
    const all = filterCoins(scoped(await opts.store.listProjects(), query.scope), filter);
    const start = (page - 1) * PAGE_SIZE;
    return {
      filter,
      page,
      total: all.length,
      hasMore: start + PAGE_SIZE < all.length,
      coins: all.slice(start, start + PAGE_SIZE).map(presentCard),
    };
  });

  app.get("/v1/stats", async (request) => {
    const scope = (request.query as { scope?: string }).scope;
    return siteStats(scoped(await opts.store.listProjects(), scope));
  });

  app.get("/v1/builders", async (request) => {
    const scope = (request.query as { scope?: string }).scope;
    const groups = new Map<string, ProjectState[]>();
    for (const project of scoped(await opts.store.listProjects(), scope)) {
      groups.set(project.xHandle, [...(groups.get(project.xHandle) ?? []), project]);
    }
    const builders = [...groups.entries()]
      .map(([handle, projects]) => ({
        handle,
        verified: projects.some((project) => project.verified === true),
        ...builderRecord(projects),
      }))
      .filter((row) => row.resolved > 0)
      .sort((a, b) => b.shipped - a.shipped || (b.onTimePct ?? 0) - (a.onTimePct ?? 0))
      .slice(0, 10);
    return { builders };
  });

  app.get("/v1/coins/:mint", async (request) => {
    const { mint } = request.params as { mint: string };
    const projects = await opts.store.listProjects();
    const project =
      projects.find((item) => item.mint === mint) ??
      projects.find((item) => coinSlug(item) === mint);
    if (!project) {
      throw notFound("No coin with that page");
    }
    const viewer = await sessionWallet(request);
    return presentLive(opts.store, project, at(request), viewer ?? undefined);
  });

  const snapshot = async (project: ProjectState) => {
    try {
      return await snapshotBalances(project);
    } catch {
      throw new HttpError(503, "RPC", "Could not read holders. Try again");
    }
  };

  const openPromise = (project: ProjectState, idx: string) => {
    const promise = project.promises.find((item) => item.idx === Number(idx));
    if (!promise || promise.status !== "vote_open") {
      throw badRequest("That promise is not open for votes");
    }
    return promise;
  };

  const sideSchema = z.enum(["pay", "burn"]);

  for (const base of ["/v1/projects", "/v1/coins"]) {
    app.post(`${base}/:mint/promises/:idx/proof`, async (request) => {
      const wallet = await requireWallet(request);
      const { mint, idx } = request.params as { mint: string; idx: string };
      const body = z
        .object({
          url: z
            .string()
            .trim()
            .min(1, "Add a proof link")
            .max(300)
            .refine((value) => /^https:\/\/[^\s]+$/.test(value), "Proof links must start with https://"),
          note: z.string().trim().max(500).optional(),
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
      if (promise.status !== "pending") {
        throw badRequest("This promise is not waiting for proof");
      }
      const builder = await opts.store.getBuilderByWallet(wallet);
      if (!builder) {
        throw notFound("Builder missing");
      }
      const balances = await snapshot(project);
      const events = markShipped(project, body.url, body.note ?? "", at(request));
      promise.proofBalances = balances;
      await persist(opts.store, builder.id, project, events);
      return presentLive(opts.store, project, at(request), wallet);
    });

    app.get(`${base}/:mint/promises/:idx/vote-message`, async (request) => {
      await requireWallet(request);
      const { mint, idx } = request.params as { mint: string; idx: string };
      const { side } = z.object({ side: sideSchema }).parse(request.query);
      const project = await loadProject(opts.store, mint);
      const promise = openPromise(project, idx);
      const nonce = newNonce();
      await auth.putNonce(nonce, Date.now() + 10 * 60 * 1000);
      return {
        nonce,
        message: voteMessage({ mint: project.mint, promiseIdx: promise.idx, side, nonce }),
      };
    });

    app.post(`${base}/:mint/promises/:idx/vote`, async (request) => {
      const wallet = await requireWallet(request);
      const { mint, idx } = request.params as { mint: string; idx: string };
      const body = z
        .object({
          side: sideSchema,
          reason: z.string().trim().max(140, "Keep the reason under 140 characters").optional(),
          nonce: z.string().min(1).max(64),
          signature: z.string().min(1).max(200),
        })
        .parse(request.body);
      const project = await loadProject(opts.store, mint);
      const promise = openPromise(project, idx);
      if (wallet === project.builderWallet || project.excludedWallets?.includes(wallet)) {
        throw badRequest("Builders cannot vote on their own coins");
      }
      const message = voteMessage({
        mint: project.mint,
        promiseIdx: promise.idx,
        side: body.side,
        nonce: body.nonce,
      });
      if (!verifyWalletSignature(wallet, message, body.signature)) {
        throw unauthorized("That vote signature could not be verified");
      }
      if (!(await auth.takeNonce(body.nonce, Date.now()))) {
        throw unauthorized("That vote expired. Sign it again");
      }
      const held = await balanceOf(project, wallet);
      if (!held.ok) {
        throw badRequest("Could not read your balance");
      }
      if (held.amount <= 0n) {
        throw badRequest("You need to hold this coin to vote");
      }
      if (voteWeight(project, promise, wallet, held.amount) <= 0n) {
        throw badRequest("Coins bought after the promise was posted do not count for this vote");
      }
      await opts.store.upsertHolderVote({
        mint: project.mint,
        promiseIdx: promise.idx,
        wallet,
        side: body.side === "burn" ? "down" : "up",
        reason: body.side === "burn" ? body.reason ?? "" : "",
        message,
        signature: body.signature,
      });
      return presentLive(opts.store, project, at(request), wallet);
    });

    app.get(`${base}/:mint/promises/:idx/tally`, async (request, reply) => {
      const { mint, idx } = request.params as { mint: string; idx: string };
      const download = (request.query as { download?: string }).download === "1";
      const project = await loadProject(opts.store, mint);
      const promise = project.promises.find((item) => item.idx === Number(idx));
      if (!promise) {
        throw notFound("No promise with that number");
      }
      if (promise.status === "pending" || promise.status === "vote_open") {
        const rows = (await opts.store.listHolderVotes(project.mint)).filter(
          (row) => row.promiseIdx === promise.idx,
        );
        const weighed = await weighVotes(project, promise, rows);
        return {
          mint: project.mint,
          promiseIdx: promise.idx,
          open: true,
          status: promise.status,
          voters: weighed.rows.filter((row) => row.weight > 0n).length,
          turnoutPct: weighed.ok ? pctOf(weighed.pay + weighed.burn, weighed.eligible) : null,
        };
      }
      const votes = promise.tally ?? [];
      const sum = (side: "pay" | "burn") =>
        votes.filter((row) => row.side === side).reduce((total, row) => total + BigInt(row.weight), 0n);
      const body = {
        mint: project.mint,
        symbol: project.symbol,
        promiseIdx: promise.idx,
        promise: promise.text,
        open: false,
        status: promise.status,
        closedAtMs: promise.closedAtMs ?? null,
        eligibleSupply: promise.eligibleAtClose ?? project.circulatingSupply,
        payWeight: sum("pay").toString(),
        burnWeight: sum("burn").toString(),
        voters: votes.filter((row) => BigInt(row.weight) > 0n).length,
        resultNet: promise.resultNet ?? null,
        messageFormat: voteMessage({
          mint: "<mint>",
          promiseIdx: promise.idx,
          side: "pay",
          nonce: "<nonce>",
        }).replace("Side: pay", "Side: <pay|burn>"),
        votes,
      };
      if (download) {
        reply.header(
          "content-disposition",
          `attachment; filename="tally-${project.symbol.toLowerCase().replace(/[^a-z0-9]/g, "")}-${promise.idx}.json"`,
        );
      }
      return body;
    });
  }

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

  app.get("/v1/wallets/:wallet", async (request) => {
    const { wallet } = request.params as { wallet: string };
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
      throw badRequest("That wallet address is not valid");
    }
    const projects = await opts.store.listProjects();
    const link = await auth.getX(wallet);
    const mine = projects.filter((project) => project.builderWallet === wallet);
    const handle = link?.xHandle || mine.find((project) => project.xHandle)?.xHandle || "";
    const verified = Boolean(link) || mine.some((project) => project.verified === true);
    const votes = await opts.store.listVotesByWallet(wallet);
    return presentProfile(wallet, handle, verified, projects, votes, at(request));
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

  app.get("/v1/builders/:handle/badge.svg", async (request, reply) => {
    const { handle } = request.params as { handle: string };
    const builder = await opts.store.getBuilderByHandle(handle);
    if (!builder) {
      throw notFound("No builder with that handle");
    }
    const record = builderRecord(await opts.store.listProjectsByBuilder(builder.id));
    const right =
      record.onTimePct === null
        ? `${record.shipped} shipped`
        : `${record.shipped} shipped, ${record.onTimePct}% on time`;
    return reply
      .type("image/svg+xml")
      .header("cache-control", "public, max-age=300")
      .send(badgeSvg(`@${builder.xHandle}`, right));
  });

  app.get("/v1/feed", async (request) => {
    const query = z
      .object({
        scope: z.string().optional(),
        filter: z.enum(["all", "shipped", "burned", "coins", "promises"]).optional(),
      })
      .parse(request.query);
    const projects = scoped(await opts.store.listProjects(), query.scope);
    const byMint = new Map(projects.map((project) => [project.mint, project]));
    const rows = (await opts.store.listFeed(200)).filter(
      (row) =>
        byMint.has(row.mint) &&
        row.atMs <= at(request) &&
        row.kind !== "inflow" &&
        feedMatches(row.kind, query.filter),
    );
    return { events: presentFeed(rows, byMint).slice(0, 50) };
  });

  app.get("/v1/coins/:mint/card.svg", async (request, reply) => {
    const { mint } = request.params as { mint: string };
    const project = await loadProject(opts.store, mint);
    const last = lastClosed(project);
    const line =
      last?.status === "paid"
        ? `$${project.symbol} shipped v${last.idx + 1} · ${Number(project.released) / 1_000_000_000} SOL paid to the builder`
        : last?.status === "burned" || last?.status === "missed"
          ? `$${project.symbol} burned · ${Number(project.burned) / 1_000_000_000} SOL`
          : `$${project.symbol} · ${Number(project.balance) / 1_000_000_000} SOL in the vault`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" role="img" aria-label="${escapeXml(line)}"><rect width="1200" height="630" fill="#F3F3F1"/><rect x="72" y="72" width="88" height="88" rx="19" fill="#111112"/><rect x="91" y="123" width="19" height="19" fill="#4A4A4D"/><rect x="122" y="123" width="19" height="19" fill="#FFFFFF"/><text x="184" y="118" fill="#111112" font-family="Geist, ui-sans-serif" font-size="42" font-weight="600">${escapeXml(project.name)}</text><text x="184" y="156" fill="#6E6E73" font-family="Geist Mono, ui-monospace" font-size="22">$${escapeXml(project.symbol)}</text><text x="72" y="320" fill="#111112" font-family="Geist, ui-sans-serif" font-size="48" font-weight="600">${escapeXml(line)}</text><text x="72" y="540" fill="#6E6E73" font-family="Geist, ui-sans-serif" font-size="22">Proof of Ship</text></svg>`;
    return reply.type("image/svg+xml").header("cache-control", "public, max-age=120").send(svg);
  });

  app.get("/v1/badge/:file", async (request, reply) => {
    const { file } = request.params as { file: string };
    if (!file.endsWith(".svg")) {
      throw notFound("No badge with that name");
    }
    const project = await loadProject(opts.store, file.slice(0, -4));
    const record = builderRecord([project]);
    const right = `${record.shipped} shipped, ${record.burned + record.missed} burned`;
    return reply
      .type("image/svg+xml")
      .header("cache-control", "public, max-age=300")
      .send(badgeSvg(`$${project.symbol}`, right));
  });

  for (const base of ["/v1/projects", "/v1/coins"]) {
    app.post(`${base}/:mint/promises`, async (request) => {
      const wallet = await requireWallet(request);
      const { mint } = request.params as { mint: string };
      const body = promiseSchema.parse(request.body);
      const project = await loadProject(opts.store, mint);
      if (project.builderWallet !== wallet) {
        throw badRequest("Only the builder can add a promise", "FORBIDDEN");
      }
      const builder = await opts.store.getBuilderByWallet(wallet);
      if (!builder) {
        throw notFound("Builder missing");
      }
      const balances = await snapshot(project);
      const events = appendPromise(project, body.title, body.deadlineMs, at(request), {
        doneLooksLike: body.doneLooksLike,
        proofType: body.proofType,
      });
      const posted = project.promises[project.promises.length - 1];
      posted.postedBalances = balances;
      await persist(opts.store, builder.id, project, events);
      return presentLive(opts.store, project, at(request), wallet);
    });
  }

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
    events.push(...(await advanceProject(opts.store, project, at(request))));
    await persist(opts.store, builder.id, project, events);
    return presentLive(opts.store, project, at(request), wallet);
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
      events.push(...(await advanceProject(opts.store, project, at(request))));
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

    app.post("/v1/sim/balance", async (request) => {
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
      setHolding(project, body.wallet, BigInt(body.amount));
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
