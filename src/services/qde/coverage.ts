import type { GeoPoint } from '../../types/index.js';
import { distanceMeters, isPointInPolygon } from '../../utils/geo.js';

const HEX_ROW_FACTOR = Math.sqrt(3) / 2;

export function metersToLatDelta(meters: number): number {
  return meters / 111_320;
}

export function metersToLngDelta(meters: number, lat: number): number {
  return meters / (111_320 * Math.cos((lat * Math.PI) / 180));
}

export function polygonCentroid(polygon: GeoPoint[]): GeoPoint {
  if (polygon.length === 0) return { lat: 18.807, lng: -69.784 };
  const sum = polygon.reduce(
    (acc, point) => ({ lat: acc.lat + point.lat, lng: acc.lng + point.lng }),
    { lat: 0, lng: 0 },
  );
  return { lat: sum.lat / polygon.length, lng: sum.lng / polygon.length };
}

export function polygonBounds(polygon: GeoPoint[]) {
  return polygon.reduce(
    (bounds, point) => ({
      minLat: Math.min(bounds.minLat, point.lat),
      maxLat: Math.max(bounds.maxLat, point.lat),
      minLng: Math.min(bounds.minLng, point.lng),
      maxLng: Math.max(bounds.maxLng, point.lng),
    }),
    {
      minLat: polygon[0].lat,
      maxLat: polygon[0].lat,
      minLng: polygon[0].lng,
      maxLng: polygon[0].lng,
    },
  );
}

/** Approximate polygon area in square meters (shoelace on local projection). */
export function estimatePolygonAreaM2(polygon: GeoPoint[]): number {
  if (polygon.length < 3) return 0;
  const centroid = polygonCentroid(polygon);
  const latScale = 111_320;
  const lngScale = 111_320 * Math.cos((centroid.lat * Math.PI) / 180);
  const points = polygon.map((point) => ({
    x: point.lng * lngScale,
    y: point.lat * latScale,
  }));

  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area / 2);
}

function adaptiveSampleStepM(polygon: GeoPoint[], requestedStepM: number): number {
  const areaM2 = estimatePolygonAreaM2(polygon);
  if (areaM2 <= 0) return requestedStepM;
  const maxSamples = 2_500;
  const minStep = Math.sqrt(areaM2 / maxSamples);
  return Math.max(requestedStepM, minStep);
}

/** Hexagonal grid — optimal packing for circular spray coverage. */
export function generateHexGridInPolygon(
  polygon: GeoPoint[],
  spacingM: number,
  maxPoints = 90,
): GeoPoint[] {
  if (polygon.length < 3 || spacingM <= 0) return [];

  const bounds = polygonBounds(polygon);
  const centroid = polygonCentroid(polygon);
  const latStep = metersToLatDelta(spacingM * HEX_ROW_FACTOR);
  const lngStep = metersToLngDelta(spacingM, centroid.lat);
  const points: GeoPoint[] = [];
  let row = 0;

  for (let lat = bounds.minLat; lat <= bounds.maxLat; lat += latStep) {
    const lngOffset = (row % 2) * (lngStep / 2);
    for (let lng = bounds.minLng + lngOffset; lng <= bounds.maxLng; lng += lngStep) {
      const point = { lat, lng };
      if (isPointInPolygon(point, polygon)) {
        points.push(point);
      }
    }
    row += 1;
  }

  if (points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  return points.filter((_, index) => index % stride === 0);
}

export interface CoverageMeasurement {
  coveragePct: number;
  gapPoints: GeoPoint[];
  sampleCount: number;
  coveredSamples: number;
}

/** Sample the polygon and measure % covered by sentinel circles. */
export function measureCoveragePct(
  polygon: GeoPoint[],
  sentinelPoints: GeoPoint[],
  radiusM: number,
  sampleStepM = 3,
): CoverageMeasurement {
  if (polygon.length < 3) {
    return { coveragePct: 0, gapPoints: [], sampleCount: 0, coveredSamples: 0 };
  }

  const stepM = adaptiveSampleStepM(polygon, sampleStepM);
  const bounds = polygonBounds(polygon);
  const centroid = polygonCentroid(polygon);
  const latStep = metersToLatDelta(stepM);
  const lngStep = metersToLngDelta(stepM, centroid.lat);
  let covered = 0;
  let total = 0;
  const gapPoints: GeoPoint[] = [];

  for (let lat = bounds.minLat; lat <= bounds.maxLat; lat += latStep) {
    for (let lng = bounds.minLng; lng <= bounds.maxLng; lng += lngStep) {
      const sample = { lat, lng };
      if (!isPointInPolygon(sample, polygon)) continue;
      total += 1;
      const isCovered = sentinelPoints.some(
        (sentinel) => distanceMeters(sample, sentinel) <= radiusM,
      );
      if (isCovered) {
        covered += 1;
      } else if (gapPoints.length < 120) {
        gapPoints.push(sample);
      }
    }
  }

  return {
    coveragePct: total === 0 ? 0 : (covered / total) * 100,
    gapPoints,
    sampleCount: total,
    coveredSamples: covered,
  };
}

/** Distance from point to nearest polygon edge segment (meters). */
export function distanceToPolygonBoundaryM(point: GeoPoint, polygon: GeoPoint[]): number {
  if (polygon.length < 2) return Number.POSITIVE_INFINITY;

  let minDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    minDistance = Math.min(minDistance, distancePointToSegmentM(point, a, b));
  }
  return minDistance;
}

function distancePointToSegmentM(point: GeoPoint, a: GeoPoint, b: GeoPoint): number {
  const latScale = 111_320;
  const lngScale = 111_320 * Math.cos((point.lat * Math.PI) / 180);

  const px = point.lng * lngScale;
  const py = point.lat * latScale;
  const ax = a.lng * lngScale;
  const ay = a.lat * latScale;
  const bx = b.lng * lngScale;
  const by = b.lat * latScale;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distanceMeters(point, a);

  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const projLng = (ax + t * dx) / lngScale;
  const projLat = (ay + t * dy) / latScale;
  return distanceMeters(point, { lat: projLat, lng: projLng });
}

/** Gap sample that adds the most new coverage when placed, preferring inset positions. */
export function pickBestGapPoint(
  gapPoints: GeoPoint[],
  sentinels: GeoPoint[],
  polygon?: GeoPoint[],
  radiusM?: number,
): GeoPoint {
  let best = gapPoints[0];
  let bestScore = -1;

  for (const gap of gapPoints) {
    const nearest = Math.min(...sentinels.map((sentinel) => distanceMeters(gap, sentinel)));
    const inset =
      polygon && radiusM ? insetFitness(gap, polygon, radiusM) : 1;
    const score = nearest * inset;
    if (score > bestScore) {
      bestScore = score;
      best = gap;
    }
  }

  return best;
}

/** Prefer positions inset from boundary so spray circles do not waste radius outside polygon. */
function insetFitness(candidate: GeoPoint, polygon: GeoPoint[], radiusM: number): number {
  const boundaryDist = distanceToPolygonBoundaryM(candidate, polygon);
  if (boundaryDist >= radiusM * 0.55) return 1;
  if (boundaryDist >= radiusM * 0.25) return 0.75;
  return Math.max(0.35, boundaryDist / (radiusM * 0.25));
}

/** Remove sentinels with the least unique contribution first (bounded iterations). */
export function pruneRedundantSentinels(
  polygon: GeoPoint[],
  nodes: GeoPoint[],
  radiusM: number,
  minCoveragePct: number,
  maxPasses = 30,
): GeoPoint[] {
  let result = [...nodes];
  const sampleStepM = 4;

  for (let pass = 0; pass < maxPasses && result.length > 1; pass += 1) {
    const measurement = measureCoveragePct(polygon, result, radiusM, sampleStepM);
    if (measurement.coveragePct < minCoveragePct) break;

    let removeIdx = -1;
    let lowestUnique = Number.POSITIVE_INFINITY;

    for (let index = 0; index < result.length; index += 1) {
      const others = result.filter((_, idx) => idx !== index);
      const without = measureCoveragePct(polygon, others, radiusM, sampleStepM);
      if (without.coveragePct < minCoveragePct) continue;

      const unique = measurement.coveredSamples - without.coveredSamples;
      if (unique < lowestUnique) {
        lowestUnique = unique;
        removeIdx = index;
      }
    }

    if (removeIdx < 0) break;
    result = result.filter((_, idx) => idx !== removeIdx);
  }

  return result;
}

function collapseOverlappingSentinels(
  polygon: GeoPoint[],
  nodes: GeoPoint[],
  radiusM: number,
  minCoveragePct: number,
  minSeparationM: number,
  maxPasses = 25,
): GeoPoint[] {
  let result = [...nodes];
  const sampleStepM = 4;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let removed = false;
    for (let i = 0; i < result.length; i += 1) {
      for (let j = i + 1; j < result.length; j += 1) {
        if (distanceMeters(result[i], result[j]) >= minSeparationM) continue;

        const reduced = result.filter((_, idx) => idx !== j);
        const measurement = measureCoveragePct(polygon, reduced, radiusM, sampleStepM);
        if (measurement.coveragePct >= minCoveragePct) {
          result = reduced;
          removed = true;
          break;
        }
      }
      if (removed) break;
    }
    if (!removed) break;
  }

  return result;
}

/**
 * Fast hybrid placement: sparse hex seed → prune → fill gaps → collapse overlap → prune.
 */
export function optimizeSentinelPlacement(
  polygon: GeoPoint[],
  spacingM: number,
  radiusM: number,
  minCoveragePct: number,
  maxExtraNodes = 24,
): GeoPoint[] {
  const minSeparationM = Math.min(spacingM, radiusM * 2 * 0.96);
  const areaM2 = estimatePolygonAreaM2(polygon);
  const nominalNodes = Math.max(
    1,
    Math.ceil(areaM2 / (Math.PI * radiusM * radiusM * 0.72)),
  );
  const maxNodes = Math.min(80, Math.max(4, Math.ceil(nominalNodes * 1.2)));
  const useHexSeed = areaM2 > 0 && areaM2 < 120_000;

  let points: GeoPoint[] = useHexSeed
    ? generateHexGridInPolygon(polygon, spacingM, Math.min(50, maxNodes + 4))
    : [];

  if (points.length > 0) {
    points = pruneRedundantSentinels(polygon, points, radiusM, minCoveragePct, 12);
  }

  let lastCoverage = measureCoveragePct(polygon, points, radiusM, 5).coveragePct;

  for (let iteration = 0; iteration < maxNodes; iteration += 1) {
    const measurement = measureCoveragePct(polygon, points, radiusM, 5);
    if (measurement.coveragePct >= minCoveragePct) break;
    if (
      points.length > 0 &&
      measurement.coveragePct >= minCoveragePct * 0.85 &&
      measurement.coveragePct <= lastCoverage + 0.2
    ) {
      break;
    }

    const gaps =
      measurement.gapPoints.length > 0
        ? measurement.gapPoints
        : [polygonCentroid(polygon)];

    points.push(pickBestGapPoint(gaps, points, polygon, radiusM));
    lastCoverage = measurement.coveragePct;
  }

  if (points.length === 0) {
    const centroid = polygonCentroid(polygon);
    points = isPointInPolygon(centroid, polygon) ? [centroid] : [polygon[0]];
  }

  if (points.length <= 50) {
    points = collapseOverlappingSentinels(
      polygon,
      points,
      radiusM,
      minCoveragePct,
      minSeparationM,
      12,
    );
    points = pruneRedundantSentinels(polygon, points, radiusM, minCoveragePct, 12);
  }

  return points;
}

/** @deprecated Prefer optimizeSentinelPlacement. */
export function fillCoverageGaps(
  polygon: GeoPoint[],
  nodes: GeoPoint[],
  radiusM: number,
  minCoveragePct: number,
  maxAdded = 40,
): GeoPoint[] {
  const result = [...nodes];

  for (let iteration = 0; iteration < maxAdded; iteration += 1) {
    const measurement = measureCoveragePct(polygon, result, radiusM, 4);
    if (measurement.coveragePct >= minCoveragePct || measurement.gapPoints.length === 0) {
      break;
    }
    result.push(pickBestGapPoint(measurement.gapPoints, result, polygon, radiusM));
  }

  return result;
}

/** Nido position: minimize max distance to all sentinels (minimax). */
export function findOptimalNidoPosition(
  sentinelPoints: GeoPoint[],
  polygon: GeoPoint[],
): GeoPoint {
  if (sentinelPoints.length === 0) return polygonCentroid(polygon);

  const candidates = [
    polygonCentroid(polygon),
    polygonCentroid(sentinelPoints),
    ...sentinelPoints.filter((_, index) => index % Math.max(1, Math.floor(sentinelPoints.length / 8)) === 0),
  ];

  let best = candidates[0];
  let bestMaxDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const maxDistance = Math.max(
      ...sentinelPoints.map((sentinel) => distanceMeters(candidate, sentinel)),
    );
    if (maxDistance < bestMaxDistance) {
      bestMaxDistance = maxDistance;
      best = candidate;
    }
  }

  return best;
}

/** Furthest sentinels from nido — ideal Cabecilla positions (perimeter / energy hubs). */
export function pickCabecillaIndices(
  sentinelPoints: GeoPoint[],
  nido: GeoPoint,
  cabecillaCount: number,
): Set<number> {
  const wanted = Math.min(cabecillaCount, sentinelPoints.length);
  if (wanted <= 0) return new Set();

  // Farthest-first selection: preserve an edge observer, then maximize the
  // separation from every Cabecilla already chosen. This prevents the entire
  // advanced sensor tier from accumulating in one perimeter band.
  const selected = new Set<number>();
  const first = sentinelPoints
    .map((point, index) => ({ index, distance: distanceMeters(nido, point) }))
    .sort((a, b) => b.distance - a.distance)[0];
  if (first) selected.add(first.index);

  while (selected.size < wanted) {
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < sentinelPoints.length; index += 1) {
      if (selected.has(index)) continue;
      const point = sentinelPoints[index];
      const nearestAdvanced = Math.min(
        ...[...selected].map((picked) => distanceMeters(point, sentinelPoints[picked])),
      );
      const score = nearestAdvanced + distanceMeters(nido, point) * 0.12;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex < 0) break;
    selected.add(bestIndex);
  }

  return selected;
}
