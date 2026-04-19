import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { loadConfig } from './config.ts';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };
  const validEncryptionKey = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const envKeys = [
    'NODE_ENV',
    'PORT',
    'DB_PATH',
    'MQTT_BROKER_URL',
    'DATABASE_URL',
    'ENCRYPTION_KEY',
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
    expect(config.port).toBe(3000);
    expect(config.dbPath).toBe('location-tracker.db');
    expect(config.mqttBrokerUrl).toBe('mqtt://localhost:1883');
    expect(config.databaseUrl).toBeUndefined();
    expect(config.encryptionKey).toBe(validEncryptionKey);
  });

  test('returns custom values from env vars', () => {
    process.env.NODE_ENV = 'production';
    process.env.PORT = '8080';
    process.env.DB_PATH = '/data/app.db';
    process.env.MQTT_BROKER_URL = 'mqtt://broker.example.com:1883';
    process.env.DATABASE_URL = 'postgres://localhost:5432/mydb';
    process.env.ENCRYPTION_KEY = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    const config = loadConfig();

    expect(config.nodeEnv).toBe('production');
    expect(config.port).toBe(8080);
    expect(config.dbPath).toBe('/data/app.db');
    expect(config.mqttBrokerUrl).toBe('mqtt://broker.example.com:1883');
    expect(config.databaseUrl).toBe('postgres://localhost:5432/mydb');
    expect(config.encryptionKey).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
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
