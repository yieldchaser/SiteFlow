"use client";
import Badge, { type BadgeTone } from "@/components/ui/Badge";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { usePermissions } from "@/context/PermissionsContext";
import { getApiHost, detailToMessage } from "@/lib/api";
import { CustomFieldsSection, useCustomFields } from "@/components/CustomFieldsSection";
import Icon from "@/components/marketing/Icon";
// R2-755: shared CSV guard — quote-doubling protects the delimiter, not the
// formula. A leading = + - @ is executed when the export opens in Excel/Sheets.
import { buildCsv } from "@/lib/csv";

import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import SegmentedTabs from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { GST_STATES, PROJECT_STAGES, PROJECT_CATEGORIES } from "@/lib/gstStates";

type Project = {
  id: string;
  name: string;
  code?: string | null;
  status?: string;
  address?: string | null;
  city?: string | null;
  stage?: string | null;
  category?: string | null;
  project_value?: number;
  planned_start_date?: string | null;
  planned_end_date?: string | null;
  orientation?: string | null;
  dimension?: string | null;
  scope_of_work?: string | null;
  attendance_radius_meters?: number | null;
  project_avatar?: string | null;
  progress?: number;
  cash_in?: number;
  cash_out?: number;
  todo_pending?: number;
  is_pinned?: boolean;
};

type Summary = {
  project_count: number;
  approvals_pending: number;
  materials_pending: number;
  todos_pending: number;
};

type Member = {
  company_team_id: string;
  name: string;
  role?: string | null;
  mobile?: string | null;
};

const fmt = (n: number | undefined | null) =>
  `₹${Math.round(n || 0).toLocaleString("en-IN")}`;

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || "")
    .join("");
}

async function readErrorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    // detailToMessage handles the validation-error array as well as the plain
    // string. The create wizard now shows this to the user, so it has to be
    // readable rather than "[object Object]".
    const msg = detailToMessage(body?.detail, "");
    if (msg) return msg;
  } catch {}
  return `HTTP ${res.status}`;
}

export default function ProjectsPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params.company_id as string;

  useEffect(() => {
    // D-V1: a missing id (malformed route) or the removed demo tenant id never
    // resolves into console data; both bounce to /login.
    if (!companyId || companyId === "e0000000-0000-0000-0000-000000000000") {
      if (typeof window !== "undefined") window.location.replace("/login");
    }
  }, [companyId]);

  const authHeaders = () => {
    const token =
      typeof window !== "undefined"
        ? localStorage.getItem("access_token")
        : null;
    return token ? { Authorization: `Bearer ${token}` } : undefined;
  };
  const api = (path: string) =>
    `${getApiHost()}/apis/v3${path}`;

  const [projects, setProjects] = useState<Project[]>([]);
  const [summary, setSummary] = useState<Summary>({
    project_count: 0,
    approvals_pending: 0,
    materials_pending: 0,
    todos_pending: 0,
  });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState("All");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [scopeFilter, setScopeFilter] = useState("All");
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsProject, setSettingsProject] = useState<Project | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");

  // What a member sees here follows their role's permissions, not its name.
  const { can } = usePermissions();
  const canEditProjects = can("projects:edit");
  const seesFinance = can("finance:view");
  const seesIndents = can("procurement:view");

  const load = useCallback(async () => {
    if (!companyId || companyId === "e0000000-0000-0000-0000-000000000000") return;
    setLoading(true);
    try {
      const [pRes, sRes] = await Promise.all([
        fetch(api(`/projects/company/${companyId}`), { headers: authHeaders() }),
        fetch(api(`/projects/company/${companyId}/summary`), {
          headers: authHeaders(),
        }),
      ]);
      if (pRes.ok) setProjects(await pRes.json());
      if (sRes.ok) setSummary(await sRes.json());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    load();
  }, [load]);

  const stages = useMemo(
    () => ["All", ...Array.from(new Set(projects.map((p) => p.stage).filter(Boolean) as string[]))],
    [projects]
  );
  const categories = useMemo(
    () => ["All", ...Array.from(new Set(projects.map((p) => p.category).filter(Boolean) as string[]))],
    [projects]
  );

  const filtered = useMemo(() => {
    return projects.filter((p) => {
      if (scopeFilter === "Pinned" && !p.is_pinned) return false;
      if (stageFilter !== "All" && p.stage !== stageFilter) return false;
      if (categoryFilter !== "All" && p.category !== categoryFilter) return false;
      if (
        search &&
        !`${p.name} ${p.city || ""}`.toLowerCase().includes(search.toLowerCase())
      )
        return false;
      return true;
    });
  }, [projects, scopeFilter, stageFilter, categoryFilter, search]);

  const togglePin = async (p: Project) => {
    try {
      const res = await fetch(api(`/projects/${p.id}/pin`), {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(await readErrorDetail(res));
    } catch (e) {
      alert(
        `Failed to update pin: ${e instanceof Error ? e.message : "server unreachable"}`
      );
    }
    load();
  };

  const removeProject = async () => {
    if (!deleteTarget) return;
    try {
      // R2-557: the confirmation is enforced server-side - the name typed in
      // the delete modal must be echoed as ?confirm= or the API refuses.
      const res = await fetch(api(`/projects/${deleteTarget.id}?confirm=${encodeURIComponent(deleteConfirmName)}`), {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(await readErrorDetail(res));
      setDeleteConfirmName("");
      setDeleteTarget(null);
      load();
    } catch (e) {
      alert(
        `Failed to delete project: ${e instanceof Error ? e.message : "server unreachable"}`
      );
    }
  };

  const exportCsv = () => {
    const headers = ["Name", "Code", "City", "Stage", "Category", "Progress %", "Billed In", "Billed Out", "To Do"];
    const rows = filtered.map((p) => [
      p.name,
      p.code || "",
      p.city || "",
      p.stage || "",
      p.category || "",
      String(p.progress ?? 0),
      String(p.cash_in ?? 0),
      String(p.cash_out ?? 0),
      String(p.todo_pending ?? 0),
    ]);
    const csv = buildCsv(headers, rows);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "projects.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title="Projects"
        subtitle="Manage site portfolios, track execution progress, and create projects"
      >
        <div className="flex items-center gap-2">
          <button
            onClick={exportCsv}
            disabled={projects.length === 0}
            className="rounded-md border border-border-custom bg-card px-3.5 py-1.5 text-xs font-semibold text-foreground hover:bg-elevated disabled:opacity-40 transition-all cursor-pointer"
          >
            Export CSV
          </button>
          {canEditProjects && (
            <button
              onClick={() => setCreateOpen(true)}
              className="rounded-md bg-primary px-3.5 py-1.5 text-xs font-bold text-white hover:opacity-90 transition-all cursor-pointer"
            >
              + Create Project
            </button>
          )}
        </div>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {seesFinance && (
          <KpiCard
            label="Approval (Pending)"
            value={summary.approvals_pending}
            tooltip="Pending approvals across all projects (drawings, credit notes, payment requests)."
            onClick={() => router.push(`/c/${companyId}/d/payment-approval`)}
          />
        )}
        {seesIndents && (
          <KpiCard
            label="Material (Pending)"
            value={summary.materials_pending}
            tooltip="Pending material indent requests across all projects."
          />
        )}
        <KpiCard
          label="To Do (Pending)"
          value={summary.todos_pending}
          tooltip="Pending to-dos assigned to you across all projects."
          onClick={() => router.push(`/c/${companyId}/d/todo`)}
        />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={scopeFilter}
          onChange={(e) => setScopeFilter(e.target.value)}
          className="rounded-md border border-border-custom bg-card px-3 py-2 text-sm text-foreground"
        >
          <option value="All">All ({projects.length})</option>
          <option value="Pinned">Pinned</option>
        </select>

        <select
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value)}
          className="rounded-md border border-border-custom bg-card px-3 py-2 text-sm text-foreground"
        >
          {stages.map((s) => (
            <option key={s} value={s}>{s === "All" ? "Stage" : s}</option>
          ))}
        </select>

        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="rounded-md border border-border-custom bg-card px-3 py-2 text-sm text-foreground"
        >
          {categories.map((c) => (
            <option key={c} value={c}>{c === "All" ? "Category" : c}</option>
          ))}
        </select>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search Projects"
          className="flex-1 min-w-[180px] rounded-md border border-border-custom bg-card px-3 py-2 text-sm text-foreground"
        />
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border-custom overflow-hidden bg-card">
        <table className="w-full text-sm">
          <thead className="bg-elevated text-muted">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Name</th>
              <th className="text-left px-4 py-3 font-medium">Progress</th>
              {seesFinance && (
                <th className="text-left px-4 py-3 font-medium">In / Out</th>
              )}
              <th className="text-left px-4 py-3 font-medium">To Do</th>
              <th className="text-right px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="p-4">
                  <TableSkeleton rows={5} cols={6} />
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="p-8">
                  <EmptyState
                    title="No projects found"
                    description={search ? "No projects match your search query." : "Get started by creating your first construction project."}
                    action={!search && canEditProjects ? { label: "New Project", onClick: () => setCreateOpen(true) } : undefined}
                  />
                </td>
              </tr>
            )}
            {!loading &&
              filtered.map((p) => (
                <tr
                  key={p.id}
                  className="border-t border-border-custom hover:bg-elevated/50 cursor-pointer"
                  onClick={() => router.push(`/c/${companyId}/p/${p.id}/dashboard`)}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-lg bg-primary/15 text-primary flex items-center justify-center font-semibold text-sm">
                        {initials(p.name)}
                      </div>
                      <div>
                        <div className="font-medium text-foreground">{p.name}</div>
                        <div className="text-xs text-muted">{p.city || "—"}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-24 rounded-full bg-elevated overflow-hidden">
                        <div
                          className="h-full bg-primary"
                          style={{ width: `${p.progress ?? 0}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted">
                        {Math.round(p.progress ?? 0)}%
                      </span>
                    </div>
                  </td>
                  {seesFinance && (
                    <td className="px-4 py-3 text-xs">
                      <div className="text-success">{fmt(p.cash_in)}</div>
                      <div className="text-danger">{fmt(p.cash_out)}</div>
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <Badge tone="primary">{p.todo_pending ?? 0}</Badge>
                  </td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-2">
                      <button
                        title={p.is_pinned ? "Unpin" : "Pin"}
                        onClick={() => togglePin(p)}
                        className={`cursor-pointer ${p.is_pinned ? "text-primary" : "text-muted hover:text-foreground"}`}
                      >
                        <Icon name="star" className="w-4 h-4" />
                      </button>
                      <button
                        title="Settings"
                        onClick={() => setSettingsProject(p)}
                        className="text-muted hover:text-foreground"
                      >
                        <Icon name="settings" className="w-4 h-4" />
                      </button>
                      {canEditProjects && (
                        <button
                          title="Delete"
                          onClick={() => {
                            setDeleteConfirmName("");
                            setDeleteTarget(p);
                          }}
                          className="text-muted hover:text-danger"
                        >
                          <Icon name="trash" className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {createOpen && (
        <CreateProjectModal
          companyId={companyId}
          api={api}
          authHeaders={authHeaders}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            load();
          }}
        />
      )}

      {settingsProject && (
        <ProjectSettingsModal
          project={settingsProject}
          companyId={companyId}
          api={api}
          authHeaders={authHeaders}
          onClose={() => setSettingsProject(null)}
          onSaved={() => {
            setSettingsProject(null);
            load();
          }}
        />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-96 rounded-lg border border-border-custom bg-card p-6">
            <h3 className="text-lg font-semibold text-foreground mb-2">Delete Project</h3>
            <p className="text-sm text-muted mb-4">
              Delete <strong>{deleteTarget.name}</strong>? This cannot be undone. Every task, bill,
              attendance record and timesheet under it is deleted with it.
            </p>
            <div className="mb-4">
              <label className="text-xs text-muted mb-1 block">
                Type <strong>{deleteTarget.name}</strong> to confirm
              </label>
              <input
                value={deleteConfirmName}
                onChange={(e) => setDeleteConfirmName(e.target.value)}
                className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground"
                placeholder={deleteTarget.name}
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setDeleteConfirmName("");
                  setDeleteTarget(null);
                }}
                className="rounded-md border border-border-custom px-4 py-2 text-sm text-muted"
              >
                Cancel
              </button>
              <button
                onClick={removeProject}
                disabled={deleteConfirmName !== deleteTarget.name}
                className="rounded-md bg-danger px-4 py-2 text-sm text-white disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
      </PageShell>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  tooltip,
  onClick,
}: {
  label: string;
  value: number;
  tooltip: string;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`rounded-lg border border-border-custom bg-card p-4 ${
        onClick ? "cursor-pointer hover:border-primary" : ""
      }`}
      title={tooltip}
    >
      <div className="text-xs uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-2 text-3xl font-bold text-foreground">{value}</div>
    </div>
  );
}

// ─── Create Project (2-step) ───

function CreateProjectModal({
  companyId,
  api,
  authHeaders,
  onClose,
  onCreated,
}: {
  companyId: string;
  api: (p: string) => string;
  authHeaders: () => Record<string, string> | undefined;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  // Required by POST /projects/. Place of supply for every invoice on this
  // project derives from the site state, so the backend refuses to create a
  // project without it. Nothing collected it, so nothing could be created.
  const [stateName, setStateName] = useState("");
  // Site coordinates. The attendance radius below is meaningless without a
  // centre, and this endpoint is the only supported way to place a site.
  const [location, setLocation] = useState("");
  const [stage, setStage] = useState("");
  const [category, setCategory] = useState("");
  const [projectValue, setProjectValue] = useState("");
  const [plannedStart, setPlannedStart] = useState("");
  const [plannedEnd, setPlannedEnd] = useState("");
  const [orientation, setOrientation] = useState("");
  const [dimension, setDimension] = useState("");
  const [scopeOfWork, setScopeOfWork] = useState("");
  const [attendanceRadius, setAttendanceRadius] = useState(500);
  const [members, setMembers] = useState<Member[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [resolvedCompanyId, setResolvedCompanyId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const TOTAL_STEPS = 3;

  useEffect(() => {
    // /projects/company/{id}/members does not exist and 404s, which is why this
    // step used to show "No members found" for every company. The company team
    // roster lives here, the same source the procurement screen reads.
    fetch(api(`/crm/team-members/${companyId}`), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{ id: string; name: string }>) =>
        setMembers((rows || []).map((r) => ({ company_team_id: r.id, name: r.name })))
      )
      .catch(() => setMembers([]));
  }, [companyId]);

  const resolveCompanyId = async (): Promise<string> => {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId))
      return companyId;
    const stored = localStorage.getItem("company_slug_mappings");
    const map = stored ? JSON.parse(stored) : {};
    if (map[companyId]) return map[companyId];
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/auth/resolve-company/${companyId}`);
      if (res.ok) return (await res.json()).id;
    } catch {}
    return companyId;
  };

  useEffect(() => {
    resolveCompanyId().then(setResolvedCompanyId);
  }, [companyId]);

  const customFields = useCustomFields(resolvedCompanyId, "project");

  const create = async () => {
    setFormError(null);
    const cfError = customFields.validate();
    if (cfError) {
      setFormError(cfError);
      return;
    }
    setSaving(true);
    try {
      const cid = resolvedCompanyId || (await resolveCompanyId());
      const res = await fetch(api(`/projects/`), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id: cid,
          name,
          code: code || null,
          address,
          city,
          state: stateName || null,
          location: location.trim() || null,
          stage: stage || null,
          category: category || null,
          project_value: parseFloat(projectValue) || 0,
          planned_start_date: plannedStart || null,
          planned_end_date: plannedEnd || null,
          orientation: orientation || null,
          dimension: dimension || null,
          scope_of_work: scopeOfWork || null,
          attendance_radius_meters: attendanceRadius,
          member_ids: selected,
          custom_fields: customFields.toPayload(),
        }),
      });
      if (res.ok) {
        onCreated();
      } else {
        // Never close on failure. This used to call onClose(), which threw away
        // everything the user had typed and told them nothing at all.
        setFormError(await readErrorDetail(res));
      }
    } finally {
      setSaving(false);
    }
  };

  const toggleMember = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const inputCls =
    "w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="relative flex w-full max-w-3xl rounded-lg border border-border-custom bg-card">
        {/* Live preview */}
        <div className="hidden md:block w-1/3 border-r border-border-custom bg-elevated p-6">
          <div className="text-xs uppercase tracking-wider text-muted mb-3">Live Preview</div>
          <div className="rounded-lg bg-card p-4 border border-border-custom">
            <div className="h-10 w-10 rounded-lg bg-primary/15 text-primary flex items-center justify-center font-semibold">
              {initials(name || "—")}
            </div>
            <div className="mt-2 font-semibold text-foreground">{name || "—"}</div>
            <div className="text-xs text-muted">{city || "—"}</div>
            {code && <div className="mt-1 text-xs text-muted">Code: {code}</div>}
            {stage && <div className="text-xs text-muted">Stage: {stage}</div>}
            <div className="mt-3 text-xs text-muted">
              Members: {selected.length}
            </div>
          </div>
        </div>

        <div className="flex-1 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-foreground">Create Project</h3>
            <div className="flex items-center gap-3">
              <div className="text-xs text-muted">Step {step} of {TOTAL_STEPS}</div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="flex h-8 w-8 items-center justify-center rounded-full border border-border-custom text-muted hover:bg-elevated hover:text-foreground cursor-pointer"
              >
                <Icon name="close" className="w-4 h-4" />
              </button>
            </div>
          </div>

          {step === 1 && (
            <div className="space-y-3">
              <Field label="Project Name *">
                <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
              </Field>
              <Field label="Project Code">
                <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. PRJ-001" className={inputCls} />
              </Field>
              <Field label="Address">
                <input value={address} onChange={(e) => setAddress(e.target.value)} className={inputCls} />
              </Field>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="City">
                  <input value={city} onChange={(e) => setCity(e.target.value)} className={inputCls} />
                </Field>
                <Field label="State *">
                  <select value={stateName} onChange={(e) => setStateName(e.target.value)} className={inputCls}>
                    <option value="">Select state</option>
                    {GST_STATES.map((st) => (
                      <option key={st.code} value={st.name}>{st.code} - {st.name}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Site Coordinates">
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="latitude, longitude - e.g. 28.6280, 77.3649"
                  className={inputCls}
                />
                <p className="mt-1 text-[10px] text-muted">
                  Used as the centre of the attendance geofence. Leave blank if the site is not geofenced.
                </p>
              </Field>
              {formError && (
                <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{formError}</p>
              )}
              <div className="flex justify-end pt-2">
                <button
                  disabled={!name || !stateName}
                  onClick={() => setStep(2)}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                >
                  Continue
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Stage">
                  <select value={stage} onChange={(e) => setStage(e.target.value)} className={inputCls}>
                    <option value="">Select stage</option>
                    {PROJECT_STAGES.map((st) => (
                      <option key={st} value={st}>{st}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Category">
                  <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
                    <option value="">Select category</option>
                    {PROJECT_CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Project Value">
                  <input type="number" value={projectValue} onChange={(e) => setProjectValue(e.target.value)} className={inputCls} />
                </Field>
                <Field label="Attendance Radius (meters)">
                  <input type="number" value={attendanceRadius} onChange={(e) => { const v = parseInt(e.target.value); setAttendanceRadius(Number.isNaN(v) ? 500 : v); }} className={inputCls} />
                </Field>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Planned Start Date">
                  <input type="date" value={plannedStart} onChange={(e) => setPlannedStart(e.target.value)} className={inputCls} />
                </Field>
                <Field label="Planned End Date">
                  <input type="date" value={plannedEnd} onChange={(e) => setPlannedEnd(e.target.value)} className={inputCls} />
                </Field>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Orientation">
                  <input value={orientation} onChange={(e) => setOrientation(e.target.value)} className={inputCls} />
                </Field>
                <Field label="Dimension">
                  <input value={dimension} onChange={(e) => setDimension(e.target.value)} className={inputCls} />
                </Field>
              </div>
              <Field label="Scope of Work">
                <textarea value={scopeOfWork} onChange={(e) => setScopeOfWork(e.target.value)} rows={3} className={inputCls} />
              </Field>
              <div className="flex justify-between pt-2">
                <button
                  onClick={() => setStep(1)}
                  className="rounded-md border border-border-custom px-4 py-2 text-sm text-muted"
                >
                  Back
                </button>
                <button
                  onClick={() => setStep(3)}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white"
                >
                  Continue
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <Field label="Add Team Member">
                <div className="max-h-48 overflow-y-auto rounded-md border border-border-custom divide-y divide-border-custom">
                  {members.map((m) => (
                    <label
                      key={m.company_team_id}
                      className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-elevated"
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(m.company_team_id)}
                        onChange={() => toggleMember(m.company_team_id)}
                      />
                      <div>
                        <div className="text-sm text-foreground">{m.name}</div>
                        <div className="text-xs text-muted">{m.role || "—"}</div>
                      </div>
                    </label>
                  ))}
                  {members.length === 0 && (
                    <EmptyState
                      title="No members found"
                      description="Add team members to this company to assign them to projects."
                      className="py-4"
                    />
                  )}
                </div>
              </Field>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <CustomFieldsSection
                  fields={customFields.fields}
                  values={customFields.values}
                  setValue={customFields.setValue}
                />
              </div>
              {formError && (
                <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {formError}
                </div>
              )}
              <div className="flex justify-between pt-2">
                <button
                  onClick={() => setStep(2)}
                  className="rounded-md border border-border-custom px-4 py-2 text-sm text-muted"
                >
                  Back
                </button>
                <button
                  disabled={saving}
                  onClick={create}
                  className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                >
                  {saving ? "Creating…" : "Finish"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted">{label}</div>
      {children}
    </div>
  );
}

// ─── Project Settings (3 tabs) ───

function ProjectSettingsModal({
  project,
  companyId,
  api,
  authHeaders,
  onClose,
  onSaved,
}: {
  project: Project;
  companyId: string;
  api: (p: string) => string;
  authHeaders: () => Record<string, string> | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tab, setTab] = useState<"details" | "members" | "locations">("details");
  const [form, setForm] = useState({
    name: project.name,
    code: project.code || "",
    address: project.address || "",
    city: project.city || "",
    stage: project.stage || "",
    category: project.category || "",
    project_value: String(project.project_value || 0),
    planned_start_date: (project.planned_start_date || "").slice(0, 10),
    planned_end_date: (project.planned_end_date || "").slice(0, 10),
    orientation: project.orientation || "",
    dimension: project.dimension || "",
    scope_of_work: project.scope_of_work || "",
    attendance_radius_meters: project.attendance_radius_meters ?? 500,
    project_avatar: project.project_avatar || "",
  });
  const [locations, setLocations] = useState<{ id: string; name: string; parent_id: string | null }[]>([]);
  const [newLoc, setNewLoc] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [saving, setSaving] = useState(false);
  const [resolvedCompanyId, setResolvedCompanyId] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) {
      setResolvedCompanyId(companyId);
      return;
    }
    (async () => {
      const stored = localStorage.getItem("company_slug_mappings");
      const map = stored ? JSON.parse(stored) : {};
      if (map[companyId]) {
        setResolvedCompanyId(map[companyId]);
        return;
      }
      try {
        const res = await fetch(`${getApiHost()}/apis/v3/auth/resolve-company/${companyId}`);
        if (res.ok) {
          setResolvedCompanyId((await res.json()).id);
          return;
        }
      } catch {}
      setResolvedCompanyId(companyId);
    })();
  }, [companyId]);

  const customFields = useCustomFields(resolvedCompanyId, "project", project.id);

  const loadLocations = useCallback(() => {
    fetch(api(`/projects/${project.id}/locations`), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then(setLocations)
      .catch(() => setLocations([]));
  }, [project.id]);

  useEffect(() => {
    loadLocations();
    fetch(api(`/projects/${project.id}/members`), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [project.id, loadLocations]);

  const removeMember = async (memberId: string) => {
    if (!confirm("Are you sure you want to remove this member from the project?")) return;
    try {
      const res = await fetch(api(`/projects/${project.id}/members/${memberId}`), {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (res.ok) {
        setMembers((prev) => prev.filter((m) => m.company_team_id !== memberId));
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to remove member");
      }
    } catch (e) {
      console.error(e);
      alert("Failed to remove member. Check your connection.");
    }
  };

  const saveDetails = async () => {
    setFormError(null);
    const cfError = customFields.validate();
    if (cfError) {
      setFormError(cfError);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(api(`/projects/${project.id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          name: form.name,
          code: form.code || null,
          address: form.address,
          city: form.city,
          stage: form.stage,
          category: form.category,
          project_value: parseFloat(form.project_value) || 0,
          planned_start_date: form.planned_start_date || null,
          planned_end_date: form.planned_end_date || null,
          orientation: form.orientation,
          dimension: form.dimension,
          scope_of_work: form.scope_of_work,
          attendance_radius_meters: form.attendance_radius_meters,
          project_avatar: form.project_avatar || null,
          custom_fields: customFields.toPayload(),
        }),
      });
      if (!res.ok) throw new Error(await readErrorDetail(res));
      onSaved();
    } catch (e) {
      setFormError(
        `Failed to save project settings: ${
          e instanceof Error ? e.message : "server unreachable"
        }`
      );
    } finally {
      setSaving(false);
    }
  };

  const addLocation = async () => {
    if (!newLoc.trim()) return;
    const res = await fetch(api(`/projects/${project.id}/locations`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      body: JSON.stringify({ name: newLoc.trim() }),
    });
    if (res.ok) {
      setNewLoc("");
      loadLocations();
    } else {
      const err = await readErrorDetail(res);
      setFormError(`Failed to add location: ${err}`);
    }
  };

  const deleteLocation = async (id: string) => {
    try {
      const res = await fetch(api(`/projects/${project.id}/locations/${id}`), {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(await readErrorDetail(res));
      loadLocations();
    } catch (e) {
      alert(
        `Failed to delete location: ${e instanceof Error ? e.message : "server unreachable"}`
      );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-lg border border-border-custom bg-card">
        <div className="flex items-center justify-between border-b border-border-custom px-6 py-4">
          <h3 className="text-lg font-semibold text-foreground">Project Settings</h3>
          <button
            onClick={onClose}
            className="text-muted hover:text-foreground p-1 cursor-pointer"
            aria-label="Close modal"
          >
            <Icon name="close" className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-2.5 border-b border-border-custom bg-elevated/40">
          <SegmentedTabs
            tabs={[
              { id: "details", label: "Project Details" },
              { id: "members", label: "Members" },
              { id: "locations", label: "Location Structure" },
            ]}
            activeTab={tab}
            onChange={(t) => setTab(t as any)}
          />
        </div>

        <div className="p-6 max-h-[60vh] overflow-y-auto">
          {tab === "details" && (
            <div className="space-y-3">
              <Field label="Project Name">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
              </Field>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Project Code">
                  <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="e.g. PRJ-001" className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
                </Field>
                <Field label="Attendance Radius (meters)">
                  <input type="number" value={form.attendance_radius_meters} onChange={(e) => { const v = parseInt(e.target.value); setForm({ ...form, attendance_radius_meters: Number.isNaN(v) ? 500 : v }); }} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
                </Field>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Planned Start Date">
                  <input type="date" value={form.planned_start_date} onChange={(e) => setForm({ ...form, planned_start_date: e.target.value })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
                </Field>
                <Field label="Planned End Date">
                  <input type="date" value={form.planned_end_date} onChange={(e) => setForm({ ...form, planned_end_date: e.target.value })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
                </Field>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Stage">
                  <input value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
                </Field>
                <Field label="Category">
                  <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
                </Field>
              </div>
              <Field label="Address">
                <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
              </Field>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="City">
                  <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
                </Field>
                <Field label="Project Value">
                  <input type="number" value={form.project_value} onChange={(e) => setForm({ ...form, project_value: e.target.value })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
                </Field>
              </div>
              <Field label="Orientation">
                <input value={form.orientation} onChange={(e) => setForm({ ...form, orientation: e.target.value })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
              </Field>
              <Field label="Dimension">
                <input value={form.dimension} onChange={(e) => setForm({ ...form, dimension: e.target.value })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
              </Field>
              <Field label="Scope of Work">
                <textarea value={form.scope_of_work} onChange={(e) => setForm({ ...form, scope_of_work: e.target.value })} rows={3} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
              </Field>
              <Field label="Project Avatar / Cover Image URL">
                <input value={form.project_avatar} onChange={(e) => setForm({ ...form, project_avatar: e.target.value })} placeholder="https://... or /images/..." className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
              </Field>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <CustomFieldsSection
                  fields={customFields.fields}
                  values={customFields.values}
                  setValue={customFields.setValue}
                />
              </div>
              {formError && (
                <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {formError}
                </div>
              )}
              <div className="flex justify-end pt-2">
                <button onClick={saveDetails} disabled={saving} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          )}

          {tab === "members" && (
            <div className="space-y-1">
              {members.map((m) => (
                <div key={m.company_team_id} className="flex items-center justify-between px-3 py-2 rounded-md hover:bg-elevated">
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-semibold">
                      {initials(m.name)}
                    </div>
                    <div>
                      <div className="text-sm text-foreground">{m.name}</div>
                      <div className="text-xs text-muted">{m.role || "—"}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone="neutral">{m.mobile || ""}</Badge>
                    <button
                      type="button"
                      onClick={() => removeMember(m.company_team_id)}
                      className="p-1.5 hover:bg-danger/10 text-muted hover:text-danger rounded cursor-pointer transition-all"
                      title="Remove member from project"
                    >
                      <Icon name="trash" className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
              {members.length === 0 && <div className="text-sm text-muted">No members.</div>}
            </div>
          )}

          {tab === "locations" && (
            <div className="space-y-3">
              <div className="flex gap-2">
                <input
                  value={newLoc}
                  onChange={(e) => setNewLoc(e.target.value)}
                  placeholder="Location Name (e.g. Tower A)"
                  className="flex-1 rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground"
                />
                <button onClick={addLocation} className="rounded-md bg-primary px-4 py-2 text-sm text-white">+ Location</button>
              </div>
              <div className="divide-y divide-border-custom rounded-md border border-border-custom">
                {locations.map((l) => (
                  <div key={l.id} className="flex items-center justify-between px-3 py-2">
                    <span className="text-sm text-foreground">{l.name}</span>
                    <button onClick={() => deleteLocation(l.id)} className="text-xs text-muted hover:text-danger">Delete</button>
                  </div>
                ))}
                {locations.length === 0 && (
                  <div className="p-4">
                    <EmptyState
                      title="No locations yet"
                      description="Add project site locations, zones, or tower areas."
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
