"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/dal";
import { MANAGER_ROLES, isRegion } from "@/lib/auth/roles";
import { geocodeAddress } from "@/lib/geocode";
import { createClient } from "@/lib/supabase/server";

export type ListsFormState = { error?: string; success?: string } | undefined;

export async function addSchool(
  _prev: ListsFormState,
  formData: FormData,
): Promise<ListsFormState> {
  const caller = await requireRole(...MANAGER_ROLES);

  const name = String(formData.get("name") ?? "").trim();
  const address = String(formData.get("address") ?? "").trim();
  const contactName = String(formData.get("contact_name") ?? "").trim();
  const contactPhone = String(formData.get("contact_phone") ?? "").trim();

  if (!name || !address) {
    return { error: "A school name and address are required." };
  }

  const geocoded = await geocodeAddress(address);
  if (!geocoded) {
    return {
      error:
        "Couldn't geocode that address (Census and Nominatim both failed). " +
        "Add the school anyway with a name and address, then set its pin manually.",
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("schools").insert({
    name,
    address,
    contact_name: contactName || null,
    contact_phone: contactPhone || null,
    lat: geocoded.lat,
    lng: geocoded.lng,
    geocode_source: geocoded.source,
    created_by: caller.id,
  });
  if (error) {
    return { error: error.message };
  }

  revalidatePath("/lists");
  return {
    success: `Added, geocoded via ${geocoded.source === "census" ? "Census" : "Nominatim"}: ${geocoded.matchedAddress}`,
  };
}

export async function updateSchoolLocation(
  _prev: ListsFormState,
  formData: FormData,
): Promise<ListsFormState> {
  await requireRole(...MANAGER_ROLES);

  const schoolId = String(formData.get("school_id") ?? "");
  const lat = Number(formData.get("lat"));
  const lng = Number(formData.get("lng"));

  if (!schoolId || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { error: "Enter valid latitude and longitude." };
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { error: "Latitude/longitude out of range." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("schools")
    .update({ lat, lng, geocode_source: "manual" })
    .eq("id", schoolId);
  if (error) {
    return { error: error.message };
  }

  revalidatePath("/lists");
  return { success: "Pin updated." };
}

export async function updateSchoolContact(
  _prev: ListsFormState,
  formData: FormData,
): Promise<ListsFormState> {
  await requireRole(...MANAGER_ROLES);

  const schoolId = String(formData.get("school_id") ?? "");
  const contactName = String(formData.get("contact_name") ?? "").trim();
  const contactPhone = String(formData.get("contact_phone") ?? "").trim();
  const radiusRaw = Number(formData.get("geofence_radius_m"));
  const geofenceRadiusM = Number.isFinite(radiusRaw) && radiusRaw > 0 ? radiusRaw : 200;

  if (!schoolId) {
    return { error: "Missing school." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("schools")
    .update({
      contact_name: contactName || null,
      contact_phone: contactPhone || null,
      geofence_radius_m: geofenceRadiusM,
    })
    .eq("id", schoolId);
  if (error) {
    return { error: error.message };
  }

  revalidatePath("/lists");
  return { success: "Contact info updated." };
}

export async function assignSchoolRegion(
  _prev: ListsFormState,
  formData: FormData,
): Promise<ListsFormState> {
  // Authoritative check; the schools_protect_region trigger re-enforces this
  // in SQL regardless of what the UI offers.
  await requireRole("operations_manager", "cpo");

  const schoolId = String(formData.get("school_id") ?? "");
  const regionRaw = formData.get("region");
  const region = regionRaw === "" ? null : regionRaw;

  if (!schoolId || (region !== null && !isRegion(region))) {
    return { error: "Pick a valid region." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("schools")
    .update({ region })
    .eq("id", schoolId);
  if (error) {
    return { error: error.message };
  }

  revalidatePath("/lists");
  return { success: "Region updated." };
}
