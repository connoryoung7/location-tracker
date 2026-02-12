import { walkingCoordinates, drivingCoordinates, stationaryCoordinates, ungeocodableCoordinates } from '@/test/coordinates.ts';

const allCoordinates = [...walkingCoordinates, ...drivingCoordinates, ...stationaryCoordinates, ...ungeocodableCoordinates];

const seen = new Set<string>();
const uniqueCoordinates: { lat: number; lon: number }[] = [];

for (const coord of allCoordinates) {
  const key = `${coord.lat}:${coord.lon}`;
  if (!seen.has(key)) {
    seen.add(key);
    uniqueCoordinates.push({ lat: coord.lat, lon: coord.lon });
  }
}

console.log(`Reverse geocoding ${uniqueCoordinates.length} unique coordinates...`);

const results: Record<string, unknown> = {};

for (const [i, coord] of uniqueCoordinates.entries()) {
  const key = `${coord.lat}:${coord.lon}`;
  console.log(`[${i + 1}/${uniqueCoordinates.length}] ${key}`);

  const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&lat=${coord.lat}&lon=${coord.lon}`);
  results[key] = await response.json();

  // Nominatim usage policy: max 1 request/second
  if (i < uniqueCoordinates.length - 1) {
    await Bun.sleep(1100);
  }
}

await Bun.write('test-data/reverse-geocodings.json', JSON.stringify(results, null, 2) + '\n');

console.log(`Saved ${Object.keys(results).length} entries to test-data/reverse-geocodings.json`);
