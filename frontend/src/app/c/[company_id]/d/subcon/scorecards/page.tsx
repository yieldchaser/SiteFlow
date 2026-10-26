"use client";
import React, { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { useProject } from "@/context/ProjectContext";
import { getApiHost } from "@/lib/api";
import { authHeaders, formatDate } from "@/lib/siteflow";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableSkeleton } from "@/components/ui/Skeleton";

interface Scorecard {
  id: string;
  subcontractor_id: string;
  subcontractor_name: string;
  period_start: string;
  period_end: string;
  on_time_pct: number;
  billing_accuracy_pct: number;
  quality_score: number;
  tasks_completed: number;
  tasks_delayed: number;
  total_billed: number;
  disputes_count: number;
}

interface ComparativeRow {
  subcontractor_id: string;
  subcontractor_name: string;
  scorecard_count: number;
  avg_on_time_pct: number;
  avg_billing_accuracy_pct: number;
  avg_quality_score: number;
  total_tasks_completed: number;
  total_tasks_delayed: number;
  total_billed: number;
  total_disputes: number;
}

export default function SubconScorecardsPage() {
  const { company_id } = useParams();
  const companyId = company_id || "demo-company";
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;

  const [scorecards, setScorecards] = useState<Scorecard[]>([]);
  const [comparative, setComparative] = useState<ComparativeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Auto-calculate scorecards from real billing + task data for the current month.
      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();
      await fetch(`${getApiHost()}/apis/v3/subcon/scorecards/recompute?project_id=${projectId}&period_start=${encodeURIComponent(periodStart)}&period_end=${encodeURIComponent(periodEnd)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      });
      const [scRes, compRes] = await Promise.all([
        fetch(`${getApiHost()}/apis/v3/subcon/scorecards/${projectId}`, { headers: authHeaders() }),
        fetch(`${getApiHost()}/apis/v3/subcon/scorecards/${projectId}/comparative`, { headers: authHeaders() }),
      ]);
      if (scRes.ok) setScorecards(await scRes.json());
      if (compRes.ok) setComparative(await compRes.json());
    } catch (e) {
      setError("Failed to load scorecard data");
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

  const fmt = (v: number) => v.toFixed(1) + "%";
  const fmtMoney = (v: number) => "₹" + Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 });

  return (
    <div className="flex-1 flex flex-col overflow-hidden font-sans">
      <div className="flex-1 flex flex-col overflow-hidden relative font-sans">
        <PageHeader
          title="Subcontractor Performance"
          subtitle="Performance scorecards · On-time % · Billing accuracy · Quality"
        >
          <button onClick={fetchData} className="px-3.5 py-1.5 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer">Refresh</button>
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
              <TableSkeleton rows={6} cols={8} />
            ) : (
              <div className="space-y-6">
                {/* Comparative Analysis */}
                <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
                  <div className="px-5 py-4 border-b border-border-custom">
                    <h2 className="text-xs font-bold uppercase tracking-wider text-muted">Comparative Analysis</h2>
                  </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className="border-b border-border-custom text-muted">
                    <th className="px-5 py-3 font-bold">Subcontractor</th>
                    <th className="px-5 py-3 font-bold">Periods</th>
                    <th className="px-5 py-3 font-bold text-right">On-Time %</th>
                    <th className="px-5 py-3 font-bold text-right">Billing Accuracy %</th>
                    <th className="px-5 py-3 font-bold text-right">Quality Score</th>
                    <th className="px-5 py-3 font-bold text-right">Tasks Done</th>
                    <th className="px-5 py-3 font-bold text-right">Tasks Delayed</th>
                    <th className="px-5 py-3 font-bold text-right">Total Billed</th>
                    <th className="px-5 py-3 font-bold text-right">Disputes</th>
                  </tr>
                </thead>
                <tbody>
                  {comparative.map((row) => (
                    <tr key={row.subcontractor_id} className="border-b border-border-custom hover:bg-elevated transition-all">
                      <td className="px-5 py-3.5 text-foreground font-semibold">{row.subcontractor_name}</td>
                      <td className="px-5 py-3.5 text-muted">{row.scorecard_count}</td>
                      <td className="px-5 py-3.5 text-right font-sans font-bold text-success">{fmt(row.avg_on_time_pct)}</td>
                      <td className="px-5 py-3.5 text-right font-sans font-bold text-info">{fmt(row.avg_billing_accuracy_pct)}</td>
                      <td className="px-5 py-3.5 text-right font-sans font-bold text-secondary">{fmt(row.avg_quality_score)}</td>
                      <td className="px-5 py-3.5 text-right font-sans">{row.total_tasks_completed}</td>
                      <td className="px-5 py-3.5 text-right font-sans text-danger">{row.total_tasks_delayed}</td>
                      <td className="px-5 py-3.5 text-right font-sans">{fmtMoney(row.total_billed)}</td>
                      <td className="px-5 py-3.5 text-right font-sans text-warning">{row.total_disputes}</td>
                    </tr>
                  ))}
                  {comparative.length === 0 && (
                    <tr>
                      <td colSpan={9} className="p-8">
                        <EmptyState
                          title="No comparative performance data yet"
                          description="Subcontractor performance metrics will calculate automatically from work orders, RA billing, and task milestones."
                        />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Scorecards List */}
          <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-border-custom">
              <h2 className="text-xs font-bold uppercase tracking-wider text-muted">All Scorecards</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className="border-b border-border-custom text-muted">
                    <th className="px-5 py-3 font-bold">Subcontractor</th>
                    <th className="px-5 py-3 font-bold">Period</th>
                    <th className="px-5 py-3 font-bold text-right">On-Time %</th>
                    <th className="px-5 py-3 font-bold text-right">Billing Accuracy %</th>
                    <th className="px-5 py-3 font-bold text-right">Quality</th>
                    <th className="px-5 py-3 font-bold text-right">Billed</th>
                    <th className="px-5 py-3 font-bold text-right">Disputes</th>
                  </tr>
                </thead>
                <tbody>
                  {scorecards.map((sc) => {
                    return (
                      <tr key={sc.id} className="border-b border-border-custom hover:bg-elevated transition-all">
                        <td className="px-5 py-3.5 text-foreground font-semibold">{sc.subcontractor_name}</td>
                        <td className="px-5 py-3.5 text-muted">{formatDate(sc.period_start)} to {formatDate(sc.period_end)}</td>
                        <td className="px-5 py-3.5 text-right font-sans font-bold text-success">{fmt(sc.on_time_pct)}</td>
                        <td className="px-5 py-3.5 text-right font-sans font-bold text-info">{fmt(sc.billing_accuracy_pct)}</td>
                        <td className="px-5 py-3.5 text-right font-sans font-bold text-secondary">{fmt(sc.quality_score)}</td>
                        <td className="px-5 py-3.5 text-right font-sans">{fmtMoney(sc.total_billed)}</td>
                        <td className="px-5 py-3.5 text-right font-sans text-warning">{sc.disputes_count}</td>
                      </tr>
                    );
                  })}
                  {scorecards.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-8">
                        <EmptyState
                          title="No scorecards recorded yet"
                          description="Scorecards evaluate subcontractor performance across quality, schedule adherence, and billing compliance."
                        />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        )}
      </PageShell>
        </div>
      </div>
    </div>
  );
}