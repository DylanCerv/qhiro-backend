import mqtt, { type MqttClient } from 'mqtt';
import { env } from '../config/env.js';
import { handleDroneTelemetry, handleNestTelemetry, handleSensorTelemetry } from './telemetry-handler.js';

const TOPICS = {
  droneTelemetry: 'qhiro/drone/telemetry',
  sensorTelemetry: 'qhiro/sensor/telemetry',
  nestTelemetry: 'qhiro/nest/telemetry',
  droneCommand: 'qhiro/drone/command',
  sensorCommand: (sensorId: string) => `qhiro/sensor/command/${sensorId}`,
} as const;

let client: MqttClient | null = null;

export function shutdownMqtt(): void {
  if (!client) return;
  client.end(true);
  client = null;
}

export function initMqtt(): void {
  if (client) return;

  client = mqtt.connect(env.mqttBrokerUrl, {
    reconnectPeriod: 5000,
    connectTimeout: 10000,
  });

  client.on('connect', () => {
    console.log('[MQTT] Connected to broker');
    client?.subscribe([
      TOPICS.droneTelemetry,
      TOPICS.sensorTelemetry,
      TOPICS.nestTelemetry,
    ]);
  });

  client.on('message', async (topic, payload) => {
    try {
      const data = JSON.parse(payload.toString()) as Record<string, unknown>;
      if (topic === TOPICS.droneTelemetry) {
        await handleDroneTelemetry(data);
      } else if (topic === TOPICS.sensorTelemetry) {
        await handleSensorTelemetry(data);
      } else if (topic === TOPICS.nestTelemetry) {
        await handleNestTelemetry(data);
      }
    } catch (error) {
      console.error('[MQTT] Failed to process message:', error);
    }
  });

  client.on('error', (error) => {
    console.error('[MQTT] Connection error:', error.message);
  });
}

export function sendDroneCommand(command: Record<string, unknown>): void {
  publish(TOPICS.droneCommand, command);
}

export function sendSensorCommand(sensorId: string, command: Record<string, unknown>): void {
  publish(TOPICS.sensorCommand(sensorId), command);
}

function publish(topic: string, payload: Record<string, unknown>): void {
  if (!client?.connected) {
    console.warn(`[MQTT] Not connected — command queued to log: ${topic}`, payload);
    return;
  }
  client.publish(topic, JSON.stringify(payload), { qos: 1 });
  console.log(`[MQTT] Published to ${topic}`);
}

export { TOPICS };
