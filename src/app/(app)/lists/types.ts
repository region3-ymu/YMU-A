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
  // Region(s) derived from the schools this teacher is scheduled at during the
  // CURRENT school year (a teacher can span several) — see teacher_directory()
  // in migration 0061. NOT profiles.region, which is null-by-design for
  // teachers, and not all-time: one July PD week at a Central school otherwise
  // put half the company in Central. Empty for a teacher with no schedule yet.
  regions: Region[];
};
