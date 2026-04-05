/**
 * Simulated GPS coordinate sequences for testing.
 * Boston routes and ungeocodable locations.
 */

type Coordinate = { lat: number; lon: number; tst: number; vel?: number; acc?: number };

/** Walking from Boston Common (Frog Pond) to Faneuil Hall (~0.7 mi, ~15 min) */
export const walkingCoordinates: Coordinate[] = [
  { lat: 42.3551, lon: -71.0656, tst: 1700000000, vel: 0, acc: 8 },
  { lat: 42.3555, lon: -71.0647, tst: 1700000060, vel: 4, acc: 10 },
  { lat: 42.3559, lon: -71.0637, tst: 1700000120, vel: 5, acc: 9 },
  { lat: 42.3563, lon: -71.0626, tst: 1700000185, vel: 5, acc: 12 },
  { lat: 42.3567, lon: -71.0618, tst: 1700000240, vel: 4, acc: 8 },
  { lat: 42.3565, lon: -71.0607, tst: 1700000310, vel: 5, acc: 10 },
  { lat: 42.3562, lon: -71.0596, tst: 1700000370, vel: 4, acc: 15 },
  { lat: 42.356, lon: -71.0588, tst: 1700000430, vel: 4, acc: 11 },
  { lat: 42.3566, lon: -71.058, tst: 1700000490, vel: 5, acc: 9 },
  { lat: 42.3574, lon: -71.0573, tst: 1700000555, vel: 5, acc: 10 },
  { lat: 42.358, lon: -71.0569, tst: 1700000610, vel: 4, acc: 8 },
  { lat: 42.3588, lon: -71.0565, tst: 1700000680, vel: 5, acc: 12 },
  { lat: 42.3595, lon: -71.0561, tst: 1700000740, vel: 4, acc: 9 },
  { lat: 42.3601, lon: -71.0557, tst: 1700000810, vel: 3, acc: 10 },
  { lat: 42.3603, lon: -71.0554, tst: 1700000870, vel: 0, acc: 8 },
];

/** Driving from Fenway Park to South Boston Waterfront (~4 mi, ~15 min) */
export const drivingCoordinates: Coordinate[] = [
  { lat: 42.3467, lon: -71.0972, tst: 1700010000, vel: 0, acc: 5 },
  { lat: 42.3475, lon: -71.094, tst: 1700010030, vel: 25, acc: 6 },
  { lat: 42.349, lon: -71.0905, tst: 1700010060, vel: 35, acc: 5 },
  { lat: 42.351, lon: -71.0865, tst: 1700010090, vel: 45, acc: 8 },
  { lat: 42.3525, lon: -71.0825, tst: 1700010120, vel: 50, acc: 5 },
  { lat: 42.354, lon: -71.0785, tst: 1700010150, vel: 48, acc: 6 },
  { lat: 42.3555, lon: -71.074, tst: 1700010185, vel: 52, acc: 5 },
  { lat: 42.3565, lon: -71.0695, tst: 1700010215, vel: 45, acc: 7 },
  { lat: 42.357, lon: -71.065, tst: 1700010250, vel: 40, acc: 10 },
  { lat: 42.3565, lon: -71.0615, tst: 1700010280, vel: 35, acc: 8 },
  { lat: 42.3555, lon: -71.058, tst: 1700010315, vel: 30, acc: 6 },
  { lat: 42.354, lon: -71.0545, tst: 1700010350, vel: 38, acc: 5 },
  { lat: 42.352, lon: -71.051, tst: 1700010385, vel: 42, acc: 6 },
  { lat: 42.35, lon: -71.048, tst: 1700010420, vel: 35, acc: 5 },
  { lat: 42.3485, lon: -71.0455, tst: 1700010455, vel: 28, acc: 8 },
  { lat: 42.3478, lon: -71.0435, tst: 1700010490, vel: 15, acc: 6 },
  { lat: 42.3475, lon: -71.0425, tst: 1700010530, vel: 0, acc: 5 },
];

/** Stationary at a café in the North End (~30 min, GPS jitter only) */
export const stationaryCoordinates: Coordinate[] = [
  { lat: 42.3636, lon: -71.0544, tst: 1700020000, vel: 0, acc: 10 },
  { lat: 42.3636, lon: -71.0544, tst: 1700020120, vel: 0, acc: 12 },
  { lat: 42.3637, lon: -71.0544, tst: 1700020240, vel: 0, acc: 15 },
  { lat: 42.3636, lon: -71.0545, tst: 1700020360, vel: 0, acc: 10 },
  { lat: 42.3636, lon: -71.0544, tst: 1700020480, vel: 0, acc: 8 },
  { lat: 42.3635, lon: -71.0544, tst: 1700020600, vel: 0, acc: 18 },
  { lat: 42.3636, lon: -71.0543, tst: 1700020720, vel: 0, acc: 12 },
  { lat: 42.3636, lon: -71.0544, tst: 1700020840, vel: 0, acc: 10 },
  { lat: 42.3637, lon: -71.0545, tst: 1700020960, vel: 0, acc: 14 },
  { lat: 42.3636, lon: -71.0544, tst: 1700021080, vel: 0, acc: 10 },
  { lat: 42.3636, lon: -71.0544, tst: 1700021200, vel: 0, acc: 9 },
  { lat: 42.3635, lon: -71.0544, tst: 1700021320, vel: 0, acc: 16 },
  { lat: 42.3636, lon: -71.0544, tst: 1700021440, vel: 0, acc: 11 },
  { lat: 42.3636, lon: -71.0543, tst: 1700021560, vel: 0, acc: 10 },
  { lat: 42.3636, lon: -71.0544, tst: 1700021680, vel: 0, acc: 8 },
];

/** Coordinates in remote locations that cannot be reverse geocoded */
export const ungeocodableCoordinates: Coordinate[] = [
  { lat: 0.0, lon: -30.0, tst: 1700030000, vel: 0, acc: 50 },
  { lat: 0.0, lon: -160.0, tst: 1700030060, vel: 0, acc: 50 },
  { lat: -85.0, lon: 0.0, tst: 1700030120, vel: 0, acc: 50 },
  { lat: 89.99, lon: 0.0, tst: 1700030180, vel: 0, acc: 50 },
];
