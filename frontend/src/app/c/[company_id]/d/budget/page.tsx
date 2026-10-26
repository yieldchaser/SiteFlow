"use client";
import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useProject } from "@/context/ProjectContext";
import { useParams } from "next/navigation";
import { getApiHost } from "@/lib/api";
import { authHeaders } from "@/lib/siteflow";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { PageSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";

interface BudgetCommitted {
  project_id: string;
  material_budget: number;
  labour_budget: number;
  subcon_budget: number;
  equipment_budget: number;
  material_committed: number;
  material_actual: number;
  labour_committed: number;
  labour_actual: number;
  subcon_committed: number;
  subcon_actual: number;
  equipment_committed: number;
  equipment_actual: number;
  total_budget: number;
  total_committed: number;
  total_actual: number;
  total_committed_variance: number;
  total_variance: number;
}

interface TowerBudgetBreakdown {
  tower_id: string | null;
  tower_name: string;
  budget: number;
  committed: number;
  actual: number;
  variance: number;
}

export default function BudgetPage() {
  const { company_id } = useParams();
  const companyId = company_id || "demo-company";
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;

  const [budget, setBudget] = useState<BudgetCommitted | null>(null);
  const [towerBreakdowns, setTowerBreakdowns] = useState<TowerBudgetBreakdown[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showBudgetModal, setShowBudgetModal] = useState(false);
  const [matBudget, setMatBudget] = useState(0);
  const [labBudget, setLabBudget] = useState(0);
  const [subBudget, setSubBudget] = useState(0);
  const [equipBudget, setEquipBudget] = useState(0);
  const [savingBudget, setSavingBudget] = useState(false);
  const [budgetMsg, setBudgetMsg] = useState("");

  const fetchData = async () => {
    setLoading(true);
    try {
      const [budRes, towerRes] = await Promise.all([
        fetch(`${getApiHost()}/apis/v3/budget/committed/${projectId}`, { headers: authHeaders() }),
        fetch(`${getApiHost()}/apis/v3/budget/committed/${projectId}/towers`, { headers: authHeaders() }),
      ]);
      if (budRes.ok) setBudget(await budRes.json());
      if (towerRes.ok) setTowerBreakdowns(await towerRes.json());
    } catch {
      setError("Failed to load budget data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (projectId) {
      fetchData();
    } else {
      setLoading(false);
    }
  }, [projectId]);

  const handleSetBudget = async () => {
    if (!projectId) return;
    setSavingBudget(true);
    setBudgetMsg("");
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/budgeting/allocation`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          project_id: projectId,
          material_budget: Number(matBudget) || 0,
          labour_budget: Number(labBudget) || 0,
          subcon_budget: Number(subBudget) || 0,
          equipment_budget: Number(equipBudget) || 0,
        }),
      });
      if (res.ok) {
        setBudgetMsg("Budget allocated.");
        setShowBudgetModal(false);
        await fetchData();
      } else {
        const data = await res.json().catch(() => ({} as any));
        setBudgetMsg(typeof data.detail === "string" ? data.detail : "Failed to allocate budget.");
      }
    } catch {
      setBudgetMsg("Backend not reachable.");
    } finally {
      setSavingBudget(false);
    }
  };

  const fmt = (v: number) => Number(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const pct = (used: number, total: number) => total > 0 ? ((used / total) * 100).toFixed(1) : "0.0";

  const noBudget = budget ? (budget.total_budget || 0) <= 0 : false;

  return (
    <div className="flex-1 flex flex-col overflow-hidden font-sans">
      

      <div className="flex-1 flex flex-col overflow-hidden relative font-sans">
        <div className="absolute top-[-10%] right-[-10%] h-[50vw] w-[50vw] rounded-full bg-primary opacity-[0.02] blur-[120px] pointer-events-none" />

        <PageHeader
          title="Budget & Committed Costs"
          subtitle="Committed vs Actuals · POs and WOs vs Bills"
        >
          <div className="flex items-center gap-2">
            <button onClick={() => setShowBudgetModal(true)} className="px-3.5 py-1.5 rounded-md bg-primary text-xs font-bold text-white hover:opacity-90 cursor-pointer">+ Set Budget</button>
            <button onClick={fetchData} className="px-3.5 py-1.5 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer">Refresh</button>
          </div>
        </PageHeader>

        <div className="flex-1 overflow-y-auto z-10">
          <PageShell width="wide">
          {error && <div className="p-4 rounded-md bg-danger/10 border border-danger/20 text-xs text-danger">{error}</div>}

          {!projectId ? (
            <EmptyState
              icon="building"
              title="No project selected"
              description='No active projects. Click "+ New Project" to create one.'
              action={{
                label: "New Project",
                href: `/c/${companyId}/projects`,
                icon: "add",
              }}
            />
          ) : loading ? (
            <PageSkeleton />
          ) : budget ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: "Total Budget", value: `₹${fmt(budget.total_budget)}`, color: "text-foreground" },
                  { label: "Total Committed", value: `₹${fmt(budget.total_committed)}`, color: "text-warning" },
                  { label: "Total Actual", value: `₹${fmt(budget.total_actual)}`, color: "text-primary" },
                  { label: "Committed Variance", value: noBudget ? "—" : `₹${fmt(budget.total_committed_variance)}`, color: noBudget ? "text-muted" : (budget.total_committed_variance >= 0 ? "text-success" : "text-danger") },
                ].map((s, idx) => (
                  <div key={idx} className="bg-card border border-border-custom rounded-lg p-4">
                    <span className="text-[10px] font-bold text-muted uppercase tracking-wider block">{s.label}</span>
                    <span className={`text-2xl font-extrabold mt-1 block ${s.color}`}>{s.value}</span>
                  </div>
                ))}
              </div>

              {noBudget && (
                <div className="p-4 rounded-md bg-warning/10 border border-warning/20 text-xs text-warning">
                  No budget has been set for this project: set one to see committed variance and utilization.
                </div>
              )}

              <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
                <div className="px-5 py-4 border-b border-border-custom">
                  <h2 className="text-xs font-bold uppercase tracking-wider text-muted">Committed vs Actuals</h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="border-b border-border-custom text-muted">
                        <th className="px-5 py-3 font-bold">Category</th>
                        <th className="px-5 py-3 font-bold text-right">Budget</th>
                        <th className="px-5 py-3 font-bold text-right">Committed</th>
                        <th className="px-5 py-3 font-bold text-right">Actual Billed</th>
                        <th className="px-5 py-3 font-bold text-right">Committed Var.</th>
                        <th className="px-5 py-3 font-bold text-right">Actual Var.</th>
                        <th className="px-5 py-3 font-bold text-center">Utilization</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        { label: "Material", b: budget.material_budget, c: budget.material_committed, a: budget.material_actual },
                        { label: "Labour", b: budget.labour_budget, c: budget.labour_committed, a: budget.labour_actual },
                        { label: "Subcontractor", b: budget.subcon_budget, c: budget.subcon_committed, a: budget.subcon_actual },
                        { label: "Equipment", b: budget.equipment_budget, c: budget.equipment_committed, a: budget.equipment_actual },
                      ].map((row) => {
                        const noRowBudget = row.b <= 0;
                        return (
                        <tr key={row.label} className="border-b border-border-custom hover:bg-elevated transition-all">
                          <td className="px-5 py-3.5 text-foreground font-semibold">{row.label}</td>
                          <td className="px-5 py-3.5 text-right font-sans text-muted">₹{fmt(row.b)}</td>
                          <td className="px-5 py-3.5 text-right font-sans text-warning">₹{fmt(row.c)}</td>
                          <td className="px-5 py-3.5 text-right font-sans text-primary">₹{fmt(row.a)}</td>
                          <td className="px-5 py-3.5 text-right font-sans text-muted">{noRowBudget ? "—" : `₹${fmt(row.b - row.c)}`}</td>
                          <td className="px-5 py-3.5 text-right font-sans text-muted">{noRowBudget ? "—" : `₹${fmt(row.b - row.a)}`}</td>
                          <td className="px-5 py-3.5 text-center">
                            <div className="flex items-center justify-center gap-2">
                              <div className="w-24 bg-elevated rounded-full h-1.5 overflow-hidden">
                                <div className="h-full bg-primary rounded-full" style={{ width: `${noRowBudget ? 0 : Math.min(Number(pct(row.a, row.b)), 100)}%` }} />
                              </div>
                              <span className="text-[10px] text-muted w-10 text-right">{noRowBudget ? "—" : `${pct(row.a, row.b)}%`}</span>
                            </div>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Tower / Scope Committed Breakdown */}
              {towerBreakdowns.length > 0 && (
                <div className="bg-card border border-border-custom rounded-lg overflow-hidden mt-6">
                  <div className="px-5 py-4 border-b border-border-custom flex items-center justify-between">
                    <div>
                      <h2 className="text-xs font-bold uppercase tracking-wider text-muted">Tower / Phase Committed Breakdown</h2>
                      <p className="text-[11px] text-muted mt-0.5">PO & WO commitments attributed by tower and project scope</p>
                    </div>
                    <span className="text-[10px] text-muted font-bold uppercase">{towerBreakdowns.length} Scope{towerBreakdowns.length > 1 ? "s" : ""}</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs text-left">
                      <thead>
                        <tr className="border-b border-border-custom text-muted">
                          <th className="px-5 py-3 font-bold">Tower / Scope</th>
                          <th className="px-5 py-3 font-bold text-right">Budget</th>
                          <th className="px-5 py-3 font-bold text-right">Committed (POs/WOs)</th>
                          <th className="px-5 py-3 font-bold text-right">Actual Billed</th>
                          <th className="px-5 py-3 font-bold text-right">Committed Var.</th>
                          <th className="px-5 py-3 font-bold text-right">Actual Var.</th>
                          <th className="px-5 py-3 font-bold text-center">Utilization</th>
                        </tr>
                      </thead>
                      <tbody>
                        {towerBreakdowns.map((t, idx) => {
                          const noTowerBudget = (t.budget || 0) <= 0;
                          return (
                            <tr key={t.tower_id || idx} className="border-b border-border-custom hover:bg-elevated transition-all">
                              <td className="px-5 py-3.5 text-foreground font-semibold">
                                {t.tower_name || "Overall Project"}
                              </td>
                              <td className="px-5 py-3.5 text-right font-sans text-muted">₹{fmt(t.budget)}</td>
                              <td className="px-5 py-3.5 text-right font-sans text-warning">₹{fmt(t.committed)}</td>
                              <td className="px-5 py-3.5 text-right font-sans text-primary">₹{fmt(t.actual)}</td>
                              <td className="px-5 py-3.5 text-right font-sans text-muted">{noTowerBudget ? "—" : `₹${fmt(t.budget - t.committed)}`}</td>
                              <td className="px-5 py-3.5 text-right font-sans text-muted">{noTowerBudget ? "—" : `₹${fmt(t.variance)}`}</td>
                              <td className="px-5 py-3.5 text-center">
                                <div className="flex items-center justify-center gap-2">
                                  <div className="w-24 bg-elevated rounded-full h-1.5 overflow-hidden">
                                    <div className="h-full bg-primary rounded-full" style={{ width: `${noTowerBudget ? 0 : Math.min(Number(pct(t.actual, t.budget)), 100)}%` }} />
                                  </div>
                                  <span className="text-[10px] text-muted w-10 text-right">{noTowerBudget ? "—" : `${pct(t.actual, t.budget)}%`}</span>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ) : null}
          </PageShell>
        </div>
      </div>

      {showBudgetModal && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-card border border-border-custom rounded-lg w-full max-w-md p-6 space-y-4">
            <div><h3 className="text-sm font-extrabold text-foreground">Set Project Budget</h3></div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Material</label>
                <input type="number" min="0" value={matBudget} onChange={(e) => setMatBudget(parseFloat(e.target.value) || 0)} className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none" />
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Labour</label>
                <input type="number" min="0" value={labBudget} onChange={(e) => setLabBudget(parseFloat(e.target.value) || 0)} className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none" />
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Subcontractor</label>
                <input type="number" min="0" value={subBudget} onChange={(e) => setSubBudget(parseFloat(e.target.value) || 0)} className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none" />
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Equipment</label>
                <input type="number" min="0" value={equipBudget} onChange={(e) => setEquipBudget(parseFloat(e.target.value) || 0)} className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none" />
              </div>
            </div>
            {budgetMsg && <div className="text-[10px] text-success">{budgetMsg}</div>}
            <div className="flex gap-3 justify-end pt-2">
              <button onClick={() => setShowBudgetModal(false)} className="px-4 py-2 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer">Cancel</button>
              <button onClick={handleSetBudget} disabled={savingBudget} className="bg-primary hover:opacity-90 text-white px-5 py-2 rounded-md text-xs font-bold cursor-pointer">Save Budget</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}