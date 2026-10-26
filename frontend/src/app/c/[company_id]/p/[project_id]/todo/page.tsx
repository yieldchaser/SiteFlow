"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getApi, authHeaders, resolveCompanyId, initials, formatDate, formatLabel } from "@/lib/siteflow";
import { readErrorDetail } from "@/lib/api";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import Icon from "@/components/marketing/Icon";

type Todo = {
  id: string;
  title: string;
  due_date?: string | null;
  repeat_type?: string;
  type?: string | null;
  status: string;
  url?: string | null;
  assignee_ids: string[];
  linked_task_id?: string | null;
  task_name?: string | null;
};

type Member = { company_team_id: string; name: string; role?: string | null };

export default function TodoPage() {
  const params = useParams();
  const companyId = params.company_id as string;
  const projectId = params.project_id as string;

  const [todos, setTodos] = useState<Todo[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [typeFilter, setTypeFilter] = useState("All");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tRes, mRes] = await Promise.all([
        fetch(getApi(`/todos/company/${companyId}?project_id=${projectId}`), { headers: authHeaders() }),
        fetch(getApi(`/projects/${projectId}/members`), { headers: authHeaders() }),
      ]);
      if (tRes.ok) setTodos(await tRes.json());
      if (mRes.ok) setMembers(await mRes.json());
    } finally {
      setLoading(false);
    }
  }, [companyId, projectId]);

  useEffect(() => { load(); }, [load]);

  const types = Array.from(new Set(todos.map((t) => t.type).filter(Boolean) as string[]));

  const filtered = todos.filter((t) => {
    if (statusFilter !== "All" && t.status !== statusFilter) return false;
    if (typeFilter !== "All" && t.type !== typeFilter) return false;
    if (search && !t.title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const nameOf = (id: string) => members.find((m) => m.company_team_id === id)?.name || "?";

  const toggle = async (t: Todo) => {
    const next = t.status === "done" ? "pending" : "done";
    try {
      const res = await fetch(getApi(`/todos/${t.id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ status: next }),
      });
      if (res.ok) {
        load();
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to update todo");
      }
    } catch (e) {
      console.error("Failed to update todo", e);
      alert("Failed to update todo. Check your connection.");
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await fetch(getApi(`/todos/${id}`), { method: "DELETE", headers: authHeaders() });
      if (res.ok) {
        load();
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to delete todo");
      }
    } catch (e) {
      console.error("Failed to delete todo", e);
      alert("Failed to delete todo. Check your connection.");
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title="Project To-Do List"
        subtitle="Track checklists, action items, and assigned deliverables for this project"
      >
        <button onClick={() => setOpen(true)} className="rounded-md bg-primary px-3.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 cursor-pointer">+ New To Do</button>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-md border border-border-custom bg-card px-3 py-2 text-sm text-foreground">
            {["All", "pending", "done"].map((s) => <option key={s} value={s}>{s === "All" ? "Status" : formatLabel(s)}</option>)}
          </select>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="rounded-md border border-border-custom bg-card px-3 py-2 text-sm text-foreground">
            <option value="All">Type</option>
            {types.map((t) => <option key={t} value={t}>{formatLabel(t)}</option>)}
          </select>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search To Do" className="flex-1 min-w-[180px] rounded-md border border-border-custom bg-card px-3 py-2 text-sm text-foreground" />
        </div>

        <div className="rounded-lg border border-border-custom overflow-hidden bg-card">
          <table className="w-full text-sm">
            <thead className="bg-elevated text-muted">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Item Name</th>
                <th className="text-left px-4 py-3 font-medium">Due Date</th>
                <th className="text-left px-4 py-3 font-medium">Assigned</th>
                <th className="text-left px-4 py-3 font-medium">Task</th>
                <th className="text-left px-4 py-3 font-medium">Type</th>
                <th className="text-left px-4 py-3 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={6} className="p-4">
                    <TableSkeleton rows={4} cols={6} />
                  </td>
                </tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-8">
                    <EmptyState
                      title="No to-dos yet"
                      description="Create task checklists and to-do items to track assignments."
                      action={{ label: "+ New To Do", onClick: () => setOpen(true) }}
                    />
                  </td>
                </tr>
              )}
            {!loading && filtered.map((t) => (
              <tr key={t.id} className="border-t border-border-custom hover:bg-elevated/50">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <input type="checkbox" checked={t.status === "done"} onChange={() => toggle(t)} />
                    <span className={t.status === "done" ? "line-through text-muted" : "text-foreground"}>{t.title}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-muted">{formatDate(t.due_date)}</td>
                <td className="px-4 py-3">
                  <div className="flex -space-x-2">
                    {t.assignee_ids.slice(0, 3).map((id) => (
                      <div key={id} title={nameOf(id)} className="h-7 w-7 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-semibold border border-card">
                        {initials(nameOf(id))}
                      </div>
                    ))}
                    {t.assignee_ids.length === 0 && <span className="text-xs text-muted">Unassigned</span>}
                  </div>
                </td>
                <td className="px-4 py-3 text-muted">{t.task_name || "—"}</td>
                <td className="px-4 py-3 text-muted">{t.type ? formatLabel(t.type) : "—"}</td>
                <td className="px-4 py-3">
                  <button onClick={() => remove(t.id)} className="text-xs text-muted hover:text-danger">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && (
        <NewTodoModal
          companyId={companyId}
          projectId={projectId}
          members={members}
          onClose={() => setOpen(false)}
          onCreated={() => { setOpen(false); load(); }}
        />
      )}
      </PageShell>
      </div>
    </div>
  );
}

function NewTodoModal({
  companyId, projectId, members, onClose, onCreated,
}: {
  companyId: string; projectId: string; members: Member[]; onClose: () => void; onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [repeat, setRepeat] = useState("none");
  const [type, setType] = useState("");
  const [url, setUrl] = useState("");
  const [assignees, setAssignees] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const toggle = (id: string) =>
    setAssignees((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const submit = async () => {
    setSaving(true);
    try {
      const cid = await resolveCompanyId(companyId);
      const res = await fetch(getApi(`/todos/`), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id: cid,
          project_id: projectId,
          title,
          due_date: dueDate || null,
          repeat_type: repeat,
          type: type || null,
          url: url || null,
          assignee_ids: assignees,
        }),
      });
      if (res.ok) onCreated();
      else onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-lg border border-border-custom bg-card p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-foreground">New To Do</h3>
          <button onClick={onClose} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-xs font-medium text-muted">Title *</div>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <div className="mb-1 text-xs font-medium text-muted">Due Date</div>
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-muted">Repeat</div>
              <select value={repeat} onChange={(e) => setRepeat(e.target.value)} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground">
                {["none", "daily", "weekly", "monthly"].map((r) => <option key={r} value={r}>{r === "none" ? "Does not repeat" : formatLabel(r)}</option>)}
              </select>
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted">Type</div>
            <input value={type} onChange={(e) => setType(e.target.value)} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted">URL</div>
            <input value={url} onChange={(e) => setUrl(e.target.value)} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted">Assignees</div>
            <div className="max-h-40 overflow-y-auto rounded-md border border-border-custom divide-y divide-border-custom">
              {members.map((m) => (
                <label key={m.company_team_id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-elevated">
                  <input type="checkbox" checked={assignees.includes(m.company_team_id)} onChange={() => toggle(m.company_team_id)} />
                  <span className="text-sm text-foreground">{m.name}</span>
                </label>
              ))}
              {members.length === 0 && <div className="px-3 py-3 text-sm text-muted">No members.</div>}
            </div>
          </div>
        </div>
        <div className="flex justify-end mt-4">
          <button onClick={submit} disabled={!title || saving} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
            {saving ? "Saving…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
