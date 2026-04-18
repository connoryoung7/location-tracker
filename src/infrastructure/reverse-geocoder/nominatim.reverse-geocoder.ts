import type { ReverseGeocoder } from '@/domain/ports';
import {
  type Address,
  type CoordinatePrecision,
  type ReverseGeocodingResult,
} from '@/domain/types';

type NominatimAddress = {
  house_number?: string;
  road?: string;
  neighbourhood?: string;
  suburb?: string;
  city?: string;
  town?: string;
  village?: string;
  hamlet?: string;
  city_district?: string;
  district?: string;
  borough?: string;
  county?: string;
  state?: string;
  state_district?: string;
  region?: string;
  postcode?: string;
  country?: string;
  country_code?: string;
  continent?: string;
  municipality?: string;
  quarter?: string;
  [key: `ISO3166-2-lvl${number}`]: string;
};

type NominatimResponse = {
  place_id: number;
  lat: string;
  lon: string;
  addresstype: string;
  display_name: string;
  name: string;
  address?: NominatimAddress;
};

export class NominatimReverseGeocoder implements ReverseGeocoder {
  private precision: CoordinatePrecision;

  constructor(precision: CoordinatePrecision) {
    this.precision = precision;
  }

  async reverseGeocode(lat: number, lon: number): Promise<ReverseGeocodingResult> {
    const factor = 10 ** this.precision;
    const rlat = Math.round(lat * factor) / factor;
    const rlon = Math.round(lon * factor) / factor;
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&lat=${rlat}&lon=${rlon}`,
    );
    const data = (await response.json()) as NominatimResponse;
    const resLat = data?.lat ? parseFloat(data.lat) : rlat;
    const resLon = data?.lon ? parseFloat(data.lon) : rlon;
    if (!data?.display_name) {
      return {
        lat: resLat,
        lon: resLon,
      };
    }

    const address: Address = { displayName: data.display_name };

    if (data.address) {
      const street = [data.address.house_number, data.address.road].filter(Boolean).join(' ');
      if (street) address.street = street;

      const city =
        data.address.city ?? data.address.town ?? data.address.village ?? data.address.hamlet;
      if (city) address.city = city;
      if (data.address.state) address.state = data.address.state;
      if (data.address.country) address.country = data.address.country;
      if (data.address.country_code) address.countryCode = data.address.country_code;
      if (data.address.postcode) address.postalCode = data.address.postcode;
    }

    return {
      address,
      lat: resLat,
      lon: resLon,
    };
  }
}
