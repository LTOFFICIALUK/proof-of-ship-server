import { nowMs } from "../clock.js";
import { syncTradingFees } from "../creator-fees.js";
import { claimAbandonedFees, ingestVaultInflows } from "../fees.js";
import { logger } from "../logger.js";
import { refillMintBank } from "../mint-bank.js";
import { advanceProject } from "../settle.js";
import type { ShipStore } from "../store/memory.js";

export const runCrank = async (store: ShipStore) => {
  const listed = await store.listProjects();
  const at = nowMs();
  try {
    await syncTradingFees(store);
    await claimAbandonedFees(listed);
    await ingestVaultInflows(store, at);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("fee ingest failed", { message });
  }
  void refillMintBank();
  const projects = await store.listProjects();
  let events = 0;
  for (const project of projects) {
    const builder = await store.getBuilderByWallet(project.builderWallet);
    if (!builder) {
      continue;
    }
    const next = await advanceProject(store, project, at);
    if (next.length) {
      events += next.length;
      await store.saveProject(builder.id, project);
      await store.appendEvents(next);
    }
  }
  if (events) {
    logger.info("crank", { events });
  }
  return events;
};

export const startCrank = (store: ShipStore) => {
  const tick = async () => {
    try {
      await runCrank(store);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("crank failed", { message });
    }
  };
  void tick();
  return setInterval(tick, 60_000);
};
