import PageSkeleton from "@/components/page-skeleton";

export default function Loading() {
  return (
    <PageSkeleton
      title="Substitutes"
      subtitle="Pick the class that needs covering."
      icon="person_search"
      cards={3}
    />
  );
}
