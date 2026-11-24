import { STEP_LABELS, type StepState } from "../src/steps";

export function Stepper({ steps }: { steps: StepState[] }) {
  return (
    <ol className="stepper" aria-label="Progress">
      {STEP_LABELS.map((label, i) => (
        <li
          key={label}
          className={`step step-${steps[i]}`}
          aria-current={steps[i] === 'active' ? 'step' : undefined}
        >
          <span className="step-dot" aria-hidden="true">
            {steps[i] === 'done' ? '✓' : steps[i] === 'failed' ? '!' : i + 1}
          </span>
          <span className="step-label">{label}</span>
        </li>
      ))}
    </ol>
  );
}