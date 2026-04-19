import { z } from 'zod';

const SECRETBOX_KEY_BYTES = 32;

function encryptionKeyByteLength(encryptionKey: string): number | undefined {
  try {
    return Buffer.from(btoa(encryptionKey), 'base64').length;
  } catch {
    return undefined;
  }
}

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['production', 'development']).default('development'),
  PORT: z.coerce
    .number()
    .min(1024, 'PORT must be >= 1024 (non-privileged)')
    .max(65535)
    .default(3000),
  DB_PATH: z.string().default('location-tracker.db'),
  MQTT_BROKER_URL: z.string().default('mqtt://localhost:1883'),
  DATABASE_URL: z.string().optional(),
  // Encryption key should be stored as UTF-16, not as a base64 encoded string
  ENCRYPTION_KEY: z
    .string()
    .min(1, 'ENCRYPTION_KEY is required')
    .refine((key) => encryptionKeyByteLength(key) === SECRETBOX_KEY_BYTES, {
      message: `ENCRYPTION_KEY must be ${SECRETBOX_KEY_BYTES} bytes`,
    }),
});

export type Config = {
  nodeEnv: 'production' | 'development';
  port: number;
  dbPath: string;
  mqttBrokerUrl: string;
  databaseUrl?: string;
  encryptionKey: string;
};

export function loadConfig(): Config {
  const { NODE_ENV, PORT, DB_PATH, MQTT_BROKER_URL, DATABASE_URL, ENCRYPTION_KEY } = process.env;
  const env = ConfigSchema.parse({
    NODE_ENV,
    PORT,
    DB_PATH,
    MQTT_BROKER_URL,
    DATABASE_URL,
    ENCRYPTION_KEY,
  });
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    dbPath: env.DB_PATH,
    mqttBrokerUrl: env.MQTT_BROKER_URL,
    databaseUrl: env.DATABASE_URL,
    encryptionKey: env.ENCRYPTION_KEY,
  };
}
