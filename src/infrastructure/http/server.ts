import express from 'express';
import { OwnTracksPayloadSchema } from '@/domain/schemas.ts';
import { handlePayload, type Deps } from '@/application/handle-payload.ts';

export function createHttpServer(deps: Deps) {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      deps.logger.info(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    });
    next();
  });

  app.get('/', (_req, res) => {
    res.send('Location Trackers');
  });

  app.get('/_health', async (_req, res) => {
    try {
      await deps.repo.healthCheck();
      res.status(200).json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'error' });
    }
  });

  app.post('/pub', async (req, res) => {
    const result = OwnTracksPayloadSchema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json({ error: 'Invalid payload', issues: result.error.issues });
      return;
    }

    deps.logger.info(`Received payload: ${JSON.stringify(result.data)}`);

    await handlePayload(result.data, deps);
    res.status(200).json([]);
  });

  return app;
}
