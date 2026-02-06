import express from 'express';
import type { OwnTracksPayload } from '@/domain/types.ts';
import { handlePayload, type Deps } from '@/application/handle-payload.ts';

export function createHttpServer(deps: Deps) {
  const app = express();
  app.use(express.json());

  app.get('/', (_req, res) => {
    res.send('Location Tracker');
  });

  app.get('/_health', async (_req, res) => {
    try {
      await deps.repo.healthCheck();
      res.status(200).json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'error' });
    }
  });

  app.post('/owntracks', async (req, res) => {
    const payload = req.body as OwnTracksPayload;

    if (!payload._type) {
      res.status(400).json({ error: 'Missing _type field' });
      return;
    }

    await handlePayload(payload, deps);
    res.status(200).json([]);
  });

  return app;
}
