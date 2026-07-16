// Shared form primitives for the (auth) pages. Imported by client form
// components, so these render on the client with them.

export function Field({
  label,
  name,
  type = "text",
  error,
  ...rest
}: {
  label: string;
  name: string;
  type?: string;
  error?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        className="rounded-lg border border-foreground/20 bg-background px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
        {...rest}
      />
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

export function SubmitButton({
  pending,
  children,
}: {
  pending: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground disabled:opacity-50"
    >
      {pending ? "Working…" : children}
    </button>
  );
}

export function FormMessage({
  error,
  success,
}: {
  error?: string;
  success?: string;
}) {
  if (error) {
    return (
      <p
        role="alert"
        className="rounded-lg border border-red-600/30 bg-red-600/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
      >
        {error}
      </p>
    );
  }
  if (success) {
    return (
      <p className="rounded-lg border border-green-600/30 bg-green-600/10 px-3 py-2 text-sm text-green-700 dark:text-green-300">
        {success}
      </p>
    );
  }
  return null;
}
