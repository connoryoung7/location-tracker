export interface Config {
  port: number;
  dbPath: string;
  mqttBrokerUrl: string;
  databaseUrl?: string;
  encryptionKey?: string;
}

  export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT) || 3000,
    dbPath: process.env.DB_PATH || 'location-tracker.db',
    mqttBrokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
    databaseUrl: process.env.DATABASE_URL,
    // Encryption key should be stored as UTF-16, not as a base64 encoded string
    encryptionKey: process.env.ENCRYPTION_KEY,
  };
}
