import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Session teardown reachable via redirect. The DAL sends archived accounts
// here because server components can't write cookies mid-render; a route
// handler can. Worst case of an unwanted GET is a logout, which is harmless.
export async function GET(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();

  const { searchParams } = new URL(request.url);
  const error = searchParams.get("error");
  redirect(error === "archived" ? "/login?error=archived" : "/login");
}
