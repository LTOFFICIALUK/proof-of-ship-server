import { burnPos, buyPos, buybackBurn, sendSolFromVault } from "./chain.js";
import { crank, executeBuybackBurn, executePosBuy, finalizeVote, lapse } from "./engine/vault.js";
import type { ProjectState } from "./engine/types.js";
import type { EngineEvent } from "./engine/vault.js";
import { logger } from "./logger.js";
import { POS_MINT } from "./pos.js";
import { destinations, treasury } from "./wallets.js";
import type { ShipStore } from "./store/memory.js";
import { weighVotes } from "./weights.js";

const n = (value: string | undefined) => BigInt(value ?? "0");

const ensureChain = (project: ProjectState) => {
  project.chain = { ...destinations(), ...project.chain };
};

export const payCuts = async (project: ProjectState, at: number): Promise<EngineEvent[]> => {
  const events: EngineEvent[] = [];
  const keys = treasury();
  if (project.demo !== false || !keys.vaultSigner) {
    return events;
  }
  ensureChain(project);
  const chain = project.chain!;
  const owedRunway = n(project.runwayPaid) - n(chain.runwaySent);
  if (owedRunway > 0n) {
    try {
      const sig = await sendSolFromVault(project.builderWallet, owedRunway);
      chain.runwaySent = (n(chain.runwaySent) + owedRunway).toString();
      events.push({
        kind: "inflow",
        atMs: at,
        mint: project.mint,
        detail: { runway: owedRunway.toString(), sig: sig || "", to: project.builderWallet },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("runway send waiting", { mint: project.mint, message });
    }
  }
  const owedPlatform = n(project.platformPaid) - n(chain.platformSent);
  if (owedPlatform > 0n && keys.platform) {
    try {
      const sig = await sendSolFromVault(keys.platform, owedPlatform);
      chain.platformSent = (n(chain.platformSent) + owedPlatform).toString();
      events.push({
        kind: "inflow",
        atMs: at,
        mint: project.mint,
        detail: { platform: owedPlatform.toString(), sig: sig || "", to: keys.platform },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("platform send waiting", { mint: project.mint, message });
    }
  }
  return events;
};

const stamp = (detail: EngineEvent["detail"], fields: Record<string, string>) => {
  for (const [key, value] of Object.entries(fields)) {
    if (value) {
      detail[key] = value;
    }
  }
};

export const flushChain = async (
  project: ProjectState,
  at: number,
  prior: EngineEvent[] = [],
): Promise<EngineEvent[]> => {
  const events: EngineEvent[] = [];
  if (project.demo !== false || !treasury().vaultSigner) {
    return events;
  }
  ensureChain(project);
  const chain = project.chain!;
  events.push(...(await payCuts(project, at)));

  const owedPay = n(project.released) - n(chain.paid);
  if (owedPay > 0n) {
    try {
      const sig = await sendSolFromVault(project.builderWallet, owedPay);
      chain.paid = (n(chain.paid) + owedPay).toString();
      events.push({
        kind: "release",
        atMs: at,
        mint: project.mint,
        detail: { amount: owedPay.toString(), sig: sig || "", to: project.builderWallet },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("pay send waiting", { mint: project.mint, message });
    }
  }

  const posQueued = n(project.posBucket);
  if (posQueued > 0n) {
    try {
      const bought = await buyPos(posQueued);
      let burnSig = "";
      try {
        burnSig = await burnPos(bought.out);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        chain.posUnburned = (n(chain.posUnburned) + bought.out).toString();
        logger.warn("pos burn waiting", { mint: project.mint, message });
      }
      const created = executePosBuy(project, at, bought.out);
      const target = created[created.length - 1];
      if (target) {
        stamp(target.detail, {
          sig: bought.sig,
          buySig: bought.sig,
          burnSig,
          token: POS_MINT,
          tokens: bought.out.toString(),
        });
        events.push(...created);
      }
      chain.posSpent = (n(chain.posSpent) + posQueued).toString();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("pos buy waiting", { mint: project.mint, message });
    }
  }

  const unburned = n(chain.posUnburned);
  if (unburned > 0n) {
    try {
      const sig = await burnPos(unburned);
      chain.posUnburned = "0";
      const open = [...prior, ...events].reverse().find((event) => event.kind === "pos" && !event.detail.burnSig);
      if (open && sig) {
        open.detail.burnSig = sig;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("pos burn waiting", { mint: project.mint, message });
    }
  }

  const owedBurn = n(project.burned) + n(project.burnBucket) - n(chain.posSpent) - n(chain.burnSpent);
  if (owedBurn > 0n) {
    try {
      const bought = await buybackBurn(project.mint, owedBurn);
      const created = executeBuybackBurn(project, at);
      const open = [...prior, ...created].filter((event) => event.kind === "burn" && !event.detail.buySig);
      const fields = {
        sig: bought.sig,
        buySig: bought.sig,
        burnSig: "burnSig" in bought ? bought.burnSig : "",
        token: project.mint,
        tokens: bought.out.toString(),
      };
      if (open.length) {
        for (const event of open) {
          stamp(event.detail, fields);
        }
        events.push(...created);
      } else {
        events.push({
          kind: "burn",
          atMs: at,
          mint: project.mint,
          detail: { amount: owedBurn.toString(), ...fields },
        });
      }
      chain.burnSpent = (n(chain.burnSpent) + owedBurn).toString();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("burn send waiting", { mint: project.mint, message });
    }
  }

  return events;
};

export const fillPos = async (project: ProjectState, at: number): Promise<EngineEvent[]> =>
  flushChain(project, at);

export const advanceProject = async (
  store: ShipStore,
  project: ProjectState,
  at: number,
): Promise<EngineEvent[]> => {
  const vote = project.vote;
  if (!vote || at < vote.endMs) {
    const events = crank(project, at);
    events.push(...(await flushChain(project, at, events)));
    return events;
  }
  const promise = project.promises.find((item) => item.idx === vote.promiseIdx);
  if (!promise) {
    const events = crank(project, at);
    events.push(...(await flushChain(project, at, events)));
    return events;
  }
  const votes = (await store.listHolderVotes(project.mint)).filter(
    (row) => row.promiseIdx === vote.promiseIdx,
  );
  const weighed = await weighVotes(project, promise, votes);
  if (!weighed.ok) {
    return flushChain(project, at);
  }
  vote.payWeight = weighed.pay.toString();
  vote.burnWeight = weighed.burn.toString();
  vote.locks = [];
  const events = finalizeVote(project, at, weighed.eligible);
  if (promise.status !== "vote_open") {
    promise.eligibleAtClose = weighed.eligible.toString();
    promise.tally = weighed.rows.map((row) => ({
      wallet: row.wallet,
      side: row.side === "down" ? "burn" : "pay",
      weight: row.weight.toString(),
      reason: row.reason,
      message: row.message,
      signature: row.signature,
    }));
  }
  events.push(...lapse(project, at));
  events.push(...executeBuybackBurn(project, at));
  events.push(...(await flushChain(project, at, events)));
  return events;
};
