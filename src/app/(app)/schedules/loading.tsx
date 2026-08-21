import PageSkeleton from "@/components/page-skeleton";

// The heaviest query in the app: 158 ms mean and 5.4 s at worst before 0083,
// which is exactly the wait this skeleton covers.
export default function Loading() {
  return (
    <PageSkeleton
      title="Schedules"
      subtitle="Classes by school and region"
      icon="calendar_month"
      cards={6}
      cardLines={2}
    />
  );
}
