import { z } from 'zod';

const ConfigSchema = z.object({
  PORT: z.coerce
    .number()
    .min(1024, 'PORT must be >= 1024 (non-privileged)')
    .max(65535)
    .default(3000),
  DB_PATH: z.string().default('location-tracker.db'),
  MQTT_BROKER_URL: z.string().default('mqtt://localhost:1883'),
  DATABASE_URL: z.string().optional(),
  // Encryption key should be stored as UTF-16, not as a base64 encoded string
  ENCRYPTION_KEY: z.string().optional(),
});

export type Config = {
  port: number;
  dbPath: string;
  mqttBrokerUrl: string;
  databaseUrl?: string;
  encryptionKey?: string;
};

export function loadConfig(): Config {
  const env = ConfigSchema.parse(process.env);
  return {
    port: env.PORT,
    dbPath: env.DB_PATH,
    mqttBrokerUrl: env.MQTT_BROKER_URL,
    databaseUrl: env.DATABASE_URL,
    encryptionKey: env.ENCRYPTION_KEY,
  };
}
