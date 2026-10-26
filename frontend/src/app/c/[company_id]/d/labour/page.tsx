"use client";
import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useProject } from "@/context/ProjectContext";
import { useParams } from "next/navigation";
import {  getApiHost , readErrorDetail } from "@/lib/api";
import { authHeaders, todayLocalISO, formatDate } from "@/lib/siteflow";
import SegmentedTabs from "@/components/ui/Tabs";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableSkeleton } from "@/components/ui/Skeleton";

interface ReliabilityScore {
  id: string;
  contractor_id: string;
  contractor_name: string;
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

interface BOCWRecord {
  id: string;
  contractor_name: string;
  month_year: string;
  workers_count: number;
  wages_paid: number;
  contribution_amount: number;
  acknowledgement_number: string | null;
  created_at: string;
}

interface MusterRollEntry {
  id: string;
  contractor_id: string | null;
  date: string;
  labor_role: string;
  workers_present: number;
  workers_absent: number;
  hours_worked: number;
  overtime_hours: number;
  notes: string | null;
}

export default function LabourPage() {
  const { company_id } = useParams();
  const companyId = company_id || "demo-company";
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;

  const [activeTab, setActiveTab] = useState<"reliability" | "bocw" | "muster">("reliability");
  const [reliability, setReliability] = useState<ReliabilityScore[]>([]);
  const [bocw, setBocw] = useState<BOCWRecord[]>([]);
  const [muster, setMuster] = useState<MusterRollEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const [showMusterModal, setShowMusterModal] = useState(false);
  const [musterDate, setMusterDate] = useState(todayLocalISO());
  const [musterRole, setMusterRole] = useState("Mason");
  const [musterPresent, setMusterPresent] = useState(20);
  const [musterAbsent, setMusterAbsent] = useState(2);
  const [musterHours, setMusterHours] = useState(8);
  const [musterOT, setMusterOT] = useState(0);
  const [musterNotes, setMusterNotes] = useState("");

  const [showBocwModal, setShowBocwModal] = useState(false);
  const [bocwContractor, setBocwContractor] = useState("");
  const [bocwMonth, setBocwMonth] = useState(todayLocalISO().slice(0, 7));
  const [bocwWorkers, setBocwWorkers] = useState(0);
  const [bocwWages, setBocwWages] = useState(0);
  const [bocwContribution, setBocwContribution] = useState(0);
  const [bocwAck, setBocwAck] = useState("");
  const [savingBocw, setSavingBocw] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [relRes, bocwRes, mRes] = await Promise.all([
        fetch(`${getApiHost()}/apis/v3/labour/reliability/${projectId}`, { headers: authHeaders() }),
        fetch(`${getApiHost()}/apis/v3/labour/bocw/${projectId}`, { headers: authHeaders() }),
        fetch(`${getApiHost()}/apis/v3/labour/muster-roll/${projectId}`, { headers: authHeaders() }),
      ]);
      if (relRes.ok) setReliability(await relRes.json());
      if (bocwRes.ok) setBocw(await bocwRes.json());
      if (mRes.ok) setMuster(await mRes.json());
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  useEffect(() => {
    if (projectId) {
      fetchData();
    } else {
      setLoading(false);
    }
  }, [projectId]);

  const handleMusterSubmit = async () => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/labour/muster-roll`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id: companyId,
          project_id: projectId,
          date: new Date(musterDate).toISOString(),
          labor_role: musterRole,
          workers_present: musterPresent,
          workers_absent: musterAbsent,
          hours_worked: musterHours,
          overtime_hours: musterOT,
          notes: musterNotes || null,
        }),
      });
      if (res.ok) { fetchData(); setShowMusterModal(false); } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (e) { console.error(e); }
  };

  const handleBOCWExport = async () => {
    window.open(`${getApiHost()}/apis/v3/labour/bocw/${projectId}/export`, "_blank");
  };

  const handleBocwSubmit = async () => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/labour/bocw`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id: companyId,
          project_id: projectId,
          contractor_name: bocwContractor,
          month_year: bocwMonth,
          workers_count: bocwWorkers,
          wages_paid: bocwWages,
          contribution_amount: bocwContribution,
          acknowledgement_number: bocwAck || null,
        }),
      });
      if (res.ok) { fetchData(); setShowBocwModal(false); } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (e) { console.error(e); }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden font-sans">
      <div className="px-6 py-2 border-b border-border-custom bg-card shrink-0 overflow-x-auto">
        <SegmentedTabs
          tabs={[
            { id: "reliability", label: "Reliability Scores" },
            { id: "bocw", label: "BOCW Records" },
            { id: "muster", label: "Muster Roll" },
          ]}
          activeTab={activeTab}
          onChange={(t) => setActiveTab(t as any)}
        />
      </div>

      <div className="flex-1 flex flex-col overflow-hidden relative font-sans">
        <PageHeader
          title="Labour Management"
          subtitle="Contractor reliability · BOCW compliance · Muster rolls"
        >
          <div className="flex items-center gap-2">
            {activeTab === "muster" && <button onClick={() => setShowMusterModal(true)} className="px-3.5 py-1.5 rounded-md bg-primary text-xs font-bold text-white hover:opacity-90 cursor-pointer">+ Add Muster</button>}
            {activeTab === "bocw" && <button onClick={() => setShowBocwModal(true)} className="px-3.5 py-1.5 rounded-md bg-primary text-xs font-bold text-white hover:opacity-90 cursor-pointer">+ Add BOCW</button>}
            {activeTab === "bocw" && <button onClick={handleBOCWExport} className="px-3.5 py-1.5 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer">Export CSV</button>}
          </div>
        </PageHeader>

        <div className="flex-1 overflow-y-auto z-10">
          <PageShell width="wide">
            {loading && <TableSkeleton rows={4} cols={5} />}

          {activeTab === "reliability" && (
            <div className="space-y-4">
              {reliability.map((r) => {
                const reliabilityScore = ((r.on_time_pct + r.billing_accuracy_pct + r.quality_score) / 3).toFixed(1);
                const scoreColor = Number(reliabilityScore) >= 80 ? "text-success" : Number(reliabilityScore) >= 60 ? "text-warning" : "text-danger";
                return (
                  <div key={r.id} className="bg-card border border-border-custom rounded-lg p-5 rounded-lg border border-border-custom">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="text-sm font-bold text-foreground">{r.contractor_name}</h3>
                        <p className="text-[10px] text-muted">{formatDate(r.period_start)} – {formatDate(r.period_end)}</p>
                      </div>
                      <div className="text-right">
                        <span className={`text-3xl font-extrabold ${scoreColor}`}>{reliabilityScore}%</span>
                        <p className="text-[10px] text-muted">Reliability</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
                      <div className="bg-elevated rounded-md p-3 text-center">
                        <span className="text-[10px] text-muted block">On-Time</span>
                        <span className="text-sm font-bold text-success">{r.on_time_pct.toFixed(1)}%</span>
                      </div>
                      <div className="bg-elevated rounded-md p-3 text-center">
                        <span className="text-[10px] text-muted block">Billing Accuracy</span>
                        <span className="text-sm font-bold text-info">{r.billing_accuracy_pct.toFixed(1)}%</span>
                      </div>
                      <div className="bg-elevated rounded-md p-3 text-center">
                        <span className="text-[10px] text-muted block">Quality</span>
                        <span className="text-sm font-bold text-secondary">{r.quality_score.toFixed(1)}%</span>
                      </div>
                      <div className="bg-elevated rounded-md p-3 text-center">
                        <span className="text-[10px] text-muted block">Disputes</span>
                        <span className="text-sm font-bold text-warning">{r.disputes_count}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
              {reliability.length === 0 && (
                <EmptyState
                  title="No reliability data yet"
                  description="Scores come from each subcontractor's work orders, bills and disputes. Calculate them on the Scorecards page for the period you want."
                  action={{ label: "Open Scorecards", href: `/c/${companyId}/d/subcon/scorecards` }}
                />
              )}
            </div>
          )}

          {activeTab === "bocw" && (
            <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
              <div className="px-5 py-4 border-b border-border-custom">
                <h2 className="text-xs font-bold uppercase tracking-wider text-muted">BOCW Records</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead><tr className="border-b border-border-custom text-muted"><th className="px-5 py-3 font-bold">Contractor</th><th className="px-5 py-3 font-bold">Month</th><th className="px-5 py-3 font-bold text-right">Workers</th><th className="px-5 py-3 font-bold text-right">Wages Paid</th><th className="px-5 py-3 font-bold text-right">Contribution</th><th className="px-5 py-3 font-bold">Ack. No.</th></tr></thead>
                  <tbody>
                    {bocw.map((r) => (
                      <tr key={r.id} className="border-b border-border-custom hover:bg-elevated transition-all">
                        <td className="px-5 py-3.5 text-foreground font-semibold">{r.contractor_name}</td>
                        <td className="px-5 py-3.5 text-muted">{r.month_year}</td>
                        <td className="px-5 py-3.5 text-right font-sans">{r.workers_count}</td>
                        <td className="px-5 py-3.5 text-right font-sans">₹{r.wages_paid.toLocaleString()}</td>
                        <td className="px-5 py-3.5 text-right font-sans">₹{r.contribution_amount.toLocaleString()}</td>
                        <td className="px-5 py-3.5 text-muted">{r.acknowledgement_number || "—"}</td>
                      </tr>
                    ))}
                    {bocw.length === 0 && (
                      <tr>
                        <td colSpan={6} className="p-8">
                          <EmptyState
                            title="No BOCW records yet"
                            description="Track Building and Other Construction Workers compliance by adding monthly contractor contribution records."
                            action={{
                              label: "+ Add BOCW",
                              onClick: () => setShowBocwModal(true),
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === "muster" && (
            <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
              <div className="px-5 py-4 border-b border-border-custom">
                <h2 className="text-xs font-bold uppercase tracking-wider text-muted">Muster Roll</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead><tr className="border-b border-border-custom text-muted"><th className="px-5 py-3 font-bold">Date</th><th className="px-5 py-3 font-bold">Role</th><th className="px-5 py-3 font-bold text-right">Present</th><th className="px-5 py-3 font-bold text-right">Absent</th><th className="px-5 py-3 font-bold text-right">Hours</th><th className="px-5 py-3 font-bold text-right">OT</th><th className="px-5 py-3 font-bold">Notes</th></tr></thead>
                  <tbody>
                    {muster.map((m) => (
                      <tr key={m.id} className="border-b border-border-custom hover:bg-elevated transition-all">
                        <td className="px-5 py-3.5 text-muted">{m.date}</td>
                        <td className="px-5 py-3.5 text-foreground font-semibold">{m.labor_role}</td>
                        <td className="px-5 py-3.5 text-right font-sans text-success">{m.workers_present}</td>
                        <td className="px-5 py-3.5 text-right font-sans text-danger">{m.workers_absent}</td>
                        <td className="px-5 py-3.5 text-right font-sans">{m.hours_worked}h</td>
                        <td className="px-5 py-3.5 text-right font-sans text-warning">{m.overtime_hours}h</td>
                        <td className="px-5 py-3.5 text-muted">{m.notes || "—"}</td>
                      </tr>
                    ))}
                    {muster.length === 0 && (
                      <tr>
                        <td colSpan={7} className="p-8">
                          <EmptyState
                            title="No muster roll entries yet"
                            description="Log daily labour muster rolls to record shifts, present headcounts, and overtime."
                            action={{
                              label: "+ Add Muster",
                              onClick: () => setShowMusterModal(true),
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          </PageShell>
        </div>
      </div>

      {showMusterModal && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-card border border-border-custom rounded-lg w-full max-w-md border border-border-custom rounded-md p-6 space-y-4">
            <div><h3 className="text-sm font-extrabold text-foreground">Add Muster Roll Entry</h3></div>
            <div className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Date</label>
                  <input type="date" value={musterDate} onChange={(e) => setMusterDate(e.target.value)} className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                </div>
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Labor Role</label>
                  <select value={musterRole} onChange={(e) => setMusterRole(e.target.value)} className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none"><option>Mason</option><option>Helper</option><option>Supervisor</option><option>Steel Fixer</option><option>Electrician</option></select>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Present</label>
                  <input type="number" value={musterPresent} onChange={(e) => setMusterPresent(parseInt(e.target.value) || 0)} className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                </div>
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Absent</label>
                  <input type="number" value={musterAbsent} onChange={(e) => setMusterAbsent(parseInt(e.target.value) || 0)} className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Hours Worked</label>
                  <input type="number" step="0.5" value={musterHours} onChange={(e) => setMusterHours(parseFloat(e.target.value) || 0)} className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                </div>
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Overtime</label>
                  <input type="number" step="0.5" value={musterOT} onChange={(e) => setMusterOT(parseFloat(e.target.value) || 0)} className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                </div>
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Notes</label>
                <textarea value={musterNotes} onChange={(e) => setMusterNotes(e.target.value)} rows={2} className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none" />
              </div>
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <button onClick={() => setShowMusterModal(false)} className="px-4 py-2 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer">Cancel</button>
              <button onClick={handleMusterSubmit} className="bg-primary hover:opacity-90 text-white px-5 py-2 rounded-md text-xs font-bold cursor-pointer">Save</button>
            </div>
          </div>
        </div>
      )}

      {showBocwModal && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-card border border-border-custom rounded-lg w-full max-w-md p-6 space-y-4">
            <div><h3 className="text-sm font-extrabold text-foreground">Add BOCW Record</h3></div>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Contractor Name</label>
                <input type="text" value={bocwContractor} onChange={(e) => setBocwContractor(e.target.value)} placeholder="Contractor name" className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Month</label>
                  <input type="month" value={bocwMonth} onChange={(e) => setBocwMonth(e.target.value)} className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                </div>
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Workers Count</label>
                  <input type="number" min="0" value={bocwWorkers} onChange={(e) => setBocwWorkers(parseInt(e.target.value) || 0)} className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Wages Paid</label>
                  <input type="number" min="0" step="0.01" value={bocwWages} onChange={(e) => setBocwWages(parseFloat(e.target.value) || 0)} className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                </div>
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Contribution (Cess)</label>
                  <input type="number" min="0" step="0.01" value={bocwContribution} onChange={(e) => setBocwContribution(parseFloat(e.target.value) || 0)} className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                </div>
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Acknowledgement No.</label>
                <input type="text" value={bocwAck} onChange={(e) => setBocwAck(e.target.value)} placeholder="Optional" className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none" />
              </div>
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <button onClick={() => setShowBocwModal(false)} className="px-4 py-2 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer">Cancel</button>
              <button onClick={handleBocwSubmit} disabled={savingBocw || !bocwContractor.trim()} className="bg-primary hover:opacity-90 text-white px-5 py-2 rounded-md text-xs font-bold cursor-pointer">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}