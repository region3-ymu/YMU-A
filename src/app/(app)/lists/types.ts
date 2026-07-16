import type { Region } from "@/lib/auth/roles";

export type School = {
  id: string;
  name: string;
  address: string;
  contact_name: string | null;
  contact_phone: string | null;
  lat: number | null;
  lng: number | null;
  geocode_source: string | null;
  geofence_radius_m: number;
  region: Region | null;
};

export type Teacher = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  region: Region | null;
};
