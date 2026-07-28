// Shared form primitives for the (auth) pages. Imported by client form
// components, so these render on the client with them.

export function Field({
  label,
  name,
  type = "text",
  error,
  icon,
  ...rest
}: {
  label: string;
  name: string;
  type?: string;
  error?: string;
  icon?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-sm font-semibold text-on-surface">
        {label}
      </label>
      <div className="relative flex items-center">
        {icon && (
          <span
            className="material-symbols-outlined pointer-events-none absolute left-3 text-outline-variant"
            aria-hidden
          >
            {icon}
          </span>
        )}
        <input
          id={name}
          name={name}
          type={type}
          className={`w-full rounded-lg bg-surface-container-low py-3 text-on-surface outline-none transition-shadow placeholder:text-outline-variant focus:ring-2 focus:ring-primary ${
            icon ? "pl-11 pr-3" : "px-3"
          }`}
          {...rest}
        />
      </div>
      {error && <p className="text-xs text-error">{error}</p>}
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
      className="mt-2 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-bold text-on-primary shadow-md transition-transform active:scale-[0.98] disabled:opacity-50"
    >
      {pending ? (
        "Working…"
      ) : (
        <>
          {children}
          <span className="material-symbols-outlined text-xl" aria-hidden>
            arrow_forward
          </span>
        </>
      )}
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
        className="flex items-center gap-2 rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container"
      >
        <span className="material-symbols-outlined text-base" aria-hidden>
          error
        </span>
        {error}
      </p>
    );
  }
  if (success) {
    return (
      <p className="flex items-center gap-2 rounded-lg bg-tertiary-container px-3 py-2 text-sm text-on-tertiary-container">
        <span className="material-symbols-outlined text-base" aria-hidden>
          check_circle
        </span>
        {success}
      </p>
    );
  }
  return null;
}
