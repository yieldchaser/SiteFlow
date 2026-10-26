"use client";

import React, { useEffect, useMemo, useState } from "react";
import { getApiHost, readErrorDetail } from "@/lib/api";
import { authHeaders, formatDate, todayLocalISO } from "@/lib/siteflow";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import SegmentedTabs from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import Badge from "@/components/ui/Badge";
import Icon from "@/components/marketing/Icon";

interface Todo {
  id: string;
  title: string;
  due_date: string | null;
  repeat_type: string;
  type: string | null;
  status: string;
  project_id: string | null;
  assignee_ids: string[];
  task_name?: string | null;
  url?: string | null;
}

interface Option {
  id: string;
  name: string;
}

const TODO_TYPES = ["General", "Task", "Reminder", "Meeting Action", "Payment", "Quality Check", "Attendance"];
// Older to-dos were saved as "task" or "reminder"; show and filter them under the same names as new ones.
const typeLabel = (type?: string | null) =>
  TODO_TYPES.find((t) => t.toLowerCase() === (type || "General").toLowerCase()) || type || "General";
const REPEATS: Record<string, string> = { none: "Does not repeat", daily: "Every day", weekly: "Every week", monthly: "Every month" };

const dueDay = (t: Todo) => (t.due_date ? t.due_date.slice(0, 10) : "");

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function SummaryTile({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-lg border border-border-custom bg-card px-4 py-3">
      <div className="text-[10px] font-bold uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-xl font-extrabold mt-0.5 ${value > 0 ? tone : "text-foreground"}`}>{value}</div>
    </div>
  );
}

type Form = { title: string; due_date: string; assignee: string; project_id: string; type: string; repeat_type: string; url: string };

/**
 * The to-do list. With `fixedProjectId` it shows one project's to-dos and new
 * ones belong to that project; without it, every to-do in the company.
 */
export default function TodoBoard({ companyId, fixedProjectId }: { companyId: string; fixedProjectId?: string }) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [projects, setProjects] = useState<Option[]>([]);
  const [team, setTeam] = useState<Option[]>([]);

  const [tab, setTab] = useState<"pending" | "done">("pending");
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("All");
  const [filterWho, setFilterWho] = useState("All");

  const [editing, setEditing] = useState<Todo | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const blank = (): Form => ({
    title: "", due_date: todayLocalISO(), assignee: "", project_id: fixedProjectId || "", type: "General", repeat_type: "none", url: "",
  });
  const [form, setForm] = useState<Form>(blank);

  const api = getApiHost();
  const today = todayLocalISO();

  const load = async () => {
    try {
      const q = fixedProjectId ? `?project_id=${fixedProjectId}` : "";
      const res = await fetch(`${api}/apis/v3/todos/company/${companyId}${q}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTodos(await res.json());
      setLoadError(false);
    } catch (e) {
      console.error("Failed to load to-dos", e);
      setLoadError(true);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    if (!companyId) return;
    load();
    fetch(`${api}/apis/v3/crm/team-members/${companyId}`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setTeam(Array.isArray(d) ? d : []))
      .catch(() => undefined);
    if (!fixedProjectId) {
      fetch(`${api}/apis/v3/planning/projects?company_id=${companyId}`, { headers: authHeaders() })
        .then((r) => (r.ok ? r.json() : []))
        .then((d) => setProjects(Array.isArray(d) ? d.map((p: Option) => ({ id: p.id, name: p.name })) : []))
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, fixedProjectId]);

  const teamName = (id: string) => team.find((m) => m.id === id)?.name || "Team member";
  const projectName = (id: string | null) => (id ? projects.find((p) => p.id === id)?.name || "" : "");

  const when = (t: Todo): { label: string; tone: "danger" | "warning" | "info" | null } => {
    const d = dueDay(t);
    if (!d || t.status === "done") return { label: "", tone: null };
    if (d < today) return { label: "Overdue", tone: "danger" };
    if (d === today) return { label: "Due today", tone: "warning" };
    if (d === addDays(today, 1)) return { label: "Tomorrow", tone: "info" };
    return { label: "", tone: null };
  };

  const pending = todos.filter((t) => t.status !== "done");
  const counts = {
    overdue: pending.filter((t) => dueDay(t) && dueDay(t) < today).length,
    today: pending.filter((t) => dueDay(t) === today).length,
    week: pending.filter((t) => dueDay(t) > today && dueDay(t) <= addDays(today, 7)).length,
  };

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = todos.filter((t) => {
      if (tab === "done" ? t.status !== "done" : t.status === "done") return false;
      if (filterType !== "All" && typeLabel(t.type) !== filterType) return false;
      if (filterWho === "none" && t.assignee_ids.length > 0) return false;
      if (filterWho !== "All" && filterWho !== "none" && !t.assignee_ids.includes(filterWho)) return false;
      if (q && !t.title.toLowerCase().includes(q) && !projectName(t.project_id).toLowerCase().includes(q)) return false;
      return true;
    });
    // Pending: soonest first, undated last. Completed: most recently due first.
    return list.sort((a, b) => {
      const da = dueDay(a) || "9999-12-31";
      const db = dueDay(b) || "9999-12-31";
      return tab === "done" ? db.localeCompare(da) : da.localeCompare(db);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todos, tab, filterType, filterWho, search, projects]);

  const openNew = () => {
    setEditing(null);
    setForm(blank());
    setFormOpen(true);
  };

  const openEdit = (t: Todo) => {
    setEditing(t);
    setForm({
      title: t.title,
      due_date: dueDay(t),
      assignee: t.assignee_ids[0] || "",
      project_id: t.project_id || "",
      type: typeLabel(t.type),
      repeat_type: t.repeat_type || "none",
      url: t.url || "",
    });
    setFormOpen(true);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    setSaving(true);
    const body: Record<string, unknown> = {
      title: form.title.trim(),
      type: form.type,
      repeat_type: form.repeat_type,
      assignee_ids: form.assignee ? [form.assignee] : [],
      url: form.url.trim() || null,
    };
    // An unchanged past due date is left alone: the server refuses new past dates.
    if (!editing || form.due_date !== dueDay(editing)) body.due_date = form.due_date || null;
    if (!editing) {
      body.company_id = companyId;
      if (form.project_id) body.project_id = form.project_id;
    }
    try {
      const res = await fetch(editing ? `${api}/apis/v3/todos/${editing.id}` : `${api}/apis/v3/todos/`, {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        alert((await readErrorDetail(res)) || "Could not save the to-do");
        return;
      }
      setFormOpen(false);
      load();
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (t: Todo) => {
    const next = t.status === "done" ? "pending" : "done";
    setTodos((prev) => prev.map((x) => (x.id === t.id ? { ...x, status: next } : x)));
    const res = await fetch(`${api}/apis/v3/todos/${t.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      body: JSON.stringify({ status: next }),
    });
    if (!res.ok) alert((await readErrorDetail(res)) || "Could not update the to-do");
    // A repeating to-do creates its next occurrence when ticked, so reload.
    load();
  };

  const remove = async (t: Todo) => {
    if (!confirm(`Delete "${t.title}"?`)) return;
    const res = await fetch(`${api}/apis/v3/todos/${t.id}`, { method: "DELETE", headers: authHeaders() });
    if (!res.ok) alert((await readErrorDetail(res)) || "Could not delete the to-do");
    load();
  };

  const inputCls = "input-field w-full px-3 py-2 text-xs focus:outline-none";
  const labelCls = "text-xs font-medium text-muted uppercase tracking-wider block mb-1.5";

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader title="To Do" subtitle={fixedProjectId ? "Follow-ups for this project, with who owns each one" : "Follow-ups across your projects, with who owns each one and when it is due"}>
        <button onClick={openNew} className="px-3.5 py-1.5 bg-primary hover:bg-primary-hover text-white rounded-md text-xs font-medium transition-all cursor-pointer">
          + New To Do
        </button>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">
          <div className="space-y-5">
            {loadError && (
              <div className="rounded-md border border-warning/20 bg-warning/10 text-warning text-xs px-4 py-2">
                Could not load to-dos. Check your connection and refresh.
              </div>
            )}

            <div className="grid grid-cols-3 gap-3">
              <SummaryTile label="Overdue" value={counts.overdue} tone="text-danger" />
              <SummaryTile label="Due today" value={counts.today} tone="text-warning" />
              <SummaryTile label="Next 7 days" value={counts.week} tone="text-primary" />
            </div>

            <div className="flex flex-col md:flex-row justify-between items-stretch md:items-center gap-3">
              <SegmentedTabs
                tabs={[
                  { id: "pending", label: `Pending (${pending.length})` },
                  { id: "done", label: "Completed" },
                ]}
                activeTab={tab}
                onChange={(t) => setTab(t as "pending" | "done")}
              />
              <div className="flex flex-wrap items-center gap-2">
                <select value={filterWho} onChange={(e) => setFilterWho(e.target.value)} className="input-field px-3 py-2 text-xs font-semibold focus:outline-none">
                  <option value="All">Everyone</option>
                  <option value="none">Not assigned</option>
                  {team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="input-field px-3 py-2 text-xs font-semibold focus:outline-none">
                  <option value="All">All Types</option>
                  {TODO_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <input
                  type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder={fixedProjectId ? "Search to-dos" : "Search to-dos or projects"}
                  className="input-field px-4 py-2 text-xs font-semibold focus:outline-none placeholder-muted w-full md:w-56"
                />
              </div>
            </div>

            <div className="rounded-lg border border-border-custom bg-card overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-border-custom text-muted font-semibold uppercase tracking-wider bg-background/50">
                    <th className="px-4 py-3 w-12 text-center">Done</th>
                    <th className="px-4 py-3">To-do</th>
                    <th className="px-4 py-3">Due</th>
                    <th className="px-4 py-3">Assigned to</th>
                    {!fixedProjectId && <th className="px-4 py-3">Project</th>}
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-custom">
                  {!loaded ? (
                    [0, 1, 2].map((i) => (
                      <tr key={i}><td colSpan={7} className="px-4 py-4"><div className="h-4 rounded bg-elevated animate-pulse" /></td></tr>
                    ))
                  ) : shown.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="p-8">
                        <EmptyState
                          title={tab === "done" ? "Nothing completed yet" : "Nothing pending"}
                          description={todos.length === 0 ? "Add the follow-ups your team must not forget, with an owner and a due date." : "No to-dos match these filters."}
                          action={todos.length === 0 ? { label: "New To Do", onClick: openNew } : undefined}
                        />
                      </td>
                    </tr>
                  ) : (
                    shown.map((t) => {
                      const w = when(t);
                      return (
                        <tr key={t.id} className={`hover:bg-elevated/20 transition-colors ${w.tone === "danger" ? "bg-danger/5" : ""}`}>
                          <td className="px-4 py-3 text-center">
                            <input type="checkbox" checked={t.status === "done"} onChange={() => toggle(t)}
                              className="h-4 w-4 accent-primary cursor-pointer" title={t.status === "done" ? "Mark as pending" : "Mark as done"} />
                          </td>
                          <td className="px-4 py-3">
                            <div className={`font-semibold ${t.status === "done" ? "line-through text-muted" : "text-foreground"}`}>
                              {t.title}
                              {t.url && (
                                <a href={t.url} target="_blank" rel="noopener noreferrer" className="ml-2 text-primary font-medium hover:underline">Open link</a>
                              )}
                            </div>
                            {(t.repeat_type && t.repeat_type !== "none") || t.task_name ? (
                              <div className="text-[10px] text-muted mt-0.5">
                                {t.repeat_type && t.repeat_type !== "none" ? REPEATS[t.repeat_type] || t.repeat_type : ""}
                                {t.repeat_type && t.repeat_type !== "none" && t.task_name ? " · " : ""}
                                {t.task_name ? `Schedule task: ${t.task_name}` : ""}
                              </div>
                            ) : null}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <div className={w.tone === "danger" ? "text-danger font-semibold" : "text-muted"}>{t.due_date ? formatDate(dueDay(t)) : "No date"}</div>
                            {w.tone && <Badge tone={w.tone} className="mt-1">{w.label}</Badge>}
                          </td>
                          <td className="px-4 py-3 text-muted font-medium">
                            {t.assignee_ids.length ? t.assignee_ids.map(teamName).join(", ") : "Not assigned"}
                          </td>
                          {!fixedProjectId && <td className="px-4 py-3 text-muted">{projectName(t.project_id) || "Company-wide"}</td>}
                          <td className="px-4 py-3">
                            <span className="bg-elevated border border-border-custom text-[10px] font-semibold px-2 py-0.5 rounded text-foreground whitespace-nowrap">
                              {typeLabel(t.type)}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap space-x-1.5">
                            <button onClick={() => openEdit(t)} className="px-2.5 py-1 bg-primary/10 text-primary border border-primary/20 text-[11px] font-semibold rounded cursor-pointer">Edit</button>
                            <button onClick={() => remove(t)} className="px-2.5 py-1 bg-elevated border border-border-custom text-muted hover:text-danger text-[11px] font-semibold rounded cursor-pointer">Delete</button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </PageShell>
      </div>

      {formOpen && (
        <div className="fixed inset-0 bg-background/80 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-md bg-card border border-border-custom rounded-lg overflow-hidden shadow-lg relative">
            <div className="p-5 border-b border-border-custom flex justify-between items-center">
              <h3 className="text-sm font-bold text-foreground uppercase tracking-wider">{editing ? "Edit To Do" : "New To Do"}</h3>
              <button onClick={() => setFormOpen(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>
            <form onSubmit={save} className="p-5 space-y-4">
              <div>
                <label className={labelCls}>What needs doing *</label>
                <input type="text" required maxLength={500} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="e.g. Send RA bill 3 to the client" className={inputCls} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Due date</label>
                  <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Repeats</label>
                  <select value={form.repeat_type} onChange={(e) => setForm({ ...form, repeat_type: e.target.value })} className={inputCls}>
                    {Object.entries(REPEATS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className={labelCls}>Assigned to</label>
                <select value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })} className={inputCls}>
                  <option value="">Not assigned</option>
                  {team.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <div className={`grid grid-cols-1 gap-4 ${fixedProjectId || editing ? "" : "md:grid-cols-2"}`}>
                {!fixedProjectId && !editing && (
                  <div>
                    <label className={labelCls}>Project</label>
                    <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })} className={inputCls}>
                      <option value="">Company-wide</option>
                      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className={labelCls}>Type</label>
                  <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className={inputCls}>
                    {(TODO_TYPES.includes(form.type) ? TODO_TYPES : [form.type, ...TODO_TYPES]).map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className={labelCls}>Link (optional)</label>
                <input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder="https://... a drawing, document or form" className={inputCls} />
              </div>
              {form.repeat_type !== "none" && (
                <p className="text-[11px] text-muted">When you tick it done, the next one is created automatically.</p>
              )}
              <button type="submit" disabled={saving}
                className="w-full py-2 bg-primary hover:bg-primary-hover text-white font-medium text-sm rounded-md transition-all cursor-pointer disabled:opacity-50">
                {saving ? "Saving..." : editing ? "Save changes" : "Save To Do"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
