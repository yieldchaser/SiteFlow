"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getApi, authHeaders, fmtINR, formatDate, formatLabel } from "@/lib/siteflow";
import { useCompanySettings } from "@/context/CompanySettingsContext";
import { usePermissions } from "@/context/PermissionsContext";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import Icon, { type IconName } from "@/components/marketing/Icon";

// ─── Types ────────────────────────────────────────────────────────────────────
type ProjectDash = {
  id: string;
  company_id: string;
  name: string;
  code?: string | null;
  status: string;
  stage?: string | null;
  category?: string | null;
  // null for roles without the accounts (the server leaves them out).
  project_value: number | null;
  progress: number;
  cash_in: number | null;
  cash_out: number | null;
  todo_pending: number;
  planned_start_date?: string | null;
  planned_end_date?: string | null;
  actual_start_date?: string | null;
  actual_end_date?: string | null;
};

type BOQDoc = {
  id: string;
  title: string;
  boq_value: number;
  physical_progress: number; // 0-100
};

type Bill = {
  id: string;
  invoice_number: string;
  invoice_date: string;
  invoice_type: string;
  status: string;
  subtotal: number;
  total_payable: number;
  paid_amount: number;
  items_json?: string | null;
};

// The project's own budget, as on the Budget page (/budget/committed).
type ProjectBudget = {
  material_budget: number;
  labour_budget: number;
  subcon_budget: number;
  equipment_budget: number;
  material_committed: number;
  labour_committed: number;
  subcon_committed: number;
  equipment_committed: number;
  material_actual: number;
  labour_actual: number;
  subcon_actual: number;
  equipment_actual: number;
  other_actual: number;
  total_budget: number;
  total_actual: number;
};

type DrillCol = { key: string; label: string };
type DrillData = {
  title: string;
  subtitle?: string;
  cols: DrillCol[];
  rows: Record<string, unknown>[];
  footer?: string;
  action?: { label: string; onClick: () => void };
};

const REVENUE_INVOICE_TYPES = ["sale", "material_sale"];
const EXPENSE_INVOICE_TYPES = ["purchase", "subcon", "expense", "equipment"];
const MONEY_IN_VOUCHER_TYPES = ["payment_in", "i_received"];
const MONEY_OUT_VOUCHER_TYPES = ["payment_out", "i_paid"];

// ─── Small components ───────────────────────────────────────────────────────────
type Tone = "good" | "bad" | "neutral";
const TONE_TEXT: Record<Tone, string> = { good: "text-success", bad: "text-danger", neutral: "text-foreground" };

// Short money for chart labels: ₹1.25 Cr, ₹4.6 L, ₹12,400.
function compactINR(n: number): string {
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(1)} L`;
  return `${sign}₹${Math.round(a).toLocaleString("en-IN")}`;
}

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 mb-3">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </div>
  );
}

function ProgressRing({ value, size = 120 }: { value: number; size?: number }) {
  const v = Math.max(0, Math.min(100, value));
  const r = 52;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" className="shrink-0" role="img" aria-label={`${v}% complete`}>
      <circle cx="60" cy="60" r={r} fill="none" stroke="var(--border)" strokeWidth="10" className="opacity-60" />
      <circle
        cx="60"
        cy="60"
        r={r}
        fill="none"
        stroke="var(--primary)"
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={`${(v / 100) * c} ${c}`}
        transform="rotate(-90 60 60)"
      />
      <text x="60" y="58" textAnchor="middle" className="fill-foreground" style={{ fontSize: 22, fontWeight: 700 }}>
        {Number.isInteger(v) ? v : v.toFixed(1)}%
      </text>
      <text x="60" y="76" textAnchor="middle" className="fill-muted" style={{ fontSize: 10, letterSpacing: 1 }}>
        COMPLETE
      </text>
    </svg>
  );
}

function KpiCard({
  label,
  value,
  sub,
  tone = "neutral",
  icon,
  onClick,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  tone?: Tone;
  icon: IconName;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group text-left rounded-xl border border-border-custom bg-card p-5 shadow-sm hover:shadow-md hover:border-primary/40 transition-all cursor-pointer flex flex-col"
    >
      <div className="flex items-center gap-2">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon name={icon} className="w-4 h-4" />
        </span>
        <span className="text-xs font-medium text-muted">{label}</span>
      </div>
      <div className={`mt-3 text-2xl font-bold tracking-tight tabular-nums ${TONE_TEXT[tone]}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
      <span className="mt-auto pt-4 text-xs font-medium text-primary inline-flex items-center gap-1 opacity-80 group-hover:opacity-100">
        View details <Icon name="chevron_right" className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}

type Slice = { label: string; value: number; color: string };

function Donut({ slices, centre, centreSub }: { slices: Slice[]; centre: string; centreSub: string }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const r = 46;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg viewBox="0 0 120 120" className="w-36 h-36 shrink-0" role="img" aria-label={`${centreSub} ${centre}`}>
      <circle cx="60" cy="60" r={r} fill="none" stroke="var(--border)" strokeWidth="14" className="opacity-60" />
      {total > 0 &&
        slices.map((s) => {
          const len = (s.value / total) * c;
          const el = (
            <circle
              key={s.label}
              cx="60"
              cy="60"
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth="14"
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 60 60)"
            />
          );
          offset += len;
          return el;
        })}
      <text x="60" y="60" textAnchor="middle" className="fill-foreground" style={{ fontSize: 13, fontWeight: 700 }}>
        {centre}
      </text>
      <text x="60" y="74" textAnchor="middle" className="fill-muted" style={{ fontSize: 9 }}>
        {centreSub}
      </text>
    </svg>
  );
}

function Meter({ value, max, color = "var(--primary)" }: { value: number; max: number; color?: string }) {
  const w = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="h-2 w-full rounded-full bg-elevated overflow-hidden">
      <div className="h-full rounded-full" style={{ width: `${w}%`, background: color }} />
    </div>
  );
}

function DrillModal({
  data,
  onClose,
  action,
}: {
  data: DrillData;
  onClose: () => void;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[82vh] overflow-auto rounded-xl border border-border-custom bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-lg font-semibold text-foreground">{data.title}</h3>
          <button onClick={onClose} className="text-muted hover:text-foreground cursor-pointer">
            <Icon name="close" className="w-5 h-5" />
          </button>
        </div>
        {data.subtitle && <div className="text-[11px] text-muted mb-4">{data.subtitle}</div>}
        {data.rows.length === 0 ? (
          <div className="py-10 text-center text-muted text-xs">No records.</div>
        ) : (
          <table className="w-full text-xs text-left border-collapse">
            <thead>
              <tr className="border-b border-border-custom text-muted uppercase tracking-wider text-[9px]">
                {data.cols.map((c) => (
                  <th key={c.key} className="py-2 px-2">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-custom">
              {data.rows.map((r, i) => (
                <tr key={i} className="hover:bg-elevated">
                  {data.cols.map((c) => (
                    <td key={c.key} className="py-2 px-2 text-muted">
                      {String(r[c.key] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data.footer && <div className="mt-3 text-[11px] text-muted">{data.footer}</div>}
        {action && (
          <div className="mt-4 flex justify-end">
            <button
              onClick={action.onClick}
              className="px-4 py-2 bg-primary text-white text-sm font-bold rounded-lg hover:opacity-90"
            >
              {action.label}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────
export default function ProjectDashboardPage() {
  const { currencyDecimalPlaces } = useCompanySettings();
  const { can } = usePermissions();
  const params = useParams();
  const companyId = params.company_id as string;
  const projectId = params.project_id as string;

  const [project, setProject] = useState<ProjectDash | null>(null);
  const [docs, setDocs] = useState<BOQDoc[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [budget, setBudget] = useState<ProjectBudget | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrillData | null>(null);
  // Read the clock once per visit, not on every render.
  const [nowMs] = useState(() => Date.now());

  // Add Cost Code modal state
  const [showAddCC, setShowAddCC] = useState(false);
  const [ccCode, setCcCode] = useState("");
  const [ccName, setCcName] = useState("");
  const [ccBudget, setCcBudget] = useState("");
  const [savingCC, setSavingCC] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pRes, docRes, billsRes, budgetRes] = await Promise.all([
        fetch(getApi(`/projects/${projectId}`), { headers: authHeaders() }),
        fetch(getApi(`/budgeting/boq-documents?project_id=${projectId}`), { headers: authHeaders() }),
        fetch(getApi(`/billing/bills?project_id=${projectId}`), { headers: authHeaders() }),
        fetch(getApi(`/budget/committed/${projectId}`), { headers: authHeaders() }),
      ]);
      const pData = pRes.ok ? await pRes.json() : null;
      if (pData) setProject(pData);
      if (docRes.ok) setDocs(await docRes.json());
      if (billsRes.ok) setBills(await billsRes.json());
      if (budgetRes.ok) setBudget(await budgetRes.json());
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <div className="p-6 text-muted">Loading project dashboard…</div>;
  if (!project) return <div className="p-6 text-muted">Project not found.</div>;
  // Site roles open the project but not its money.
  const seesMoney = project.cash_in !== null && project.cash_in !== undefined;
  const addsCostCodes = can("library:edit");

  // ── Real financial computations (per spec) ───────────────────────────────────
  const boqValue = docs.reduce((s, d) => s + (d.boq_value || 0), 0);
  const workDone = docs.reduce((s, d) => s + (d.boq_value || 0) * ((d.physical_progress || 0) / 100), 0);
  // Cost codes belong to the whole company, so the project's budget comes
  // from its own budget, the same figures the Budget page shows.
  const estimatedBudget = budget?.total_budget || 0;
  const budgetSpent = budget?.total_actual || 0;

  // Cancelled bills never count, same as the server's Billed In/Out.
  const sale = bills.filter((b) => REVENUE_INVOICE_TYPES.includes(b.invoice_type) && b.status !== "Cancelled");
  const purchase = bills.filter((b) => EXPENSE_INVOICE_TYPES.includes(b.invoice_type) && b.status !== "Cancelled");

  const saleTotal = sale.reduce((s, b) => s + (b.total_payable || 0), 0);
  const expense = purchase.reduce((s, b) => s + (b.total_payable || 0), 0); // Total Expense (Till Date)

  // D1 R2-021: margin on ex-GST subtotals, not GST-inclusive total_payable.
  // Billed In/Out remain accrual incl GST for display, margin is ex-GST.
  const saleExGst = sale.reduce((s, b) => s + (Number((b as unknown as { subtotal: number }).subtotal) || 0), 0);
  const expenseExGst = purchase.reduce((s, b) => s + (Number((b as unknown as { subtotal: number }).subtotal) || 0), 0);
  const margin0 = saleExGst - expenseExGst;

  const cashIn = bills
    .filter((b) => REVENUE_INVOICE_TYPES.includes(b.invoice_type) || MONEY_IN_VOUCHER_TYPES.includes(b.invoice_type))
    .reduce((s, b) => s + (b.paid_amount || 0), 0);
  const cashOut = bills
    .filter((b) => EXPENSE_INVOICE_TYPES.includes(b.invoice_type) || MONEY_OUT_VOUCHER_TYPES.includes(b.invoice_type))
    .reduce((s, b) => s + (b.paid_amount || 0), 0);
  const receivables = sale
    .filter((b) => b.status !== "Cancelled")
    .reduce((s, b) => s + ((b.total_payable || 0) - (b.paid_amount || 0)), 0);
  const payables = purchase
    .filter((b) => b.status !== "Cancelled")
    .reduce((s, b) => s + ((b.total_payable || 0) - (b.paid_amount || 0)), 0);
  const projectBalance = cashIn - cashOut;
  const netCash = projectBalance + receivables - payables;

  const estimatedMargin = boqValue - estimatedBudget;
  const pct = (num: number, den: number) => (den > 0 ? `${((num / den) * 100).toFixed(1)}%` : "—");

  // ── Add Cost Code ────────────────────────────────────────────────────────────
  const saveCostCode = async (e: React.FormEvent) => {
    e.preventDefault();
    const budget = parseFloat(ccBudget) || 0;
    if (!ccName.trim() || !ccCode.trim()) {
      setError("Code and Name are required");
      return;
    }
    setSavingCC(true);
    setError(null);
    try {
      const res = await fetch(getApi("/library/cost-codes"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id: companyId,
          code: ccCode.trim(),
          name: ccName.trim(),
          budget_amount: budget,
        }),
      });
      if (!res.ok) throw new Error(`Error ${res.status}`);
      setShowAddCC(false);
      setCcCode("");
      setCcName("");
      setCcBudget("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add cost code");
    } finally {
      setSavingCC(false);
    }
  };

  const billRows = (list: Bill[]) =>
    list.map((b) => ({
      "Invoice #": b.invoice_number,
      Date: formatDate(b.invoice_date),
      Type: formatLabel(b.invoice_type),
      Status: formatLabel(b.status),
      Total: fmtINR(b.total_payable, currencyDecimalPlaces),
      Paid: fmtINR(b.paid_amount, currencyDecimalPlaces),
      Balance: fmtINR((b.total_payable || 0) - (b.paid_amount || 0), currencyDecimalPlaces),
    }));

  // ── Schedule: time gone vs work done ────────────────────────────────────────
  const DAY = 86_400_000;
  const startStr = project.actual_start_date || project.planned_start_date;
  const endStr = project.actual_end_date || project.planned_end_date;
  const startMs = startStr ? new Date(startStr).getTime() : NaN;
  const endMs = endStr ? new Date(endStr).getTime() : NaN;
  const hasSchedule = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;

  const elapsedPct = hasSchedule ? Math.max(0, Math.min(100, ((nowMs - startMs) / (endMs - startMs)) * 100)) : 0;
  const daysLeft = hasSchedule ? Math.ceil((endMs - nowMs) / DAY) : 0;
  const progress = project.progress ?? 0;
  const lead = progress - elapsedPct;
  const pace: { text: string; cls: string } = !hasSchedule
    ? { text: "No schedule set", cls: "bg-elevated text-muted" }
    : project.actual_end_date
      ? { text: "Completed", cls: "bg-success/10 text-success" }
      : nowMs < startMs
        ? { text: "Not started", cls: "bg-elevated text-muted" }
        : lead >= -5
          ? { text: lead > 5 ? "Ahead of schedule" : "On track", cls: "bg-success/10 text-success" }
          : lead >= -15
            ? { text: "Slightly behind", cls: "bg-warning/10 text-warning" }
            : { text: "Behind schedule", cls: "bg-danger/10 text-danger" };

  // ── Where the money went (pie) ───────────────────────────────────────────────
  const EXPENSE_SLICES: { type: string; label: string; color: string }[] = [
    { type: "purchase", label: "Materials", color: "var(--chart-1)" },
    { type: "subcon", label: "Subcontractors", color: "var(--chart-6)" },
    { type: "expense", label: "Site expenses", color: "var(--chart-3)" },
    { type: "equipment", label: "Equipment", color: "var(--chart-7)" },
  ];
  const expenseSlices = EXPENSE_SLICES.map((s) => ({
    label: s.label,
    color: s.color,
    value: purchase.filter((b) => b.invoice_type === s.type).reduce((t, b) => t + (b.total_payable || 0), 0),
  }));

  // Budget against actual spend for each budget head.
  const budgetRows = budget
    ? [
        { name: "Materials", budget: budget.material_budget, committed: budget.material_committed, actual: budget.material_actual },
        { name: "Labour", budget: budget.labour_budget, committed: budget.labour_committed, actual: budget.labour_actual },
        { name: "Subcontractors", budget: budget.subcon_budget, committed: budget.subcon_committed, actual: budget.subcon_actual },
        { name: "Equipment", budget: budget.equipment_budget, committed: budget.equipment_committed, actual: budget.equipment_actual },
      ].filter((r) => r.budget > 0 || r.actual > 0)
    : [];
  const rowMax = Math.max(1, ...budgetRows.map((r) => Math.max(r.budget, r.actual)));

  const marginPct = saleExGst > 0 ? (margin0 / saleExGst) * 100 : null;
  const collectedPct = saleTotal > 0 ? (cashIn / saleTotal) * 100 : 0;

  const openBudgetDrill = () =>
    setDrill({
      title: "Project Budget",
      subtitle: `${fmtINR(budgetSpent, currencyDecimalPlaces)} spent of ${fmtINR(estimatedBudget, currencyDecimalPlaces)} · ${pct(budgetSpent, estimatedBudget)} used`,
      cols: [
        { key: "name", label: "Budget head" },
        { key: "budget", label: "Budget" },
        { key: "committed", label: "Committed" },
        { key: "actual", label: "Spent" },
        { key: "left", label: "Left" },
      ],
      rows: [
        ...budgetRows.map((r) => ({
          name: r.name,
          budget: fmtINR(r.budget, currencyDecimalPlaces),
          committed: fmtINR(r.committed, currencyDecimalPlaces),
          actual: fmtINR(r.actual, currencyDecimalPlaces),
          left: fmtINR(r.budget - r.actual, currencyDecimalPlaces),
        })),
        ...(budget && budget.other_actual > 0
          ? [{ name: "Other", budget: "", committed: "", actual: fmtINR(budget.other_actual, currencyDecimalPlaces), left: "" }]
          : []),
      ],
      footer: "Committed is ordered but not yet billed. Spent counts approved bills, finalised payroll, equipment use, fuel and wastage. Change the budget on the Budget page.",
    });

  const openBoqDrill = () =>
    setDrill({
      title: "Total BOQ Value",
      subtitle: `BOQ Value ${fmtINR(boqValue, currencyDecimalPlaces)} − Project Budget ${fmtINR(estimatedBudget, currencyDecimalPlaces)} = Estimated Margin ${fmtINR(estimatedMargin, currencyDecimalPlaces)}`,
      cols: [
        { key: "title", label: "BOQ Document" },
        { key: "value", label: "BOQ Value" },
        { key: "progress", label: "Physical %" },
      ],
      rows: docs.map((d) => ({
        title: d.title,
        value: fmtINR(d.boq_value, currencyDecimalPlaces),
        progress: `${(d.physical_progress || 0).toFixed(1)}%`,
      })),
    });

  const openWorkDoneDrill = () =>
    setDrill({
      title: "Work Done Value",
      subtitle: `BOQ value weighted by physical progress · ${pct(workDone, boqValue)} of Total BOQ Value (${fmtINR(boqValue, currencyDecimalPlaces)})`,
      cols: [
        { key: "title", label: "BOQ Document" },
        { key: "value", label: "BOQ Value" },
        { key: "progress", label: "Physical %" },
        { key: "done", label: "Work Done" },
      ],
      rows: docs.map((d) => ({
        title: d.title,
        value: fmtINR(d.boq_value, currencyDecimalPlaces),
        progress: `${(d.physical_progress || 0).toFixed(1)}%`,
        done: fmtINR((d.boq_value || 0) * ((d.physical_progress || 0) / 100), currencyDecimalPlaces),
      })),
      footer: workDone === 0 && boqValue > 0 ? "Physical progress is not recorded on the BOQ yet. Update it on the BOQ page to see work done." : undefined,
    });

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title={project.name}
        subtitle={[project.code, project.category, project.stage].filter(Boolean).join(" · ") || "Project Overview"}
        action={
          addsCostCodes ? (
            <button
              onClick={() => setShowAddCC(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-primary hover:bg-primary/95 text-white rounded-md text-xs font-semibold transition-all cursor-pointer"
            >
              + Add Cost Code
            </button>
          ) : null
        }
      />
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">

      {/* Hero: progress, schedule pace, status */}
      <div className="rounded-xl border border-border-custom bg-card p-5 sm:p-6 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center gap-6">
          <ProgressRing value={progress} />
          <div className="flex-1 min-w-0 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-primary/10 text-primary px-2.5 py-1 text-xs font-semibold">
                {formatLabel(project.status)}
              </span>
              <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${pace.cls}`}>{pace.text}</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-elevated text-muted px-2.5 py-1 text-xs font-medium">
                <Icon name="task_alt" className="w-3.5 h-3.5" />
                {project.todo_pending ?? 0} pending to-do{(project.todo_pending ?? 0) === 1 ? "" : "s"}
              </span>
            </div>

            {hasSchedule ? (
              <div>
                <div className="relative h-2.5 w-full rounded-full bg-elevated">
                  <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${Math.min(100, progress)}%` }} />
                  <div
                    className="absolute -top-1 h-[18px] w-0.5 rounded bg-foreground/70"
                    style={{ left: `calc(${elapsedPct}% - 1px)` }}
                    title={`Today: ${elapsedPct.toFixed(0)}% of the schedule has passed`}
                  />
                </div>
                <div className="mt-2 flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted">
                  <span>
                    <span className="inline-block h-2 w-2 rounded-full bg-primary mr-1.5 align-middle" />
                    Work done {progress.toFixed(1)}%
                  </span>
                  <span>
                    <span className="inline-block h-2.5 w-0.5 bg-foreground/70 mr-1.5 align-middle" />
                    Time gone {elapsedPct.toFixed(0)}%
                  </span>
                  <span className="font-medium text-foreground">
                    {project.actual_end_date
                      ? `Finished ${formatDate(project.actual_end_date)}`
                      : daysLeft >= 0
                        ? `${daysLeft.toLocaleString("en-IN")} days left`
                        : `${Math.abs(daysLeft).toLocaleString("en-IN")} days past the end date`}
                  </span>
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted">Add planned start and end dates to the project to track pace.</div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-1 text-xs">
              {[
                ["Planned start", project.planned_start_date],
                ["Planned end", project.planned_end_date],
                ["Actual start", project.actual_start_date],
                ["Actual end", project.actual_end_date],
              ].map(([k, v]) => (
                <div key={k as string}>
                  <div className="text-muted">{k}</div>
                  <div className="mt-0.5 font-medium text-foreground">{v ? formatDate(v) : "Not set"}</div>
                </div>
              ))}
            </div>
          </div>
          {seesMoney && (
            <div className="md:border-l md:border-border-custom md:pl-6 shrink-0">
              <div className="text-xs text-muted">Project value</div>
              <div className="mt-1 text-2xl font-bold tracking-tight tabular-nums text-foreground">
                {fmtINR(project.project_value, currencyDecimalPlaces)}
              </div>
              <div className="mt-1 text-xs text-muted">BOQ {compactINR(boqValue)}</div>
            </div>
          )}
        </div>
      </div>

      {seesMoney && (
        <>
          {/* Money at a glance. Billed In/Out are accrual incl GST, margin is ex-GST (D1 R2-021). */}
          <div>
            <SectionTitle title="Money" hint="Billed amounts include GST. Margin is before GST." />
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              <KpiCard
                label="Billed In"
                icon="inbox"
                value={fmtINR(project.cash_in, currencyDecimalPlaces)}
                tone="good"
                sub={`${pct(saleTotal, boqValue)} of BOQ value · ${collectedPct.toFixed(0)}% collected`}
                onClick={() =>
                  setDrill({
                    title: "Billed In (Sales Invoices)",
                    subtitle: `${fmtINR(saleTotal, currencyDecimalPlaces)} · ${pct(saleTotal, boqValue)} of Total BOQ Value (${fmtINR(boqValue, currencyDecimalPlaces)})`,
                    cols: [
                      { key: "Invoice #", label: "Invoice #" },
                      { key: "Date", label: "Date" },
                      { key: "Status", label: "Status" },
                      { key: "Total", label: "Total" },
                      { key: "Paid", label: "Paid" },
                    ],
                    rows: billRows(sale),
                  })
                }
              />
              <KpiCard
                label="Billed Out"
                icon="outbox"
                value={fmtINR(project.cash_out, currencyDecimalPlaces)}
                sub={estimatedBudget > 0 ? `${pct(budgetSpent, estimatedBudget)} of the project budget spent` : "No project budget set yet"}
                onClick={() =>
                  setDrill({
                    title: "Billed Out (Expenses till date)",
                    subtitle: `${fmtINR(expense, currencyDecimalPlaces)} billed by vendors and subcontractors, including GST`,
                    cols: [
                      { key: "Invoice #", label: "Invoice #" },
                      { key: "Date", label: "Date" },
                      { key: "Type", label: "Type" },
                      { key: "Status", label: "Status" },
                      { key: "Total", label: "Total" },
                    ],
                    rows: billRows(purchase),
                  })
                }
              />
              <KpiCard
                label="Net Margin"
                icon={margin0 >= 0 ? "trending_up" : "trending_down"}
                value={fmtINR(margin0, currencyDecimalPlaces)}
                tone={margin0 >= 0 ? "good" : "bad"}
                sub={marginPct === null ? "No sales billed yet" : `${marginPct.toFixed(1)}% of sales, before GST`}
                onClick={() =>
                  setDrill({
                    title: "Net Margin",
                    subtitle: `Sales ${fmtINR(saleExGst, currencyDecimalPlaces)} − Costs ${fmtINR(expenseExGst, currencyDecimalPlaces)}, both before GST`,
                    cols: [
                      { key: "k", label: "Component" },
                      { key: "v", label: "Amount" },
                    ],
                    rows: [
                      { k: "Sales billed (before GST)", v: fmtINR(saleExGst, currencyDecimalPlaces) },
                      { k: "Costs billed (before GST)", v: fmtINR(expenseExGst, currencyDecimalPlaces) },
                      { k: "Net Margin", v: fmtINR(margin0, currencyDecimalPlaces) },
                    ],
                  })
                }
              />
              <KpiCard
                label="Net Cash Position"
                icon="bank"
                value={fmtINR(netCash, currencyDecimalPlaces)}
                tone={netCash >= 0 ? "good" : "bad"}
                sub={`To collect ${compactINR(receivables)} · To pay ${compactINR(payables)}`}
                onClick={() =>
                  setDrill({
                    title: "Net Cash Position",
                    subtitle: `${fmtINR(projectBalance, currencyDecimalPlaces)} (Balance) + ${fmtINR(receivables, currencyDecimalPlaces)} (Receivables) − ${fmtINR(payables, currencyDecimalPlaces)} (Payables) = ${fmtINR(netCash, currencyDecimalPlaces)}`,
                    cols: [
                      { key: "k", label: "Component" },
                      { key: "v", label: "Amount" },
                    ],
                    rows: [
                      { k: "Project Balance (cash in − cash out)", v: fmtINR(projectBalance, currencyDecimalPlaces) },
                      { k: "Receivables (to be collected)", v: fmtINR(receivables, currencyDecimalPlaces) },
                      { k: "Payables (due to vendors)", v: fmtINR(payables, currencyDecimalPlaces) },
                      { k: "Net Cash Position", v: fmtINR(netCash, currencyDecimalPlaces) },
                    ],
                  })
                }
              />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            {/* Where the money went */}
            <div className="lg:col-span-2 rounded-xl border border-border-custom bg-card p-5 shadow-sm">
              <SectionTitle title="Where the money went" hint="Bills till date" />
              {expense > 0 ? (
                <div className="flex flex-col sm:flex-row items-center gap-5">
                  <Donut slices={expenseSlices} centre={compactINR(expense)} centreSub="total spent" />
                  <ul className="flex-1 w-full space-y-2.5">
                    {expenseSlices.map((s) => (
                      <li key={s.label} className="flex items-center gap-2 text-xs">
                        <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
                        <span className="text-foreground">{s.label}</span>
                        <span className="ml-auto tabular-nums text-muted">{compactINR(s.value)}</span>
                        <span className="w-10 text-right tabular-nums font-medium text-foreground">
                          {((s.value / expense) * 100).toFixed(0)}%
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="py-10 text-center text-xs text-muted">No expense bills on this project yet.</div>
              )}
            </div>

            {/* Budget and BOQ */}
            <div className="lg:col-span-3 rounded-xl border border-border-custom bg-card p-5 shadow-sm">
              <SectionTitle title="Budget and BOQ" />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[
                  { k: "Project Budget", v: estimatedBudget > 0 ? fmtINR(estimatedBudget, currencyDecimalPlaces) : "Not set", s: estimatedBudget > 0 ? `${compactINR(estimatedBudget - budgetSpent)} left to spend` : "Set it on the Budget page", on: openBudgetDrill },
                  { k: "Total BOQ Value", v: fmtINR(boqValue, currencyDecimalPlaces), s: estimatedBudget > 0 ? `Estimated margin ${compactINR(estimatedMargin)}` : `${docs.length} BOQ document${docs.length === 1 ? "" : "s"}`, on: openBoqDrill },
                  {
                    k: "Work Done Value",
                    v: workDone > 0 || boqValue === 0 ? fmtINR(workDone, currencyDecimalPlaces) : "Not measured",
                    s: workDone > 0 ? `${pct(workDone, boqValue)} of BOQ value` : "Record physical progress on the BOQ",
                    on: openWorkDoneDrill,
                  },
                ].map((x) => (
                  <button
                    key={x.k}
                    onClick={x.on}
                    className="group text-left rounded-lg bg-elevated/60 hover:bg-elevated p-3 transition-colors cursor-pointer"
                  >
                    <div className="text-xs text-muted">{x.k}</div>
                    <div className="mt-1 text-lg font-bold tracking-tight tabular-nums text-foreground">{x.v}</div>
                    <div className="mt-0.5 text-[11px] text-muted">{x.s}</div>
                    <div className="mt-2 text-[11px] font-medium text-primary inline-flex items-center gap-1 opacity-80 group-hover:opacity-100">
                      View details <Icon name="chevron_right" className="w-3 h-3" />
                    </div>
                  </button>
                ))}
              </div>

              <div className="mt-5">
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="text-muted">Budget used</span>
                  <span className="tabular-nums font-medium text-foreground">
                    {compactINR(budgetSpent)} of {compactINR(estimatedBudget)}
                    {estimatedBudget > 0 && ` · ${pct(budgetSpent, estimatedBudget)}`}
                  </span>
                </div>
                <Meter
                  value={budgetSpent}
                  max={estimatedBudget}
                  color={estimatedBudget > 0 && budgetSpent > estimatedBudget ? "var(--danger)" : "var(--primary)"}
                />
              </div>

              {budgetRows.length > 0 && (
                <div className="mt-5 space-y-3">
                  <div className="flex items-center gap-4 text-[11px] text-muted">
                    <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-primary/25" />Budget</span>
                    <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-primary" />Spent</span>
                  </div>
                  {budgetRows.map((r) => (
                    <div key={r.name}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="truncate text-foreground">{r.name}</span>
                        <span className="tabular-nums text-muted shrink-0 ml-3">
                          {compactINR(r.actual)} / {compactINR(r.budget)}
                        </span>
                      </div>
                      <div className="relative h-2 rounded-full bg-elevated overflow-hidden">
                        <div className="absolute inset-y-0 left-0 rounded-full bg-primary/25" style={{ width: `${(r.budget / rowMax) * 100}%` }} />
                        <div
                          className={`absolute inset-y-0 left-0 rounded-full ${r.actual > r.budget ? "bg-danger" : "bg-primary"}`}
                          style={{ width: `${(r.actual / rowMax) * 100}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Modals */}
      {drill && <DrillModal data={drill} onClose={() => setDrill(null)} action={drill.action} />}

      {/* Add Cost Code */}
      {showAddCC && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-lg border border-border-custom bg-card p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-foreground">Add Cost Code</h3>
              <button onClick={() => setShowAddCC(false)} className="text-muted hover:text-foreground cursor-pointer">
                <Icon name="close" className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={saveCostCode} className="space-y-4">
              <div>
                <label className="text-xs font-medium text-muted">Code</label>
                <input
                  value={ccCode}
                  onChange={(e) => setCcCode(e.target.value)}
                  placeholder="e.g. CC-CIV-01"
                  className="mt-1 w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground placeholder-muted"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted">Name</label>
                <input
                  value={ccName}
                  onChange={(e) => setCcName(e.target.value)}
                  placeholder="e.g. Civil Works"
                  className="mt-1 w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground placeholder-muted"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted">Budget Amount</label>
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={ccBudget}
                  onChange={(e) => setCcBudget(e.target.value)}
                  placeholder="0"
                  className="mt-1 w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground placeholder-muted"
                />
              </div>
              {error && <div className="text-[11px] text-danger">{error}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddCC(false)}
                  className="px-4 py-2 bg-elevated text-muted text-sm rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingCC}
                  className="px-4 py-2 bg-primary text-white text-sm font-bold rounded-lg disabled:opacity-40"
                >
                  {savingCC ? "Saving…" : "Add"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
        </PageShell>
      </div>
    </div>
  );
}
