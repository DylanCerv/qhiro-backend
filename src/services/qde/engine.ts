import type {
  QdeAlternative,
  QdeAlternativeStatus,
  QdeBudgetBreakdown,
  QdeCostCatalog,
  QdeDeploymentNode,
  QdeEnergyConfig,
  QdeSprayProfile,
  QdeTraceStep,
  QdeVersionInputs,
  QdeVersionOutput,
} from '../../types/qde.js';
import type { GeoPoint } from '../../types/index.js';
import { distanceMeters } from '../../utils/geo.js';
import {
  findOptimalNidoPosition,
  measureCoveragePct,
  metersToLatDelta,
  metersToLngDelta,
  optimizeSentinelPlacement,
  pickBestGapPoint,
  pickCabecillaIndices,
  pruneRedundantSentinels,
} from './coverage.js';

export const QDE_ENGINE_VERSION = '1.2.3-fast-placement';

const MIN_PIPE_LENGTH_M = 40;
const MAX_QDN_COUNT = 3;

interface EnergyValidation {
  ok: boolean;
  worstDistanceM: number;
  worstVoltageV: number;
  reasons: string[];
  withinRange: number;
}

interface InfrastructurePlan {
  nidoPosition: GeoPoint;
  sentinelPoints: GeoPoint[];
  cabecillaCount: number;
  qdnPositions: GeoPoint[];
  pipeLengthM: number;
  coveragePct: number;
  gapCount: number;
  energy: EnergyValidation;
}

export function defaultEnergyConfig(ra = 12): QdeEnergyConfig {
  return {
    peonEffectiveRadiusM: ra,
    cabecillaEffectiveRadiusM: ra,
    nidoPumpMaxFlowLpm: 120,
    nidoControlRadiusM: 450,
    nidoSupplyVoltageV: 48,
    minVoltageAtSentinelV: 42,
    electricalLossPctPer100m: 2.5,
    pipePressureLossBarPer100m: 0.35,
    maxHydraulicReachM: 380,
    maxSentinelsPerNido: 64,
    maxCabecillasPerNido: 64,
    maxPeonesPerNido: 64,
  };
}

export function normalizeInputs(inputs: Partial<QdeVersionInputs> & Pick<QdeVersionInputs, 'terrain' | 'crop' | 'sprayProfile' | 'constraints' | 'costs'>): QdeVersionInputs {
  const ra = inputs.sprayProfile?.ra ?? 12;
  return {
    ...inputs,
    energy: {
      ...defaultEnergyConfig(ra),
      ...inputs.energy,
      peonEffectiveRadiusM: inputs.energy?.peonEffectiveRadiusM ?? ra,
      cabecillaEffectiveRadiusM: inputs.energy?.cabecillaEffectiveRadiusM ?? ra,
    },
  };
}

export function validateInputsForRun(inputs: QdeVersionInputs): string | null {
  const coords = inputs.terrain.coordinates;
  if (!coords || coords.length < 3) {
    return 'Debe delimitar la parcela en el mapa (mínimo 3 vértices) antes de generar el plano.';
  }
  if (inputs.terrain.usefulAreaHa <= 0) {
    return 'El área útil debe ser mayor que cero. Dibuja o ajusta el polígono del terreno.';
  }
  return null;
}

export function defaultCostCatalog(): QdeCostCatalog {
  return {
    nidoUsd: 18_500,
    cabecillaUsd: 1_850,
    peonUsd: 1_250,
    qdnUsd: 8_200,
    pipePerMeterUsd: 12,
    installPerNodeUsd: 180,
  };
}

export function defaultProjectInputs(costs?: QdeCostCatalog): QdeVersionInputs {
  const catalog = costs ?? defaultCostCatalog();
  return {
    terrain: {
      name: 'Parcela sin nombre',
      grossAreaHa: 1,
      usefulAreaHa: 0.95,
    },
    crop: {
      species: 'Por definir',
      stage: 'Por definir',
      canopyHeightM: 3,
      mission: 'Por definir',
    },
    sprayProfile: {
      profileId: 'spray_a_v0',
      label: 'Perfil A — V0',
      version: '0.1.0',
      ra: 12,
      fo: 0.25,
      pa: 3.0,
      qa: 2.0,
    },
    constraints: {
      minCoveragePct: 98,
      maxSimultaneousHeads: 8,
      minTerminalPressureBar: 3.0,
    },
    energy: defaultEnergyConfig(12),
    costs: { ...catalog },
  };
}

export function montePlataPreset(): QdeVersionInputs {
  return {
    terrain: {
      name: 'Monte Plata — guineo (sintético)',
      grossAreaHa: 2.4,
      usefulAreaHa: 2.28,
    },
    crop: {
      species: 'Guineo',
      stage: 'Adulto',
      canopyHeightM: 4.0,
      mission: 'Aspersión preventiva',
    },
    sprayProfile: {
      profileId: 'spray_a_v0',
      label: 'Perfil A — V0',
      version: '0.1.0',
      ra: 12,
      fo: 0.25,
      pa: 3.0,
      qa: 2.0,
    },
    constraints: {
      minCoveragePct: 98,
      maxSimultaneousHeads: 8,
      minTerminalPressureBar: 3.0,
    },
    energy: defaultEnergyConfig(12),
    costs: {
      nidoUsd: 18_500,
      cabecillaUsd: 1_850,
      peonUsd: 1_250,
      qdnUsd: 8_200,
      pipePerMeterUsd: 12,
      installPerNodeUsd: 180,
    },
  };
}

function spacingM(profile: QdeSprayProfile): number {
  return 2 * profile.ra * (1 - profile.fo);
}

function nearestHubDistance(point: GeoPoint, nido: GeoPoint, qdnPositions: GeoPoint[]): number {
  const hubs = [nido, ...qdnPositions];
  return Math.min(...hubs.map((hub) => distanceMeters(hub, point)));
}

function resolveMinimalQdnPositions(
  nido: GeoPoint,
  sentinels: GeoPoint[],
  energy: QdeEnergyConfig,
): GeoPoint[] {
  const positions: GeoPoint[] = [];
  const controlRadius = energy.nidoControlRadiusM;

  const isWithinControl = (sentinel: GeoPoint) =>
    nearestHubDistance(sentinel, nido, positions) <= controlRadius;

  while (positions.length < MAX_QDN_COUNT) {
    const uncovered = sentinels.filter((sentinel) => !isWithinControl(sentinel));
    if (uncovered.length === 0) break;

    const farthest = uncovered.reduce((best, sentinel) => {
      const bestDistance = nearestHubDistance(best, nido, positions);
      const sentinelDistance = nearestHubDistance(sentinel, nido, positions);
      return sentinelDistance > bestDistance ? sentinel : best;
    });

    const nearestHub = [nido, ...positions].reduce((best, hub) => {
      const hubDistance = distanceMeters(hub, farthest);
      const bestDistance = distanceMeters(best, farthest);
      return hubDistance < bestDistance ? hub : best;
    });

    positions.push({
      lat: (nearestHub.lat + farthest.lat) / 2,
      lng: (nearestHub.lng + farthest.lng) / 2,
    });
  }

  return positions;
}

function validateInfrastructureEnergy(
  nido: GeoPoint,
  sentinels: GeoPoint[],
  qdnPositions: GeoPoint[],
  energy: QdeEnergyConfig,
): EnergyValidation {
  const reasons: string[] = [];
  let worstDistanceM = 0;
  let worstVoltageV = energy.nidoSupplyVoltageV;
  let withinRange = 0;

  for (const sentinel of sentinels) {
    const controlDistance = nearestHubDistance(sentinel, nido, qdnPositions);
    const supplyHub = [nido, ...qdnPositions].reduce((best, hub) => {
      const hubDistance = distanceMeters(hub, sentinel);
      const bestDistance = distanceMeters(best, sentinel);
      return hubDistance < bestDistance ? hub : best;
    });
    const supplyDistance = distanceMeters(supplyHub, sentinel);
    const hydraulicDistance = distanceMeters(nido, sentinel);
    const qdnHydraulicOk = qdnPositions.some(
      (qdn) => distanceMeters(qdn, sentinel) <= energy.maxHydraulicReachM * 0.65,
    );

    worstDistanceM = Math.max(worstDistanceM, controlDistance);
    const lossPct = (supplyDistance / 100) * energy.electricalLossPctPer100m;
    const voltage = energy.nidoSupplyVoltageV * (1 - lossPct / 100);
    worstVoltageV = Math.min(worstVoltageV, voltage);

    if (controlDistance <= energy.nidoControlRadiusM) {
      withinRange += 1;
    } else {
      reasons.push(
        `Centinela a ${controlDistance.toFixed(0)} m sin hub dentro del radio de control (${energy.nidoControlRadiusM} m)`,
      );
    }

    if (hydraulicDistance > energy.maxHydraulicReachM && !qdnHydraulicOk) {
      reasons.push(
        `Distancia hidráulica ${hydraulicDistance.toFixed(0)} m excede alcance (${energy.maxHydraulicReachM} m)`,
      );
    }
  }

  if (worstVoltageV < energy.minVoltageAtSentinelV) {
    reasons.push(
      `Voltaje mínimo estimado ${worstVoltageV.toFixed(1)} V bajo umbral ${energy.minVoltageAtSentinelV} V`,
    );
  }

  return {
    ok: reasons.length === 0,
    worstDistanceM,
    worstVoltageV,
    reasons: [...new Set(reasons)],
    withinRange,
  };
}

function estimatePipeLengthM(
  nido: GeoPoint,
  sentinels: GeoPoint[],
  qdnPositions: GeoPoint[],
): number {
  if (sentinels.length === 0) return MIN_PIPE_LENGTH_M;

  const spans = [
    ...sentinels.map((sentinel) => distanceMeters(nido, sentinel)),
    ...qdnPositions.map((qdn) => distanceMeters(nido, qdn)),
    ...qdnPositions.flatMap((qdn) =>
      sentinels.map((sentinel) => distanceMeters(qdn, sentinel)),
    ),
  ];

  const maxSpan = Math.max(...spans);
  return Math.max(MIN_PIPE_LENGTH_M, Math.ceil(maxSpan * 1.12));
}

function minimalCabecillaCount(
  sentinelPoints: GeoPoint[],
  nido: GeoPoint,
  qdnPositions: GeoPoint[],
  spacingM: number,
): number {
  if (sentinelPoints.length === 0) return 0;

  const needPerceptionHub = sentinelPoints.filter((point) => {
    const fromNido = distanceMeters(nido, point);
    const fromNearestQdn =
      qdnPositions.length > 0
        ? Math.min(...qdnPositions.map((qdn) => distanceMeters(qdn, point)))
        : Number.POSITIVE_INFINITY;
    return fromNido > spacingM * 2.2 && fromNearestQdn > spacingM * 1.5;
  }).length;

  // Cabecillas are expensive advanced observers, not a replacement for every
  // Peón. Keep a strategic baseline but cap their share so the layout remains
  // economically balanced and the spatial picker can distribute them by zone.
  const strategicMinimum = Math.max(1, Math.ceil(sentinelPoints.length * 0.12));
  const strategicMaximum = Math.max(strategicMinimum, Math.ceil(sentinelPoints.length * 0.25));
  return Math.min(
    sentinelPoints.length,
    Math.min(strategicMaximum, Math.max(strategicMinimum, needPerceptionHub)),
  );
}

function buildMinimalInfrastructure(
  sentinelPoints: GeoPoint[],
  polygon: GeoPoint[],
  inputs: QdeVersionInputs,
): InfrastructurePlan {
  const spacing = spacingM(inputs.sprayProfile);
  const effectiveRa = inputs.energy.peonEffectiveRadiusM || inputs.sprayProfile.ra;
  const nidoPosition = findOptimalNidoPosition(sentinelPoints, polygon);
  const qdnPositions = resolveMinimalQdnPositions(nidoPosition, sentinelPoints, inputs.energy);
  const cabecillaCount = minimalCabecillaCount(
    sentinelPoints,
    nidoPosition,
    qdnPositions,
    spacing,
  );
  const pipeLengthM = estimatePipeLengthM(nidoPosition, sentinelPoints, qdnPositions);
  const coverageMeasurement = measureCoveragePct(polygon, sentinelPoints, effectiveRa, 3);
  const coveragePct = coverageMeasurement.coveragePct;
  const energy = validateInfrastructureEnergy(
    nidoPosition,
    sentinelPoints,
    qdnPositions,
    inputs.energy,
  );

  return {
    nidoPosition,
    sentinelPoints,
    cabecillaCount,
    qdnPositions,
    pipeLengthM,
    coveragePct,
    gapCount: coverageMeasurement.gapPoints.length,
    energy,
  };
}

function addBufferSentinels(
  polygon: GeoPoint[],
  sentinels: GeoPoint[],
  radiusM: number,
  extraCount: number,
): GeoPoint[] {
  const result = [...sentinels];
  for (let index = 0; index < extraCount; index += 1) {
    const measurement = measureCoveragePct(polygon, result, radiusM, 3);
    if (measurement.gapPoints.length === 0) break;
    result.push(pickBestGapPoint(measurement.gapPoints, result, polygon, radiusM));
  }
  return result;
}

function calculateCapex(
  alt: Pick<QdeAlternative, 'cabecillas' | 'peones' | 'qdnCount'>,
  costs: QdeCostCatalog,
  totalNodes: number,
  pipeLengthM: number,
): number {
  return (
    costs.nidoUsd +
    alt.cabecillas * costs.cabecillaUsd +
    alt.peones * costs.peonUsd +
    alt.qdnCount * costs.qdnUsd +
    pipeLengthM * costs.pipePerMeterUsd +
    totalNodes * costs.installPerNodeUsd
  );
}

function evaluateAlternative(
  alternativeId: string,
  label: string,
  plan: InfrastructurePlan,
  inputs: QdeVersionInputs,
): QdeAlternative {
  const { sprayProfile, constraints, costs, terrain, energy } = inputs;
  const sentinelPoints = plan.sentinelPoints;
  const totalNodes = sentinelPoints.length;
  const cabecillas = plan.cabecillaCount;
  const peones = Math.max(0, totalNodes - cabecillas);
  const qdnCount = plan.qdnPositions.length;
  const coveragePct = plan.coveragePct;
  const peakFlowLpm = constraints.maxSimultaneousHeads * sprayProfile.qa;
  const terminalPressureBar = 3.91 - Math.max(0, qdnCount - 1) * 0.15;
  const rejectionReasons: string[] = plan.energy.ok ? [] : [...plan.energy.reasons];

  if (coveragePct < constraints.minCoveragePct) {
    rejectionReasons.push(
      `Cobertura ${coveragePct.toFixed(1)}% inferior al mínimo ${constraints.minCoveragePct}%`,
    );
  }
  if (plan.gapCount > 0) {
    rejectionReasons.push(
      `${plan.gapCount} muestras de hueco de cobertura pendientes dentro del polígono útil`,
    );
  }
  if (peakFlowLpm > energy.nidoPumpMaxFlowLpm) {
    rejectionReasons.push(
      `Caudal pico ${peakFlowLpm} L/min excede capacidad del Nido ${energy.nidoPumpMaxFlowLpm} L/min`,
    );
  }
  if (terminalPressureBar < constraints.minTerminalPressureBar) {
    rejectionReasons.push(
      `Presión terminal ${terminalPressureBar.toFixed(2)} bar inferior a P_a ${constraints.minTerminalPressureBar} bar`,
    );
  }
  if (totalNodes > energy.maxSentinelsPerNido) {
    rejectionReasons.push(`Centinelas ${totalNodes} exceden capacidad del Nido (${energy.maxSentinelsPerNido})`);
  }
  if (cabecillas > energy.maxCabecillasPerNido) {
    rejectionReasons.push(`Cabecillas ${cabecillas} exceden capacidad del Nido (${energy.maxCabecillasPerNido})`);
  }
  if (peones > energy.maxPeonesPerNido) {
    rejectionReasons.push(`Peones ${peones} exceden capacidad del Nido (${energy.maxPeonesPerNido})`);
  }

  const capexUsd = calculateCapex(
    { cabecillas, peones, qdnCount },
    costs,
    totalNodes,
    plan.pipeLengthM,
  );
  const costPerUsefulHaUsd = capexUsd / terrain.usefulAreaHa;

  return {
    alternativeId,
    label,
    totalNodes,
    cabecillas,
    peones,
    qdnCount,
    coveragePct: Number(coveragePct.toFixed(1)),
    capexUsd: Math.round(capexUsd),
    costPerUsefulHaUsd: Math.round(costPerUsefulHaUsd),
    peakFlowLpm,
    terminalPressureBar: Number(terminalPressureBar.toFixed(2)),
    status: 'feasible_not_optimal',
    rejectionReasons,
    margins: {
      coverageAboveMinPct: Number((coveragePct - constraints.minCoveragePct).toFixed(1)),
      pressureAboveMinBar: Number((terminalPressureBar - constraints.minTerminalPressureBar).toFixed(2)),
      flowHeadroomLpm: energy.nidoPumpMaxFlowLpm - peakFlowLpm,
    },
  };
}

function assignStatuses(alternatives: QdeAlternative[]): QdeAlternative[] {
  const feasible = alternatives.filter((alt) => alt.rejectionReasons.length === 0);
  if (feasible.length === 0) {
    return alternatives.map((alt) => ({ ...alt, status: 'not_feasible' as QdeAlternativeStatus }));
  }

  // The generated view must start from the fully covered design. Lower
  // coverage alternatives remain available as explicit cost trade-offs.
  const minCapex = Math.min(...feasible.map((alt) => alt.capexUsd));
  const selected = feasible.find((alt) => alt.alternativeId === 'A') ?? feasible.find((alt) => alt.capexUsd === minCapex)!;

  return alternatives.map((alt) => {
    if (alt.rejectionReasons.length > 0) {
      return { ...alt, status: 'not_feasible' as QdeAlternativeStatus };
    }
    if (alt.alternativeId === selected.alternativeId) {
      return { ...alt, status: 'selected' as QdeAlternativeStatus };
    }
    return { ...alt, status: 'feasible_not_optimal' as QdeAlternativeStatus };
  });
}

function buildBudgetBreakdown(
  selected: QdeAlternative,
  costs: QdeCostCatalog,
  usefulAreaHa: number,
  pipeLengthM: number,
): QdeBudgetBreakdown {
  const lines = [
    { item: 'El Nido (cerebro del proyecto)', quantity: 1, unitUsd: costs.nidoUsd },
    {
      item: 'Cabecilla (percepción + aspersión)',
      quantity: selected.cabecillas,
      unitUsd: costs.cabecillaUsd,
    },
    { item: 'Peón / Aspersor (ejecución)', quantity: selected.peones, unitUsd: costs.peonUsd },
    { item: 'QDN (refuerzo hidráulico)', quantity: selected.qdnCount, unitUsd: costs.qdnUsd },
    { item: 'Tubería principal (m)', quantity: pipeLengthM, unitUsd: costs.pipePerMeterUsd },
    {
      item: 'Instalación por Centinela',
      quantity: selected.totalNodes,
      unitUsd: costs.installPerNodeUsd,
    },
  ].map((line) => ({
    ...line,
    subtotalUsd: Math.round(line.quantity * line.unitUsd),
  }));

  const totalUsd = lines.reduce((sum, line) => sum + line.subtotalUsd, 0);
  return {
    lines,
    totalUsd,
    costPerUsefulHaUsd: Math.round(totalUsd / usefulAreaHa),
  };
}

function buildSentinelGrid(
  polygon: GeoPoint[],
  spacingM: number,
  minCoveragePct: number,
  effectiveRadiusM: number,
): GeoPoint[] {
  return optimizeSentinelPlacement(polygon, spacingM, effectiveRadiusM, minCoveragePct);
}

function generateDeploymentNodes(
  selected: QdeAlternative,
  inputs: QdeVersionInputs,
  plan: InfrastructurePlan,
): QdeDeploymentNode[] {
  const nodes: QdeDeploymentNode[] = [];
  const spacing = spacingM(inputs.sprayProfile);
  const polygon = inputs.terrain.coordinates ?? [];
  const { energy } = inputs;
  const effectiveRa = energy.peonEffectiveRadiusM || inputs.sprayProfile.ra;

  let sentinelPoints = plan.sentinelPoints;

  if (sentinelPoints.length === 0 && selected.totalNodes > 0) {
    const origin = polygon[0] ?? { lat: 18.807, lng: -69.784 };
    const cols = Math.ceil(Math.sqrt(selected.totalNodes));
    sentinelPoints = [];
    for (let index = 0; index < selected.totalNodes; index += 1) {
      const row = Math.floor(index / cols);
      const col = index % cols;
      sentinelPoints.push({
        lat: origin.lat + row * metersToLatDelta(spacing),
        lng: origin.lng + col * metersToLngDelta(spacing, origin.lat),
      });
    }
  }

  const nidoPosition = plan.nidoPosition;

  const cabecillaIndices = pickCabecillaIndices(
    sentinelPoints,
    nidoPosition,
    selected.cabecillas,
  );

  nodes.push({
    nodeId: 'N-1',
    role: 'nido',
    coordinates: nidoPosition,
    placementReason:
      'Único Nido del proyecto — posición minimax para alimentar la red con el menor cableado posible.',
  });

  plan.qdnPositions.forEach((coordinates, qdnIndex) => {
    nodes.push({
      nodeId: `QDN-${qdnIndex + 1}`,
      role: 'qdn',
      coordinates,
      placementReason:
        'QDN mínimo requerido para extender control eléctrico/hidráulico a sectores lejanos del Nido.',
    });
  });

  let cabecillaCount = 0;
  let peonCount = 0;

  sentinelPoints.forEach((coordinates, index) => {
    const isCabecilla = cabecillaIndices.has(index);
    if (isCabecilla) cabecillaCount += 1;
    else peonCount += 1;

    const distanceFromNido = distanceMeters(nidoPosition, coordinates);
    const lossPct = (distanceFromNido / 100) * energy.electricalLossPctPer100m;
    const estimatedVoltageV = energy.nidoSupplyVoltageV * (1 - lossPct / 100);
    const pressureLoss = (distanceFromNido / 100) * energy.pipePressureLossBarPer100m;
    const estimatedPressureBar = Math.max(0, inputs.sprayProfile.pa - pressureLoss);
    const sectorId = `sector-${(index % 4) + 1}`;

    nodes.push({
      nodeId: isCabecilla ? `C-${cabecillaCount}` : `P-${peonCount}`,
      role: isCabecilla ? 'cabecilla' : 'peon',
      coordinates,
      sectorId,
      distanceFromNidoM: Number(distanceFromNido.toFixed(1)),
      estimatedVoltageV: Number(estimatedVoltageV.toFixed(1)),
      estimatedPressureBar: Number(estimatedPressureBar.toFixed(2)),
      placementReason: isCabecilla
        ? `Cabecilla mínima en sector ${sectorId} — percepción en zona lejana (${distanceFromNido.toFixed(0)} m del Nido).`
        : `Peón mínimo s=${spacing.toFixed(1)} m — cobertura R=${effectiveRa} m, ${distanceFromNido.toFixed(0)} m del Nido.`,
    });
  });

  return nodes;
}

export function runQdeEngine(inputs: QdeVersionInputs): QdeVersionOutput {
  const normalized = normalizeInputs(inputs);
  const trace: QdeTraceStep[] = [];
  const push = (
    step: number,
    phase: string,
    title: string,
    detail: string,
    data?: Record<string, unknown>,
  ) => {
    trace.push({ step, phase, title, detail, data });
  };

  const validationError = validateInputsForRun(normalized);
  if (validationError) {
    return {
      engineVersion: QDE_ENGINE_VERSION,
      computedAt: new Date().toISOString(),
      alternatives: [],
      selectedAlternativeId: null,
      selectedAlternative: null,
      trace: [
        {
          step: 1,
          phase: 'validation',
          title: 'Parcela requerida',
          detail: validationError,
        },
      ],
      summary: validationError,
      deploymentNodes: [],
      budgetBreakdown: null,
      hydraulicSummary: {
        sectorCount: 0,
        maxSimultaneousHeads: normalized.constraints.maxSimultaneousHeads,
        peakFlowLpm: 0,
        terminalPressureBar: 0,
      },
    };
  }

  const polygon = normalized.terrain.coordinates!;
  const spacing = spacingM(normalized.sprayProfile);
  const effectiveRa = normalized.energy.peonEffectiveRadiusM;

  push(1, 'validation', 'Validar expediente', 'Parcela delimitada, área útil y perfiles cargados.', {
    usefulAreaHa: normalized.terrain.usefulAreaHa,
    vertices: polygon.length,
    sprayProfile: normalized.sprayProfile.profileId,
  });

  push(
    2,
    'geometry',
    'Colocación greedy de cobertura',
    `Separación objetivo ${spacing.toFixed(1)} m · Radio efectivo ${effectiveRa} m · sin malla densa`,
    { spacingM: spacing, ra: effectiveRa, fo: normalized.sprayProfile.fo },
  );

  const hexGrid = buildSentinelGrid(
    polygon,
    spacing,
    normalized.constraints.minCoveragePct,
    effectiveRa,
  );

  push(
    3,
    'coverage',
    'Optimizar Centinelas mínimos',
    `Conjunto mínimo híbrido → ${hexGrid.length} Centinelas (hex + poda + huecos).`,
    { hexNodes: hexGrid.length },
  );

  // Cerrar huecos geométricos antes de comparar CAPEX. Un porcentaje mínimo no
  // autoriza dejar una esquina o corredor del polígono sin aspersión.
  const coverageCompleteGrid = pruneRedundantSentinels(
    polygon,
    addBufferSentinels(polygon, hexGrid, effectiveRa, 80),
    effectiveRa,
    100,
    80,
  );
  const measuredPreview = measureCoveragePct(polygon, coverageCompleteGrid, effectiveRa, 3);
  push(
    4,
    'coverage',
    'Medir cobertura real del polígono',
    `Cobertura medida ${measuredPreview.coveragePct.toFixed(1)}% (${measuredPreview.gapPoints.length} zonas sin cubrir en muestra).`,
    {
      measuredCoveragePct: measuredPreview.coveragePct,
      gapSamples: measuredPreview.gapPoints.length,
    },
  );

  // A is the safe default (no sampled gaps). The following variants remove
  // redundant nodes to provide a real cost/coverage comparison ladder.
  const planA = buildMinimalInfrastructure(coverageCompleteGrid, polygon, normalized);
  const gridB = pruneRedundantSentinels(polygon, coverageCompleteGrid, effectiveRa, 98, 80);
  const gridC = pruneRedundantSentinels(polygon, coverageCompleteGrid, effectiveRa, 96, 80);
  const gridD = pruneRedundantSentinels(polygon, coverageCompleteGrid, effectiveRa, 94, 80);
  const gridE = pruneRedundantSentinels(polygon, coverageCompleteGrid, effectiveRa, 92, 80);
  const planB = buildMinimalInfrastructure(gridB, polygon, normalized);
  const planC = buildMinimalInfrastructure(gridC, polygon, normalized);
  const planD = buildMinimalInfrastructure(gridD, polygon, normalized);
  const planE = buildMinimalInfrastructure(gridE, polygon, normalized);

  const rawAlternatives: QdeAlternative[] = [
    evaluateAlternative('A', 'Alternativa A — cobertura total (100%)', planA, normalized),
    evaluateAlternative('B', 'Alternativa B — objetivo 98%', planB, normalized),
    evaluateAlternative('C', 'Alternativa C — objetivo 96%', planC, normalized),
    evaluateAlternative('D', 'Alternativa D — objetivo 94%', planD, normalized),
    evaluateAlternative('E', 'Alternativa E — objetivo 92%', planE, normalized),
  ];

  const alternatives = assignStatuses(rawAlternatives);
  let selectedAlternative = alternatives.find((alt) => alt.status === 'selected') ?? null;

  if (!selectedAlternative) {
    const fallback = alternatives.find((alt) => alt.alternativeId === 'A') ?? alternatives[0];
    if (fallback) {
      selectedAlternative = {
        ...fallback,
        status: 'experimental',
        rejectionReasons: fallback.rejectionReasons,
      };
    }
  }

  push(
    5,
    'energy',
    'Infraestructura mínima (Nido + QDN + red)',
    planA.energy.ok
      ? `1 Nido · ${planA.qdnPositions.length} QDN · ${planA.cabecillaCount} Cabecillas · ${planA.sentinelPoints.length - planA.cabecillaCount} Peones · ${planA.pipeLengthM} m tubería.`
      : `Restricciones de energía: ${planA.energy.reasons.slice(0, 2).join('; ')}`,
    {
      worstDistanceM: planA.energy.worstDistanceM,
      worstVoltageV: planA.energy.worstVoltageV,
      qdnCount: planA.qdnPositions.length,
      cabecillas: planA.cabecillaCount,
      peones: planA.sentinelPoints.length - planA.cabecillaCount,
      pipeLengthM: planA.pipeLengthM,
    },
  );

  push(
    6,
    'constraints',
    'Aplicar restricciones duras',
    'Cobertura, caudal, presión y energía filtraron alternativas inviables.',
    {
      rejected: alternatives
        .filter((alt) => alt.status === 'not_feasible')
        .map((alt) => ({ id: alt.alternativeId, reasons: alt.rejectionReasons })),
    },
  );

  push(
    7,
    'economics',
    'Seleccionar menor CAPEX factible',
    selectedAlternative
      ? `Seleccionada ${selectedAlternative.label} con CAPEX US$${selectedAlternative.capexUsd.toLocaleString()}.`
      : 'Ninguna alternativa cumplió cobertura, energía y restricciones hidráulicas.',
    {
      selectedId: selectedAlternative?.alternativeId ?? null,
      capexUsd: selectedAlternative?.capexUsd ?? null,
    },
  );

  const plansByAlternative = { A: planA, B: planB, C: planC, D: planD, E: planE };
  const selectedPlan = plansByAlternative[selectedAlternative?.alternativeId as keyof typeof plansByAlternative] ?? planA;

  const deploymentNodes = selectedAlternative
    ? generateDeploymentNodes(selectedAlternative, normalized, selectedPlan)
    : [];

  const sentinels = deploymentNodes.filter((n) => n.role === 'cabecilla' || n.role === 'peon');
  const nidoNode = deploymentNodes.find((n) => n.role === 'nido');
  const finalCoverage = nidoNode
    ? measureCoveragePct(
        polygon,
        sentinels.map((n) => n.coordinates),
        effectiveRa,
        3,
      )
    : measuredPreview;

  const finalEnergy =
    nidoNode && sentinels.length > 0
      ? validateInfrastructureEnergy(
          nidoNode.coordinates,
          sentinels.map((n) => n.coordinates),
          deploymentNodes.filter((n) => n.role === 'qdn').map((n) => n.coordinates),
          normalized.energy,
        )
      : planA.energy;

  if (selectedAlternative && deploymentNodes.length > 0) {
    push(
      8,
      'deployment',
      'Generar plano de despliegue',
      `${selectedAlternative.totalNodes} Centinelas + 1 Nido + ${selectedAlternative.qdnCount} QDN (mínimo). Cobertura ${finalCoverage.coveragePct.toFixed(1)}%.`,
      {
        nodeCount: deploymentNodes.length,
        nido: 1,
        cabecillas: selectedAlternative.cabecillas,
        peones: selectedAlternative.peones,
        qdn: selectedAlternative.qdnCount,
        pipeLengthM: selectedPlan.pipeLengthM,
        gapSamples: finalCoverage.gapPoints.length,
      },
    );
  }

  const summary = selectedAlternative
    ? `Mínimo factible: 1 Nido, ${selectedAlternative.qdnCount} QDN, ${selectedAlternative.cabecillas} Cabecillas, ${selectedAlternative.peones} Peones (${selectedAlternative.totalNodes} centinelas), ${selectedPlan.pipeLengthM} m tubería. Cobertura ${finalCoverage.coveragePct.toFixed(1)}%, CAPEX US$${selectedAlternative.capexUsd.toLocaleString()}.`
    : 'No hay configuración factible. Revise cobertura mínima, radio efectivo, energía del Nido o aumente QDN.';

  const budgetBreakdown = selectedAlternative
    ? buildBudgetBreakdown(
        selectedAlternative,
        normalized.costs,
        normalized.terrain.usefulAreaHa,
        selectedPlan.pipeLengthM,
      )
    : null;

  return {
    engineVersion: QDE_ENGINE_VERSION,
    computedAt: new Date().toISOString(),
    alternatives,
    selectedAlternativeId: selectedAlternative?.alternativeId ?? null,
    selectedAlternative,
    trace,
    summary,
    deploymentNodes,
    budgetBreakdown,
    hydraulicSummary: {
      sectorCount: 4,
      maxSimultaneousHeads: normalized.constraints.maxSimultaneousHeads,
      peakFlowLpm: selectedAlternative?.peakFlowLpm ?? 0,
      terminalPressureBar: selectedAlternative?.terminalPressureBar ?? 0,
    },
    coverageAnalysis: {
      measuredCoveragePct: Number(finalCoverage.coveragePct.toFixed(1)),
      gapCount: finalCoverage.gapPoints.length,
      gapPoints: finalCoverage.gapPoints.slice(0, 80),
      gridSpacingM: spacing,
      sentinelCount: sentinels.length,
    },
    energySummary: {
      worstDistanceM: Number(finalEnergy.worstDistanceM.toFixed(1)),
      worstVoltageV: Number(finalEnergy.worstVoltageV.toFixed(1)),
      nidoControlRadiusM: normalized.energy.nidoControlRadiusM,
      withinRangeCount: finalEnergy.withinRange,
      outOfRangeCount: sentinels.length - finalEnergy.withinRange,
      rejectionReasons: finalEnergy.reasons,
    },
  };
}

export function calculateUsefulAreaHa(coordinates: GeoPoint[], exclusionFactor = 0.95): number {
  if (!coordinates || coordinates.length < 3) return 0;

  const latToMeters = 111_320;
  const avgLat = coordinates.reduce((sum, point) => sum + point.lat, 0) / coordinates.length;
  const lngToMeters = Math.cos((avgLat * Math.PI) / 180) * 111_320;

  const points = coordinates.map((point) => ({
    x: point.lng * lngToMeters,
    y: point.lat * latToMeters,
  }));

  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }

  const grossHa = Math.abs(area / 2) / 10_000;
  return Number((grossHa * exclusionFactor).toFixed(2));
}

export function buildInputsFromParcel(
  parcel: { name: string; cropType?: string; coordinates?: GeoPoint[] },
  base?: Partial<QdeVersionInputs>,
): QdeVersionInputs {
  const preset = montePlataPreset();
  const grossHa = parcel.coordinates?.length
    ? calculateUsefulAreaHa(parcel.coordinates, 1)
    : preset.terrain.grossAreaHa;
  const usefulHa = parcel.coordinates?.length
    ? calculateUsefulAreaHa(parcel.coordinates, 0.95)
    : preset.terrain.usefulAreaHa;

  return {
    ...preset,
    ...base,
    terrain: {
      name: parcel.name,
      grossAreaHa: grossHa,
      usefulAreaHa: usefulHa,
      coordinates: parcel.coordinates,
      ...base?.terrain,
    },
    crop: {
      ...preset.crop,
      species: parcel.cropType ?? preset.crop.species,
      ...base?.crop,
    },
  };
}
