import { nowMs } from "../clock.js";
import { crank } from "../engine/vault.js";
import { logger } from "../logger.js";
import type { ShipStore } from "../store/memory.js";

export const runCrank = async (store: ShipStore) => {
  const projects = await store.listProjects();
  const at = nowMs();
  let events = 0;
  for (const project of projects) {
    const builder = await store.getBuilderByWallet(project.builderWallet);
    if (!builder) {
      continue;
    }
    const next = crank(project, at);
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
