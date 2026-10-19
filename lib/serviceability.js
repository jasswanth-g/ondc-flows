// Serviceability of a provider location for a delivery point, from what the catalogue publishes:
// type 10 radius (km from the location), 11 pincode ranges/lists, 13 GeoJSON polygon.

const toRad = (d) => (d * Math.PI) / 180;
function km([lat1, lng1], [lat2, lng2]) {
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
const parseGps = (s) => (s ? String(s).split(',').map(Number) : null);

function pincodeMatches(spec, pin) {
  const n = Number(pin);
  return spec.split(',').some((part) => {
    const [lo, hi] = part.split('-').map(Number);
    return hi ? n >= lo && n <= hi : n === lo;
  });
}

// Ray casting over every ring of every polygon; GeoJSON coordinates are [lng, lat].
function inPolygon([lat, lng], geojson) {
  const polys = JSON.parse(geojson).features.flatMap((f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates));
  return polys.some(([ring]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  });
}

export function serves(location, { gps, areaCode }) {
  const s = location.serviceability;
  const point = parseGps(gps);
  if (s.type === '10') return point ? km(parseGps(location.gps), point) <= Number(s.val) : false;
  if (s.type === '11') return areaCode ? pincodeMatches(s.val, areaCode) : false;
  if (s.type === '13') return point ? inPolygon(point, s.val) : false;
  return true;
}
