"use client";
import Badge, { type BadgeTone } from "@/components/ui/Badge";
import { getApiHost, readErrorDetail } from "@/lib/api";
import { authHeaders, formatDate } from "@/lib/siteflow";
import React, { useState, useEffect } from "react";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ActionItem {
  text: string;
  owner?: string | null;
  due_date?: string | null;
  done: boolean;
}

interface MoM {
  id: string;
  company_id: string;
  project_id: string | null;
  title: string | null;
  meeting_date: string | null;
  venue: string | null;
  action_items: ActionItem[];
  type: string;
  status: string;
  attendees: string[];
  notes: string | null;
  created_by: string | null;
  created_at: string | null;
}

interface ProjectOption {
  id: string;
  name: string;
}

const MOM_TYPES = ["Regular", "Review", "Client Meeting", "Internal"] as const;
const MOM_STATUSES = ["Open", "Action Pending", "Closed", "Draft"] as const;

const statusTones: Record<string, BadgeTone> = {
  Open: "danger",
  "Action Pending": "warning",
  Closed: "success",
  Draft: "neutral",
};

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const isOverdue = (a: ActionItem) => !a.done && !!a.due_date && a.due_date < todayIso();

const emptyForm = (projectId: string | null) => ({
  project_id: projectId || "",
  title: "",
  meeting_date: todayIso(),
  venue: "",
  type: "Regular" as string,
  status: "Open" as string,
  attendees: "",
  notes: "",
  action_items: [] as ActionItem[],
});

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * The minutes-of-meeting register. With `fixedProjectId` it lists and records
 * one project's meetings (the project page); without it, the whole company's.
 */
export default function MomRegister({
  companyId,
  fixedProjectId,
  defaultProjectId,
}: {
  companyId: string;
  fixedProjectId?: string;
  defaultProjectId?: string | null;
}) {
  const [moms, setMoms] = useState<MoM[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [isOffline, setIsOffline] = useState(false);

  const [filterDate, setFilterDate] = useState("");
  const [filterAttendee, setFilterAttendee] = useState("");
  const [filterProject, setFilterProject] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterType, setFilterType] = useState("all");

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<MoM | null>(null);
  const [viewing, setViewing] = useState<MoM | null>(null);
  const [saving, setSaving] = useState(false);
  const [todoAdded, setTodoAdded] = useState<Record<string, boolean>>({});

  const startProject = fixedProjectId || defaultProjectId || null;
  const [form, setForm] = useState(emptyForm(startProject));

  const validCompany = !!companyId && companyId !== "e0000000-0000-0000-0000-000000000000";

  const loadProjects = async () => {
    if (!validCompany) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/planning/projects?company_id=${companyId}`, { headers: authHeaders() });
      if (res.ok) {
        const data: Array<{ id: string; name: string }> = await res.json();
        setProjects(data.map((p) => ({ id: p.id, name: p.name })));
      }
    } catch (e) {
      console.error("Failed to fetch projects", e);
    }
  };

  const loadMoms = async () => {
    if (!validCompany) return;
    const q = new URLSearchParams();
    if (fixedProjectId) q.set("project_id", fixedProjectId);
    else if (filterProject !== "all") q.set("project_id", filterProject);
    if (filterStatus !== "all") q.set("status", filterStatus);
    if (filterType !== "all") q.set("type", filterType);
    if (filterAttendee.trim()) q.set("attendee", filterAttendee.trim());
    if (filterDate) q.set("date", filterDate);
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/mom/${companyId}?${q.toString()}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: MoM[] = await res.json();
      setMoms(data);
      setViewing((cur) => (cur ? data.find((m) => m.id === cur.id) ?? cur : cur));
      setIsOffline(false);
    } catch (e) {
      console.error("Failed to fetch MOMs", e);
      setIsOffline(true);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  useEffect(() => {
    // Typing in the attendee box should not fire a request per keystroke.
    const t = setTimeout(loadMoms, filterAttendee ? 300 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, fixedProjectId, filterProject, filterStatus, filterType, filterAttendee, filterDate]);

  const projectName = (id: string | null) => {
    if (!id) return "Company-wide";
    return projects.find((x) => x.id === id)?.name ?? "Project";
  };

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm(startProject));
    setShowForm(true);
  };

  const openEdit = (m: MoM) => {
    setViewing(null);
    setEditing(m);
    setForm({
      project_id: m.project_id || "",
      title: m.title || "",
      meeting_date: m.meeting_date || todayIso(),
      venue: m.venue || "",
      type: m.type,
      status: m.status,
      attendees: (m.attendees || []).join(", "),
      notes: m.notes || "",
      action_items: (m.action_items || []).map((a) => ({ ...a })),
    });
    setShowForm(true);
  };

  const saveMom = async (id: string | null, body: Record<string, unknown>) => {
    const url = id ? `${getApiHost()}/apis/v3/mom/${companyId}/${id}` : `${getApiHost()}/apis/v3/mom/${companyId}`;
    const res = await fetch(url, {
      method: id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      alert((await readErrorDetail(res)) || "Could not save the minutes");
      return null;
    }
    return (await res.json()) as MoM;
  };

  const handleSave = async () => {
    const actionItems = form.action_items
      .filter((a) => a.text.trim())
      .map((a) => ({ text: a.text.trim(), owner: a.owner?.trim() || null, due_date: a.due_date || null, done: a.done }));
    const body = {
      project_id: form.project_id || null,
      title: form.title.trim() || null,
      meeting_date: form.meeting_date || null,
      venue: form.venue.trim() || null,
      type: form.type,
      status: form.status,
      attendees: form.attendees.split(",").map((a) => a.trim()).filter(Boolean),
      notes: form.notes.trim() || null,
      action_items: actionItems,
    };
    setSaving(true);
    try {
      const saved = await saveMom(editing?.id ?? null, body);
      if (saved) {
        setShowForm(false);
        setEditing(null);
        loadMoms();
      }
    } finally {
      setSaving(false);
    }
  };

  const toggleItem = async (m: MoM, index: number) => {
    const items = m.action_items.map((a, i) => (i === index ? { ...a, done: !a.done } : a));
    const optimistic = { ...m, action_items: items };
    setViewing(optimistic);
    setMoms((prev) => prev.map((x) => (x.id === m.id ? optimistic : x)));
    const saved = await saveMom(m.id, { action_items: items });
    if (!saved) loadMoms();
  };

  const addToTodo = async (m: MoM, a: ActionItem, index: number) => {
    // The to-do list refuses a due date in the past; an overdue point becomes due today.
    const due = a.due_date && a.due_date >= todayIso() ? a.due_date : todayIso();
    const res = await fetch(`${getApiHost()}/apis/v3/todos/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      body: JSON.stringify({
        company_id: companyId,
        project_id: m.project_id,
        title: a.owner ? `${a.text} (${a.owner})` : a.text,
        due_date: due,
        type: "Meeting Action",
      }),
    });
    if (res.ok) setTodoAdded((prev) => ({ ...prev, [`${m.id}:${index}`]: true }));
    else alert((await readErrorDetail(res)) || "Could not add to the to-do list");
  };

  const handleDelete = async (m: MoM) => {
    if (!confirm(`Delete the minutes "${m.title || m.type}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/mom/${companyId}/${m.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (res.ok) {
        setViewing(null);
        loadMoms();
      } else {
        alert((await readErrorDetail(res)) || "Failed to delete MOM");
      }
    } catch (e) {
      console.error("Failed to delete MOM", e);
    }
  };

  const setItem = (i: number, patch: Partial<ActionItem>) =>
    setForm((prev) => ({ ...prev, action_items: prev.action_items.map((a, j) => (j === i ? { ...a, ...patch } : a)) }));

  const inputCls = "w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-primary";
  const labelCls = "text-[10px] uppercase font-bold text-muted block mb-1";
  const filterCls = "w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-xs text-foreground";

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <main className="flex-1 flex flex-col overflow-hidden">
        <PageHeader
          title="Minutes of Meeting"
          subtitle={fixedProjectId ? "Meetings held for this project, with their action points" : "Every meeting across your projects, with action points and who owns them"}
        >
          <button onClick={openCreate}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-xs font-bold hover:bg-primary/90 transition-all cursor-pointer">
            + New MOM
          </button>
        </PageHeader>

        {isOffline && (
          <div className="px-6 py-2.5 bg-warning/10 border-b border-warning/20 text-warning text-xs">
            The meeting register could not be loaded. Check your connection and refresh.
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          <PageShell width="wide">
            <div className="rounded-md border border-border-custom bg-card p-4">
              <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between mb-3">
                <div>
                  <h3 className="text-xs font-bold text-muted uppercase tracking-wider">MOM Register</h3>
                  <p className="text-[10px] text-muted mt-1">Find minutes by meeting date, attendee, project, type or status.</p>
                </div>
                <div className="text-[10px] text-muted font-medium">{moms.length} meeting{moms.length === 1 ? "" : "s"} shown</div>
              </div>
              <div className={`grid grid-cols-1 gap-3 ${fixedProjectId ? "md:grid-cols-4" : "md:grid-cols-5"}`}>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-muted tracking-wider">Meeting date</label>
                  <input type="date" value={filterDate} onChange={(e) => setFilterDate(e.target.value)} className={filterCls} />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-muted tracking-wider">Attendee</label>
                  <input value={filterAttendee} onChange={(e) => setFilterAttendee(e.target.value)}
                    placeholder="Any part of a name" className={`${filterCls} placeholder:text-muted`} />
                </div>
                {!fixedProjectId && (
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase font-bold text-muted tracking-wider">Project</label>
                    <select value={filterProject} onChange={(e) => setFilterProject(e.target.value)} className={filterCls}>
                      <option value="all">All Projects</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-muted tracking-wider">Type</label>
                  <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className={filterCls}>
                    <option value="all">All Types</option>
                    {MOM_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-muted tracking-wider">Status</label>
                  <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className={filterCls}>
                    <option value="all">All Statuses</option>
                    {MOM_STATUSES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="bg-card border border-border-custom rounded-md overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-elevated border-b border-border-custom">
                    <tr>
                      <th className="px-5 py-3 font-semibold">Meeting</th>
                      {!fixedProjectId && <th className="px-5 py-3 font-semibold">Project</th>}
                      <th className="px-5 py-3 font-semibold">Attendees</th>
                      <th className="px-5 py-3 font-semibold">Action points</th>
                      <th className="px-5 py-3 font-semibold">Status</th>
                      <th className="px-5 py-3 font-semibold text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!loaded ? (
                      [0, 1, 2].map((i) => (
                        <tr key={i} className="border-b border-border-custom">
                          <td colSpan={6} className="px-5 py-4"><div className="h-4 rounded bg-elevated animate-pulse" /></td>
                        </tr>
                      ))
                    ) : moms.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="p-8">
                          <EmptyState
                            title="No meetings recorded"
                            description="Record who attended, what was decided, and the action points with an owner and a due date."
                            action={{ label: "+ New MOM", onClick: () => openCreate() }}
                          />
                        </td>
                      </tr>
                    ) : (
                      moms.map((m) => {
                        const items = m.action_items || [];
                        const done = items.filter((a) => a.done).length;
                        const overdue = items.filter(isOverdue).length;
                        return (
                          <tr key={m.id} onClick={() => setViewing(m)} className="border-b border-border-custom hover:bg-elevated transition-all cursor-pointer">
                            <td className="px-5 py-3">
                              <div className="font-bold text-foreground">{m.title || `${m.type} meeting`}</div>
                              <div className="text-[10px] text-muted mt-0.5">
                                {m.meeting_date ? formatDate(m.meeting_date) : "No date"} · {m.type}
                                {m.venue ? ` · ${m.venue}` : ""}
                              </div>
                            </td>
                            {!fixedProjectId && <td className="px-5 py-3 text-foreground">{projectName(m.project_id)}</td>}
                            <td className="px-5 py-3 text-muted max-w-[220px]">
                              <div className="truncate" title={(m.attendees || []).join(", ")}>
                                {(m.attendees || []).length ? (m.attendees || []).join(", ") : "Not recorded"}
                              </div>
                            </td>
                            <td className="px-5 py-3">
                              {items.length === 0 ? (
                                <span className="text-muted">None</span>
                              ) : (
                                <div className="flex items-center gap-2 whitespace-nowrap">
                                  <span className="text-foreground font-semibold">{done} of {items.length} done</span>
                                  {overdue > 0 && <Badge tone="danger">{overdue} overdue</Badge>}
                                </div>
                              )}
                            </td>
                            <td className="px-5 py-3 whitespace-nowrap"><Badge tone={statusTones[m.status] || "neutral"}>{m.status}</Badge></td>
                            <td className="px-5 py-3 text-right whitespace-nowrap space-x-2" onClick={(e) => e.stopPropagation()}>
                              <button onClick={() => setViewing(m)}
                                className="px-3 py-1.5 rounded-lg bg-elevated text-foreground text-[10px] font-bold border border-border-custom hover:border-primary cursor-pointer">
                                View
                              </button>
                              <button onClick={() => openEdit(m)}
                                className="px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-[10px] font-bold border border-primary/20 hover:bg-primary/20 cursor-pointer">
                                Edit
                              </button>
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
      </main>

      {/* View one meeting */}
      {viewing && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50" onClick={() => setViewing(null)}>
          <div className="bg-card border border-border-custom rounded-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 space-y-5 text-left" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-extrabold text-foreground">{viewing.title || `${viewing.type} meeting`}</h3>
                <p className="text-xs text-muted mt-1">
                  {viewing.meeting_date ? formatDate(viewing.meeting_date) : "No date"} · {viewing.type}
                  {viewing.venue ? ` · ${viewing.venue}` : ""} · {projectName(viewing.project_id)}
                </p>
              </div>
              <Badge tone={statusTones[viewing.status] || "neutral"}>{viewing.status}</Badge>
            </div>

            <div>
              <h4 className={labelCls}>Attendees</h4>
              {(viewing.attendees || []).length ? (
                <div className="flex flex-wrap gap-1.5">
                  {viewing.attendees.map((a) => (
                    <span key={a} className="text-[11px] px-2 py-0.5 rounded-full bg-elevated border border-border-custom text-foreground">{a}</span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted">Not recorded</p>
              )}
            </div>

            <div>
              <h4 className={labelCls}>Discussion</h4>
              <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap">{viewing.notes || "No notes recorded."}</p>
            </div>

            <div>
              <h4 className={labelCls}>Action points</h4>
              {(viewing.action_items || []).length === 0 ? (
                <p className="text-xs text-muted">No action points. Use Edit to add who does what by when.</p>
              ) : (
                <div className="divide-y divide-border-custom border border-border-custom rounded-md">
                  {viewing.action_items.map((a, i) => {
                    const key = `${viewing.id}:${i}`;
                    return (
                      <div key={i} className="flex items-start gap-3 p-3">
                        <input type="checkbox" checked={a.done} onChange={() => toggleItem(viewing, i)}
                          className="mt-0.5 h-4 w-4 cursor-pointer" title={a.done ? "Mark as not done" : "Mark as done"} />
                        <div className="flex-1 min-w-0">
                          <div className={`text-xs ${a.done ? "line-through text-muted" : "text-foreground font-semibold"}`}>{a.text}</div>
                          <div className="text-[10px] text-muted mt-0.5 flex flex-wrap gap-x-3">
                            <span>Owner: {a.owner || "Not set"}</span>
                            <span className={isOverdue(a) ? "text-danger font-bold" : ""}>
                              Due: {a.due_date ? formatDate(a.due_date) : "No date"}{isOverdue(a) ? " (overdue)" : ""}
                            </span>
                          </div>
                        </div>
                        {!a.done && (
                          todoAdded[key] ? (
                            <span className="text-[10px] text-success font-bold shrink-0">Added to To-Do</span>
                          ) : (
                            <button onClick={() => addToTodo(viewing, a, i)}
                              className="text-[10px] font-bold text-primary hover:underline shrink-0 cursor-pointer">
                              Add to To-Do
                            </button>
                          )
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="text-[10px] text-muted">
              Recorded by {viewing.created_by || "a team member"}
              {viewing.created_at ? ` on ${formatDate(viewing.created_at)}` : ""}
            </div>

            <div className="flex gap-3 justify-between pt-1">
              <button onClick={() => handleDelete(viewing)} className="px-4 py-2 rounded-md text-danger text-xs font-bold hover:bg-danger/10 cursor-pointer">Delete</button>
              <div className="flex gap-3">
                <button onClick={() => setViewing(null)} className="px-4 py-2 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer">Close</button>
                <button onClick={() => openEdit(viewing)} className="bg-primary hover:opacity-90 text-white px-5 py-2 rounded-md text-xs font-bold cursor-pointer">Edit</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create / edit */}
      {showForm && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-card border border-border-custom rounded-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 space-y-4 text-left">
            <div>
              <h3 className="text-sm font-extrabold text-foreground">{editing ? "Edit Minutes of Meeting" : "New Minutes of Meeting"}</h3>
              <p className="text-xs text-muted mt-1">Who met, what was decided, and who does what by when.</p>
            </div>
            <div className="space-y-3">
              <div>
                <label className={labelCls}>Meeting title</label>
                <input type="text" placeholder="e.g. Monthly progress review with client" maxLength={255}
                  value={form.title} onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))} className={inputCls} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Meeting date</label>
                  <input type="date" required value={form.meeting_date}
                    onChange={(e) => setForm((p) => ({ ...p, meeting_date: e.target.value }))} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Venue</label>
                  <input type="text" placeholder="e.g. Site office, Tower A" maxLength={255}
                    value={form.venue} onChange={(e) => setForm((p) => ({ ...p, venue: e.target.value }))} className={inputCls} />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {!fixedProjectId && (
                  <div>
                    <label className={labelCls}>Project</label>
                    <select value={form.project_id} onChange={(e) => setForm((p) => ({ ...p, project_id: e.target.value }))} className={inputCls}>
                      <option value="">Company-wide (no project)</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label className={labelCls}>Type</label>
                  <select value={form.type} onChange={(e) => setForm((p) => ({ ...p, type: e.target.value }))} className={inputCls}>
                    {MOM_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Status</label>
                  <select value={form.status} onChange={(e) => setForm((p) => ({ ...p, status: e.target.value }))} className={inputCls}>
                    {MOM_STATUSES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className={labelCls}>Attendees</label>
                <input type="text" placeholder="Names separated by commas, e.g. R. Kulkarni, Ar. Mehta (Architect)"
                  value={form.attendees} onChange={(e) => setForm((p) => ({ ...p, attendees: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Discussion and decisions</label>
                <textarea placeholder="What was discussed and agreed"
                  value={form.notes} onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
                  rows={5} className={inputCls} />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className={labelCls}>Action points</label>
                  <button type="button"
                    onClick={() => setForm((p) => ({ ...p, action_items: [...p.action_items, { text: "", owner: "", due_date: "", done: false }] }))}
                    className="text-[11px] font-bold text-primary hover:underline cursor-pointer">
                    + Add action point
                  </button>
                </div>
                {form.action_items.length === 0 ? (
                  <p className="text-[11px] text-muted">None yet. Add each task agreed in the meeting with the person responsible and a due date.</p>
                ) : (
                  <div className="space-y-2">
                    {form.action_items.map((a, i) => (
                      <div key={i} className="grid grid-cols-12 gap-2 items-center">
                        <input type="checkbox" checked={a.done} onChange={(e) => setItem(i, { done: e.target.checked })}
                          className="col-span-1 h-4 w-4 justify-self-center cursor-pointer" title="Done" />
                        <input type="text" placeholder="What needs to be done" value={a.text}
                          onChange={(e) => setItem(i, { text: e.target.value })} className={`${inputCls} col-span-11 md:col-span-5`} />
                        <input type="text" placeholder="Owner" value={a.owner || ""}
                          onChange={(e) => setItem(i, { owner: e.target.value })} className={`${inputCls} col-span-5 md:col-span-3`} />
                        <input type="date" value={a.due_date || ""}
                          onChange={(e) => setItem(i, { due_date: e.target.value })} className={`${inputCls} col-span-5 md:col-span-2`} />
                        <button type="button" title="Remove"
                          onClick={() => setForm((p) => ({ ...p, action_items: p.action_items.filter((_, j) => j !== i) }))}
                          className="col-span-2 md:col-span-1 text-muted hover:text-danger text-sm font-bold cursor-pointer">
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <button onClick={() => { setShowForm(false); setEditing(null); }} className="px-4 py-2 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer">Cancel</button>
              <button onClick={handleSave} disabled={saving || !form.meeting_date}
                className="bg-primary hover:opacity-90 text-white px-5 py-2 rounded-md text-xs font-bold cursor-pointer disabled:opacity-50">
                {saving ? "Saving..." : "Save MOM"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
