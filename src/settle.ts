import { crank, executeBuybackBurn, finalizeFromNet, lapse } from "./engine/vault.js";
import type { ProjectState } from "./engine/types.js";
import type { EngineEvent } from "./engine/vault.js";
import { loadHoldings, tallyVotes } from "./holdings.js";
import type { ShipStore } from "./store/memory.js";

export const advanceProject = async (
  store: ShipStore,
  project: ProjectState,
  at: number,
): Promise<EngineEvent[]> => {
  if (project.vote && at >= project.vote.endMs) {
    const votes = (await store.listHolderVotes(project.mint)).filter(
      (row) => row.promiseIdx === project.vote?.promiseIdx,
    );
    if (votes.length) {
      const holdings = await loadHoldings(
        project,
        votes.map((row) => row.wallet),
      );
      if (holdings.ok) {
        const tally = tallyVotes(votes, holdings.balances, holdings.supply);
        const promise = project.promises.find((item) => item.idx === project.vote?.promiseIdx);
        if (promise) {
          promise.resultNet = tally.netPct;
        }
        const events = finalizeFromNet(project, at, tally.netPct > 0);
        events.push(...lapse(project, at));
        events.push(...executeBuybackBurn(project, at));
        return events;
      }
    }
  }
  return crank(project, at);
};
