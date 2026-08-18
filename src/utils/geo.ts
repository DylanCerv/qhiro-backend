import type { Device, GeoPoint, Parcel } from '../types/index.js';

const EARTH_RADIUS_METERS = 6_371_000;

export function readGeoPoints(value: unknown): GeoPoint[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is GeoPoint => (
    Boolean(item)
    && typeof item === 'object'
    && typeof (item as GeoPoint).lat === 'number'
    && Number.isFinite((item as GeoPoint).lat)
    && typeof (item as GeoPoint).lng === 'number'
    && Number.isFinite((item as GeoPoint).lng)
  ));
}

export function distanceMeters(a?: GeoPoint | null, b?: GeoPoint | null): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const haversine = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

export function findNearestDevice<T extends { coordinates?: GeoPoint }>(
  point: GeoPoint | undefined,
  devices: T[] = [],
): T | undefined {
  if (!point || devices.length === 0) return undefined;

  return devices.reduce<T | undefined>((nearest, device) => {
    if (!device.coordinates) return nearest;
    if (!nearest?.coordinates) return device;
    return distanceMeters(point, device.coordinates) < distanceMeters(point, nearest.coordinates)
      ? device
      : nearest;
  }, undefined);
}

export function findNearestSentinel(
  point: GeoPoint | undefined,
  devices: Device[] = [],
): Device | undefined {
  const sentinels = devices.filter((device) =>
    device.type === 'sentinel' && device.coordinates,
  );
  return findNearestDevice(point, sentinels);
}

export function isPointInPolygon(point: GeoPoint, polygon: GeoPoint[] = []): boolean {
  if (polygon.length < 3) return false;

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;
    const intersects = yi > point.lat !== yj > point.lat
      && point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function findParcelAtPoint(point: GeoPoint, parcels: Parcel[] = []): Parcel | undefined {
  return parcels.find((parcel) => isPointInPolygon(point, parcel.coordinates ?? []));
}
