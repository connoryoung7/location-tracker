import { test, expect, describe, spyOn, beforeEach } from "bun:test";
import { NominatimReverseGeocoder } from "@/infrastructure/reverse-geocoder/nominatim.reverse-geocoder";
import { CoordinatePrecision } from "@/domain/types";

function jsonResponse(body: object) {
  return new Response(JSON.stringify(body));
}

const fullNominatimResponse = {
  place_id: 123,
  lat: "42.3601",
  lon: "-71.0589",
  addresstype: "building",
  display_name: "123 Main St, Boston, MA 02101, US",
  name: "Test Place",
  address: {
    house_number: "123",
    road: "Main St",
    city: "Boston",
    state: "Massachusetts",
    postcode: "02101",
    country: "United States",
    country_code: "us",
  },
};

const fetchSpy = spyOn(globalThis, "fetch");

beforeEach(() => {
  fetchSpy.mockReset();
});

describe("NominatimReverseGeocoder", () => {
  describe("coordinate rounding", () => {
    test("Country precision (0) rounds to whole degrees", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(fullNominatimResponse));
      const geocoder = new NominatimReverseGeocoder(CoordinatePrecision.Country);

      await geocoder.reverseGeocode(42.3601, -71.0589);

      if (!fetchSpy.mock.calls[0]) throw new Error("Expected fetch to be called");
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("lat=42");
      expect(url).toContain("lon=-71");
      expect(url).not.toContain("lat=42.");
      expect(url).not.toContain("lon=-71.");
    });

    test("City precision (1) rounds to 1 decimal place", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(fullNominatimResponse));
      const geocoder = new NominatimReverseGeocoder(CoordinatePrecision.City);

      await geocoder.reverseGeocode(42.3601, -71.0589);

    if (!fetchSpy.mock.calls[0]) throw new Error("Expected fetch to be called");
      const url: string = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("lat=42.4");
      expect(url).toContain("lon=-71.1");
    });

    test("Neighborhood precision (2) rounds to 2 decimal places", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(fullNominatimResponse));
      const geocoder = new NominatimReverseGeocoder(CoordinatePrecision.Neighborhood);

      await geocoder.reverseGeocode(42.3601, -71.0589);

      if (!fetchSpy.mock.calls[0]) throw new Error("Expected fetch to be called");
      const url: string = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("lat=42.36");
      expect(url).toContain("lon=-71.06");
    });

    test("Street precision (3) rounds to 3 decimal places", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(fullNominatimResponse));
      const geocoder = new NominatimReverseGeocoder(CoordinatePrecision.Street);

      await geocoder.reverseGeocode(42.3601, -71.0589);

      if (!fetchSpy.mock.calls[0]) throw new Error("Expected fetch to be called");
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("lat=42.36");
      expect(url).toContain("lon=-71.059");
    });

    test("Building precision (4) rounds to 4 decimal places", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(fullNominatimResponse));
      const geocoder = new NominatimReverseGeocoder(CoordinatePrecision.Building);

      await geocoder.reverseGeocode(42.36014, -71.05891);

      if (!fetchSpy.mock.calls[0]) throw new Error("Expected fetch to be called");
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("lat=42.3601");
      expect(url).toContain("lon=-71.0589");
    });

    test("VeryPrecise (6) rounds to 6 decimal places", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(fullNominatimResponse));
      const geocoder = new NominatimReverseGeocoder(CoordinatePrecision.VeryPrecise);

      await geocoder.reverseGeocode(42.3601234, -71.0589876);

      if (!fetchSpy.mock.calls[0]) throw new Error("Expected fetch to be called");
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("lat=42.360123");
      expect(url).toContain("lon=-71.058988");
    });
  });

  describe("URL format", () => {
    test("calls the Nominatim reverse API with correct base URL and params", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(fullNominatimResponse));
      const geocoder = new NominatimReverseGeocoder(CoordinatePrecision.Building);

      await geocoder.reverseGeocode(42.3601, -71.0589);

      if (!fetchSpy.mock.calls[0]) throw new Error("Expected fetch to be called");
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toStartWith("https://nominatim.openstreetmap.org/reverse?");
      expect(url).toContain("format=jsonv2");
      expect(url).toContain("addressdetails=1");
    });
  });

  describe("response parsing", () => {
    test("returns full address and parsed lat/lon when all fields present", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse(fullNominatimResponse));
      const geocoder = new NominatimReverseGeocoder(CoordinatePrecision.Building);

      const result = await geocoder.reverseGeocode(42.3601, -71.0589);

      expect(result).toEqual({
        lat: 42.3601,
        lon: -71.0589,
        address: {
          displayName: "123 Main St, Boston, MA 02101, US",
          street: "123 Main St",
          city: "Boston",
          state: "Massachusetts",
          country: "United States",
          countryCode: "us",
          postalCode: "02101",
        },
      });
    });

    test("returns only lat/lon when display_name is missing", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ place_id: 1 }));
      const geocoder = new NominatimReverseGeocoder(CoordinatePrecision.Building);

      const result = await geocoder.reverseGeocode(10, 20);

      expect(result).toEqual({ lat: 10, lon: 20 });
      expect(result.address).toBeUndefined();
    });

    test("returns address with only displayName when address details are missing", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        place_id: 1,
        lat: "5",
        lon: "10",
        display_name: "Somewhere",
      }));
      const geocoder = new NominatimReverseGeocoder(CoordinatePrecision.Building);

      const result = await geocoder.reverseGeocode(0, 0);

      expect(result).toEqual({ lat: 5, lon: 10, address: { displayName: "Somewhere" } });
    });

    test("uses town when city is absent", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        ...fullNominatimResponse,
        address: { ...fullNominatimResponse.address, city: undefined, town: "Concord" },
      }));
      const geocoder = new NominatimReverseGeocoder(CoordinatePrecision.Building);

      const result = await geocoder.reverseGeocode(42.3601, -71.0589);

      expect(result.address?.city).toBe("Concord");
    });

    test("uses village when city and town are absent", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        ...fullNominatimResponse,
        address: { ...fullNominatimResponse.address, city: undefined, town: undefined, village: "Lexington" },
      }));
      const geocoder = new NominatimReverseGeocoder(CoordinatePrecision.Building);

      const result = await geocoder.reverseGeocode(42.3601, -71.0589);

      expect(result.address?.city).toBe("Lexington");
    });

    test("uses hamlet when city, town, and village are absent", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        ...fullNominatimResponse,
        address: { ...fullNominatimResponse.address, city: undefined, town: undefined, village: undefined, hamlet: "Smallville" },
      }));
      const geocoder = new NominatimReverseGeocoder(CoordinatePrecision.Building);

      const result = await geocoder.reverseGeocode(42.3601, -71.0589);

      expect(result.address?.city).toBe("Smallville");
    });

    test("omits street when road and house_number are absent", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        ...fullNominatimResponse,
        address: { ...fullNominatimResponse.address, house_number: undefined, road: undefined },
      }));
      const geocoder = new NominatimReverseGeocoder(CoordinatePrecision.Building);

      const result = await geocoder.reverseGeocode(42.3601, -71.0589);

      expect(result.address?.street).toBeUndefined();
    });

    test("street is just road when house_number is absent", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({
        ...fullNominatimResponse,
        address: { ...fullNominatimResponse.address, house_number: undefined },
      }));
      const geocoder = new NominatimReverseGeocoder(CoordinatePrecision.Building);

      const result = await geocoder.reverseGeocode(42.3601, -71.0589);

      expect(result.address?.street).toBe("Main St");
    });
  });
});
