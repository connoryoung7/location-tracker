import { test, expect, describe, afterEach } from 'bun:test';
import { loadConfig } from './config.ts';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env after each test
    for (const key of ['PORT', 'DB_PATH', 'MQTT_BROKER_URL', 'DATABASE_URL', 'ENCRYPTION_KEY']) {
      if (key in originalEnv) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  test('returns defaults when no env vars are set', () => {
    delete process.env.PORT;
    delete process.env.DB_PATH;
    delete process.env.MQTT_BROKER_URL;
    delete process.env.DATABASE_URL;
    delete process.env.ENCRYPTION_KEY;

    const config = loadConfig();

    expect(config.port).toBe(3000);
    expect(config.dbPath).toBe('location-tracker.db');
    expect(config.mqttBrokerUrl).toBe('mqtt://localhost:1883');
    expect(config.databaseUrl).toBeUndefined();
    expect(config.encryptionKey).toBeUndefined();
  });

  test('returns custom values from env vars', () => {
    process.env.PORT = '8080';
    process.env.DB_PATH = '/data/app.db';
    process.env.MQTT_BROKER_URL = 'mqtt://broker.example.com:1883';
    process.env.DATABASE_URL = 'postgres://localhost:5432/mydb';
    process.env.ENCRYPTION_KEY = 'supersecretkey';

    const config = loadConfig();

    expect(config.port).toBe(8080);
    expect(config.dbPath).toBe('/data/app.db');
    expect(config.mqttBrokerUrl).toBe('mqtt://broker.example.com:1883');
    expect(config.databaseUrl).toBe('postgres://localhost:5432/mydb');
    expect(config.encryptionKey).toBe('supersecretkey');
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
