import PageSkeleton from "@/components/page-skeleton";

// The catch-all. Every route under (app) without its own loading.tsx gets
// this, so no screen in the app can navigate with zero feedback again — the
// failure mode that had people tapping the bottom bar three times.
//
// No title: this file cannot know which page is coming. The ones below can, and
// they say so.
export default function Loading() {
  return <PageSkeleton title="Loading" cards={3} />;
}
