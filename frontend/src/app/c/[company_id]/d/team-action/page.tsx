"use client";
import { readErrorDetail, detailToMessage} from "@/lib/api";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { getApi, authHeaders, formatDate, todayLocalISO } from "@/lib/siteflow";
import Icon from "@/components/marketing/Icon";
import SegmentedTabs from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import { CardSkeleton } from "@/components/ui/Skeleton";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import FieldHint from "@/components/ui/FieldHint";
// R2-755: shared CSV guard. Quote-doubling protects the delimiter, not the
// formula — a leading = + - @ executes when the export opens in Excel/Sheets.
import { buildCsv } from "@/lib/csv";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface CompanyTask {
  id: string;
  project_id: string;
  project_name: string | null;
  parent_id: string | null;
  name: string;
  duration_days: number;
  start_date: string;
  end_date: string;
  status: string;
  priority: string;
  assigned_to: string | null;
  assigned_to_name: string | null;
  progress: number;
}

interface ProjectLite {
  id: string;
  name: string;
}

interface PartyLite {
  id: string;
  name: string;
  party_type: string | null;
}

interface TimesheetRow {
  id: string;
  party_id: string | null;
  party_name: string | null;
  project_id: string | null;
  project_name: string | null;
  entry_date: string;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  remarks: string | null;
  file_url: string | null;
  file_name: string | null;
}

type Granularity = "day" | "week" | "month" | "year";
type StatusFilter = "All" | "not_started" | "in_progress" | "completed";

const DAY_MS = 86400000;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// R2-257 defence in depth: a stored javascript: URL must never reach an href,
// even if a row predates the server-side scheme allow-list.
const safeHref = (url: string | null): string | null => {
  if (!url) return null;
  const u = url.trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("/") && !u.startsWith("//")) return u;
  return null;
};

const fmtDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmtDateNice = (iso: string) => formatDate(iso);
const fmtTime = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
};
const fmtDuration = (min: number | null) => {
  if (min == null) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h} Hr ${m} Min`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Schedule (Gantt) helpers
// ─────────────────────────────────────────────────────────────────────────────
interface TreeNode {
  task: CompanyTask;
  children: TreeNode[];
}

function collectLeaves(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (n.children.length === 0) out.push(n);
    else out.push(...collectLeaves(n.children));
  }
  return out;
}

function aggregateProgress(nodes: TreeNode[]): number {
  const leaves = collectLeaves(nodes);
  if (leaves.length === 0) return 0;
  let wsum = 0;
  let dsum = 0;
  for (const l of leaves) {
    const d = Number(l.task.duration_days) || 0;
    wsum += (Number(l.task.progress) || 0) * d;
    dsum += d;
  }
  if (dsum <= 0) {
    return leaves.reduce((a, l) => a + (Number(l.task.progress) || 0), 0) / leaves.length;
  }
  return wsum / dsum;
}

function nodeSpan(nodes: TreeNode[]): { start: Date; end: Date } {
  const leaves = collectLeaves(nodes);
  let start = new Date(leaves[0].task.start_date);
  let end = new Date(leaves[0].task.end_date);
  for (const l of leaves) {
    const s = new Date(l.task.start_date);
    const e = new Date(l.task.end_date);
    if (s < start) start = s;
    if (e > end) end = e;
  }
  return { start, end };
}

interface Period {
  key: string;
  label: string;
  year: number;
}

function buildPeriods(rangeStart: Date, rangeEnd: Date, g: Granularity): Period[] {
  const periods: Period[] = [];
  const cursor = new Date(rangeStart);
  if (g === "day") {
    // cap to avoid runaway DOM
    let guard = 0;
    while (cursor <= rangeEnd && guard < 400) {
      periods.push({ key: fmtDate(cursor), label: String(cursor.getDate()), year: cursor.getFullYear() });
      cursor.setDate(cursor.getDate() + 1);
      guard++;
    }
  } else if (g === "week") {
    // align to Monday
    const dow = (cursor.getDay() + 6) % 7;
    cursor.setDate(cursor.getDate() - dow);
    let guard = 0;
    while (cursor <= rangeEnd && guard < 300) {
      periods.push({ key: fmtDate(cursor), label: String(cursor.getDate()), year: cursor.getFullYear() });
      cursor.setDate(cursor.getDate() + 7);
      guard++;
    }
  } else if (g === "month") {
    cursor.setDate(1);
    let guard = 0;
    while ((cursor <= rangeEnd || cursor.getMonth() === rangeEnd.getMonth()) && guard < 240) {
      const y = cursor.getFullYear();
      const m = cursor.getMonth();
      periods.push({ key: `${y}-${m}`, label: cursor.toLocaleDateString("en-IN", { month: "short" }), year: y });
      cursor.setMonth(m + 1);
      guard++;
    }
  } else {
    cursor.setMonth(0, 1);
    let guard = 0;
    while (cursor <= rangeEnd && guard < 100) {
      periods.push({ key: String(cursor.getFullYear()), label: String(cursor.getFullYear()), year: cursor.getFullYear() });
      cursor.setFullYear(cursor.getFullYear() + 1);
      guard++;
    }
  }
  return periods;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────
export default function TeamSchedulePage() {
  const params = useParams();
  const companyId = params.company_id as string;

  const [activeTab, setActiveTab] = useState<"schedule" | "timesheet">("schedule");

  // ── Schedule state ──
  const [tasks, setTasks] = useState<CompanyTask[]>([]);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);

  const [granularity, setGranularity] = useState<Granularity>("month");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("All");
  const [projectFilter, setProjectFilter] = useState("All");
  const [exportOpen, setExportOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // ── Timesheet state ──
  const [timesheets, setTimesheets] = useState<TimesheetRow[]>([]);
  const [parties, setParties] = useState<PartyLite[]>([]);
  const [loadingTS, setLoadingTS] = useState(true);
  const [tsPartyFilter, setTsPartyFilter] = useState("");
  const [tsDateFrom, setTsDateFrom] = useState("");
  const [tsDateTo, setTsDateTo] = useState("");
  const [tsSearch, setTsSearch] = useState("");
  const [tsDrawerOpen, setTsDrawerOpen] = useState(false);

  // ── New Timesheet form ──
  const [tsDate, setTsDate] = useState(todayLocalISO());
  const [tsPartyQuery, setTsPartyQuery] = useState("");
  const [tsPartyId, setTsPartyId] = useState<string | null>(null);
  const [tsPartyName, setTsPartyName] = useState("");
  const [tsPartyDropdown, setTsPartyDropdown] = useState(false);
  const [tsProjectId, setTsProjectId] = useState("");
  const [tsStart, setTsStart] = useState("09:00");
  const [tsEnd, setTsEnd] = useState("17:00");
  const [tsRemarks, setTsRemarks] = useState("");
  const [tsFileUrl, setTsFileUrl] = useState<string | null>(null);
  const [tsFileName, setTsFileName] = useState<string | null>(null);
  const [tsUploading, setTsUploading] = useState(false);
  const [tsSaving, setTsSaving] = useState(false);
  const [tsFormError, setTsFormError] = useState<string | null>(null);

  // ── Data loaders ──
  const loadSchedule = useCallback(async () => {
    setLoadingTasks(true);
    try {
      const [tRes, pRes] = await Promise.all([
        fetch(getApi(`/planning/tasks/company/${companyId}`), { headers: authHeaders() }),
        fetch(getApi(`/planning/projects?company_id=${companyId}`), { headers: authHeaders() }),
      ]);
      if (tRes.ok) setTasks((await tRes.json()) as CompanyTask[]);
      if (pRes.ok) setProjects((await pRes.json()) as ProjectLite[]);
    } catch {
      /* ignore */
    } finally {
      setLoadingTasks(false);
    }
  }, [companyId]);

  const loadTimesheets = useCallback(async () => {
    setLoadingTS(true);
    try {
      const q = new URLSearchParams({ company_id: companyId });
      if (tsPartyFilter) q.set("party_id", tsPartyFilter);
      if (tsDateFrom) q.set("date_from", `${tsDateFrom}T00:00:00Z`);
      if (tsDateTo) q.set("date_to", `${tsDateTo}T23:59:59Z`);
      if (tsSearch) q.set("search", tsSearch);
      const [tsRes, pRes] = await Promise.all([
        fetch(getApi(`/team-schedule/timesheets?${q.toString()}`), { headers: authHeaders() }),
        fetch(getApi(`/library/parties/${companyId}`), { headers: authHeaders() }),
      ]);
      if (tsRes.ok) setTimesheets((await tsRes.json()) as TimesheetRow[]);
      if (pRes.ok) setParties((await pRes.json()) as PartyLite[]);
    } catch {
      /* ignore */
    } finally {
      setLoadingTS(false);
    }
  }, [companyId, tsPartyFilter, tsDateFrom, tsDateTo, tsSearch]);

  useEffect(() => {
    loadSchedule();
  }, [loadSchedule]);

  useEffect(() => {
    loadTimesheets();
  }, [loadTimesheets]);

  // ── Schedule: derive assignee options + filtered tasks ──
  const assigneeOptions = useMemo(() => {
    const set = new Set<string>();
    tasks.forEach((t) => {
      if (t.assigned_to_name) set.add(t.assigned_to_name);
    });
    return Array.from(set).sort();
  }, [tasks]);

  const overlaps = (t: CompanyTask, from: string, to: string) => {
    if (!from && !to) return true;
    const s = new Date(t.start_date).getTime();
    const e = new Date(t.end_date).getTime();
    const f = from ? new Date(from).getTime() : -Infinity;
    const tt = to ? new Date(to).getTime() + DAY_MS : Infinity;
    return e >= f && s <= tt;
  };

  const filteredTasks = useMemo(
    () =>
      tasks.filter((t) => {
        if (assigneeFilter === "Unassigned" && t.assigned_to) return false;
        if (assigneeFilter !== "All" && assigneeFilter !== "Unassigned" && t.assigned_to_name !== assigneeFilter)
          return false;
        if (statusFilter !== "All" && t.status !== statusFilter) return false;
        if (projectFilter !== "All" && t.project_id !== projectFilter) return false;
        return overlaps(t, dateFrom, dateTo);
      }),
    [tasks, assigneeFilter, statusFilter, projectFilter, dateFrom, dateTo]
  );

  // ── Build Gantt tree (assigned tree + synthetic Unassigned group) ──
  const ganttRows = useMemo(() => {
    const unassigned = filteredTasks.filter((t) => !t.assigned_to);
    const assigned = filteredTasks.filter((t) => t.assigned_to);

    const byId = new Map(assigned.map((t) => [t.id, t]));
    const childMap = new Map<string, CompanyTask[]>();
    for (const t of assigned) {
      const pid = t.parent_id;
      if (pid && byId.has(pid)) {
        if (!childMap.has(pid)) childMap.set(pid, []);
        childMap.get(pid)!.push(t);
      }
    }
    const roots = assigned.filter((t) => !t.parent_id || !byId.has(t.parent_id));

    const toNode = (t: CompanyTask): TreeNode => ({
      task: t,
      children: (childMap.get(t.id) || []).map(toNode),
    });

    const rows: { kind: "group"; id: string; name: string; nodes: TreeNode[]; unassigned: boolean }[] = [];

    if (unassigned.length > 0) {
      rows.push({
        kind: "group",
        id: "__unassigned__",
        name: "Unassigned",
        nodes: unassigned.map((t) => ({ task: t, children: [] })),
        unassigned: true,
      });
    }
    for (const r of roots) {
      const node = toNode(r);
      rows.push({
        kind: "group",
        id: r.id,
        name: r.name,
        nodes: [node],
        unassigned: false,
      });
    }
    return rows;
  }, [filteredTasks]);

  // ── Timeline range + periods ──
  const range = useMemo(() => {
    if (filteredTasks.length === 0) {
      const now = new Date();
      return { start: now, end: now, days: 1 };
    }
    let min = new Date(filteredTasks[0].start_date);
    let max = new Date(filteredTasks[0].end_date);
    for (const t of filteredTasks) {
      const s = new Date(t.start_date);
      const e = new Date(t.end_date);
      if (s < min) min = s;
      if (e > max) max = e;
    }
    const fromD = dateFrom ? new Date(dateFrom) : null;
    const toD = dateTo ? new Date(dateTo) : null;
    if (fromD && fromD > min) min = fromD;
    if (toD && toD < max) max = toD;
    const span = Math.max(1, (max.getTime() - min.getTime()) / DAY_MS);
    return { start: min, end: max, days: span };
  }, [filteredTasks, dateFrom, dateTo]);

  const periods = useMemo(() => buildPeriods(range.start, range.end, granularity), [range, granularity]);
  const cellW = granularity === "day" ? 40 : granularity === "week" ? 56 : granularity === "month" ? 64 : 80;

  const posPct = (d: Date) => {
    const total = range.end.getTime() - range.start.getTime();
    if (total <= 0) return 0;
    return clamp(((d.getTime() - range.start.getTime()) / total) * 100, 0, 100);
  };

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Flatten a group into render rows (recursive, respecting collapse)
  const renderGroup = (
    group: { kind: "group"; id: string; name: string; nodes: TreeNode[]; unassigned: boolean },
    depth: number
  ): React.ReactElement[] => {
    const isCollapsed = collapsed.has(group.id);
    const span = nodeSpan(group.nodes);
    const agg = aggregateProgress(group.nodes);
    const leaves = collectLeaves(group.nodes);
    const startPct = posPct(span.start);
    const endPct = posPct(span.end);
    const widthPct = Math.max(endPct - startPct, 1.5);
    const barColor = group.unassigned ? "bg-slate-400/20 border border-slate-400/60" : "bg-primary/15 border border-primary/50";
    const fillColor = group.unassigned ? "bg-slate-400/70" : "bg-primary/60";

    const out: React.ReactElement[] = [];
    out.push(
      <div
        key={group.id}
        className="flex items-stretch border-b border-border-custom hover:bg-elevated/40"
      >
        <div
          className="w-64 shrink-0 flex items-center gap-2 px-4 py-2 border-r border-border-custom bg-background/30 cursor-pointer"
          onClick={() => toggleCollapse(group.id)}
        >
          <Icon name={isCollapsed ? "chevron_right" : "chevron_down"} className="w-3 h-3 text-muted shrink-0" />
          <div className="min-w-0">
            <div className="text-xs font-semibold text-foreground truncate" style={{ paddingLeft: depth * 10 }}>
              {group.name}
            </div>
            <div className="text-[10px] text-muted">
              {group.unassigned ? "No assignee" : `${leaves.length} task${leaves.length > 1 ? "s" : ""}`}
            </div>
          </div>
        </div>
        <div className="relative flex-1 min-w-0 h-11 flex items-center">
          <div
            className={`absolute h-7 rounded ${barColor} shadow-sm overflow-hidden flex items-center`}
            style={{ left: `${startPct}%`, width: `${widthPct}%` }}
            title={`${group.name} — ${Math.round(agg)}%`}
          >
            <div className={`h-full ${fillColor}`} style={{ width: `${clamp(agg, 0, 100)}%` }} />
            <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-foreground px-1 truncate">
              {Math.round(agg)}%
            </span>
          </div>
        </div>
      </div>
    );

    if (!isCollapsed) {
      const walk = (nodes: TreeNode[], d: number) => {
        for (const n of nodes) {
          const s = new Date(n.task.start_date);
          const e = new Date(n.task.end_date);
          const sp = posPct(s);
          const ep = posPct(e);
          const wp = Math.max(ep - sp, 1.5);
          const color = n.task.assigned_to ? "bg-primary/15 border border-primary/50" : "bg-slate-400/20 border border-slate-400/60";
          const fill = n.task.assigned_to ? "bg-primary/60" : "bg-slate-400/70";
          out.push(
            <div key={n.task.id} className="flex items-stretch border-b border-border-custom hover:bg-elevated/40">
              <div className="w-64 shrink-0 flex items-center gap-2 px-4 py-2 border-r border-border-custom bg-background/10">
                <span className="w-3" />
                <div className="min-w-0">
                  <div className="text-xs text-foreground truncate" style={{ paddingLeft: d * 10 }}>
                    {n.task.name}
                  </div>
                  <div className="text-[10px] text-muted truncate">
                    {n.task.project_name || "—"}
                    {n.task.assigned_to_name ? ` · ${n.task.assigned_to_name}` : ""}
                  </div>
                </div>
              </div>
              <div className="relative flex-1 min-w-0 h-9 flex items-center">
                <div
                  className={`absolute h-6 rounded ${color} shadow-sm overflow-hidden flex items-center`}
                  style={{ left: `${sp}%`, width: `${wp}%` }}
                  title={`${n.task.name} — ${Math.round(Number(n.task.progress) || 0)}%`}
                >
                  <div className={`h-full ${fill}`} style={{ width: `${clamp(Number(n.task.progress) || 0, 0, 100)}%` }} />
                  <span className="absolute inset-0 flex items-center justify-center text-[9px] font-bold text-foreground px-1 truncate">
                    {Math.round(Number(n.task.progress) || 0)}%
                  </span>
                </div>
              </div>
            </div>
          );
          if (n.children.length > 0) walk(n.children, d + 1);
        }
      };
      walk(group.nodes, depth + 1);
    }
    return out;
  };

  // ── Exports ──
  const downloadBlob = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportExcel = () => {
    const header = ["S.No", "Task", "Project", "Assignee", "Start", "End", "Status", "Progress %"];
    const rows = filteredTasks.map((t, i) => [
      String(i + 1),
      t.name,
      t.project_name || "",
      t.assigned_to_name || "Unassigned",
      fmtDate(new Date(t.start_date)),
      fmtDate(new Date(t.end_date)),
      t.status,
      String(Math.round(Number(t.progress) || 0)),
    ]);
    // R2-755: task names and assignee names are user-controlled; the old
    // builder only quote-doubled, which does not stop a formula.
    const csv = buildCsv(header, rows);
    downloadBlob(csv, "team-schedule.csv", "text/csv;charset=utf-8");
  };

  const exportMSP = () => {
    const tasksXml = filteredTasks
      .map((t, i) => {
        const s = fmtDate(new Date(t.start_date));
        const e = fmtDate(new Date(t.end_date));
        return `    <Task>
      <UID>${i + 1}</UID>
      <ID>${i + 1}</ID>
      <Name>${t.name.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</Name>
      <Start>${s}T08:00:00</Start>
      <Finish>${e}T17:00:00</Finish>
      <PercentComplete>${Math.round(Number(t.progress) || 0)}</PercentComplete>
    </Task>`;
      })
      .join("\n");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Project xmlns="http://schemas.microsoft.com/project/2007/1/1">
  <UID>1</UID>
  <Name>Team Schedule</Name>
  <Tasks>
${tasksXml}
  </Tasks>
</Project>`;
    downloadBlob(xml, "team-schedule.xml", "application/xml");
  };

  // ── New Timesheet handlers ──
  const partyMatches = useMemo(() => {
    if (!tsPartyQuery.trim()) return parties.slice(0, 20);
    const q = tsPartyQuery.toLowerCase();
    return parties.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 20);
  }, [parties, tsPartyQuery]);

  const handleCreateParty = async () => {
    if (!tsPartyQuery.trim()) return;
    try {
      const res = await fetch(getApi("/library/parties"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id: companyId,
          name: tsPartyQuery.trim(),
          party_type: "Staff",
        }),
      });
      if (res.ok) {
        const created = (await res.json()) as PartyLite;
        setParties((prev) => [...prev, created]);
        setTsPartyId(created.id);
        setTsPartyName(created.name);
        setTsPartyQuery(created.name);
        setTsPartyDropdown(false);
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch {
      /* ignore */
    }
  };

  const handleFileUpload = async (file: File) => {
    if (!tsProjectId) return;
    setTsUploading(true);
    try {
      const form = new FormData();
      form.append("project_id", tsProjectId);
      form.append("file", file);
      const res = await fetch(getApi("/files/upload"), {
        method: "POST",
        headers: authHeaders() || undefined,
        body: form,
      });
      if (res.ok) {
        const data = await res.json();
        const fid = data.id || data.file_id;
        setTsFileUrl(fid ? `/files/file/${fid}` : null);
        setTsFileName(file.name);
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch {
      /* ignore */
    } finally {
      setTsUploading(false);
    }
  };

  const handleSaveTimesheet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tsProjectId || !tsPartyId) {
      setTsFormError("Select a project and a party to save the timesheet.");
      return;
    }
    setTsFormError(null);
    setTsSaving(true);
    try {
      const offMin = -new Date().getTimezoneOffset();
      const pad2 = (n: number) => String(n).padStart(2, "0");
      const tz = `${offMin < 0 ? "-" : "+"}${pad2(Math.floor(Math.abs(offMin) / 60))}:${pad2(Math.abs(offMin) % 60)}`;
      const res = await fetch(getApi("/team-schedule/timesheets"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id: companyId,
          party_id: tsPartyId,
          project_id: tsProjectId,
          entry_date: `${tsDate}T00:00:00${tz}`,
          start_time: `${tsDate}T${tsStart}:00${tz}`,
          end_time: `${tsDate}T${tsEnd}:00${tz}`,
          remarks: tsRemarks || null,
          file_url: tsFileUrl,
          file_name: tsFileName,
        }),
      });
      if (res.ok) {
        setTsDrawerOpen(false);
        // reset form
        setTsPartyQuery("");
        setTsPartyId(null);
        setTsPartyName("");
        setTsRemarks("");
        setTsFileUrl(null);
        setTsFileName(null);
        loadTimesheets();
      } else {
        try {
          const err = await res.json();
          setTsFormError(detailToMessage(err?.detail, "Could not save the timesheet. Please try again."));
        } catch {
          setTsFormError("Could not save the timesheet. Please try again.");
        }
      }
    } catch {
      setTsFormError("Could not save the timesheet. Please try again.");
    } finally {
      setTsSaving(false);
    }
  };

  const handleDeleteTimesheet = async (id: string) => {
    try {
      const res = await fetch(getApi(`/team-schedule/timesheets/${id}`), {
        method: "DELETE",
        headers: authHeaders() || undefined,
      });
      if (res.ok) {
        setTimesheets((prev) => prev.filter((t) => t.id !== id));
      } else {
        const err = await res.json().catch(() => ({}));
        alert(detailToMessage(err.detail, "Failed to delete timesheet"));
      }
    } catch (e: any) {
      alert(e?.message || "Network error deleting timesheet");
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title="Team Schedule"
        subtitle="Company-wide task rollup across all projects and party-linked time logs."
      >
        <SegmentedTabs
          tabs={[
            { id: "schedule", label: "Schedule Gantt" },
            { id: "timesheet", label: "Timesheet" },
          ]}
          activeTab={activeTab}
          onChange={(t) => setActiveTab(t as any)}
        />
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">

      {/* ───────── Schedule sub-tab ───────── */}
      {activeTab === "schedule" && (
        <div className="flex-1 flex flex-col min-h-0 bg-card border border-border-custom rounded-lg overflow-hidden">
          {/* Toolbar */}
          <div className="p-4 border-b border-border-custom bg-background/50 flex flex-wrap items-center gap-3 shrink-0">
            <select
              value={granularity}
              onChange={(e) => setGranularity(e.target.value as Granularity)}
              className="input-field px-3 py-1.5 text-xs font-semibold focus:outline-none"
            >
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
              <option value="year">Year</option>
            </select>

            <div className="flex items-center gap-1 text-xs">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="input-field px-2 py-1.5 text-xs focus:outline-none"
                placeholder="From"
              />
              <span className="text-muted text-xs">to</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="input-field px-2 py-1.5 text-xs focus:outline-none"
                placeholder="To"
              />
            </div>

            <select
              value={assigneeFilter}
              onChange={(e) => setAssigneeFilter(e.target.value)}
              className="input-field px-3 py-1.5 text-xs font-semibold focus:outline-none"
            >
              <option value="All">All assignees</option>
              <option value="Unassigned">Unassigned</option>
              {assigneeOptions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="input-field px-3 py-1.5 text-xs font-semibold focus:outline-none"
            >
              <option value="All">All statuses</option>
              <option value="not_started">Not Started</option>
              <option value="in_progress">Ongoing</option>
              <option value="completed">Completed</option>
            </select>

            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              className="input-field px-3 py-1.5 text-xs font-semibold focus:outline-none"
            >
              <option value="All">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>

            <div className="relative ml-auto">
              <button
                onClick={() => setExportOpen((v) => !v)}
                className="px-3 py-1.5 text-xs font-semibold border border-border-custom rounded-md hover:bg-elevated text-foreground flex items-center gap-1 cursor-pointer"
              >
                Export ▾
              </button>
              {exportOpen && (
                <div className="absolute right-0 mt-1 w-44 bg-card border border-border-custom rounded-md shadow-lg z-20 overflow-hidden">
                  {[
                    { label: "Export to PDF", fn: () => window.print() },
                    { label: "Export to Excel", fn: exportExcel },
                    { label: "Export to MSP", fn: exportMSP },
                  ].map((o) => (
                    <button
                      key={o.label}
                      onClick={() => {
                        o.fn();
                        setExportOpen(false);
                      }}
                      className="w-full text-left px-3 py-2 text-xs text-foreground hover:bg-elevated cursor-pointer"
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Legend */}
          <div className="px-4 py-2 flex items-center gap-4 text-[10px] border-b border-border-custom bg-background/30">
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-3 rounded bg-slate-400/70" /> Unassigned
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-3 rounded bg-primary/60" /> Assigned
            </div>
            <span className="text-muted ml-auto">{filteredTasks.length} tasks</span>
          </div>

          {/* Gantt */}
          <div className="flex-1 overflow-auto">
            {loadingTasks ? (
              <div className="p-8">
                <CardSkeleton />
              </div>
            ) : filteredTasks.length === 0 ? (
              <div className="p-8">
                <EmptyState
                  title="No tasks found"
                  description="No tasks found for the selected filters."
                />
              </div>
            ) : (
              <div style={{ minWidth: periods.length * cellW }}>
                {/* Timeline header */}
                <div className="sticky top-0 z-10 bg-background/80 border-b border-border-custom">
                  {/* Year band */}
                  <div className="flex border-b border-border-custom/60">
                    <div className="w-64 shrink-0 border-r border-border-custom" />
                    <div className="flex-1 flex">
                      {periods.reduce<React.ReactElement[]>((acc, p, i) => {
                        const prev = periods[i - 1];
                        if (!prev || prev.year !== p.year) {
                          // count consecutive same-year periods
                          let count = 0;
                          for (let j = i; j < periods.length && periods[j].year === p.year; j++) count++;
                          acc.push(
                            <div
                              key={`y-${p.year}-${i}`}
                              className="flex items-center justify-center text-[10px] font-bold text-muted uppercase border-r border-border-custom/40"
                              style={{ width: count * cellW }}
                            >
                              {p.year}
                            </div>
                          );
                        }
                        return acc;
                      }, [])}
                    </div>
                  </div>
                  {/* Period labels */}
                  <div className="flex">
                    <div className="w-64 shrink-0 border-r border-border-custom px-4 py-2 text-[10px] font-bold text-muted uppercase">
                      Task
                    </div>
                    <div className="flex-1 flex">
                      {periods.map((p) => (
                        <div
                          key={p.key}
                          className="flex items-center justify-center text-[9px] font-semibold text-muted border-r border-border-custom/30 shrink-0"
                          style={{ width: cellW }}
                        >
                          {p.label}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Rows */}
                <div>
                  {ganttRows.map((g) => renderGroup(g, 0))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ───────── Timesheet sub-tab ───────── */}
      {activeTab === "timesheet" && (
        <div className="flex-1 flex flex-col min-h-0 bg-card border border-border-custom rounded-lg overflow-hidden">
          <div className="p-4 border-b border-border-custom bg-white/[0.01] flex flex-wrap items-center gap-3 shrink-0">
            <select
              value={tsPartyFilter}
              onChange={(e) => setTsPartyFilter(e.target.value)}
              className="input-field px-3 py-1.5 text-xs font-semibold focus:outline-none"
            >
              <option value="">All parties</option>
              {parties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.party_type ? ` (${p.party_type})` : ""}
                </option>
              ))}
            </select>

            <div className="flex items-center gap-1 text-xs">
              <input
                type="date"
                value={tsDateFrom}
                onChange={(e) => setTsDateFrom(e.target.value)}
                className="input-field px-2 py-1.5 text-xs focus:outline-none"
              />
              <span className="text-muted text-xs">to</span>
              <input
                type="date"
                value={tsDateTo}
                onChange={(e) => setTsDateTo(e.target.value)}
                className="input-field px-2 py-1.5 text-xs focus:outline-none"
              />
            </div>

            <input
              type="text"
              value={tsSearch}
              onChange={(e) => setTsSearch(e.target.value)}
              placeholder="Search remarks / party…"
              className="input-field px-3 py-1.5 text-xs focus:outline-none flex-1 min-w-[160px]"
            />

            <button
              onClick={() => {
                setTsDate(todayLocalISO());
                setTsProjectId(projects[0]?.id || "");
                setTsPartyQuery("");
                setTsPartyId(null);
                setTsPartyName("");
                setTsStart("09:00");
                setTsEnd("17:00");
                setTsRemarks("");
                setTsFileUrl(null);
                setTsFileName(null);
                setTsFormError(null);
                setTsDrawerOpen(true);
              }}
              className="px-4 py-1.5 bg-primary hover:bg-primary-hover text-white rounded-md text-xs font-medium transition-all cursor-pointer"
            >
              + New Timesheet
            </button>
          </div>

          <div className="flex-1 overflow-auto">
            {loadingTS ? (
              <div className="p-10 text-center text-sm text-muted">Loading timesheets…</div>
            ) : timesheets.length === 0 ? (
              <div className="py-12">
                <EmptyState
                  title="No timesheets available"
                  description="Log employee work hours, daily activities, and task allocations."
                  action={{
                    label: "+ Add Timesheet",
                    onClick: () => {
                      setTsFormError(null);
                      setTsDrawerOpen(true);
                    },
                  }}
                />
              </div>
            ) : (
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-border-custom text-muted font-semibold uppercase tracking-wider bg-background/50">
                    <th className="px-5 py-3">Date</th>
                    <th className="px-5 py-3">Party</th>
                    <th className="px-5 py-3">Start &amp; End Time</th>
                    <th className="px-5 py-3">Duration</th>
                    <th className="px-5 py-3">Project</th>
                    <th className="px-5 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-custom">
                  {timesheets.map((ts) => (
                    <tr key={ts.id} className="hover:bg-background/25 transition-all">
                      <td className="px-5 py-3 text-foreground whitespace-nowrap">{fmtDateNice(ts.entry_date)}</td>
                      <td className="px-5 py-3 font-bold text-white">{ts.party_name || "—"}</td>
                      <td className="px-5 py-3 text-muted whitespace-nowrap">
                        {fmtTime(ts.start_time)} – {fmtTime(ts.end_time)}
                        {safeHref(ts.file_url) && (
                          <a href={safeHref(ts.file_url)!} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline">
                            <Icon name="paperclip" className="w-3 h-3" /> {ts.file_name || "file"}
                          </a>
                        )}
                      </td>
                      <td className="px-5 py-3 text-success font-semibold">{fmtDuration(ts.duration_minutes)}</td>
                      <td className="px-5 py-3 text-muted">{ts.project_name || "—"}</td>
                      <td className="px-5 py-3 text-right">
                        <button
                          onClick={() => handleDeleteTimesheet(ts.id)}
                          className="text-muted hover:text-danger text-[11px] cursor-pointer"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* New Timesheet Drawer */}
      {tsDrawerOpen && (
        <div className="fixed inset-0 bg-background/80 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-md bg-card border border-border-custom rounded-lg overflow-hidden shadow-lg">
            <div className="p-6 border-b border-border-custom flex justify-between items-center">
              <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">New Timesheet</h3>
              <button onClick={() => setTsDrawerOpen(false)} className="text-muted hover:text-foreground cursor-pointer">
                <Icon name="close" className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveTimesheet} className="p-6 space-y-4 max-h-[80vh] overflow-y-auto">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Date</label>
                <input
                  type="date"
                  value={tsDate}
                  onChange={(e) => setTsDate(e.target.value)}
                  className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  required
                />
              </div>

              {/* Party search-select */}
              <div className="space-y-1 relative">
                <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">
                  Party Name
                </label>
                <input
                  type="text"
                  value={tsPartyQuery}
                  onChange={(e) => {
                    setTsPartyQuery(e.target.value);
                    setTsPartyDropdown(true);
                    setTsPartyId(null);
                    setTsPartyName("");
                  }}
                  onFocus={() => setTsPartyDropdown(true)}
                  placeholder="Search party (any type)…"
                  className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  required
                />
                {tsPartyDropdown && (
                  <div className="absolute z-30 mt-1 w-full bg-card border border-border-custom rounded-md shadow-lg max-h-48 overflow-y-auto">
                    {partyMatches.map((p) => (
                      <button
                        type="button"
                        key={p.id}
                        onClick={() => {
                          setTsPartyId(p.id);
                          setTsPartyName(p.name);
                          setTsPartyQuery(p.name);
                          setTsPartyDropdown(false);
                        }}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-elevated flex justify-between gap-2 cursor-pointer"
                      >
                        <span className="text-foreground truncate">{p.name}</span>
                        {p.party_type && <span className="text-muted shrink-0">{p.party_type}</span>}
                      </button>
                    ))}
                    {tsPartyQuery.trim() && (
                      <button
                        type="button"
                        onClick={handleCreateParty}
                        className="w-full text-left px-3 py-2 text-xs text-primary hover:bg-elevated border-t border-border-custom cursor-pointer"
                      >
                        + Create Party “{tsPartyQuery.trim()}”
                      </button>
                    )}
                  </div>
                )}
                {tsPartyId && <div className="text-[10px] text-success mt-1">Selected: {tsPartyName}</div>}
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">
                  Project <span className="text-danger">*</span>
                </label>
                <select
                  value={tsProjectId}
                  onChange={(e) => setTsProjectId(e.target.value)}
                  required
                  className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                >
                  <option value="" disabled>
                    Select project…
                  </option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                {projects.length === 0 && (
                  <FieldHint text="No projects found. Create a project in Projects." href={`/c/${companyId}/projects`} linkLabel="Go to Projects" />
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Start Time</label>
                  <input
                    type="time"
                    value={tsStart}
                    onChange={(e) => setTsStart(e.target.value)}
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">End Time</label>
                  <input
                    type="time"
                    value={tsEnd}
                    onChange={(e) => setTsEnd(e.target.value)}
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-xs font-medium text-muted uppercase tracking-wider">
                  <span>Computed Duration</span>
                  <span className="text-success font-semibold">
                    {fmtDuration(
                      (() => {
                        if (!tsStart || !tsEnd) return null;
                        const [sh, sm] = tsStart.split(":").map(Number);
                        const [eh, em] = tsEnd.split(":").map(Number);
                        let diff = eh * 60 + em - (sh * 60 + sm);
                        if (diff < 0) diff += 24 * 60;
                        return diff;
                      })()
                    )}
                  </span>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Remarks</label>
                <textarea
                  value={tsRemarks}
                  onChange={(e) => setTsRemarks(e.target.value)}
                  rows={2}
                  placeholder="Remarks…"
                  className="input-field w-full px-3 py-2 text-xs focus:outline-none resize-none"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">
                  Upload Files
                </label>
                <input
                  type="file"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFileUpload(f);
                  }}
                  disabled={!tsProjectId || tsUploading}
                  className="input-field w-full px-3 py-2 text-xs focus:outline-none disabled:opacity-50"
                />
                {!tsProjectId && (
                  <p className="text-[10px] text-muted">Select a project first to enable upload.</p>
                )}
                {tsUploading && <p className="text-[10px] text-muted">Uploading…</p>}
                {tsFileName && !tsUploading && (
                  <p className="text-[10px] text-success">Attached: {tsFileName}</p>
                )}
              </div>

              <button
                type="submit"
                disabled={tsSaving || !tsProjectId || !tsPartyId}
                className="w-full py-2 bg-primary hover:bg-primary-hover text-white font-medium text-sm rounded-md transition-all mt-2 cursor-pointer disabled:opacity-50"
              >
                {tsSaving ? "Saving…" : "Save Timesheet"}
              </button>
              {tsFormError && (
                <p className="text-xs text-danger mt-2">{tsFormError}</p>
              )}
            </form>
          </div>
        </div>
      )}
      </PageShell>
      </div>
    </div>
  );
}
