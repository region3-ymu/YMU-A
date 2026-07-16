// Placeholder body for tabs whose real features land in later phases.
export default function Stub({
  title,
  note,
  phase,
}: {
  title: string;
  note: string;
  phase: number;
}) {
  return (
    <main className="flex flex-1 flex-col p-6">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm opacity-70">{note}</p>
      <p className="mt-8 rounded-2xl border border-dashed border-foreground/20 p-6 text-center text-sm opacity-60">
        Coming in Phase {phase}.
      </p>
    </main>
  );
}
