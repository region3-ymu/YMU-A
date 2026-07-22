"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth/dal";
import { createClient } from "@/lib/supabase/server";

export type SchoolYearFormState = { error?: string; success?: string } | undefined;

export async function createSchoolYear(
  _prev: SchoolYearFormState,
  formData: FormData,
): Promise<SchoolYearFormState> {
  await requireRole("operations_manager", "cpo");

  const name = String(formData.get("name") ?? "").trim();
  const startDate = String(formData.get("start_date") ?? "");
  const endDate = String(formData.get("end_date") ?? "");

  if (!name || !startDate || !endDate) {
    return { error: "A name, start date, and end date are all required." };
  }
  // Mirrors the school_years_dates_order check constraint — a friendly error
  // instead of a raw constraint-violation message.
  if (endDate <= startDate) {
    return { error: "The end date must be after the start date." };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("school_years").insert({
    name,
    start_date: startDate,
    end_date: endDate,
  });
  if (error) {
    return { error: error.message };
  }

  revalidatePath("/lists/school-years");
  return { success: `Created ${name}.` };
}

export async function archiveSchoolYear(
  _prev: SchoolYearFormState,
  formData: FormData,
): Promise<SchoolYearFormState> {
  await requireRole("operations_manager", "cpo");

  const yearId = String(formData.get("year_id") ?? "");
  if (!yearId) {
    return { error: "Missing school year." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("school_years")
    .update({ archived: true })
    .eq("id", yearId);
  if (error) {
    return { error: error.message };
  }

  revalidatePath("/lists/school-years");
  return { success: "School year archived." };
}
