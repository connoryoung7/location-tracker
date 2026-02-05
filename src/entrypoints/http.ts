import { loadConfig } from "../config.ts";
import { PinoLogger } from "../infrastructure/logging/pino.logger.ts";
import { SqliteLocationRepository } from "../infrastructure/persistence/sqlite.repository.ts";
import { createHttpServer } from "../infrastructure/http/server.ts";
import type { Deps } from "../application/handle-payload.ts";

const config = loadConfig();

const deps: Deps = {
  repo: new SqliteLocationRepository(config.dbPath),
  logger: new PinoLogger(),
};

const app = createHttpServer(deps);

app.listen(config.port, () => {
  deps.logger.info(`HTTP server running on http://localhost:${config.port}`);
});
