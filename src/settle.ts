import { crank, executeBuybackBurn, finalizeVote, lapse } from "./engine/vault.js";
import type { ProjectState } from "./engine/types.js";
import type { EngineEvent } from "./engine/vault.js";
import type { ShipStore } from "./store/memory.js";
import { weighVotes } from "./weights.js";

export const advanceProject = async (
  store: ShipStore,
  project: ProjectState,
  at: number,
): Promise<EngineEvent[]> => {
  const vote = project.vote;
  if (!vote || at < vote.endMs) {
    return crank(project, at);
  }
  const promise = project.promises.find((item) => item.idx === vote.promiseIdx);
  if (!promise) {
    return crank(project, at);
  }
  const votes = (await store.listHolderVotes(project.mint)).filter(
    (row) => row.promiseIdx === vote.promiseIdx,
  );
  const weighed = await weighVotes(project, promise, votes);
  if (!weighed.ok) {
    return [];
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
  return events;
};
