import type { PlaceFinder } from '@/domain/ports.ts';
import type { PointOfInterest } from '@/domain/types.ts';

type OverpassElement = {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  /** Present on ways and relations when the query asks for `out center`. */
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

type OverpassResponse = { elements?: OverpassElement[] };

/** Tag keys that describe somewhere a person might spend time, most telling first. */
const PLACE_KEYS = [
  'shop',
  'amenity',
  'healthcare',
  'leisure',
  'tourism',
  'office',
  'craft',
] as const;

/** Friendly names for common `key=value` tags. Anything else is derived from the tag value. */
const CATEGORY_BY_TAG: Record<string, string> = {
  'shop=supermarket': 'Grocery store',
  'shop=grocery': 'Grocery store',
  'shop=greengrocer': 'Grocery store',
  'shop=health_food': 'Health food store',
  'shop=convenience': 'Convenience store',
  'shop=bakery': 'Bakery',
  'shop=butcher': 'Butcher',
  'shop=alcohol': 'Liquor store',
  'shop=wine': 'Liquor store',
  'shop=mall': 'Shopping mall',
  'shop=department_store': 'Department store',
  'shop=clothes': 'Clothing store',
  'shop=shoes': 'Shoe store',
  'shop=hardware': 'Hardware store',
  'shop=doityourself': 'Hardware store',
  'shop=electronics': 'Electronics store',
  'shop=books': 'Bookstore',
  'shop=pet': 'Pet store',
  'shop=chemist': 'Pharmacy',
  'shop=hairdresser': 'Hair salon',
  'shop=beauty': 'Beauty salon',
  'shop=car_repair': 'Car repair',
  'amenity=pharmacy': 'Pharmacy',
  'amenity=restaurant': 'Restaurant',
  'amenity=fast_food': 'Fast food',
  'amenity=food_court': 'Food court',
  'amenity=cafe': 'Café',
  'amenity=ice_cream': 'Ice cream',
  'amenity=bar': 'Bar',
  'amenity=pub': 'Bar',
  'amenity=biergarten': 'Bar',
  'amenity=nightclub': 'Nightclub',
  'amenity=fuel': 'Gas station',
  'amenity=car_wash': 'Car wash',
  'amenity=bank': 'Bank',
  'amenity=post_office': 'Post office',
  'amenity=library': 'Library',
  'amenity=kindergarten': 'School',
  'amenity=school': 'School',
  'amenity=college': 'College',
  'amenity=university': 'University',
  'amenity=childcare': 'Childcare',
  'amenity=hospital': 'Hospital',
  'amenity=clinic': 'Clinic',
  'amenity=doctors': 'Doctor',
  'amenity=dentist': 'Dentist',
  'amenity=veterinary': 'Vet',
  'amenity=place_of_worship': 'Place of worship',
  'amenity=cinema': 'Movie theater',
  'amenity=theatre': 'Theater',
  'amenity=community_centre': 'Community center',
  'amenity=townhall': 'Town hall',
  'amenity=police': 'Police station',
  'healthcare=doctor': 'Doctor',
  'healthcare=dentist': 'Dentist',
  'healthcare=hospital': 'Hospital',
  'healthcare=clinic': 'Clinic',
  'healthcare=pharmacy': 'Pharmacy',
  'leisure=fitness_centre': 'Gym',
  'leisure=sports_centre': 'Sports center',
  'leisure=swimming_pool': 'Swimming pool',
  'leisure=park': 'Park',
  'leisure=garden': 'Garden',
  'leisure=playground': 'Playground',
  'leisure=pitch': 'Sports field',
  'leisure=stadium': 'Stadium',
  'leisure=golf_course': 'Golf course',
  'tourism=hotel': 'Hotel',
  'tourism=motel': 'Hotel',
  'tourism=hostel': 'Hostel',
  'tourism=guest_house': 'Guest house',
  'tourism=museum': 'Museum',
  'tourism=gallery': 'Gallery',
  'tourism=zoo': 'Zoo',
  'tourism=attraction': 'Attraction',
};

/**
 * Street furniture and infrastructure: named often enough to show up, but not
 * somewhere anyone goes to spend time.
 */
const IGNORED_TAGS = new Set([
  'amenity=atm',
  'amenity=bench',
  'amenity=bicycle_parking',
  'amenity=bicycle_rental',
  'amenity=bicycle_repair_station',
  'amenity=bus_station',
  'amenity=car_sharing',
  'amenity=charging_station',
  'amenity=clock',
  'amenity=drinking_water',
  'amenity=fountain',
  'amenity=grit_bin',
  'amenity=letter_box',
  'amenity=loading_dock',
  'amenity=motorcycle_parking',
  'amenity=parking',
  'amenity=parking_entrance',
  'amenity=parking_space',
  'amenity=post_box',
  'amenity=public_bookcase',
  'amenity=recycling',
  'amenity=shelter',
  'amenity=taxi',
  'amenity=telephone',
  'amenity=toilets',
  'amenity=vending_machine',
  'amenity=waste_basket',
  'amenity=waste_disposal',
  'leisure=bleachers',
  'leisure=firepit',
  'leisure=outdoor_seating',
  'leisure=picnic_table',
  'leisure=slipway',
  'tourism=artwork',
  'tourism=information',
  'tourism=viewpoint',
]);

const HEADERS = {
  // Same generic identifier as the Nominatim geocoder; never anything user-specific.
  'User-Agent': 'location-tracker/1.0',
  'Content-Type': 'application/x-www-form-urlencoded',
};

/**
 * Finds named shops, restaurants, parks and the like with the OpenStreetMap
 * Overpass API. The coordinate is sent to the configured server, so point
 * `endpoint` at a self-hosted instance to keep locations off third parties.
 */
export class OverpassPlaceFinder implements PlaceFinder {
  constructor(
    private endpoint: string,
    // Generous: the public instance answers in about a second normally, but
    // can queue requests for half a minute under load.
    private timeoutMs = 30_000,
  ) {}

  async findNearbyPlaces(
    lat: number,
    lon: number,
    radiusMeters: number,
  ): Promise<PointOfInterest[]> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: HEADERS,
      body: new URLSearchParams({ data: buildQuery(lat, lon, radiusMeters) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Overpass query failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as OverpassResponse;
    return (data.elements ?? []).flatMap((element) => {
      const poi = toPointOfInterest(element);
      return poi ? [poi] : [];
    });
  }
}

/** Every named feature within the radius that carries one of the `PLACE_KEYS`. */
export function buildQuery(lat: number, lon: number, radiusMeters: number): string {
  const keys = PLACE_KEYS.join('|');
  // Fixed decimals: a number like 1e-7 would otherwise print in exponent form,
  // which Overpass QL does not accept.
  const around = `${Math.round(radiusMeters)},${lat.toFixed(6)},${lon.toFixed(6)}`;
  return `[out:json][timeout:10];nwr(around:${around})[name][~"^(${keys})$"~"."];out center 100;`;
}

function toPointOfInterest(element: OverpassElement): PointOfInterest | undefined {
  const name = element.tags?.name?.trim();
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  const category = element.tags ? categorize(element.tags) : undefined;
  if (!name || lat === undefined || lon === undefined || !category) {
    return undefined;
  }

  return { id: `${element.type}/${element.id}`, name, category, lat, lon };
}

/** The category of the first meaningful place tag, or undefined when every tag is ignored. */
export function categorize(tags: Record<string, string>): string | undefined {
  for (const key of PLACE_KEYS) {
    // A value can list several, e.g. `shop=bakery;cafe`; the first is the main one.
    const value = tags[key]?.split(';')[0]?.trim();
    if (!value) continue;

    const tag = `${key}=${value}`;
    if (IGNORED_TAGS.has(tag)) continue;

    if (key === 'office') return 'Office';
    return CATEGORY_BY_TAG[tag] ?? humanize(value === 'yes' ? key : value);
  }
  return undefined;
}

/** `car_repair` → `Car repair`. */
function humanize(value: string): string {
  const words = value.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
