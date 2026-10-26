"use client";
import { getApiHost, readErrorDetail } from "@/lib/api";
import { authHeaders, formatDate, formatLabel } from "@/lib/siteflow";

import React, { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { useProject } from "@/context/ProjectContext";
import { useCompanySettings } from "@/context/CompanySettingsContext";
import Icon, { type IconName } from "@/components/marketing/Icon";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import FieldHint from "@/components/ui/FieldHint";

interface Task {
  id: string;
  name: string;
  status: string;
  priority: string;
}

interface MaterialOption {
  id: string;
  name: string;
  unit?: string;
}

interface InventoryItem {
  id: string;
  material_name: string;
  on_hand_qty: number;
  reserved_qty: number;
  unit: string;
}

interface ConsumedMaterialItem {
  material_name: string;
  quantity: string;
  unit: string;
}

interface DPRSummary {
  activities_tracked: number;
  total_workers_deployed: number;
  avg_completion: number;
  issues_flagged: number;
  // R2-444: today's material movement from the stock ledger, so the tiles
  // answer from the same source as the DPR feed rendered below them.
  material_received_today?: number;
  material_used_today?: number;
}

interface DPRLog {
  id: string;
  dpr_date: string;
  reported_by: string;
  weather: string;
  executed_qty: number;
  workers_deployed: number;
  task_id?: string | null;
  materials_consumed?: { material_name: string; quantity: number; unit: string }[];
  notes: string;
  issues: string;
}

const PHOTO_SLOTS: { label: string; icon: IconName; color: string }[] = [
  { label: "Site Progress", icon: "site", color: "bg-primary/15" },
  { label: "Material Delivery", icon: "truck", color: "bg-info/15" },
  { label: "Quality Check", icon: "check_circle", color: "bg-success/15" },
  { label: "Safety Observation", icon: "warning", color: "bg-warning/15" },
];

export default function DPRPage() {
  const params = useParams();
  const companyId = params?.company_id as string;
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;
  const { quantityDecimalPlaces } = useCompanySettings();

  const fmtQty = (val: number | string | null | undefined) => {
    const num = Number(val) || 0;
    return new Intl.NumberFormat("en-IN", {
      maximumFractionDigits: quantityDecimalPlaces,
    }).format(num);
  };

  const [tasks, setTasks] = useState<Task[]>([]);
  const [materials, setMaterials] = useState<MaterialOption[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [summary, setSummary] = useState<DPRSummary>({
    activities_tracked: 0,
    total_workers_deployed: 0,
    avg_completion: 0,
    issues_flagged: 0,
    material_received_today: 0,
    material_used_today: 0
  });
  const [logs, setLogs] = useState<DPRLog[]>([]);
  // The feed shows its empty state only once the list has actually come back;
  // a cold API can take most of a minute and "no reports" would be untrue.
  const [logsLoaded, setLogsLoaded] = useState(false);

  // Modal open states
  const [isCreateDPROpen, setIsCreateDPROpen] = useState(false);
  const [showMBModal, setShowMBModal] = useState(false);

  // Form states
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [executedQty, setExecutedQty] = useState("");
  const [workersDeployed, setWorkersDeployed] = useState("");
  const [weather, setWeather] = useState("Clear");
  const [notes, setNotes] = useState("");
  const [issues, setIssues] = useState("");
  // Seeded from the signed-in user purely so the read-only field shows who the
  // backend will record as the author.
  const [reportedBy, setReportedBy] = useState(
    typeof window !== "undefined" ? localStorage.getItem("user_name") || "Signed-in user" : "Signed-in user"
  );
  const [materialsConsumed, setMaterialsConsumed] = useState<ConsumedMaterialItem[]>([]);
  
  // Measurement Book (M.B.) takeoff items state
  const [mbRows, setMbRows] = useState<any[]>([
    { description: "", nos: 1, l: 0, w: 0, h: 0 },
  ]);

  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  const fetchTasks = async () => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/planning/tasks?project_id=${projectId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setTasks(data);
        if (data.length > 0) {
          setSelectedTaskId(data[0].id);
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchMaterialsAndInventory = async () => {
    if (!projectId || !companyId) return;
    try {
      const [matRes, invRes] = await Promise.all([
        fetch(`${getApiHost()}/apis/v3/library/materials?company_id=${companyId}`, { headers: authHeaders() }),
        fetch(`${getApiHost()}/apis/v3/procurement/inventory?project_id=${projectId}`, { headers: authHeaders() }),
      ]);
      if (matRes.ok) {
        const matData = await matRes.json();
        setMaterials(Array.isArray(matData) ? matData : []);
      }
      if (invRes.ok) {
        const invData = await invRes.json();
        setInventory(Array.isArray(invData) ? invData : []);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchDPRSummary = async () => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/dpr/summary?project_id=${projectId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setSummary(data);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchDPRLogs = async () => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/dpr?project_id=${projectId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setLogs(data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLogsLoaded(true);
    }
  };

  useEffect(() => {
    if (projectId) {
      setLogsLoaded(false);
      fetchTasks();
      fetchDPRSummary();
      fetchDPRLogs();
      fetchMaterialsAndInventory();
    }
  }, [projectId, companyId]);

  const handleSubmitDPR = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setMessage("");

    const formattedMaterials = materialsConsumed
      .filter(m => m.material_name.trim() && parseFloat(m.quantity) > 0)
      .map(m => ({
        material_name: m.material_name.trim(),
        quantity: parseFloat(m.quantity),
        unit: m.unit || "unit",
      }));

    try {
      const res = await fetch(`${getApiHost()}/apis/v3/dpr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          project_id: projectId,
          task_id: selectedTaskId && /^[0-9a-fA-F-]{36}$/.test(selectedTaskId) ? selectedTaskId : null,
          reported_by: reportedBy || "—",
          dpr_date: new Date().toISOString(),
          executed_qty: parseFloat(executedQty) || 0.0,
          workers_deployed: parseInt(workersDeployed) || 0,
          weather: weather,
          notes: notes,
          issues: issues,
          materials_consumed: formattedMaterials,
        })
      });

      if (res.ok) {
        setMessage("DPR submitted successfully!");
        setExecutedQty("");
        setWorkersDeployed("");
        setMaterialsConsumed([]);
        setNotes("");
        setIssues("");
        setIsCreateDPROpen(false);
        fetchDPRSummary();
        fetchDPRLogs();
        fetchMaterialsAndInventory();
      } else {
        const detail = await readErrorDetail(res);
        setMessage(detail || "Failed to submit DPR.");
      }
    } catch (err: any) {
      setMessage(err?.message || "Server connection failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Main Container */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <PageHeader
          title="Project Daily Progress Report (DPR)"
          subtitle="SiteFlow daily feed"
        >
          <button
            onClick={() => setIsCreateDPROpen(true)}
            className="px-3.5 py-1.5 bg-primary rounded-md text-xs font-bold text-white hover:opacity-90 transition-all cursor-pointer"
          >
            + Create DPR
          </button>
        </PageHeader>

        {/* Content */}
        <div className="flex-1 overflow-y-auto relative">
          <PageShell width="wide">
          
          {/* Dashboard Quick Stats Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: "Workers on Latest DPR", value: logs.length > 0 ? fmtQty(logs[0].workers_deployed) : "—", desc: logs.length > 0 ? `As reported on ${formatDate(logs[0].dpr_date)}` : "No DPR yet", color: "border-primary/20 bg-primary/5 text-primary" },
              { label: "DPRs Logged", value: summary.activities_tracked || 0, desc: `${summary.issues_flagged || 0} with an issue flagged`, color: "border-secondary/20 bg-secondary/5 text-secondary" },
              { label: "Material Received Today", value: (summary.material_received_today || 0) > 0 ? `${fmtQty(summary.material_received_today)} Units` : "No GRNs today", desc: "Material inward logged", color: "border-warning/20 bg-warning/5 text-warning" },
              { label: "Material Used Today", value: (summary.material_used_today || 0) > 0 ? `${fmtQty(summary.material_used_today)} Units` : "No consumption logged", desc: "On-site consumption", color: "border-primary/20 bg-primary/5 text-primary" }
            ].map((card, idx) => (
              <div key={idx} className={`p-4 rounded-lg border ${card.color} flex flex-col justify-between h-28`}>
                <span className="text-[10px] uppercase font-bold tracking-wider opacity-70">{card.label}</span>
                <div>
                  <h3 className="text-lg font-extrabold mt-1">{card.value}</h3>
                  <p className="text-[9px] opacity-60 mt-0.5">{card.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* DPR Log Timeline Feed */}
          <div className="bg-card border border-border-custom rounded-lg p-6 space-y-4">
            <h3 className="text-xs font-bold text-muted uppercase tracking-wider">Chronological DPR Activity Feed</h3>
            <div className="space-y-4">
              {!logsLoaded && projectId ? (
                <div className="space-y-3">
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-20 w-full" />
                </div>
              ) : logs.length === 0 ? (
                <EmptyState
                  icon="task_alt"
                  title="No daily progress logs reported"
                  description="Submit daily progress reports with executed quantities, weather, and labor deployment."
                  action={{
                    label: "Create DPR",
                    onClick: () => setIsCreateDPROpen(true),
                    icon: "add",
                  }}
                />
              ) : (
                logs.map((log) => (
                  <div key={log.id} className="p-4 rounded-md border border-border-custom bg-input space-y-2 text-xs">
                    <div className="flex justify-between items-center text-[10px] text-muted">
                      <span className="font-bold text-foreground">Reported By: {log.reported_by}</span>
                      <span>Weather: <strong className="text-muted">{log.weather}</strong> · {formatDate(log.dpr_date)}</span>
                    </div>
                    <div className="border-l-2 border-border-custom pl-3 my-2 space-y-1">
                      {log.task_id && tasks.find((t) => t.id === log.task_id) && (
                        <p className="text-foreground text-xs font-bold">{tasks.find((t) => t.id === log.task_id)?.name}</p>
                      )}
                      <p className="text-foreground text-xs font-semibold">
                        Qty Executed: {fmtQty(log.executed_qty)} · Workers: {fmtQty(log.workers_deployed)}
                      </p>
                      {log.materials_consumed && log.materials_consumed.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {log.materials_consumed.map((m, mi) => (
                            <span key={mi} className="px-2 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 text-[10px] font-bold">
                              {fmtQty(m.quantity)} {m.unit} {m.material_name}
                            </span>
                          ))}
                        </div>
                      )}
                      {log.notes && <p className="text-muted mt-1">{log.notes}</p>}
                    </div>
                    {log.issues && (
                      <div className="p-2 rounded bg-warning/10 border border-warning/20 text-warning text-[10px] inline-flex items-center gap-1">
                        <Icon name="warning" className="w-3 h-3 shrink-0" /> <strong>Issue Flagged:</strong> {log.issues}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
          </PageShell>
        </div>
      </main>

      {/* Create DPR Modal Drawer */}
      {isCreateDPROpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-background border border-border-custom rounded-lg w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-6 py-4 border-b border-border-custom flex items-center justify-between">
              <div>
                <h3 className="text-sm font-extrabold text-foreground">Create Daily Progress Report (DPR)</h3>
                <p className="text-[10px] text-muted">Log task physical status, workers, and material consumption</p>
              </div>
              <button onClick={() => { setIsCreateDPROpen(false); setMessage(""); }} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>

            <form onSubmit={handleSubmitDPR} className="p-6 overflow-y-auto space-y-4 text-xs">
              {message && (
                <div className={`p-3 rounded-lg text-xs font-semibold ${message.includes("success") ? "bg-success/10 text-success border border-success/20" : "bg-danger/10 text-danger border border-danger/20"}`}>
                  {message}
                </div>
              )}

              <div className="space-y-1">
                <label className="text-muted">Select WBS Task</label>
                <select
                  value={selectedTaskId}
                  onChange={(e) => setSelectedTaskId(e.target.value)}
                  className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground"
                >
                  {/* A select with zero options renders as an empty box and the
                      user cannot tell whether it is loading, broken or empty. */}
                  <option value="">{tasks.length ? "Select a task (optional)" : "No tasks planned on this project yet"}</option>
                  {tasks.map(t => (
                    <option key={t.id} value={t.id}>{t.name} ({formatLabel(t.status)})</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-muted">Reported By</label>
                {/* Not editable by design. The DPR is the primary contemporaneous
                    site record, so the backend stamps the authenticated user as
                    the author (R2-408) and ignores anything sent here. This used
                    to be a free-text box whose contents were silently discarded. */}
                <input
                  type="text"
                  value={reportedBy}
                  readOnly
                  title="Recorded automatically as the signed-in user"
                  className="w-full bg-elevated border border-border-custom rounded-lg p-2 text-muted cursor-not-allowed"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <div className="flex justify-between items-center">
                    <label className="text-muted">Executed Qty</label>
                    <button
                      type="button"
                      onClick={() => setShowMBModal(true)}
                      className="text-[10px] font-bold text-primary hover:underline cursor-pointer inline-flex items-center gap-1"
                    >
                      <Icon name="ruler" className="w-3 h-3" /> Open M.B. Sheet
                    </button>
                  </div>
                  <input type="number" step="0.01" value={executedQty} onChange={(e) => setExecutedQty(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" placeholder="e.g. 45" />
                </div>
                <div className="space-y-1">
                  <label className="text-muted">Workers Deployed</label>
                  <input type="number" value={workersDeployed} onChange={(e) => setWorkersDeployed(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" placeholder="e.g. 15" />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-muted">Weather Condition</label>
                <select value={weather} onChange={(e) => setWeather(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground">
                  <option value="Clear">Clear</option>
                  <option value="Rainy">Rainy</option>
                  <option value="Overcast">Overcast</option>
                </select>
              </div>

              {/* Materials Consumed Section */}
              <div className="space-y-2 pt-2 border-t border-border-custom">
                <div className="flex justify-between items-center">
                  <div>
                    <label className="text-muted font-bold block text-[11px]">Material Consumed Today</label>
                    <p className="text-[10px] text-muted">Decrements warehouse stock and releases indent reservations</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setMaterialsConsumed([...materialsConsumed, { material_name: "", quantity: "", unit: "" }])}
                    className="px-2 py-1 bg-primary/10 hover:bg-primary/20 text-primary font-bold rounded text-[10px] inline-flex items-center gap-1 transition-all cursor-pointer"
                  >
                    <Icon name="add" className="w-3 h-3" /> + Add Material
                  </button>
                </div>

                {materials.length === 0 && inventory.length === 0 && (
                  <FieldHint text="No materials yet. Add one in Library." href={`/c/${companyId}/d/library`} linkLabel="Go to Library" />
                )}

                {materialsConsumed.length > 0 && (
                  <div className="space-y-2">
                    {materialsConsumed.map((matRow, idx) => {
                      const invItem = inventory.find(inv => inv.material_name.toLowerCase() === matRow.material_name.toLowerCase());
                      const avail = invItem ? invItem.on_hand_qty - invItem.reserved_qty : null;
                      return (
                        <div key={idx} className="p-2.5 bg-input border border-border-custom rounded-md space-y-1.5 relative">
                          <button
                            type="button"
                            onClick={() => setMaterialsConsumed(materialsConsumed.filter((_, i) => i !== idx))}
                            className="absolute top-2 right-2 text-muted hover:text-danger cursor-pointer"
                            title="Remove row"
                          >
                            <Icon name="close" className="w-3.5 h-3.5" />
                          </button>

                          <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center pr-6">
                            <div className="sm:col-span-6">
                              <label className="text-[9px] text-muted block mb-0.5">Material*</label>
                              <select
                                value={matRow.material_name}
                                onChange={(e) => {
                                  const selectedName = e.target.value;
                                  const next = [...materialsConsumed];
                                  const foundLib = materials.find(m => m.name === selectedName);
                                  const foundInv = inventory.find(i => i.material_name === selectedName);
                                  next[idx].material_name = selectedName;
                                  next[idx].unit = foundLib?.unit || foundInv?.unit || (selectedName.toLowerCase().includes("cement") ? "bags" : selectedName.toLowerCase().includes("steel") ? "tons" : "units");
                                  setMaterialsConsumed(next);
                                }}
                                className="w-full bg-background border border-border-custom rounded px-2 py-1 text-foreground text-xs"
                              >
                                <option value="">Select Material...</option>
                                {materials.map(m => (
                                  <option key={m.id} value={m.name}>{m.name}</option>
                                ))}
                                {inventory
                                  .filter(inv => !materials.some(m => m.name.toLowerCase() === inv.material_name.toLowerCase()))
                                  .map(inv => (
                                    <option key={inv.id} value={inv.material_name}>{inv.material_name}</option>
                                  ))}
                              </select>
                            </div>

                            <div className="sm:col-span-3">
                              <label className="text-[9px] text-muted block mb-0.5">Qty Consumed*</label>
                              <input
                                type="number"
                                step="any"
                                min="0.01"
                                placeholder="0.0"
                                value={matRow.quantity}
                                onChange={(e) => {
                                  const next = [...materialsConsumed];
                                  next[idx].quantity = e.target.value;
                                  setMaterialsConsumed(next);
                                }}
                                className="w-full bg-background border border-border-custom rounded px-2 py-1 text-foreground text-xs"
                              />
                            </div>

                            <div className="sm:col-span-3">
                              <label className="text-[9px] text-muted block mb-0.5">Unit</label>
                              <input
                                type="text"
                                placeholder="e.g. bags"
                                value={matRow.unit}
                                onChange={(e) => {
                                  const next = [...materialsConsumed];
                                  next[idx].unit = e.target.value;
                                  setMaterialsConsumed(next);
                                }}
                                className="w-full bg-background border border-border-custom rounded px-2 py-1 text-foreground text-xs"
                              />
                            </div>
                          </div>

                          {matRow.material_name && (
                            <div className="text-[10px] text-muted flex items-center gap-2 pt-0.5">
                              <span>
                                Available Stock:{" "}
                                <strong className={avail !== null && avail <= 0 ? "text-danger" : "text-success"}>
                                  {avail !== null ? `${fmtQty(avail)} ${invItem?.unit || matRow.unit}` : "0 (No stock recorded)"}
                                </strong>
                              </span>
                              {invItem && (
                                <span className="text-[9px] opacity-75">
                                  (On-hand: {fmtQty(invItem.on_hand_qty)}, Reserved: {fmtQty(invItem.reserved_qty)})
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <label className="text-muted">General Notes</label>
                <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground resize-none" placeholder="Cast grid concrete..." />
              </div>

              <div className="space-y-1">
                <label className="text-muted">Site Issues / Blockers</label>
                <input type="text" value={issues} onChange={(e) => setIssues(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" placeholder="Water logging, shortage of steel..." />
              </div>

              {/* Photo uploading slots simulator */}
              <div className="space-y-2 pt-2 border-t border-border-custom">
                <span className="text-muted font-bold block">Attach Progress Records</span>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-center text-[10px]">
                  {PHOTO_SLOTS.map((slot, i) => (
                    <div key={i} className={`p-2.5 rounded-md border border-border-custom ${slot.color} flex flex-col items-center justify-center cursor-pointer hover:border-border-custom`}>
                      <Icon name={slot.icon} className="w-5 h-5" />
                      <span className="mt-1 text-muted font-bold">{slot.label}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-2 justify-end border-t border-border-custom pt-4">
                <button type="button" onClick={() => setIsCreateDPROpen(false)} className="px-4 py-2 bg-elevated text-muted hover:text-foreground rounded-md">Cancel</button>
                <button type="submit" disabled={submitting} className="px-5 py-2.5 bg-primary text-white font-bold rounded-md hover:opacity-90">
                  {submitting ? "Saving..." : "Submit Log"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Measurement Book (M.B.) Takeoff Sheet Modal */}
      {showMBModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-background border border-border-custom rounded-lg w-full max-w-3xl shadow-2xl overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-border-custom flex items-center justify-between">
              <div>
                <h3 className="text-sm font-extrabold text-foreground inline-flex items-center gap-2">
                  <Icon name="ruler" className="w-5 h-5" /> Measurement Book (M.B.) Takeoff Sheet
                </h3>
                <p className="text-[10px] text-muted">Calculate quantities by structural dimensions (N × L × W × H)</p>
              </div>
              <button onClick={() => setShowMBModal(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>

            <div className="p-6 overflow-y-auto space-y-4 max-h-[60vh]">
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className="border-b border-border-custom text-muted bg-elevated">
                    <th className="px-4 py-2 font-semibold">Description</th>
                    <th className="px-4 py-2 font-semibold">No. (Multiplier)</th>
                    <th className="px-4 py-2 font-semibold">Length (m)</th>
                    <th className="px-4 py-2 font-semibold">Width (m)</th>
                    <th className="px-4 py-2 font-semibold">Height / Depth (m)</th>
                    <th className="px-4 py-2 font-semibold text-right">Quantity (m³)</th>
                    <th className="px-4 py-2 font-semibold text-center">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {mbRows.map((row, idx) => {
                    const rowQty = row.nos * row.l * row.w * row.h;
                    return (
                      <tr key={idx} className="border-b border-white/[0.02] hover:bg-elevated">
                        <td className="px-4 py-2">
                          <input
                            type="text"
                            value={row.description}
                            onChange={(e) => {
                              const next = [...mbRows];
                              next[idx].description = e.target.value;
                              setMbRows(next);
                            }}
                            placeholder="e.g. Column C1"
                            className="bg-input border border-border-custom rounded px-2 py-1 text-foreground w-full"
                          />
                        </td>
                        <td className="px-4 py-2">
                          <input
                            type="number"
                            value={row.nos}
                            onChange={(e) => {
                              const next = [...mbRows];
                              next[idx].nos = parseFloat(e.target.value) || 0;
                              setMbRows(next);
                            }}
                            className="bg-input border border-border-custom rounded px-2 py-1 text-foreground w-16"
                          />
                        </td>
                        <td className="px-4 py-2">
                          <input
                            type="number"
                            value={row.l}
                            onChange={(e) => {
                              const next = [...mbRows];
                              next[idx].l = parseFloat(e.target.value) || 0;
                              setMbRows(next);
                            }}
                            className="bg-input border border-border-custom rounded px-2 py-1 text-foreground w-16"
                          />
                        </td>
                        <td className="px-4 py-2">
                          <input
                            type="number"
                            value={row.w}
                            onChange={(e) => {
                              const next = [...mbRows];
                              next[idx].w = parseFloat(e.target.value) || 0;
                              setMbRows(next);
                            }}
                            className="bg-input border border-border-custom rounded px-2 py-1 text-foreground w-16"
                          />
                        </td>
                        <td className="px-4 py-2">
                          <input
                            type="number"
                            value={row.h}
                            onChange={(e) => {
                              const next = [...mbRows];
                              next[idx].h = parseFloat(e.target.value) || 0;
                              setMbRows(next);
                            }}
                            className="bg-input border border-border-custom rounded px-2 py-1 text-foreground w-16"
                          />
                        </td>
                        <td className="px-4 py-2 text-right font-sans text-muted">
                          {fmtQty(rowQty)}
                        </td>
                        <td className="px-4 py-2 text-center">
                          <button
                            type="button"
                            onClick={() => {
                              setMbRows(mbRows.filter((_, i) => i !== idx));
                            }}
                            className="text-danger hover:text-danger font-bold cursor-pointer"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <div className="flex justify-between items-center pt-2">
                <button
                  type="button"
                  onClick={() => setMbRows([...mbRows, { description: "", nos: 1, l: 0, w: 0, h: 0 }])}
                  className="px-3 py-1.5 bg-elevated hover:bg-elevated rounded-lg text-white font-bold cursor-pointer"
                >
                  + Add Dimension Row
                </button>
                <div className="text-right text-xs">
                  <span className="text-muted block uppercase text-[9px] tracking-wider">Total Takeoff Sum</span>
                  <strong className="text-lg font-black text-success font-sans">
                    {fmtQty(mbRows.reduce((acc, r) => acc + (r.nos * r.l * r.w * r.h), 0))} m³
                  </strong>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-border-custom bg-background flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowMBModal(false)}
                className="px-4 py-2 bg-elevated text-muted hover:text-foreground rounded-md cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const total = mbRows.reduce((acc, r) => acc + (r.nos * r.l * r.w * r.h), 0);
                  setExecutedQty(total.toFixed(3));
                  setShowMBModal(false);
                }}
                className="px-5 py-2.5 bg-primary text-white font-bold rounded-md hover:opacity-90 cursor-pointer inline-flex items-center gap-1.5"
              >
                Apply to Executed Qty
                <Icon name="check" className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}