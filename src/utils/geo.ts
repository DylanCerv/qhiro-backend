import type { GeoPoint, Parcel } from '../types/index.js';

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
