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
    .default(3001),
  DB_PATH: z.string().default('location-tracker.db'),
  MQTT_BROKER_URL: z.string().default('mqtt://localhost:1883'),
  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.coerce.number().default(5432),
  POSTGRES_USER: z.string().default('location_tracker'),
  POSTGRES_PASSWORD: z.string().optional(),
  POSTGRES_DB: z.string().default('location_tracker'),
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
  postgresHost: string;
  postgresPort: number;
  postgresUser: string;
  postgresPassword?: string;
  postgresDb: string;
  encryptionKey: string;
};

export function loadConfig(): Config {
  const {
    NODE_ENV,
    PORT,
    DB_PATH,
    MQTT_BROKER_URL,
    POSTGRES_HOST,
    POSTGRES_PORT,
    POSTGRES_USER,
    POSTGRES_PASSWORD,
    POSTGRES_DB,
    ENCRYPTION_KEY,
  } = process.env;
  const env = ConfigSchema.parse({
    NODE_ENV,
    PORT,
    DB_PATH,
    MQTT_BROKER_URL,
    POSTGRES_HOST,
    POSTGRES_PORT,
    POSTGRES_USER,
    POSTGRES_PASSWORD,
    POSTGRES_DB,
    ENCRYPTION_KEY,
  });
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    dbPath: env.DB_PATH,
    mqttBrokerUrl: env.MQTT_BROKER_URL,
    postgresHost: env.POSTGRES_HOST,
    postgresPort: env.POSTGRES_PORT,
    postgresUser: env.POSTGRES_USER,
    postgresPassword: env.POSTGRES_PASSWORD,
    postgresDb: env.POSTGRES_DB,
    encryptionKey: env.ENCRYPTION_KEY,
  };
}
