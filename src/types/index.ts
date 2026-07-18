export type RecommendedAction = 'none' | 'monitor' | 'injection' | 'emergency';

export type FlightStatus = 'scheduled' | 'started' | 'completed' | 'failed';

export type NotificationEvent =
  | 'flightCompleted'
  | 'anomalyDetected'
  | 'injectionExecuted'
  | 'emergencyAlert'
  | 'deviceLowBattery'
  | 'supplyLow';

export interface SoilNutrients {
  nitrogen: number;
  phosphorus: number;
  potassium: number;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface CropTypeOption {
  value: string;
  label: string;
}

export interface AiAnalysisRequest {
  parcelId: string;
  zoneId: string;
  ndvi: number;
  soilNutrients: SoilNutrients;
  soilMoisture: number;
  cropType?: string;
  timestamp: string;
  imageUrl?: string;
  imageBase64?: string;
  coordinates?: GeoPoint[];
}

export interface AiAnalysisResponse {
  diagnosis: string;
  severity: number;
  recommendedNpkFormula: SoilNutrients;
  recommendedAction: RecommendedAction;
  explanation: string;
  affectedCoordinates?: GeoPoint[] | null;
}

export interface Parcel {
  parcelId: string;
  userId: string;
  cropType?: string;
  name: string;
  ndvi: number;
  healthStatus: 'green' | 'yellow' | 'red';
  zoneId: string;
  coordinates?: GeoPoint[];
  soilNutrients?: SoilNutrients;
  soilMoisture?: number;
  createdAt: string;
}

export type ScheduleType = 'routine' | 'inspection' | 'emergency';

export interface FlightSchedule {
  scheduleId: string;
  userId: string;
  parcelId: string;
  scheduleType: ScheduleType;
  startTime: string;
  frequencyDays: number;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string;
}

export interface Flight {
  flightId: string;
  userId: string;
  parcelId: string;
  status: FlightStatus;
  scheduledAt: string;
  startedAt: string | null;
  completedAt: string | null;
  reportId: string | null;
}

export interface Alert {
  alertId: string;
  userId: string;
  parcelId: string;
  severity: number;
  message: string;
  event: NotificationEvent;
  createdAt: string;
  read: boolean;
}

export interface Device {
  deviceId: string;
  userId: string;
  type: 'drone' | 'sensor' | 'nest' | 'sentinel';
  name: string;
  status: 'online' | 'offline' | 'lowBattery';
  batteryLevel: number;
  lastSeenAt: string;
  parcelId?: string;
  zoneId?: string;
}

export interface Report {
  reportId: string;
  userId: string;
  parcelId: string;
  severity: number;
  diagnosis: string;
  npkFormula: SoilNutrients;
  storagePath: string;
  createdAt: string;
}

export type TelemetryProcessingStatus = 'processed' | 'rejected' | 'failed';

export interface TelemetryProcessingLog {
  logId: string;
  userId: string;
  deviceId: string;
  deviceType: Device['type'];
  parcelId?: string;
  flightId?: string;
  status: TelemetryProcessingStatus;
  validationMessage?: string;
  payload: Record<string, unknown>;
  aiRequest?: AiAnalysisRequest;
  aiResponse?: AiAnalysisResponse;
  actions: string[];
  durationMs: number;
  createdAt: string;
}

export type ActionExecutionStatus = 'pending' | 'completed' | 'failed';

export interface ActionExecutionLog {
  actionId: string;
  userId: string;
  deviceId: string;
  parcelId: string;
  zoneId: string;
  action: 'inject' | 'rescan' | 'command';
  status: ActionExecutionStatus;
  commandPayload: Record<string, unknown>;
  ackPayload?: Record<string, unknown>;
  error?: string;
  queueReason?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

export type UserRole = 'admin' | 'client';

export type AccountStatus = 'active' | 'suspended' | 'disabled';

export interface UserProfile {
  userId: string;
  email: string;
  displayName: string;
  role: UserRole;
  accountStatus: AccountStatus;
  country: string;
  location: GeoPoint;
  fcmToken?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthenticatedUser {
  uid: string;
  email?: string;
  role: UserRole;
  accountStatus: AccountStatus;
  displayName?: string;
  country?: string;
  location?: GeoPoint;
  fcmToken?: string;
}
