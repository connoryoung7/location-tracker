import type { Geocoder } from "@/domain/ports";
import { type Address, type CoordinatePrecision, type GeocodingResult } from "@/domain/types";

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

export class NominatimGeocoder implements Geocoder {
    private precision: CoordinatePrecision;

    constructor(precision: CoordinatePrecision) {
        this.precision = precision;
    }

    async geocode(address: string): Promise<GeocodingResult[]> {
        const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&q=${encodeURIComponent(address)}`);
        const data = await response.json() as NominatimResponse[];
        return data.map((item) => {
            const result: GeocodingResult = {
                lat: Number(item.lat),
                lon: Number(item.lon),
            };

            if (item.display_name) {
                const addr: Address = { displayName: item.display_name };

                if (item.address) {
                    const street = [item.address.house_number, item.address.road].filter(Boolean).join(" ");
                    if (street) addr.street = street;

                    const city = item.address.city ?? item.address.town ?? item.address.village ?? item.address.hamlet;
                    if (city) addr.city = city;
                    if (item.address.state) addr.state = item.address.state;
                    if (item.address.country) addr.country = item.address.country;
                    if (item.address.country_code) addr.countryCode = item.address.country_code;
                    if (item.address.postcode) addr.postalCode = item.address.postcode;
                }

                result.address = addr;
            }

            return result;
        });
    }

    async reverseGeocode(lat: number, lon: number): Promise<GeocodingResult> {
        const factor = 10 ** this.precision;
        const rlat = Math.round(lat * factor) / factor;
        const rlon = Math.round(lon * factor) / factor;
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&lat=${rlat}&lon=${rlon}`);
        const data = await response.json() as NominatimResponse;
        if (!data?.display_name) {
            return {
                lat: rlat,
                lon: rlon
            }
        };

        const address: Address = { displayName: data.display_name };

        if (data.address) {
            const street = [data.address.house_number, data.address.road].filter(Boolean).join(" ");
            if (street) address.street = street;

            const city = data.address.city ?? data.address.town ?? data.address.village ?? data.address.hamlet;
            if (city) address.city = city;
            if (data.address.state) address.state = data.address.state;
            if (data.address.country) address.country = data.address.country;
            if (data.address.country_code) address.countryCode = data.address.country_code;
            if (data.address.postcode) address.postalCode = data.address.postcode;
        }

        return {
            address,
            lat: rlat,
            lon: rlon
        };
    }
}

