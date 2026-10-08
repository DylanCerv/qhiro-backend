import type { GeoPoint } from './index.js';

export type QdeProjectStatus = 'draft' | 'active' | 'archived';
export type QdeVersionStatus = 'draft' | 'computed' | 'selected' | 'superseded';
export type QdeAlternativeStatus =
  | 'selected'
  | 'feasible_not_optimal'
  | 'not_feasible'
  | 'experimental';

export interface QdeSprayProfile {
  profileId: string;
  label: string;
  version: string;
  ra: number;
  fo: number;
  pa: number;
  qa: number;
}

export interface QdeCostCatalog {
  nidoUsd: number;
  cabecillaUsd: number;
  peonUsd: number;
  qdnUsd: number;
  pipePerMeterUsd: number;
  installPerNodeUsd: number;
}

export interface QdeConstraints {
  minCoveragePct: number;
  maxSimultaneousHeads: number;
  minTerminalPressureBar: number;
}

export interface QdeEnergyConfig {
  peonEffectiveRadiusM: number;
  cabecillaEffectiveRadiusM: number;
  nidoPumpMaxFlowLpm: number;
  nidoControlRadiusM: number;
  nidoSupplyVoltageV: number;
  minVoltageAtSentinelV: number;
  electricalLossPctPer100m: number;
  pipePressureLossBarPer100m: number;
  maxHydraulicReachM: number;
  maxSentinelsPerNido: number;
  maxCabecillasPerNido: number;
  maxPeonesPerNido: number;
}

export interface QdeTerrainInput {
  name: string;
  grossAreaHa: number;
  usefulAreaHa: number;
  coordinates?: GeoPoint[];
  exclusions?: GeoPoint[][];
}

export interface QdeCropInput {
  species: string;
  stage: string;
  canopyHeightM: number;
  mission: string;
}

export interface QdeVersionInputs {
  terrain: QdeTerrainInput;
  crop: QdeCropInput;
  sprayProfile: QdeSprayProfile;
  constraints: QdeConstraints;
  energy: QdeEnergyConfig;
  costs: QdeCostCatalog;
  notes?: string;
}

export interface QdeTraceStep {
  step: number;
  phase: string;
  title: string;
  detail: string;
  data?: Record<string, unknown>;
}

export interface QdeAlternative {
  alternativeId: string;
  label: string;
  totalNodes: number;
  cabecillas: number;
  peones: number;
  qdnCount: number;
  coveragePct: number;
  capexUsd: number;
  costPerUsefulHaUsd: number;
  peakFlowLpm: number;
  terminalPressureBar: number;
  status: QdeAlternativeStatus;
  rejectionReasons: string[];
  margins: {
    coverageAboveMinPct: number;
    pressureAboveMinBar: number;
    flowHeadroomLpm: number;
  };
}

export interface QdeDeploymentNode {
  nodeId: string;
  role: 'cabecilla' | 'peon' | 'nido' | 'qdn';
  coordinates: GeoPoint;
  sectorId?: string;
  placementReason: string;
  distanceFromNidoM?: number;
  estimatedVoltageV?: number;
  estimatedPressureBar?: number;
}

export interface QdeBudgetLine {
  item: string;
  quantity: number;
  unitUsd: number;
  subtotalUsd: number;
}

export interface QdeBudgetBreakdown {
  lines: QdeBudgetLine[];
  totalUsd: number;
  costPerUsefulHaUsd: number;
}

export interface QdeVersionOutput {
  engineVersion: string;
  computedAt: string;
  alternatives: QdeAlternative[];
  selectedAlternativeId: string | null;
  selectedAlternative: QdeAlternative | null;
  deploymentNodesByAlternative: Record<string, QdeDeploymentNode[]>;
  trace: QdeTraceStep[];
  summary: string;
  deploymentNodes: QdeDeploymentNode[];
  budgetBreakdown: QdeBudgetBreakdown | null;
  hydraulicSummary: {
    sectorCount: number;
    maxSimultaneousHeads: number;
    peakFlowLpm: number;
    terminalPressureBar: number;
  };
  coverageAnalysis?: {
    measuredCoveragePct: number;
    gapCount: number;
    gapPoints: GeoPoint[];
    gridSpacingM: number;
    sentinelCount: number;
  };
  energySummary?: {
    worstDistanceM: number;
    worstVoltageV: number;
    nidoControlRadiusM: number;
    withinRangeCount: number;
    outOfRangeCount: number;
    rejectionReasons: string[];
  };
}

export interface QdeDefaultConfig {
  costs: QdeCostCatalog;
  energy: QdeEnergyConfig;
  updatedAt?: string;
}

export interface QdeProject {
  projectId: string;
  userId: string;
  clientUserId?: string;
  clientName?: string;
  parcelId?: string;
  parcelName?: string;
  name: string;
  description?: string;
  status: QdeProjectStatus;
  currentVersionNumber: number;
  latestVersionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface QdePlanVersion {
  versionId: string;
  projectId: string;
  userId: string;
  versionNumber: number;
  label: string;
  status: QdeVersionStatus;
  parentVersionId?: string;
  inputs: QdeVersionInputs;
  output?: QdeVersionOutput;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface QdeProfileRecord extends QdeSprayProfile {
  type: 'spray_a' | 'spray_b';
  evidence?: string;
  createdAt: string;
}
