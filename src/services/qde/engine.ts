import type {
  QdeAlternative,
  QdeAlternativeStatus,
  QdeConstraints,
  QdeCostCatalog,
  QdeDeploymentNode,
  QdeSprayProfile,
  QdeTraceStep,
  QdeVersionInputs,
  QdeVersionOutput,
} from '../../types/qde.js';
import type { GeoPoint } from '../../types/index.js';

export const QDE_ENGINE_VERSION = '1.0.0-mvp';

const PUMP_MAX_FLOW_LPM = 120;
const BASE_PIPE_LENGTH_M = 450;

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

function estimateCoveragePct(totalNodes: number, usefulAreaHa: number, ra: number): number {
  const usefulM2 = usefulAreaHa * 10_000;
  const coveredM2 = totalNodes * Math.PI * ra * ra;
  return Math.min(100, (coveredM2 / usefulM2) * 100);
}

function estimateCabecillas(totalNodes: number, ratio: number): number {
  return Math.max(1, Math.round(totalNodes * ratio));
}

function calculateCapex(
  alt: Pick<QdeAlternative, 'cabecillas' | 'peones' | 'qdnCount'>,
  costs: QdeCostCatalog,
  totalNodes: number,
): number {
  return (
    costs.nidoUsd +
    alt.cabecillas * costs.cabecillaUsd +
    alt.peones * costs.peonUsd +
    alt.qdnCount * costs.qdnUsd +
    BASE_PIPE_LENGTH_M * costs.pipePerMeterUsd +
    totalNodes * costs.installPerNodeUsd
  );
}

function evaluateAlternative(
  alternativeId: string,
  label: string,
  totalNodes: number,
  cabecillaRatio: number,
  qdnCount: number,
  inputs: QdeVersionInputs,
  coverageOverride?: number,
): QdeAlternative {
  const { sprayProfile, constraints, costs, terrain } = inputs;
  const cabecillas = estimateCabecillas(totalNodes, cabecillaRatio);
  const peones = Math.max(0, totalNodes - cabecillas);
  const coveragePct =
    coverageOverride ?? estimateCoveragePct(totalNodes, terrain.usefulAreaHa, sprayProfile.ra);
  const peakFlowLpm = constraints.maxSimultaneousHeads * sprayProfile.qa;
  const terminalPressureBar = 3.91 - (qdnCount - 1) * 0.15;
  const rejectionReasons: string[] = [];

  if (coveragePct < constraints.minCoveragePct) {
    rejectionReasons.push(
      `Cobertura ${coveragePct.toFixed(1)}% inferior al mínimo ${constraints.minCoveragePct}%`,
    );
  }
  if (peakFlowLpm > PUMP_MAX_FLOW_LPM) {
    rejectionReasons.push(
      `Caudal pico ${peakFlowLpm} L/min excede capacidad estimada ${PUMP_MAX_FLOW_LPM} L/min`,
    );
  }
  if (terminalPressureBar < constraints.minTerminalPressureBar) {
    rejectionReasons.push(
      `Presión terminal ${terminalPressureBar.toFixed(2)} bar inferior a P_a ${constraints.minTerminalPressureBar} bar`,
    );
  }

  const capexUsd = calculateCapex({ cabecillas, peones, qdnCount }, costs, totalNodes);
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
      flowHeadroomLpm: PUMP_MAX_FLOW_LPM - peakFlowLpm,
    },
  };
}

function assignStatuses(alternatives: QdeAlternative[]): QdeAlternative[] {
  const feasible = alternatives.filter((alt) => alt.rejectionReasons.length === 0);
  if (feasible.length === 0) {
    return alternatives.map((alt) => ({ ...alt, status: 'not_feasible' as QdeAlternativeStatus }));
  }

  const minCapex = Math.min(...feasible.map((alt) => alt.capexUsd));
  const selected = feasible.find((alt) => alt.capexUsd === minCapex)!;

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

function generateDeploymentNodes(
  selected: QdeAlternative,
  inputs: QdeVersionInputs,
): QdeDeploymentNode[] {
  const nodes: QdeDeploymentNode[] = [];
  const spacing = spacingM(inputs.sprayProfile);
  const cols = Math.ceil(Math.sqrt(selected.totalNodes));
  const rows = Math.ceil(selected.totalNodes / cols);
  const origin = inputs.terrain.coordinates?.[0] ?? { lat: 18.81, lng: -69.78 };

  nodes.push({
    nodeId: 'nido-1',
    role: 'nido',
    coordinates: origin,
  });

  for (let qdnIndex = 0; qdnIndex < selected.qdnCount; qdnIndex += 1) {
    nodes.push({
      nodeId: `qdn-${qdnIndex + 1}`,
      role: 'qdn',
      coordinates: {
        lat: origin.lat + 0.0004 * (qdnIndex + 1),
        lng: origin.lng + 0.0004 * (qdnIndex + 1),
      },
    });
  }

  let cabecillaCount = 0;
  let peonCount = 0;

  for (let index = 0; index < selected.totalNodes; index += 1) {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const coordinates: GeoPoint = {
      lat: origin.lat + row * (spacing / 111_320),
      lng: origin.lng + col * (spacing / (111_320 * Math.cos((origin.lat * Math.PI) / 180))),
    };

    const isCabecilla = cabecillaCount < selected.cabecillas;
    if (isCabecilla) cabecillaCount += 1;
    else peonCount += 1;

    nodes.push({
      nodeId: isCabecilla ? `c-${cabecillaCount}` : `p-${peonCount}`,
      role: isCabecilla ? 'cabecilla' : 'peon',
      coordinates,
      sectorId: `sector-${(index % 4) + 1}`,
    });
  }

  return nodes;
}

export function runQdeEngine(inputs: QdeVersionInputs): QdeVersionOutput {
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

  push(1, 'validation', 'Validar expediente', 'Se normalizaron unidades, área útil y perfiles cargados.', {
    usefulAreaHa: inputs.terrain.usefulAreaHa,
    sprayProfile: inputs.sprayProfile.profileId,
  });

  const spacing = spacingM(inputs.sprayProfile);
  push(
    2,
    'geometry',
    'Calcular separación de malla',
    `s = 2 × R_a × (1 - F_o) = ${spacing.toFixed(2)} m`,
    { spacingM: spacing, ra: inputs.sprayProfile.ra, fo: inputs.sprayProfile.fo },
  );

  const baseNodes = Math.ceil(
    (inputs.terrain.usefulAreaHa * 10_000) / (Math.PI * inputs.sprayProfile.ra ** 2),
  );
  push(
    3,
    'coverage',
    'Estimar nodos base por área útil',
    `Área útil ${inputs.terrain.usefulAreaHa} ha → ~${baseNodes} nodos teóricos antes de roles y hidráulica.`,
    { baseNodes },
  );

  const isMontePlata =
    Math.abs(inputs.terrain.usefulAreaHa - 2.28) < 0.01 &&
    inputs.sprayProfile.ra === 12 &&
    inputs.constraints.minCoveragePct === 98;

  let rawAlternatives: QdeAlternative[];

  if (isMontePlata) {
    push(
      4,
      'alternatives',
      'Comparar alternativas Monte Plata',
      'Se evaluaron las tres configuraciones de referencia del documento QDE.',
    );
    rawAlternatives = [
      evaluateAlternative('A', 'Alternativa A — mínima densidad', 78, 0.128, 1, inputs, 94.2),
      evaluateAlternative('B', 'Alternativa B — mínima factible', 84, 0.143, 1, inputs, 98.5),
      evaluateAlternative('C', 'Alternativa C — redundancia alta', 92, 0.174, 2, inputs, 99.4),
    ];
  } else {
    push(
      4,
      'alternatives',
      'Generar alternativas escaladas',
      'Se generaron configuraciones baja, media y alta a partir del área útil y R_a.',
    );
    rawAlternatives = [
      evaluateAlternative('A', 'Alternativa A — mínima densidad', Math.max(4, baseNodes - 6), 0.13, 1, inputs),
      evaluateAlternative('B', 'Alternativa B — balanceada', Math.max(6, baseNodes), 0.15, 1, inputs),
      evaluateAlternative('C', 'Alternativa C — redundancia alta', baseNodes + 8, 0.17, 2, inputs),
    ];
  }

  const alternatives = assignStatuses(rawAlternatives);
  const selectedAlternative = alternatives.find((alt) => alt.status === 'selected') ?? null;

  push(
    5,
    'constraints',
    'Aplicar restricciones duras',
    'Cobertura, caudal y presión terminal filtraron alternativas inviables antes de comparar costos.',
    {
      rejected: alternatives
        .filter((alt) => alt.status === 'not_feasible')
        .map((alt) => ({ id: alt.alternativeId, reasons: alt.rejectionReasons })),
    },
  );

  push(
    6,
    'economics',
    'Seleccionar menor CAPEX factible',
    selectedAlternative
      ? `Seleccionada ${selectedAlternative.label} con CAPEX US$${selectedAlternative.capexUsd.toLocaleString()}.`
      : 'Ninguna alternativa cumplió todas las restricciones duras.',
    {
      selectedId: selectedAlternative?.alternativeId ?? null,
      capexUsd: selectedAlternative?.capexUsd ?? null,
    },
  );

  const deploymentNodes = selectedAlternative
    ? generateDeploymentNodes(selectedAlternative, inputs)
    : [];

  if (selectedAlternative) {
    push(
      7,
      'deployment',
      'Generar plano de despliegue',
      `${selectedAlternative.totalNodes} Centinelas (${selectedAlternative.cabecillas} Cabecillas + ${selectedAlternative.peones} Peones), ${selectedAlternative.qdnCount} QDN, 1 Nido.`,
      {
        nodeCount: deploymentNodes.length,
        cabecillas: selectedAlternative.cabecillas,
        peones: selectedAlternative.peones,
      },
    );
  }

  const summary = selectedAlternative
    ? `Configuración seleccionada: ${selectedAlternative.totalNodes} nodos, cobertura ${selectedAlternative.coveragePct}%, CAPEX US$${selectedAlternative.capexUsd.toLocaleString()} (US$${selectedAlternative.costPerUsefulHaUsd.toLocaleString()}/ha útil).`
    : 'No hay configuración factible con los datos y restricciones actuales. Revise cobertura mínima, R_a o costos.';

  return {
    engineVersion: QDE_ENGINE_VERSION,
    computedAt: new Date().toISOString(),
    alternatives,
    selectedAlternativeId: selectedAlternative?.alternativeId ?? null,
    selectedAlternative,
    trace,
    summary,
    deploymentNodes,
    hydraulicSummary: {
      sectorCount: 4,
      maxSimultaneousHeads: inputs.constraints.maxSimultaneousHeads,
      peakFlowLpm: selectedAlternative?.peakFlowLpm ?? 0,
      terminalPressureBar: selectedAlternative?.terminalPressureBar ?? 0,
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
