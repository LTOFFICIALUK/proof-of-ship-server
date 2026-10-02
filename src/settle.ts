import { crank, executeBuybackBurn, finalizeVote, lapse } from "./engine/vault.js";
import type { ProjectState } from "./engine/types.js";
import type { EngineEvent } from "./engine/vault.js";
import { loadHoldings } from "./holdings.js";
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
    if (votes.length && project.vote) {
      const holdings = await loadHoldings(
        project,
        votes.map((row) => row.wallet),
      );
      if (holdings.ok) {
        project.vote.payWeight = "0";
        project.vote.burnWeight = "0";
        project.vote.locks = [];
        for (const vote of votes) {
          const current = holdings.balances.get(vote.wallet) ?? 0n;
          const promise = project.promises.find((item) => item.idx === project.vote?.promiseIdx);
          const posted = promise?.postedBalances?.[vote.wallet];
          const proof = promise?.proofBalances?.[vote.wallet];
          let weight = current;
          if (vote.wallet === project.builderWallet || project.excludedWallets?.includes(vote.wallet)) {
            weight = 0n;
          } else {
            if (proof !== undefined) {
              const proofN = BigInt(proof);
              weight = weight < proofN ? weight : proofN;
            }
            if (posted !== undefined) {
              const postedN = BigInt(posted);
              weight = weight < postedN ? weight : postedN;
            } else if (project.demo === false) {
              weight = 0n;
            }
          }
          if (weight <= 0n) {
            continue;
          }
          if (vote.side === "down") {
            project.vote.burnWeight = (BigInt(project.vote.burnWeight) + weight).toString();
          } else {
            project.vote.payWeight = (BigInt(project.vote.payWeight) + weight).toString();
          }
        }
        const events = finalizeVote(project, at);
        events.push(...lapse(project, at));
        events.push(...executeBuybackBurn(project, at));
        return events;
      }
    }
  }
  return crank(project, at);
};
