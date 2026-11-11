"use client";
import { getApiHost, readErrorDetail } from "@/lib/api";
import UnitInput from "@/components/UnitInput";
import { authHeaders, formatDate, formatLabel, todayLocalISO } from "@/lib/siteflow";

import React, { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { useProject } from "@/context/ProjectContext";
import { useCompanySettings } from "@/context/CompanySettingsContext";
import Icon, { type IconName } from "@/components/marketing/Icon";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import AuthImage, { uploadProjectImage } from "@/components/ui/AuthImage";

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
  // How many different materials moved today (quantities of different units
  // cannot be added up).
  materials_received_today?: number;
  materials_used_today?: number;
}

interface DPRLog {
  id: string;
  dpr_date: string;
  reported_by: string;
  weather: string;
  executed_qty: number;
  workers_deployed: number;
  task_id?: string | null;
  task_unit?: string | null;
  task_name?: string | null;
  project_id?: string;
  materials_consumed?: { material_name: string; quantity: number; unit: string }[];
  notes: string;
  issues: string;
  photos?: string[];
}

// A DPR photo is stored as its file path with the record type after "#", e.g.
// "/apis/v3/files/file/<id>#Quality Check". The fragment never reaches the server.
const photoLabel = (path: string) => decodeURIComponent(path.split("#")[1] || "");

// Measurement-book line: a dimension left at 0 is not measured, so the same
// sheet gives running metres (L), area (L x W) or volume (L x W x H).
type MbRow = { description: string; nos: number; l: number; w: number; h: number };
const mbDims = (r: MbRow) => [r.l, r.w, r.h].filter((v) => v > 0);
const mbQty = (r: MbRow) => {
  const dims = mbDims(r);
  return dims.length ? dims.reduce((acc, v) => acc * v, r.nos) : 0;
};
const MB_UNITS = ["", "m", "m²", "m³"];
const mbTotalUnit = (rows: MbRow[]) => {
  const units = new Set(rows.filter((r) => mbQty(r) > 0).map((r) => mbDims(r).length));
  return units.size === 1 ? MB_UNITS[[...units][0]] : "";
};

const PHOTO_SLOTS: { label: string; icon: IconName; color: string }[] = [
  { label: "Site Progress", icon: "site", color: "bg-primary/15" },
  { label: "Material Delivery", icon: "truck", color: "bg-info/15" },
  { label: "Quality Check", icon: "check_circle", color: "bg-success/15" },
  { label: "Safety Observation", icon: "warning", color: "bg-warning/15" },
];

export default function DPRPage() {
  const params = useParams();
  const companyId = params?.company_id as string;
  const { activeProjectId, projects, setActiveProjectId } = useProject();
  const projectId = activeProjectId;
  const activeProject = projects.find((p) => p.id === projectId);
  const projectName = activeProject?.project_name || activeProject?.name || "";
  // Reports are filed per site. The head office is not a site.
  const sites = projects.filter((p) => p.id && !p.is_office);
  const siteName = (id?: string) => {
    const p = projects.find((x) => x.id === id);
    return p?.project_name || p?.name || "";
  };
  // Feed of every site at once. Filing a report is still for one site.
  const [viewAll, setViewAll] = useState(false);
  // Picking a site here picks it everywhere (sidebar, Planning, Material), so
  // the tasks and stock in the form are always that site's.
  const pickSite = (id: string) => {
    if (id === "__all") { setViewAll(true); return; }
    setViewAll(false);
    if (id && id !== projectId) setActiveProjectId(id);
  };
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
  // A site engineer filing a report for work nobody planned yet can add the
  // task here instead of leaving the form for Planning.
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskName, setNewTaskName] = useState("");
  const [newTaskDays, setNewTaskDays] = useState("1");
  const [newTaskSaving, setNewTaskSaving] = useState(false);
  const [newTaskError, setNewTaskError] = useState("");
  // Same for a material the Library does not have yet.
  const [newMatOpen, setNewMatOpen] = useState(false);
  const [newMatName, setNewMatName] = useState("");
  const [newMatUnit, setNewMatUnit] = useState("");
  const [newMatSaving, setNewMatSaving] = useState(false);
  const [newMatError, setNewMatError] = useState("");
  // The day the work was done: yesterday's report is often written next morning.
  const [reportDate, setReportDate] = useState(todayLocalISO());
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
  const [mbRows, setMbRows] = useState<MbRow[]>([
    { description: "", nos: 1, l: 0, w: 0, h: 0 },
  ]);

  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploadingSlot, setUploadingSlot] = useState<string | null>(null);

  const addPhotos = async (label: string, files: FileList | null) => {
    if (!files || !files.length || !projectId) return;
    setUploadingSlot(label);
    setMessage("");
    try {
      for (const file of Array.from(files)) {
        const path = await uploadProjectImage(projectId, file, "DPR Photos");
        setPhotos((prev) => [...prev, `${path}#${encodeURIComponent(label)}`]);
      }
    } catch (err) {
      setMessage(err instanceof Error && err.message ? err.message : "Could not upload the photo.");
    } finally {
      setUploadingSlot(null);
    }
  };

  const fetchTasks = async () => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/planning/tasks?project_id=${projectId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        // Work still to do first; finished tasks at the bottom. The form used
        // to preselect whatever came first, often a task already completed.
        const done = (t: Task) => (t.status || "").toLowerCase() === "completed";
        const ordered = [...(data as Task[])].sort((a, b) => Number(done(a)) - Number(done(b)));
        setTasks(ordered);
        const firstOpen = ordered.find((t) => !done(t));
        setSelectedTaskId(firstOpen ? firstOpen.id : "");
      }
    } catch (e) {
      console.error(e);
    }
  };

  const createTaskHere = async () => {
    const name = newTaskName.trim();
    const days = parseInt(newTaskDays) || 0;
    if (!name) { setNewTaskError("Enter what the task is, e.g. Slab casting, 2nd floor."); return; }
    if (days < 1) { setNewTaskError("A task lasts at least 1 day."); return; }
    setNewTaskSaving(true);
    setNewTaskError("");
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/planning/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          project_id: projectId,
          name,
          duration_days: days,
          // Starts on the day being reported, at noon so the day never shifts.
          start_date: new Date(`${reportDate}T12:00:00`).toISOString(),
          status: "in_progress",
        }),
      });
      if (!res.ok) {
        setNewTaskError(res.status === 403
          ? "Your role cannot add tasks. Ask your office to add it in Planning, or to give your role Planning edit access."
          : (await readErrorDetail(res)) || "Could not add the task.");
        return;
      }
      const created = (await res.json()) as Task;
      setTasks((prev) => [created, ...prev]);
      setSelectedTaskId(created.id);
      setNewTaskOpen(false);
      setNewTaskName("");
      setNewTaskDays("1");
    } catch {
      setNewTaskError("Could not reach the server. Try again.");
    } finally {
      setNewTaskSaving(false);
    }
  };

  const createMaterialHere = async () => {
    const name = newMatName.trim();
    const unit = newMatUnit.trim();
    if (!name) { setNewMatError("Enter the material, e.g. Cement OPC 53."); return; }
    if (!unit) { setNewMatError("Enter its unit, e.g. Bag or Cu.M."); return; }
    const existing = materials.find((m) => m.name.trim().toLowerCase() === name.toLowerCase());
    let picked: { name: string; unit: string } | null = existing ? { name: existing.name, unit: existing.unit || unit } : null;
    if (!picked) {
      setNewMatSaving(true);
      setNewMatError("");
      try {
        const res = await fetch(`${getApiHost()}/apis/v3/library/materials`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
          body: JSON.stringify({ company_id: companyId, name, unit }),
        });
        if (!res.ok) {
          setNewMatError(res.status === 403
            ? "Your role cannot add materials to the Library. Ask your office to add it, or to give your role Library edit access."
            : (await readErrorDetail(res)) || "Could not add the material.");
          return;
        }
        const created = (await res.json()) as MaterialOption;
        setMaterials((prev) => [...prev, created]);
        picked = { name: created.name, unit: created.unit || unit };
      } catch {
        setNewMatError("Could not reach the server. Try again.");
        return;
      } finally {
        setNewMatSaving(false);
      }
    }
    // Fill the first empty row, or add a row for it.
    setMaterialsConsumed((prev) => {
      const i = prev.findIndex((r) => !r.material_name);
      const row = { material_name: picked!.name, quantity: i >= 0 ? prev[i].quantity : "", unit: picked!.unit };
      if (i >= 0) return prev.map((r, k) => (k === i ? row : r));
      return [...prev, row];
    });
    setNewMatOpen(false);
    setNewMatName("");
    setNewMatUnit("");
  };

  const fetchMaterialsAndInventory = async () => {
    if (!projectId || !companyId) return;
    try {
      const [matRes, invRes] = await Promise.all([
        fetch(`${getApiHost()}/apis/v3/library/materials/${companyId}`, { headers: authHeaders() }),
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

  const feedProjectIds = () => (viewAll ? sites.map((p) => p.id as string) : projectId ? [projectId] : []);

  const fetchDPRSummary = async () => {
    try {
      const ids = feedProjectIds();
      const parts = await Promise.all(ids.map(async (id) => {
        const res = await fetch(`${getApiHost()}/apis/v3/dpr/summary?project_id=${id}`, { headers: authHeaders() });
        return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
      }));
      const ok = parts.filter((x): x is Record<string, unknown> => x !== null);
      if (!ok.length) return;
      // Counts add up across sites; the average is averaged.
      const total: Record<string, number> = {};
      for (const part of ok) {
        for (const [k, v] of Object.entries(part)) {
          if (typeof v === "number") total[k] = (total[k] || 0) + v;
        }
      }
      if (ok.length > 1 && total.avg_completion != null) total.avg_completion = total.avg_completion / ok.length;
      setSummary((prev) => ({ ...prev, ...(ok.length === 1 ? ok[0] : total) } as DPRSummary));
    } catch (e) {
      console.error(e);
    }
  };

  const fetchDPRLogs = async () => {
    try {
      const ids = feedProjectIds();
      const parts = await Promise.all(ids.map(async (id) => {
        const res = await fetch(`${getApiHost()}/apis/v3/dpr?project_id=${id}`, { headers: authHeaders() });
        return res.ok ? ((await res.json()) as DPRLog[]) : [];
      }));
      // Newest first across every site in view.
      setLogs(parts.flat().sort((a, b) => (a.dpr_date < b.dpr_date ? 1 : a.dpr_date > b.dpr_date ? -1 : 0)));
    } catch (e) {
      console.error(e);
    } finally {
      setLogsLoaded(true);
    }
  };

  // Every report of the most recent day: a site files one per activity.
  const latestDayLogs = logs.length > 0 ? logs.filter((l) => l.dpr_date.slice(0, 10) === logs[0].dpr_date.slice(0, 10)) : [];
  const latestDayWorkers = latestDayLogs.reduce((s, l) => s + (Number(l.workers_deployed) || 0), 0);

  // A wrong report is deleted and filed again; the material it used goes
  // back into stock and the task's progress is recalculated.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const deleteDPR = async (log: DPRLog) => {
    if (!confirm(`Delete the report for ${formatDate(log.dpr_date)}? Material it used goes back into stock.`)) return;
    setDeletingId(log.id);
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/dpr/${log.id}`, { method: "DELETE", headers: authHeaders() });
      if (!res.ok) throw new Error(await readErrorDetail(res));
      fetchDPRLogs();
      fetchDPRSummary();
      fetchTasks();
      fetchMaterialsAndInventory();
    } catch (e) {
      alert(`Could not delete the report: ${e instanceof Error ? e.message : "server unreachable"}`);
    } finally {
      setDeletingId(null);
    }
  };

  useEffect(() => {
    if (projectId) {
      fetchTasks();
      fetchMaterialsAndInventory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, companyId]);

  useEffect(() => {
    if (projectId || viewAll) {
      setLogsLoaded(false);
      fetchDPRSummary();
      fetchDPRLogs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, companyId, viewAll, sites.length]);

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
          // Noon local time, so the day never shifts when stored in UTC (a
          // report filed before 5:30 am IST used to land on the previous day).
          dpr_date: new Date(`${reportDate}T12:00:00`).toISOString(),
          executed_qty: parseFloat(executedQty) || 0.0,
          workers_deployed: parseInt(workersDeployed) || 0,
          weather: weather,
          notes: notes,
          issues: issues,
          materials_consumed: formattedMaterials,
          photos,
        })
      });

      if (res.ok) {
        setMessage("DPR submitted successfully!");
        setExecutedQty("");
        setWorkersDeployed("");
        setMaterialsConsumed([]);
        setNotes("");
        setIssues("");
        setPhotos([]);
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
          subtitle={viewAll ? `Daily site reports for all ${sites.length} sites` : projectName ? `Daily site reports for ${projectName}` : "Daily site reports"}
        >
          <label className="flex items-center gap-2 text-xs text-muted">
            Site
            <select
              value={viewAll ? "__all" : projectId}
              onChange={(e) => pickSite(e.target.value)}
              className="bg-input border border-border-custom rounded-md px-2 py-1.5 text-xs font-semibold text-foreground max-w-[14rem]"
            >
              {sites.length > 1 && <option value="__all">All sites</option>}
              {sites.map((p) => (
                <option key={p.id} value={p.id}>{p.project_name || p.name}</option>
              ))}
            </select>
          </label>
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
              { label: "Workers on Latest Day", value: logs.length > 0 ? fmtQty(latestDayWorkers) : "—", desc: logs.length > 0 ? `Across ${latestDayLogs.length} report${latestDayLogs.length === 1 ? "" : "s"} on ${formatDate(logs[0].dpr_date)}` : "No DPR yet", color: "border-primary/20 bg-primary/5 text-primary" },
              { label: "DPRs Logged", value: summary.activities_tracked || 0, desc: `${summary.issues_flagged || 0} with an issue flagged`, color: "border-secondary/20 bg-secondary/5 text-secondary" },
              { label: "Material Received Today", value: (summary.materials_received_today || 0) > 0 ? `${summary.materials_received_today} material${summary.materials_received_today === 1 ? "" : "s"}` : "Nothing received today", desc: "Received at this site today", color: "border-warning/20 bg-warning/5 text-warning" },
              { label: "Material Used Today", value: (summary.materials_used_today || 0) > 0 ? `${summary.materials_used_today} material${summary.materials_used_today === 1 ? "" : "s"}` : "No consumption logged", desc: "Used on site today, from today's DPRs", color: "border-primary/20 bg-primary/5 text-primary" }
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
                    <div className="flex justify-between items-center gap-2 text-[10px] text-muted">
                      <span className="font-bold text-foreground">Reported By: {log.reported_by}</span>
                      <span className="flex items-center gap-2">
                        <span>Weather: <strong className="text-muted">{log.weather}</strong> · {formatDate(log.dpr_date)}</span>
                        <button
                          type="button"
                          onClick={() => deleteDPR(log)}
                          disabled={deletingId === log.id}
                          title="Delete this report"
                          className="p-1 rounded text-muted hover:text-danger disabled:opacity-40 cursor-pointer"
                        >
                          <Icon name="trash" className="w-3.5 h-3.5" />
                        </button>
                      </span>
                    </div>
                    <div className="border-l-2 border-border-custom pl-3 my-2 space-y-1">
                      {viewAll && log.project_id && (
                        <p className="text-[10px] font-bold uppercase tracking-wider text-primary">{siteName(log.project_id)}</p>
                      )}
                      {(log.task_name || (log.task_id && tasks.find((t) => t.id === log.task_id)?.name)) && (
                        <p className="text-foreground text-xs font-bold">{log.task_name || tasks.find((t) => t.id === log.task_id)?.name}</p>
                      )}
                      <p className="text-foreground text-xs font-semibold">
                        Qty Executed: {fmtQty(log.executed_qty)}{log.task_unit ? ` ${log.task_unit}` : ""} · Workers: {fmtQty(log.workers_deployed)}
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
                      {log.photos && log.photos.length > 0 && (
                        <div className="flex flex-wrap gap-2 pt-1">
                          {log.photos.map((path) => (
                            <figure key={path} className="w-20">
                              <AuthImage
                                src={path.split("#")[0]}
                                alt={photoLabel(path) || "DPR photo"}
                                className="h-16 w-20 rounded border border-border-custom object-cover cursor-zoom-in"
                                fallback={<div className="h-16 w-20 rounded border border-border-custom bg-elevated" />}
                                onClick={(url) => window.open(url, "_blank")}
                              />
                              {photoLabel(path) && <figcaption className="mt-0.5 truncate text-[9px] text-muted">{photoLabel(path)}</figcaption>}
                            </figure>
                          ))}
                        </div>
                      )}
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
                <label className="text-muted">Site</label>
                <select
                  value={projectId}
                  onChange={(e) => pickSite(e.target.value)}
                  required
                  className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground font-semibold"
                >
                  {!projectId && <option value="">Pick the site</option>}
                  {sites.map((p) => (
                    <option key={p.id} value={p.id}>{p.project_name || p.name}</option>
                  ))}
                </select>
                <p className="text-[10px] text-muted">The tasks and stock below are this site&apos;s. Changing it here changes the site everywhere in the app.</p>
              </div>

              <div className="space-y-1">
                <div className="flex justify-between items-center h-5">
                  <label className="text-muted">Select Task</label>
                  {!newTaskOpen && (
                    <button
                      type="button"
                      onClick={() => { setNewTaskOpen(true); setNewTaskError(""); }}
                      className="text-[10px] font-bold text-primary hover:underline cursor-pointer"
                    >
                      + New task
                    </button>
                  )}
                </div>
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
                {newTaskOpen && (
                  <div className="mt-2 p-3 rounded-lg border border-border-custom bg-elevated/40 space-y-2">
                    <div className="grid grid-cols-1 md:grid-cols-[1fr_7rem] gap-2">
                      <input
                        type="text"
                        value={newTaskName}
                        onChange={(e) => setNewTaskName(e.target.value)}
                        placeholder="Task, e.g. Slab casting, 2nd floor"
                        maxLength={255}
                        className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground"
                      />
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={newTaskDays}
                        onChange={(e) => setNewTaskDays(e.target.value)}
                        title="How many days it should take"
                        className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground"
                      />
                    </div>
                    <p className="text-[10px] text-muted">
                      Starts on the report date and takes the number of days on the right. It also appears in Planning,
                      where you can link it to a BOQ line so its progress is worked out from the quantity you report.
                    </p>
                    {newTaskError && <p className="text-[11px] text-danger">{newTaskError}</p>}
                    <div className="flex gap-2 justify-end">
                      <button type="button" onClick={() => setNewTaskOpen(false)}
                        className="px-3 py-1.5 rounded-md border border-border-custom text-muted hover:text-foreground cursor-pointer">
                        Cancel
                      </button>
                      <button type="button" onClick={createTaskHere} disabled={newTaskSaving}
                        className="px-3 py-1.5 rounded-md bg-primary text-white font-semibold disabled:opacity-50 cursor-pointer">
                        {newTaskSaving ? "Adding..." : "Add task"}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <label className="text-muted">Report Date</label>
                <input
                  type="date"
                  value={reportDate}
                  max={todayLocalISO()}
                  onChange={(e) => setReportDate(e.target.value || todayLocalISO())}
                  className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground"
                />
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
                  <div className="flex justify-between items-center h-5">
                    <label className="text-muted">Executed Qty</label>
                    <button
                      type="button"
                      onClick={() => setShowMBModal(true)}
                      className="text-[10px] font-bold text-primary hover:underline cursor-pointer inline-flex items-center gap-1"
                    >
                      <Icon name="ruler" className="w-3 h-3" /> Open M.B. Sheet
                    </button>
                  </div>
                  <input type="number" min={0} step="0.01" value={executedQty} onChange={(e) => setExecutedQty(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" placeholder="e.g. 45" />
                </div>
                <div className="space-y-1">
                  <div className="flex items-center h-5">
                    <label className="text-muted">Workers Deployed</label>
                  </div>
                  <input type="number" min={0} step={1} value={workersDeployed} onChange={(e) => setWorkersDeployed(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" placeholder="e.g. 15" />
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
                    <p className="text-[10px] text-muted">Saving the report takes these off this site&apos;s stock</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setMaterialsConsumed([...materialsConsumed, { material_name: "", quantity: "", unit: "" }])}
                    className="px-2 py-1 bg-primary/10 hover:bg-primary/20 text-primary font-bold rounded text-[10px] inline-flex items-center gap-1 transition-all cursor-pointer"
                  >
                    <Icon name="add" className="w-3 h-3" /> Add Material
                  </button>
                </div>

                {materials.length === 0 && inventory.length === 0 && !newMatOpen && (
                  <p className="text-[10px] text-muted">
                    No materials in your Library yet.{" "}
                    <button type="button" onClick={() => { setNewMatOpen(true); setNewMatError(""); }} className="text-primary font-semibold hover:underline cursor-pointer">
                      Add one here
                    </button>
                  </p>
                )}
                {(materials.length > 0 || inventory.length > 0) && !newMatOpen && (
                  <button type="button" onClick={() => { setNewMatOpen(true); setNewMatError(""); }}
                    className="text-[10px] font-bold text-primary hover:underline cursor-pointer">
                    Material not in the list? Add it
                  </button>
                )}
                {newMatOpen && (
                  <div className="p-3 rounded-lg border border-border-custom bg-elevated/40 space-y-2">
                    <div className="grid grid-cols-1 md:grid-cols-[1fr_7rem] gap-2">
                      <input type="text" value={newMatName} onChange={(e) => setNewMatName(e.target.value)} maxLength={255}
                        placeholder="Material, e.g. Cement OPC 53"
                        className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" />
                      <UnitInput type="text" value={newMatUnit} onChange={(e) => setNewMatUnit(e.target.value)} autoComplete="off"
                        placeholder="Unit, e.g. Bag"
                        className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" />
                    </div>
                    <p className="text-[10px] text-muted">
                      Saved to your Library so everyone can pick it next time. This site&apos;s stock of it comes from material received here.
                    </p>
                    {newMatError && <p className="text-[11px] text-danger">{newMatError}</p>}
                    <div className="flex gap-2 justify-end">
                      <button type="button" onClick={() => setNewMatOpen(false)}
                        className="px-3 py-1.5 rounded-md border border-border-custom text-muted hover:text-foreground cursor-pointer">Cancel</button>
                      <button type="button" onClick={createMaterialHere} disabled={newMatSaving}
                        className="px-3 py-1.5 rounded-md bg-primary text-white font-semibold disabled:opacity-50 cursor-pointer">
                        {newMatSaving ? "Adding..." : "Add material"}
                      </button>
                    </div>
                  </div>
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
                              <UnitInput
                                type="text"
                                placeholder="e.g. bags"
                                autoComplete="off"
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
                  {PHOTO_SLOTS.map((slot) => {
                    const count = photos.filter((p) => photoLabel(p) === slot.label).length;
                    return (
                      <label key={slot.label} className={`p-2.5 rounded-md border border-border-custom ${slot.color} flex flex-col items-center justify-center cursor-pointer hover:border-primary`}>
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          className="hidden"
                          disabled={uploadingSlot !== null}
                          onChange={(e) => {
                            const files = e.target.files;
                            addPhotos(slot.label, files).finally(() => { e.target.value = ""; });
                          }}
                        />
                        <Icon name={slot.icon} className="w-5 h-5" />
                        <span className="mt-1 text-muted font-bold">{slot.label}</span>
                        <span className="mt-0.5 text-[9px] text-primary font-bold">
                          {uploadingSlot === slot.label ? "Uploading..." : count ? `${count} added` : "Add photo"}
                        </span>
                      </label>
                    );
                  })}
                </div>
                {photos.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {photos.map((path) => (
                      <div key={path} className="relative">
                        <AuthImage src={path.split("#")[0]} alt={photoLabel(path)} className="h-14 w-14 rounded border border-border-custom object-cover" />
                        <button
                          type="button"
                          onClick={() => setPhotos((prev) => prev.filter((p) => p !== path))}
                          className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-danger text-white"
                          aria-label={`Remove ${photoLabel(path)} photo`}
                        >
                          <Icon name="close" className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex gap-2 justify-end border-t border-border-custom pt-4">
                <button type="button" onClick={() => setIsCreateDPROpen(false)} className="px-4 py-2 bg-elevated text-muted hover:text-foreground rounded-md">Cancel</button>
                <button type="submit" disabled={submitting || uploadingSlot !== null} className="px-5 py-2.5 bg-primary text-white font-bold rounded-md hover:opacity-90">
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
                <p className="text-[10px] text-muted">Multiply the dimensions you measure: length for running metres, length × width for area, add height for volume</p>
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
                    <th className="px-4 py-2 font-semibold text-right">Quantity</th>
                    <th className="px-4 py-2 font-semibold text-center">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {mbRows.map((row, idx) => {
                    const rowQty = mbQty(row);
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
                            min={0}
                            value={row.nos}
                            onChange={(e) => {
                              const next = [...mbRows];
                              next[idx].nos = Math.max(0, parseFloat(e.target.value) || 0);
                              setMbRows(next);
                            }}
                            className="bg-input border border-border-custom rounded px-2 py-1 text-foreground w-16"
                          />
                        </td>
                        <td className="px-4 py-2">
                          <input
                            type="number"
                            min={0}
                            value={row.l}
                            onChange={(e) => {
                              const next = [...mbRows];
                              next[idx].l = Math.max(0, parseFloat(e.target.value) || 0);
                              setMbRows(next);
                            }}
                            className="bg-input border border-border-custom rounded px-2 py-1 text-foreground w-16"
                          />
                        </td>
                        <td className="px-4 py-2">
                          <input
                            type="number"
                            min={0}
                            value={row.w}
                            onChange={(e) => {
                              const next = [...mbRows];
                              next[idx].w = Math.max(0, parseFloat(e.target.value) || 0);
                              setMbRows(next);
                            }}
                            className="bg-input border border-border-custom rounded px-2 py-1 text-foreground w-16"
                          />
                        </td>
                        <td className="px-4 py-2">
                          <input
                            type="number"
                            min={0}
                            value={row.h}
                            onChange={(e) => {
                              const next = [...mbRows];
                              next[idx].h = Math.max(0, parseFloat(e.target.value) || 0);
                              setMbRows(next);
                            }}
                            className="bg-input border border-border-custom rounded px-2 py-1 text-foreground w-16"
                          />
                        </td>
                        <td className="px-4 py-2 text-right font-sans text-muted">
                          {fmtQty(rowQty)} {rowQty > 0 ? MB_UNITS[mbDims(row).length] : ""}
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
                  className="px-3 py-1.5 bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 rounded-lg font-bold cursor-pointer"
                >
                  + Add Dimension Row
                </button>
                <div className="text-right text-xs">
                  <span className="text-muted block uppercase text-[9px] tracking-wider">Total Takeoff Sum</span>
                  <strong className="text-lg font-black text-success font-sans">
                    {fmtQty(mbRows.reduce((acc, r) => acc + mbQty(r), 0))} {mbTotalUnit(mbRows)}
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
                  const total = mbRows.reduce((acc, r) => acc + mbQty(r), 0);
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