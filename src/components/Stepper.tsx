import { Check } from "@/components/icons";

/** Progress through the booking steps. Purely presentational; `current` is zero-based. */
export default function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center gap-2 text-sm" aria-label="Booking progress">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li
            key={label}
            data-done={done}
            aria-current={active ? "step" : undefined}
            className="flex items-center gap-2"
          >
            <span className="step-dot">{done ? <Check className="size-4" /> : i + 1}</span>
            <span className={`${active ? "text-gold-100" : "hidden text-slate-500 sm:inline"} font-semibold`}>
              {label}
              {done ? <span className="sr-only"> (done)</span> : null}
            </span>
            {i < steps.length - 1 ? <span aria-hidden className="mx-1 hidden h-px w-6 bg-[rgba(247,237,213,0.16)] sm:block" /> : null}
          </li>
        );
      })}
    </ol>
  );
}
