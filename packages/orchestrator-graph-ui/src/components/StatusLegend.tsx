import type { ModuleStatus } from "../types";

const items: Array<{ status: ModuleStatus; label: string }> = [
  { status: "success", label: "Success" },
  { status: "failed", label: "Failed" },
  { status: "blocked", label: "Blocked" },
  { status: "skipped", label: "Skipped" },
  { status: "pending", label: "Pending" },
];

export function StatusLegend(): JSX.Element {
  return (
    <section className="legend">
      {items.map((item) => (
        <span className="legend-item" key={item.status}>
          <i className={`legend-dot status-${item.status}`} />
          {item.label}
        </span>
      ))}
    </section>
  );
}
