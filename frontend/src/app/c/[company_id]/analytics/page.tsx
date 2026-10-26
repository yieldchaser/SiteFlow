"use client";
import { getApiHost } from "@/lib/api";
import { authHeaders, fmtINR } from "@/lib/siteflow";


import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import PwaControls from "@/components/pwa/PwaControls";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";

interface AnalyticsPoint {
  label: string;
  planned_pct: number;
  actual_pct: number;
}

interface BurnPoint {
  label: string;
  burn_pct: number;
  spend: number;
}

interface ProjectSummary {
  project_id: string;
  project_name: string;
  code?: string | null;
  budget: number;
  spend: number;
  variance: number;
  completion_pct: number;
  task_count: number;
  completed_tasks: number;
}

interface SubcontractorScore {
  subcontractor_id: string;
  subcontractor_name: string;
  project_names: string[];
  bill_count: number;
  on_time_rate: number;
  ncr_count: number;
  late_bills: number;
}

interface MaterialReconciliationRow {
  material_name: string;
  unit: string;
  ordered_qty: number;
  consumed_qty: number;
  variance_qty: number;
  over_consumed: boolean;
}

interface AnalyticsPayload {
  company_id: string;
  company_name: string;
  project_count: number;
  total_tasks: number;
  completed_tasks: number;
  task_completion_pct: number;
  total_budget: number;
  total_spend: number;
  budget_variance: number;
  burn_rate_pct: number | null;
  s_curve: AnalyticsPoint[];
  budget_burn_series: BurnPoint[];
  labour_productivity: {
    total_hours: number | null;
    labour_days: number | null;
    completed_area_m2: number;
    productivity_m2_per_labour_day: number | null;
  };
  material_wastage: {
    ordered_qty: number;
    consumed_qty: number;
    stock_variance_qty: number;
    wastage_qty: number;
    wastage_pct: number | null;
  };
  material_reconciliation: MaterialReconciliationRow[];
  projects: ProjectSummary[];
  subcontractor_scorecard: SubcontractorScore[];
}

const chartColors = {
  planned: "var(--primary)",
  actual: "var(--danger)",
  burn: "var(--success)",
  grid: "var(--border)",
};

function formatCurrency(value: number) {
  return fmtINR(value);
}

function buildPoints(values: number[], width = 640, height = 220, padding = 24) {
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;
  const maxValue = Math.max(...values, 100);

  return values
    .map((value, index) => {
      const x = values.length === 1 ? width / 2 : padding + (index / (values.length - 1)) * usableWidth;
      const y = height - padding - (value / maxValue) * usableHeight;
      return `${x},${y}`;
    })
    .join(" ");
}

function ChartCard({
  title,
  subtitle,
  labels,
  plannedValues,
  actualValues,
  plannedLabel,
  actualLabel,
}: {
  title: string;
  subtitle: string;
  labels: string[];
  plannedValues: number[];
  actualValues: number[];
  plannedLabel: string;
  actualLabel: string;
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const width = 760;
  const height = 260;
  const padding = 28;
  const plannedPoints = buildPoints(plannedValues, width, height, padding);
  const actualPoints = buildPoints(actualValues, width, height, padding);

  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;

  return (
    <div className="bg-card border border-border-custom rounded-lg rounded-md border border-border-custom p-5">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.24em] text-muted">{title}</div>
          <div className="mt-1 text-sm text-muted">{subtitle}</div>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-[0.2em]">
          <span className="flex items-center gap-1 text-muted">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: chartColors.planned }} />
            {plannedLabel}
          </span>
          <span className="flex items-center gap-1 text-muted">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: chartColors.actual }} />
            {actualLabel}
          </span>
        </div>
      </div>

      <div className="relative rounded-lg border border-border-custom bg-card">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-[260px] w-full">
          {[0, 25, 50, 75, 100].map((tick) => {
            const y = height - padding - (tick / 100) * (height - padding * 2);
            return (
              <g key={tick}>
                <line x1={padding} y1={y} x2={width - padding} y2={y} stroke={chartColors.grid} strokeDasharray="4 6" />
                <text x="8" y={y + 4} fill="var(--muted)" fontSize="10">
                  {tick}%
                </text>
              </g>
            );
          })}

          {labels.map((label, index) => {
            if (index % Math.ceil(labels.length / 8) !== 0 && index !== labels.length - 1) return null;
            const x = labels.length === 1 ? width / 2 : padding + (index / Math.max(labels.length - 1, 1)) * (width - padding * 2);
            return (
              <text key={label} x={x} y={height - 6} fill="var(--muted)" fontSize="10" textAnchor="middle">
                {label}
              </text>
            );
          })}

          <polyline
            fill="none"
            stroke={chartColors.planned}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={plannedPoints}
          />
          <polyline
            fill="none"
            stroke={chartColors.actual}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={actualPoints}
          />

          {/* Interactive dots overlay */}
          {plannedValues.map((value, idx) => {
            const maxVal = Math.max(...plannedValues, 100);
            const x = plannedValues.length === 1 ? width / 2 : padding + (idx / (plannedValues.length - 1)) * usableWidth;
            const y = height - padding - (value / maxVal) * usableHeight;
            return (
              <circle
                key={`p-dot-${idx}`}
                cx={x}
                cy={y}
                r={hoveredIndex === idx ? 7 : 4}
                fill={chartColors.planned}
                stroke="var(--card)"
                strokeWidth={hoveredIndex === idx ? 2 : 0}
                className="cursor-pointer transition-all duration-150"
                onMouseEnter={() => setHoveredIndex(idx)}
                onMouseLeave={() => setHoveredIndex(null)}
              />
            );
          })}

          {actualValues.map((value, idx) => {
            const maxVal = Math.max(...actualValues, 100);
            const x = actualValues.length === 1 ? width / 2 : padding + (idx / (actualValues.length - 1)) * usableWidth;
            const y = height - padding - (value / maxVal) * usableHeight;
            return (
              <circle
                key={`a-dot-${idx}`}
                cx={x}
                cy={y}
                r={hoveredIndex === idx ? 7 : 4}
                fill={chartColors.actual}
                stroke="var(--card)"
                strokeWidth={hoveredIndex === idx ? 2 : 0}
                className="cursor-pointer transition-all duration-150"
                onMouseEnter={() => setHoveredIndex(idx)}
                onMouseLeave={() => setHoveredIndex(null)}
              />
            );
          })}
        </svg>

        {hoveredIndex !== null && (
          <div
            className="absolute bg-input/95 backdrop-blur-md border border-border-custom rounded-md p-3 shadow-2xl text-[10px] pointer-events-none transition-all duration-150 z-20 space-y-1.5 min-w-[120px]"
            style={{
              left: `${((labels.length === 1 ? width / 2 : padding + (hoveredIndex / Math.max(labels.length - 1, 1)) * (width - padding * 2)) / width) * 100}%`,
              top: "12px",
              transform: "translateX(-50%)",
            }}
          >
            <div className="font-extrabold text-foreground border-b border-border-custom pb-1">{labels[hoveredIndex]}</div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted">{plannedLabel}:</span>
              <span className="font-bold font-sans" style={{ color: chartColors.planned }}>{plannedValues[hoveredIndex]}%</span>
            </div>
            {actualValues[hoveredIndex] !== undefined && (
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted">{actualLabel}:</span>
                <span className="font-bold font-sans" style={{ color: chartColors.actual }}>{actualValues[hoveredIndex]}%</span>
              </div>
            )}
            {actualValues[hoveredIndex] !== undefined && (
              <div className="flex items-center justify-between gap-4 border-t border-border-custom pt-1 mt-1">
                <span className="text-muted">Variance:</span>
                <span className={`font-bold font-sans ${actualValues[hoveredIndex] >= plannedValues[hoveredIndex] ? "text-success" : "text-primary"}`}>
                  {(actualValues[hoveredIndex] - plannedValues[hoveredIndex]).toFixed(1)}%
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function CompanyAnalyticsPage() {
  const params = useParams();
  const companyId = params?.company_id as string;
  const [data, setData] = useState<AnalyticsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [hoveredBurnIndex, setHoveredBurnIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!companyId) {
      return;
    }

    const fetchAnalytics = async () => {
      try {
        setLoading(true);
        const response = await fetch(`${getApiHost()}/apis/v3/analytics/company/${companyId}`, { headers: authHeaders() });
        if (!response.ok) {
          throw new Error(`Analytics request failed: ${response.status}`);
        }
        const payload = (await response.json()) as AnalyticsPayload;
        setData(payload);
    } catch (error) {
      console.error("Failed to load analytics", error);
    } finally {
        setLoading(false);
      }
    };

    void fetchAnalytics();
  }, [companyId]);

  const planned = data?.s_curve.map((point) => point.planned_pct) ?? [];
  const actual = data?.s_curve.map((point) => point.actual_pct) ?? [];
  const burn = data?.budget_burn_series.map((point) => point.burn_pct) ?? [];
  const labels = data?.s_curve.map((point) => point.label) ?? [];
  const burnLabels = data?.budget_burn_series.map((point) => point.label) ?? [];

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title="Advanced Analytics Dashboard"
        subtitle="Cross-project KPI view for burn rate, progress cadence, labour productivity, and procurement leakage"
      >
        <div className="w-full max-w-xs">
          <PwaControls />
        </div>
      </PageHeader>
      <main className="flex-1 overflow-y-auto">
        <PageShell width="wide">

          <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            {[
              {
                label: "Budget Variance",
                value: data ? formatCurrency(data.budget_variance) : "—",
                hint: data ? `Spend ${formatCurrency(data.total_spend)} vs budget ${formatCurrency(data.total_budget)}` : "Loading",
                tone: "text-foreground",
              },
              {
                label: "Burn Rate",
                value: data ? (data.burn_rate_pct == null ? "—" : `${data.burn_rate_pct}%`) : "—",
                hint: data && data.burn_rate_pct == null ? "No budget set: not tracked" : "Company-wide budget consumption",
                tone: "text-success",
              },
              {
                label: "Labour Productivity",
                value: data ? (data.labour_productivity.productivity_m2_per_labour_day == null ? "—" : `${data.labour_productivity.productivity_m2_per_labour_day}`) : "—",
                hint: "m2 per labour-day",
                tone: "text-primary",
              },
              {
                label: "Material Wastage",
                value: data ? (data.material_wastage.wastage_pct == null ? "—" : `${data.material_wastage.wastage_pct}%`) : "—",
                hint: "Ordered vs consumed from procurement",
                tone: "text-warning",
              },
            ].map((card) => (
              <div key={card.label} className="bg-card border border-border-custom rounded-lg p-5">
                <div className="text-[10px] uppercase tracking-[0.24em] text-muted">{card.label}</div>
                <div className={`mt-3 text-3xl font-black tracking-tight ${card.tone}`}>{card.value}</div>
                <div className="mt-2 text-xs text-muted">{card.hint}</div>
              </div>
            ))}
          </section>

          <section className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <ChartCard
              title="S-Curve"
              subtitle="Planned vs actual physical progress from scheduled task completion"
              labels={labels}
              plannedValues={planned}
              actualValues={actual}
              plannedLabel="Planned"
              actualLabel="Actual"
            />

            <div className="bg-card border border-border-custom rounded-lg p-5">
              <div className="mb-4 flex items-end justify-between gap-4">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.24em] text-muted">Budget Burn</div>
                  <div className="mt-1 text-sm text-muted">Cumulative spend as a share of total project budget</div>
                </div>
                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted">
                  {data ? `${formatCurrency(data.total_spend)} spent` : "Loading"}
                </div>
              </div>
              <div className="relative rounded-lg border border-border-custom bg-card">
                <svg viewBox="0 0 760 260" className="h-[260px] w-full">
                  {[0, 25, 50, 75, 100].map((tick) => {
                    const y = 260 - 28 - (tick / 100) * (260 - 56);
                    return (
                      <g key={tick}>
                        <line x1="28" y1={y} x2="732" y2={y} stroke={chartColors.grid} strokeDasharray="4 6" />
                        <text x="8" y={y + 4} fill="var(--muted)" fontSize="10">
                          {tick}%
                        </text>
                      </g>
                    );
                  })}

                  {burnLabels.map((label, index) => {
                    if (index % Math.ceil(burnLabels.length / 8) !== 0 && index !== burnLabels.length - 1) return null;
                    const x = burnLabels.length === 1 ? 380 : 28 + (index / Math.max(burnLabels.length - 1, 1)) * 704;
                    return (
                      <text key={label} x={x} y="254" fill="var(--muted)" fontSize="10" textAnchor="middle">
                        {label}
                      </text>
                    );
                  })}

                  <polyline
                    fill="none"
                    stroke={chartColors.burn}
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    points={buildPoints(burn, 760, 260, 28)}
                  />

                  {/* Interactive dots overlay */}
                  {burn.map((value, idx) => {
                    const maxVal = Math.max(...burn, 100);
                    const x = burn.length === 1 ? 380 : 28 + (idx / Math.max(burn.length - 1, 1)) * 704;
                    const y = 260 - 28 - (value / maxVal) * (260 - 56);
                    return (
                      <circle
                        key={`b-dot-${idx}`}
                        cx={x}
                        cy={y}
                        r={hoveredBurnIndex === idx ? 7 : 4}
                        fill={chartColors.burn}
                        stroke="var(--card)"
                        strokeWidth={hoveredBurnIndex === idx ? 2 : 0}
                        className="cursor-pointer transition-all duration-150"
                        onMouseEnter={() => setHoveredBurnIndex(idx)}
                        onMouseLeave={() => setHoveredBurnIndex(null)}
                      />
                    );
                  })}
                </svg>

                {hoveredBurnIndex !== null && data?.budget_burn_series[hoveredBurnIndex] && (
                  <div
                    className="absolute bg-input/95 backdrop-blur-md border border-border-custom rounded-md p-3 shadow-2xl text-[10px] pointer-events-none transition-all duration-150 z-20 space-y-1.5 min-w-[140px]"
                    style={{
                      left: `${((burnLabels.length === 1 ? 380 : 28 + (hoveredBurnIndex / Math.max(burnLabels.length - 1, 1)) * 704) / 760) * 100}%`,
                      top: "12px",
                      transform: "translateX(-50%)",
                    }}
                  >
                    <div className="font-extrabold text-foreground border-b border-border-custom pb-1">
                      {data.budget_burn_series[hoveredBurnIndex].label}
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-muted">Burn Share:</span>
                      <span className="font-bold font-sans" style={{ color: chartColors.burn }}>
                        {data.budget_burn_series[hoveredBurnIndex].burn_pct}%
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-4 border-t border-border-custom pt-1 mt-1">
                      <span className="text-muted">Spend:</span>
                      <span className="font-bold font-sans text-foreground">
                        {formatCurrency(data.budget_burn_series[hoveredBurnIndex].spend)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-6">
            <div className="bg-card border border-border-custom rounded-lg p-5">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.24em] text-muted">Project Scoreboard</div>
                  <div className="mt-1 text-sm text-muted">Budget vs spend and completion by project</div>
                </div>
              </div>
              <div className="mt-4 overflow-hidden rounded-lg border border-border-custom">
                <table className="w-full text-sm">
                  <thead className="bg-elevated text-[10px] uppercase tracking-[0.2em] text-muted">
                    <tr>
                      <th className="px-4 py-3 text-left">Project</th>
                      <th className="px-4 py-3 text-right">Budget</th>
                      <th className="px-4 py-3 text-right">Spend</th>
                      <th className="px-4 py-3 text-right">Variance</th>
                      <th className="px-4 py-3 text-right">Completion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.projects ?? []).map((project) => (
                      <tr key={project.project_id} className="border-t border-border-custom hover:bg-elevated">
                        <td className="px-4 py-3">
                          <div className="font-semibold text-foreground">{project.project_name}</div>
                          <div className="text-[11px] text-muted">{project.code ?? "—"}</div>
                        </td>
                        <td className="px-4 py-3 text-right text-muted">{formatCurrency(project.budget)}</td>
                        <td className="px-4 py-3 text-right text-muted">{formatCurrency(project.spend)}</td>
                        <td className={`px-4 py-3 text-right font-semibold ${project.variance >= 0 ? "text-success" : "text-danger"}`}>
                          {formatCurrency(project.variance)}
                        </td>
                        <td className="px-4 py-3 text-right text-foreground">{project.completion_pct}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="space-y-6">
              <div className="bg-card border border-border-custom rounded-lg p-5">
                <div className="text-[10px] uppercase tracking-[0.24em] text-muted">Labour Intelligence</div>
                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                  <div className="rounded-lg border border-border-custom bg-elevated p-4">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-muted">Hours Logged</div>
                    <div className="mt-2 text-2xl font-black text-foreground">{data?.labour_productivity.total_hours ?? "—"}</div>
                  </div>
                  <div className="rounded-lg border border-border-custom bg-elevated p-4">
                    <div className="text-[10px] uppercase tracking-[0.2em] text-muted">Labour Days</div>
                    <div className="mt-2 text-2xl font-black text-foreground">{data?.labour_productivity.labour_days ?? "—"}</div>
                  </div>
                </div>
              </div>

              <div className="bg-card border border-border-custom rounded-lg p-5">
                <div className="text-[10px] uppercase tracking-[0.24em] text-muted">Material Leakage</div>
                <div className="mt-4 space-y-3">
                  <div>
                    <div className="flex items-center justify-between text-xs text-muted">
                      <span>Ordered</span>
                      <span>{data?.material_wastage.ordered_qty ?? "—"}</span>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-elevated">
                      <div className="h-2 rounded-full bg-secondary" style={{ width: "100%" }} />
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center justify-between text-xs text-muted">
                      <span>Consumed</span>
                      <span>{data?.material_wastage.consumed_qty ?? "—"}</span>
                    </div>
                    <div className="mt-2 h-2 rounded-full bg-elevated">
                      <div
                        className="h-2 rounded-full bg-success"
                        style={{
                          width: data ? `${Math.min((data.material_wastage.consumed_qty / Math.max(data.material_wastage.ordered_qty, 1)) * 100, 100)}%` : "0%",
                        }}
                      />
                    </div>
                  </div>
                  <div className="text-xs text-muted">
                    Wastage: <span className="font-semibold text-warning">{data?.material_wastage.wastage_pct == null ? "—" : `${data.material_wastage.wastage_pct}%`}</span>
                  </div>
                  {data && data.material_reconciliation.some((row) => row.over_consumed) ? (
                    <div className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-xs font-semibold text-danger">
                      Over-consumed {data.material_reconciliation.filter((row) => row.over_consumed).length} material line(s): consumption exceeds the ordered quantity.
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </section>

          <section className="bg-card border border-border-custom rounded-lg p-5">
            <div className="flex items-end justify-between gap-4">
              <div>
                <div className="text-[10px] uppercase tracking-[0.24em] text-muted">Subcontractor Scorecard</div>
                <div className="mt-1 text-sm text-muted">On-time bill rate and NCR burden by subcontractor</div>
              </div>
            </div>
            <div className="mt-4 overflow-hidden rounded-lg border border-border-custom">
              <table className="w-full text-sm">
                <thead className="bg-elevated text-[10px] uppercase tracking-[0.2em] text-muted">
                  <tr>
                    <th className="px-4 py-3 text-left">Subcontractor</th>
                    <th className="px-4 py-3 text-left">Projects</th>
                    <th className="px-4 py-3 text-right">Bills</th>
                    <th className="px-4 py-3 text-right">On-time</th>
                    <th className="px-4 py-3 text-right">NCRs</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.subcontractor_scorecard ?? []).map((row) => (
                    <tr key={row.subcontractor_id} className="border-t border-border-custom hover:bg-elevated">
                      <td className="px-4 py-3 font-semibold text-foreground">{row.subcontractor_name}</td>
                      <td className="px-4 py-3 text-xs text-muted">
                        {row.project_names.length > 0 ? row.project_names.join(", ") : "No linked projects"}
                      </td>
                      <td className="px-4 py-3 text-right text-muted">{row.bill_count}</td>
                      <td className="px-4 py-3 text-right font-semibold text-success">{row.on_time_rate}%</td>
                      <td className="px-4 py-3 text-right text-danger">{row.ncr_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {loading && (
            <div className="rounded-lg border border-border-custom bg-elevated px-4 py-3 text-sm text-muted">
              Loading analytics...
            </div>
          )}
        </PageShell>
      </main>
    </div>
  );
}