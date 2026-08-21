import PageSkeleton from "@/components/page-skeleton";

// Matches dashboard/page.tsx: a counter strip over grouped escalation cards.
export default function Loading() {
  return (
    <PageSkeleton
      title="Dashboard"
      subtitle="Today at a glance"
      icon="space_dashboard"
      pills={4}
      cards={4}
    />
  );
}
