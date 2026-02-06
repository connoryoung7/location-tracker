import express from 'express';
import type { OwnTracksPayload } from '@/domain/types.ts';
import { handlePayload, type Deps } from '@/application/handle-payload.ts';

export function createHttpServer(deps: Deps) {
  const app = express();
  app.use(express.json());

  app.get('/', (_req, res) => {
    res.send('Location Tracker');
  });

  app.post('/owntracks', (req, res) => {
    const payload = req.body as OwnTracksPayload;

    if (!payload._type) {
      res.status(400).json({ error: 'Missing _type field' });
      return;
    }

    handlePayload(payload, deps);
    res.status(200).json([]);
  });

  return app;
}
