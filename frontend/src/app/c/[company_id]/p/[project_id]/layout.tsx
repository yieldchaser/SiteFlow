"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { getApi, authHeaders } from "@/lib/siteflow";
import { useProject } from "@/context/ProjectContext";
import Icon from "@/components/marketing/Icon";
import { usePermissions } from "@/context/PermissionsContext";
import { canOpen } from "@/lib/routeAccess";

const TABS = [
  { label: "Dashboard", slug: "dashboard" },
  { label: "BOQ", slug: "boq" },
  { label: "Party", slug: "party" },
  { label: "Transaction", slug: "transaction" },
  { label: "To Do", slug: "todo" },
  { label: "Task", slug: "task" },
  { label: "Attendance", slug: "attendance" },
  { label: "Material", slug: "material" },
  { label: "Subcon", slug: "subcon" },
  { label: "Files", slug: "files" },
  { label: "MOM", slug: "mom" },
  { label: "Equipment", slug: "equipment" },
  { label: "Inspection", slug: "quality" },
];

// Modules that live only at company level. Each entry mirrors the exact final
// destination of that module's legacy p/[project_id] redirect stub; withProject
// appends ?project= so the company page opens scoped to this project.
const MORE_TABS = [
  { label: "Billing", path: "/d/billing", withProject: true },
  { label: "Budget", path: "/d/budget", withProject: true },
  { label: "BOQ Budgeting", path: "/d/budgeting/boq", withProject: false },
  { label: "Chat", path: "/d/chat", withProject: true },
  { label: "CRM", path: "/d/crm", withProject: true },
  { label: "Custom Fields", path: "/d/custom-fields", withProject: true },
  { label: "Daily Progress", path: "/d/dpr", withProject: true },
  { label: "Depreciation", path: "/d/depreciation", withProject: true },
  { label: "Drawings", path: "/d/drawings", withProject: true },
  { label: "Face Recognition", path: "/d/face-recognition", withProject: true },
  { label: "Finance", path: "/d/finance", withProject: true },
  { label: "HR & Payroll", path: "/d/hr", withProject: true },
  { label: "Labour", path: "/d/labour", withProject: true },
  { label: "Planning", path: "/d/planning", withProject: true },
  { label: "Planning Gantt", path: "/d/planning/gantt", withProject: false },
  { label: "Procurement", path: "/d/procurement", withProject: true },
  { label: "Procurement RFQ", path: "/d/procurement/rfq", withProject: false },
  { label: "Vendor Performance", path: "/d/procurement/vendor-performance", withProject: false },
  { label: "Production", path: "/d/production", withProject: true },
  { label: "Reports", path: "/d/reports", withProject: true },
  { label: "Calculators", path: "/d/reports/calculators", withProject: false },
  { label: "Safety", path: "/d/safety", withProject: true },
  { label: "Statutory", path: "/d/statutory", withProject: true },
  { label: "Subcon Scorecards", path: "/d/subcon/scorecards", withProject: false },
  { label: "WO Amendments", path: "/d/subcon/work-orders/amendments", withProject: false },
  { label: "Three-Way Match", path: "/d/three-way", withProject: true },
  { label: "Towers", path: "/d/towers", withProject: true },
  { label: "Wastage", path: "/d/wastage", withProject: true },
];

// Every status the backend accepts must be listed: a project whose status is
// missing here showed as "Ongoing" (the first option) and saved as such.
const STATUSES = ["Not Started", "Planning", "Ongoing", "On Hold", "Completed", "Cancelled"];

async function readErrorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.detail === "string" && body.detail) return body.detail;
  } catch {}
  return `HTTP ${res.status}`;
}

type ProjectInfo = {
  id: string;
  name: string;
  code?: string | null;
  status: string;
};

export default function ProjectDetailLayout({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const pathname = usePathname();
  const router = useRouter();
  const companyId = params.company_id as string;
  const projectId = params.project_id as string;

  const { projects, setActiveProjectId } = useProject();
  const { can } = usePermissions();

  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [status, setStatus] = useState("Ongoing");
  const [savingStatus, setSavingStatus] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  const base = `/c/${companyId}/p/${projectId}`;
  const currentSlug =
    TABS.find((t) => pathname === `${base}/${t.slug}`)?.slug || "dashboard";

  const load = useCallback(async () => {
    try {
      const res = await fetch(getApi(`/projects/${projectId}`), { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setProject({
          id: data.id,
          name: data.name,
          code: data.code,
          status: data.status || "—",
        });
        setStatus(data.status || "—");
      }
    } catch {
      /* ignore */
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const onSwitchProject = (nextId: string) => {
    setActiveProjectId(nextId);
    router.push(`/c/${companyId}/p/${nextId}/${currentSlug}`);
  };

  const onStatusChange = async (next: string) => {
    const prev = status;
    setStatus(next);
    setSavingStatus(true);
    try {
      const res = await fetch(getApi(`/projects/${projectId}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error(await readErrorDetail(res));
      setProject((p) => (p ? { ...p, status: next } : p));
      load();
    } catch (e) {
      setStatus(prev);
      setProject((p) => (p ? { ...p, status: prev } : p));
      alert(
        `Failed to change project status: ${
          e instanceof Error ? e.message : "server unreachable"
        }`
      );
    } finally {
      setSavingStatus(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Project header: name + switcher + status */}
      <div className="flex flex-wrap items-center gap-3 px-6 py-3 border-b border-border-custom bg-card">
        <div className="min-w-0">
          <div className="text-base font-semibold text-foreground truncate">
            {project?.name || "—"}
            {project?.code ? <span className="ml-2 text-xs font-normal text-muted">({project.code})</span> : null}
          </div>
          <div className="text-[11px] uppercase tracking-wider text-muted">Project</div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <select
            value={projectId}
            onChange={(e) => onSwitchProject(e.target.value)}
            className="rounded-md border border-border-custom bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary cursor-pointer"
          >
            {projects.length === 0 && <option value={projectId}>Switch Project…</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.project_name || p.name}
                {p.project_code || p.code ? ` (${p.project_code || p.code})` : ""}
              </option>
            ))}
          </select>

          <select
            value={status === "Onhold" ? "On Hold" : status}
            disabled={savingStatus}
            onChange={(e) => onStatusChange(e.target.value)}
            className="rounded-md border border-border-custom bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary cursor-pointer disabled:opacity-50"
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>

      {/* 11-sub-tab nav bar */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-border-custom bg-background/40 overflow-x-auto">
        {TABS.filter((t) => canOpen(`${base}/${t.slug}`, can)).map((t) => {
          const href = `${base}/${t.slug}`;
          const active = pathname === href;
          return (
            <Link
              key={t.slug}
              href={href}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold transition-all ${
                active
                  ? "bg-elevated text-foreground font-semibold border border-border-custom"
                  : "text-muted hover:text-foreground hover:bg-elevated border border-transparent"
              }`}
            >
              {t.label}
            </Link>
          );
        })}

        {/* Overflow menu for modules that live only at company level */}
        <div className="relative shrink-0 ml-auto">
          <button
            type="button"
            onClick={() => setMoreOpen((o) => !o)}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold transition-all inline-flex items-center gap-1 cursor-pointer ${
              moreOpen
                ? "bg-elevated text-foreground font-semibold border border-border-custom"
                : "text-muted hover:text-foreground hover:bg-elevated border border-transparent"
            }`}
          >
            More <Icon name="chevron_down" className="w-3.5 h-3.5" />
          </button>
          {moreOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setMoreOpen(false)}
                aria-hidden="true"
              />
              <div className="absolute right-0 top-full mt-1 z-50 w-[26rem] max-h-80 overflow-y-auto rounded-md border border-border-custom bg-card shadow-xl p-2 grid grid-cols-1 md:grid-cols-2 gap-1">
                {MORE_TABS.filter((m) => canOpen(`/c/${companyId}${m.path}`, can)).map((m) => (
                  <Link
                    key={m.path}
                    href={`/c/${companyId}${m.path}${m.withProject ? `?project=${projectId}` : ""}`}
                    className="whitespace-nowrap rounded px-2 py-1.5 text-xs text-muted hover:text-foreground hover:bg-elevated transition-all"
                  >
                    {m.label}
                  </Link>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
