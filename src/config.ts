export interface Config {
  port: number;
  dbPath: string;
  mqttBrokerUrl: string;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT) || 3000,
    dbPath: process.env.DB_PATH || "location-tracker.db",
    mqttBrokerUrl: process.env.MQTT_BROKER_URL || "mqtt://localhost:1883",
  };
}
