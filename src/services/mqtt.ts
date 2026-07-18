import mqtt, { type MqttClient } from 'mqtt';
import { env } from '../config/env.js';
import type { Device } from '../types/index.js';
import { completeActionExecutionLog } from './firebase.js';
import { handleDroneTelemetry, handleNestTelemetry, handleSensorTelemetry } from './telemetry-handler.js';

const TOPICS = {
  telemetry: 'qhiro/users/+/devices/+/+/telemetry',
  actionAck: 'qhiro/users/+/devices/+/actions/+/ack',
  telemetryFor: (userId: string, deviceId: string, deviceType: Device['type']) =>
    `qhiro/users/${userId}/devices/${deviceId}/${deviceType}/telemetry`,
  actionAckFor: (userId: string, deviceId: string, actionId: string) =>
    `qhiro/users/${userId}/devices/${deviceId}/actions/${actionId}/ack`,
  deviceCommand: (userId: string, deviceId: string) =>
    `qhiro/users/${userId}/devices/${deviceId}/command`,
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
    clientId: env.mqttClientId || undefined,
    username: env.mqttUsername || undefined,
    password: env.mqttPassword || undefined,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
  });

  client.on('connect', () => {
    console.log('[MQTT] Connected to broker');
    client?.subscribe(TOPICS.telemetry, { qos: 1 });
    client?.subscribe(TOPICS.actionAck, { qos: 1 });
  });

  client.on('message', async (topic, payload) => {
    try {
      const data = JSON.parse(payload.toString()) as Record<string, unknown>;
      const actionAckTopic = parseActionAckTopic(topic);
      if (actionAckTopic) {
        await handleActionAck(actionAckTopic, data);
        return;
      }

      const parsedTopic = parseTelemetryTopic(topic);
      if (!parsedTopic) {
        console.warn(`[MQTT] Ignoring unsupported topic: ${topic}`);
        return;
      }

      if (parsedTopic.deviceType === 'drone') {
        await handleDroneTelemetry(parsedTopic, data);
      } else if (parsedTopic.deviceType === 'sensor' || parsedTopic.deviceType === 'sentinel') {
        await handleSensorTelemetry(parsedTopic, data);
      } else if (parsedTopic.deviceType === 'nest') {
        await handleNestTelemetry(parsedTopic, data);
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
  const userId = String(command.userId ?? '');
  const deviceId = String(command.deviceId ?? '');
  if (!userId || !deviceId) {
    console.warn('[MQTT] Drone command missing userId or deviceId. Command not published.', command);
    return;
  }
  publish(TOPICS.deviceCommand(userId, deviceId), command);
}

export function sendSensorCommand(userId: string, sensorId: string, command: Record<string, unknown>): void {
  publish(TOPICS.deviceCommand(userId, sensorId), command);
}

export function getMqttStatus(): { connected: boolean; brokerUrl: string; clientId: string | null } {
  return {
    connected: Boolean(client?.connected),
    brokerUrl: env.mqttBrokerUrl,
    clientId: client?.options.clientId ?? null,
  };
}

export function publishMqttDiagnostic(payload: Record<string, unknown>): void {
  publish('qhiro/admin/diagnostics', {
    ...payload,
    source: 'qhiro-backend',
    timestamp: new Date().toISOString(),
  });
}

export function publishTelemetry(
  userId: string,
  deviceId: string,
  deviceType: Device['type'],
  payload: Record<string, unknown>,
): void {
  publish(TOPICS.telemetryFor(userId, deviceId, deviceType), payload);
}

export function publishActionAck(
  userId: string,
  deviceId: string,
  actionId: string,
  payload: Record<string, unknown>,
): void {
  publish(TOPICS.actionAckFor(userId, deviceId, actionId), payload);
}

function publish(topic: string, payload: Record<string, unknown>): void {
  if (!client?.connected) {
    console.warn(`[MQTT] Not connected — command queued to log: ${topic}`, payload);
    return;
  }
  client.publish(topic, JSON.stringify(payload), { qos: 1 });
  console.log(`[MQTT] Published to ${topic}`);
}

function parseTelemetryTopic(
  topic: string,
): { userId: string; deviceId: string; deviceType: Device['type'] } | null {
  const match = /^qhiro\/users\/([^/]+)\/devices\/([^/]+)\/(drone|sensor|nest|sentinel)\/telemetry$/.exec(topic);
  if (!match) return null;
  return {
    userId: match[1],
    deviceId: match[2],
    deviceType: match[3] as Device['type'],
  };
}

function parseActionAckTopic(topic: string): { userId: string; deviceId: string; actionId: string } | null {
  const match = /^qhiro\/users\/([^/]+)\/devices\/([^/]+)\/actions\/([^/]+)\/ack$/.exec(topic);
  if (!match) return null;
  return {
    userId: match[1],
    deviceId: match[2],
    actionId: match[3],
  };
}

async function handleActionAck(
  topic: { userId: string; deviceId: string; actionId: string },
  data: Record<string, unknown>,
): Promise<void> {
  const status = data.status === 'failed' ? 'failed' : 'completed';
  const error = typeof data.error === 'string' ? data.error : undefined;
  const updated = await completeActionExecutionLog(topic.userId, topic.actionId, topic.deviceId, status, {
    ...data,
    deviceId: topic.deviceId,
  }, error);

  if (!updated) {
    console.warn(`[MQTT] Action ack ignored. Unknown action "${topic.actionId}" for user "${topic.userId}".`);
    return;
  }

  console.log(`[MQTT] Action ${topic.actionId} marked ${status} in ${updated.durationMs ?? 0}ms`);
}

export { TOPICS };
