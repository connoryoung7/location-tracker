import type { Deps } from "@/application/handle-payload.ts";
import type { Config } from "@/config.ts";

// TODO: Implement MQTT subscriber
// Will connect to config.mqttBrokerUrl, subscribe to owntracks/+/+ topic,
// parse incoming messages as OwnTracksPayload, and call handlePayload(payload, deps)
export function createMqttClient(_config: Config, _deps: Deps): void {
  throw new Error("MQTT client not yet implemented");
}
