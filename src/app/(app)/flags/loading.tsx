import PageSkeleton from "@/components/page-skeleton";

export default function Loading() {
  return (
    <PageSkeleton
      title="Flags"
      subtitle="GPS, late clock-in, and stuck-feedback escalations needing manager attention."
      icon="flag"
      cards={5}
      cardLines={3}
    />
  );
}
