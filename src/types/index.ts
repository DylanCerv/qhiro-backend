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

export interface AiAnalysisRequest {
  parcelId: string;
  zoneId: string;
  ndvi: number;
  soilNutrients: SoilNutrients;
  soilMoisture: number;
  cropType?: string;
  timestamp: string;
}

export interface AiAnalysisResponse {
  diagnosis: string;
  severity: number;
  recommendedNpkFormula: SoilNutrients;
  recommendedAction: RecommendedAction;
  explanation: string;
}

export interface Parcel {
  parcelId: string;
  userId: string;
  cropType?: string;
  name: string;
  ndvi: number;
  healthStatus: 'green' | 'yellow' | 'red';
  zoneId: string;
  coordinates?: { lat: number; lng: number }[];
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
  type: 'drone' | 'sensor' | 'nest';
  name: string;
  status: 'online' | 'offline' | 'lowBattery';
  batteryLevel: number;
  lastSeenAt: string;
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

export type UserRole = 'admin' | 'client';

export type AccountStatus = 'active' | 'suspended' | 'disabled';

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface UserProfile {
  userId: string;
  email: string;
  displayName: string;
  role: UserRole;
  accountStatus: AccountStatus;
  country: string;
  location: GeoPoint;
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
}
