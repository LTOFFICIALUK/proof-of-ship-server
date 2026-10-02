import { createPgAuth } from "./auth-pg.js";
import { loadConfig } from "./config.js";
import { nowMs } from "./clock.js";
import { migrate, pool } from "./db.js";
import { logger } from "./logger.js";
import { buildApp } from "./app.js";
import { createPgStore } from "./store/pg.js";
import { startMintBank } from "./mint-bank.js";
import { startCrank } from "./workers/crank.js";

const main = async () => {
  const config = loadConfig();
  await migrate();
  const store = createPgStore();
  const app = await buildApp({
    store,
    allowSim: config.ALLOW_SIM,
    frontendOrigin: config.FRONTEND_ORIGIN,
    now: nowMs,
    auth: createPgAuth(),
  });
  const address = await app.listen({ host: "0.0.0.0", port: config.PORT });
  logger.info("server listening", { address });
  startMintBank();
  startCrank(store);
};

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error("fatal startup error", { message });
  await pool.end().catch(() => undefined);
  process.exit(1);
});
