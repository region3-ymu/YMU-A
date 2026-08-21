import PageSkeleton from "@/components/page-skeleton";

// Reports leads with the per-teacher totals row, hence the pills.
export default function Loading() {
  return (
    <PageSkeleton
      title="Reports"
      subtitle="Hours and classes by teacher"
      icon="assessment"
      pills={5}
      cards={5}
      cardLines={1}
    />
  );
}
