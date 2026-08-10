import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { loadConfig } from './config.ts';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };
  const validEncryptionKey = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const envKeys = [
    'NODE_ENV',
    'PORT',
    'APP_PORT',
    'DB_PATH',
    'MQTT_BROKER_URL',
    'POSTGRES_HOST',
    'POSTGRES_PORT',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'POSTGRES_DB',
    'ENCRYPTION_KEY',
    'REDIS_URL',
    'GEOFENCE_EXIT_THRESHOLD_SECONDS',
  ] as const;

  beforeEach(() => {
    for (const key of envKeys) {
      delete process.env[key];
    }
    // Encryption key is required; tests that want to assert it's required
    // must delete it explicitly.
    process.env.ENCRYPTION_KEY = validEncryptionKey;
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (key in originalEnv) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  test('returns defaults when only the required encryption key is set', () => {
    const config = loadConfig();

    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(3001);
    expect(config.appPort).toBe(3002);
    expect(config.dbPath).toBe('location-tracker.db');
    expect(config.mqttBrokerUrl).toBe('mqtt://localhost:1883');
    expect(config.postgresHost).toBe('localhost');
    expect(config.postgresPort).toBe(5432);
    expect(config.postgresUser).toBe('location_tracker');
    expect(config.postgresPassword).toBeUndefined();
    expect(config.postgresDb).toBe('location_tracker');
    expect(config.encryptionKey).toBe(validEncryptionKey);
    expect(config.redisUrl).toBe('redis://localhost:6379');
    expect(config.geofenceExitThresholdSeconds).toBe(60);
  });

  test('returns custom values from env vars', () => {
    process.env.NODE_ENV = 'production';
    process.env.PORT = '8080';
    process.env.APP_PORT = '8081';
    process.env.DB_PATH = '/data/app.db';
    process.env.MQTT_BROKER_URL = 'mqtt://broker.example.com:1883';
    process.env.POSTGRES_HOST = 'db.example.com';
    process.env.POSTGRES_PORT = '5433';
    process.env.POSTGRES_USER = 'myuser';
    process.env.POSTGRES_PASSWORD = 'secret';
    process.env.POSTGRES_DB = 'mydb';
    process.env.ENCRYPTION_KEY = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    process.env.REDIS_URL = 'redis://redis.example.com:6380';
    process.env.GEOFENCE_EXIT_THRESHOLD_SECONDS = '120';

    const config = loadConfig();

    expect(config.nodeEnv).toBe('production');
    expect(config.port).toBe(8080);
    expect(config.appPort).toBe(8081);
    expect(config.dbPath).toBe('/data/app.db');
    expect(config.mqttBrokerUrl).toBe('mqtt://broker.example.com:1883');
    expect(config.postgresHost).toBe('db.example.com');
    expect(config.postgresPort).toBe(5433);
    expect(config.postgresUser).toBe('myuser');
    expect(config.postgresPassword).toBe('secret');
    expect(config.postgresDb).toBe('mydb');
    expect(config.encryptionKey).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(config.redisUrl).toBe('redis://redis.example.com:6380');
    expect(config.geofenceExitThresholdSeconds).toBe(120);
  });

  test('throws when ENCRYPTION_KEY is missing', () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => loadConfig()).toThrow();
  });

  test('throws when ENCRYPTION_KEY is an empty string', () => {
    process.env.ENCRYPTION_KEY = '';
    expect(() => loadConfig()).toThrow();
  });

  test('throws when ENCRYPTION_KEY is not 32 bytes', () => {
    process.env.ENCRYPTION_KEY = 'short-key';
    expect(() => loadConfig()).toThrow();
  });

  test('defaults NODE_ENV to development when unset', () => {
    const config = loadConfig();
    expect(config.nodeEnv).toBe('development');
  });

  test('accepts NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    const config = loadConfig();
    expect(config.nodeEnv).toBe('production');
  });

  test('throws when NODE_ENV is not production or development', () => {
    process.env.NODE_ENV = 'staging';
    expect(() => loadConfig()).toThrow();
  });

  test('throws when PORT is a privileged port (< 1024)', () => {
    process.env.PORT = '80';
    expect(() => loadConfig()).toThrow();
  });

  test('throws when PORT is 0', () => {
    process.env.PORT = '0';
    expect(() => loadConfig()).toThrow();
  });

  test('throws when PORT exceeds 65535', () => {
    process.env.PORT = '65536';
    expect(() => loadConfig()).toThrow();
  });

  test('throws when PORT is non-numeric', () => {
    process.env.PORT = 'abc';
    expect(() => loadConfig()).toThrow();
  });

  test('accepts port at lower boundary (1024)', () => {
    process.env.PORT = '1024';
    const config = loadConfig();
    expect(config.port).toBe(1024);
  });

  test('accepts port at upper boundary (65535)', () => {
    process.env.PORT = '65535';
    const config = loadConfig();
    expect(config.port).toBe(65535);
  });
});
