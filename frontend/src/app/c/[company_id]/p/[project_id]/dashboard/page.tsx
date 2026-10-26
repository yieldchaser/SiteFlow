"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getApi, authHeaders, fmtINR, formatDate, formatLabel } from "@/lib/siteflow";
import { useCompanySettings } from "@/context/CompanySettingsContext";
import { usePermissions } from "@/context/PermissionsContext";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import Icon from "@/components/marketing/Icon";

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

type CostCode = {
  id: string;
  code: string;
  name: string;
  sub_cost_code?: string | null;
  budget_amount: number;
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
function Card({ label, value, tone }: { label: string; value: string; tone?: "emerald" | "rose" | "violet" }) {
  const color =
    tone === "emerald" ? "text-success" : tone === "rose" ? "text-danger" : tone === "violet" ? "text-chart-4" : "text-foreground";
  return (
    <div className="rounded-lg border border-border-custom bg-card p-4">
      <div className="text-xs uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-2 text-3xl font-bold ${color}`}>{value}</div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "emerald" | "rose" | "violet";
  onClick: () => void;
}) {
  const color =
    tone === "emerald" ? "text-success" : tone === "rose" ? "text-danger" : tone === "violet" ? "text-chart-4" : "text-foreground";
  return (
    <button
      onClick={onClick}
      className="group text-left rounded-lg border border-border-custom bg-card p-4 hover:border-primary/50 transition-colors"
    >
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-muted">{label}</div>
        <span className="text-[10px] text-muted group-hover:text-primary inline-flex items-center gap-0.5">details <Icon name="chevron_right" className="w-3 h-3" /></span>
      </div>
      <div className={`mt-2 text-2xl font-bold ${color}`}>{value}</div>
      {sub && <div className="mt-1 text-[11px] text-muted">{sub}</div>}
    </button>
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
        className="w-full max-w-2xl max-h-[82vh] overflow-auto rounded-lg border border-border-custom bg-card p-6"
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
            <tbody className="divide-y divide-white/[0.03]">
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
  const [costCodes, setCostCodes] = useState<CostCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrillData | null>(null);

  // Add Cost Code modal state
  const [showAddCC, setShowAddCC] = useState(false);
  const [ccCode, setCcCode] = useState("");
  const [ccName, setCcName] = useState("");
  const [ccBudget, setCcBudget] = useState("");
  const [savingCC, setSavingCC] = useState(false);

  const loadCostCodes = useCallback(async (compId: string) => {
    try {
      const res = await fetch(getApi(`/library/cost-codes/${compId}`), { headers: authHeaders() });
      if (res.ok) setCostCodes(await res.json());
    } catch {
      /* ignore */
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pRes, docRes, billsRes] = await Promise.all([
        fetch(getApi(`/projects/${projectId}`), { headers: authHeaders() }),
        fetch(getApi(`/budgeting/boq-documents?project_id=${projectId}`), { headers: authHeaders() }),
        fetch(getApi(`/billing/bills?project_id=${projectId}`), { headers: authHeaders() }),
      ]);
      const pData = pRes.ok ? await pRes.json() : null;
      if (pData) setProject(pData);
      if (docRes.ok) setDocs(await docRes.json());
      if (billsRes.ok) setBills(await billsRes.json());
      // cost codes are company-scoped → use the resolved company UUID, not the route slug
      await loadCostCodes(pData?.company_id || companyId);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [projectId, companyId, loadCostCodes]);

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
  const estimatedBudget = costCodes.reduce((s, c) => s + (c.budget_amount || 0), 0);

  const sale = bills.filter((b) => REVENUE_INVOICE_TYPES.includes(b.invoice_type));
  const purchase = bills.filter((b) => EXPENSE_INVOICE_TYPES.includes(b.invoice_type));

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

  // Actual expense per cost code (from bill line items tagged with a cost code)
  const expByCC: Record<string, number> = {};
  for (const b of bills) {
    if (!b.items_json) continue;
    try {
      const items = JSON.parse(b.items_json);
      for (const it of items) {
        if (it && it.cost_code_name) {
          expByCC[it.cost_code_name] = (expByCC[it.cost_code_name] || 0) + (Number(it.amount) || 0);
        }
      }
    } catch {
      /* ignore malformed */
    }
  }

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
      await loadCostCodes(companyId);
    } catch (e: any) {
      setError(e?.message || "Failed to add cost code");
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

      {/* Basic snapshot - D1 R2-021: accrual is Billed In/Out, margin is ex-GST */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card label="Progress" value={`${project.progress ?? 0}%`} tone="violet" />
        {seesMoney && (
          <>
            <Card label="Billed In" value={fmtINR(project.cash_in, currencyDecimalPlaces)} tone="emerald" />
            <Card label="Billed Out" value={fmtINR(project.cash_out, currencyDecimalPlaces)} tone="rose" />
            <Card label="Net Margin" value={fmtINR(margin0, currencyDecimalPlaces)} tone={margin0 >= 0 ? "emerald" : "rose"} />
          </>
        )}
      </div>

      {/* Financial View — 6 spec cards */}
      {seesMoney && (
      <div>
        <div className="text-xs uppercase tracking-wider text-muted mb-3">Financial View</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* 1. Estimated Budget */}
          <KpiCard
            label="Estimated Budget"
            value={fmtINR(estimatedBudget, currencyDecimalPlaces)}
            sub={`across ${costCodes.length} cost code${costCodes.length === 1 ? "" : "s"}`}
            tone="violet"
            onClick={() =>
              setDrill({
                title: "Estimate Cost Code Budget",
                subtitle: `Total estimated budget ${fmtINR(estimatedBudget, currencyDecimalPlaces)} across ${costCodes.length} cost codes`,
                cols: [
                  { key: "name", label: "Cost Code Name" },
                  { key: "budget", label: "Budget Amount" },
                  { key: "actual", label: "Actual Expense" },
                ],
                rows: costCodes.map((c) => ({
                  name: c.name,
                  budget: fmtINR(c.budget_amount, currencyDecimalPlaces),
                  actual: fmtINR(expByCC[c.name] || 0, currencyDecimalPlaces),
                })),
                footer: "Actual Expense is summed from bill line items tagged to each cost code.",
                action: { label: "+ Add Cost Code", onClick: () => setShowAddCC(true) },
              })
            }
          />

          {/* 2. Total BOQ Value */}
          <KpiCard
            label="Total BOQ Value"
            value={fmtINR(boqValue, currencyDecimalPlaces)}
            sub={`Estimated Margin: ${fmtINR(estimatedMargin, currencyDecimalPlaces)}`}
            tone="emerald"
            onClick={() =>
              setDrill({
                title: "Total BOQ Value",
                subtitle: `BOQ Value ${fmtINR(boqValue, currencyDecimalPlaces)} − Estimated Budget ${fmtINR(estimatedBudget, currencyDecimalPlaces)} = Estimated Margin ${fmtINR(estimatedMargin, currencyDecimalPlaces)}`,
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
              })
            }
          />

          {/* 3. Total Sales Invoice */}
          <KpiCard
            label="Total Sales Invoice"
            value={fmtINR(saleTotal, currencyDecimalPlaces)}
            sub={`${pct(saleTotal, boqValue)} of BOQ value`}
            tone="emerald"
            onClick={() =>
              setDrill({
                title: "Total Sales Invoice",
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

          {/* 4. Total Expense (Till Date) */}
          <KpiCard
            label="Total Expense (Till Date)"
            value={fmtINR(expense, currencyDecimalPlaces)}
            sub={`${pct(expense, estimatedBudget)} of Budget used`}
            tone="rose"
            onClick={() =>
              setDrill({
                title: "Total Expense (Till Date)",
                subtitle: `${fmtINR(expense, currencyDecimalPlaces)} · ${pct(expense, estimatedBudget)} of Estimated Budget (${fmtINR(estimatedBudget, currencyDecimalPlaces)})`,
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

          {/* 5. Work done value */}
          <KpiCard
            label="Work Done Value"
            value={fmtINR(workDone, currencyDecimalPlaces)}
            sub={`${pct(workDone, boqValue)} of BOQ value`}
            tone="violet"
            onClick={() =>
              setDrill({
                title: "Work Done Value",
                subtitle: `Physical-progress-weighted BOQ value · ${pct(workDone, boqValue)} of Total BOQ Value (${fmtINR(boqValue, currencyDecimalPlaces)})`,
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
              })
            }
          />

          {/* 6. Net Cash Position */}
          <KpiCard
            label="Net Cash Position"
            value={fmtINR(netCash, currencyDecimalPlaces)}
            sub="Project Balance + Receivables − Payables"
            tone={netCash >= 0 ? "emerald" : "rose"}
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
      )}

      {/* Info + Schedule (existing) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card label="Pending To-Dos" value={`${project.todo_pending ?? 0}`} />
        {seesMoney && <Card label="Project Value" value={fmtINR(project.project_value, currencyDecimalPlaces)} />}
        <Card label="Status" value={formatLabel(project.status)} />
      </div>

      <div className="rounded-lg border border-border-custom bg-card p-4 text-sm">
        <div className="text-xs uppercase tracking-wider text-muted mb-3">Schedule</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <div className="text-muted">Planned Start</div>
            <div className="text-foreground">
              {formatDate(project.planned_start_date)}
            </div>
          </div>
          <div>
            <div className="text-muted">Planned End</div>
            <div className="text-foreground">
              {formatDate(project.planned_end_date)}
            </div>
          </div>
          <div>
            <div className="text-muted">Actual Start</div>
            <div className="text-foreground">
              {formatDate(project.actual_start_date)}
            </div>
          </div>
          <div>
            <div className="text-muted">Actual End</div>
            <div className="text-foreground">
              {formatDate(project.actual_end_date)}
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      {drill && <DrillModal data={drill} onClose={() => setDrill(null)} action={drill.action} />}

      {/* Add Cost Code (inside Estimated Budget context) */}
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
