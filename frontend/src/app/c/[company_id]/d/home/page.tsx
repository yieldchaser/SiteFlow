"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { getApiHost, readErrorDetail, detailToMessage} from "@/lib/api";
import { formatDate, formatLabel } from "@/lib/siteflow";
import { useProject } from "@/context/ProjectContext";
import { usePermissions } from "@/context/PermissionsContext";
import Icon from "@/components/marketing/Icon";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";

interface Project {
  id: string;
  name: string;
  code: string;
  status: string;
  stage?: string;
  city: string;
  address?: string;
  health?: string;
  progress?: number;
  cashflow_in?: number;
  cashflow_out?: number;
  project_name?: string;
  project_code?: string;
  project_status?: string;
  project_address?: string;
  project_health?: string;
}

interface PaymentRequest {
  id: string;
  amount: number;
  status: string;
}

interface Indent {
  id: string;
  indent_number: string;
  status: string;
  project_id: string;
  created_at: string;
  items: Array<{ material_name: string; quantity: number; unit: string }>;
}

interface Leave {
  id: string;
  employee_name: string;
  leave_type: string;
  days_count: number;
  status: string;
  start_date: string;
  end_date: string;
}

const normalizeText = (value: string) => value.toLowerCase().replace(/\s+/g, "");

const getProjectName = (project: Project) => project.project_name || project.name || "—";

import Badge, { type BadgeTone } from "@/components/ui/Badge";

const getProjectCode = (project: Project) => project.project_code || project.code || "—";

const getProjectStatus = (project: Project) => project.project_status || project.status || "—";

const getProjectAddress = (project: Project) => {
  const address = project.project_address || project.address || "";
  const city = project.city || "";

  if (!address && !city) return "Address not set";
  if (!address) return city;
  if (!city) return address;
  if (normalizeText(address).includes(normalizeText(city))) return address;
  return `${address} • ${city}`;
};

const getProjectHealth = (project: Project) => project.project_health || project.health || "—";

const getProjectStatusTone = (status: string): BadgeTone => {
  const normalized = normalizeText(status);
  if (normalized.includes("complete")) return "success";
  if (normalized.includes("hold")) return "warning";
  if (normalized.includes("ongoing") || normalized.includes("active") || normalized.includes("progress")) {
    return "primary";
  }
  return "neutral";
};

const getProjectHealthTone = (health: string): BadgeTone => {
  const normalized = normalizeText(health);
  if (normalized.includes("healthy") || normalized.includes("good") || normalized.includes("stable")) {
    return "success";
  }
  if (normalized.includes("warn")) return "warning";
  if (normalized.includes("critical")) return "danger";
  if (normalized.includes("complete")) return "success";
  if (normalized.includes("hold")) return "warning";
  return "neutral";
};

const extractProjects = (data: unknown): Project[] => {
  if (Array.isArray(data)) return data as Project[];

  if (data && typeof data === "object") {
    const payload = data as { data?: unknown; projects?: unknown; items?: unknown };

    if (Array.isArray(payload.data)) return payload.data as Project[];
    if (Array.isArray(payload.projects)) return payload.projects as Project[];
    if (Array.isArray(payload.items)) return payload.items as Project[];
  }

  return [];
};

export default function ProjectsHomePage() {
  const params = useParams();
  const companyId = params.company_id as string;
  const { setActiveProjectId } = useProject();
  const { can } = usePermissions();
  // Money and leave approvals only show to roles that can act on them.
  const seesLeaves = can("payroll:edit");
  const seesFinance = can("finance:view");
  const seesIndents = can("procurement:view");
  const canEditProjects = can("projects:edit");
  const kpiCols = 1 + (seesFinance ? 1 : 0) + (seesIndents ? 1 : 0);
  const accessToken = typeof window !== "undefined" ? localStorage.getItem("access_token") : "";

  const [projects, setProjects] = useState<Project[]>([]);
  const [paymentRequests, setPaymentRequests] = useState<PaymentRequest[]>([]);
  const [indents, setIndents] = useState<Indent[]>([]);
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [todoCount, setTodoCount] = useState(0);
  const [toastMessage, setToastMessage] = useState("");

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(""), 3000);
  };

  // States for drawers & popups
  const [isLeaveModalOpen, setIsLeaveModalOpen] = useState(false);
  const [isNewProjectOpen, setIsNewProjectOpen] = useState(false);
  const [isMaterialDrawerOpen, setIsMaterialDrawerOpen] = useState(false);

  // New Project Form state
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectCode, setNewProjectCode] = useState("");
  const [newProjectCity, setNewProjectCity] = useState("Bangalore");

  // Material requests drawer tab and filter states
  const [mrTab, setMrTab] = useState<"pending" | "approved" | "ordered" | "rejected">("pending");
  const [mrProjectFilter, setMrProjectFilter] = useState("");
  const [mrSearchFilter, setMrSearchFilter] = useState("");

  // Projects filter and search states
  const [stageFilter, setStageFilter] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");

  const apiHost = getApiHost();

  // False until the first load answers, so the lists say Loading rather than empty.
  const [hubLoaded, setHubLoaded] = useState(false);
  const hubLoading = !hubLoaded;

  const fetchData = async () => {
    if (!companyId) return;
    try {
      const authHeaders = { "Authorization": `Bearer ${accessToken}` };

      // The five lists are independent; fetch them together so the hub fills
      // in one round trip instead of five sequential ones.
      const [planningProjectsRes, paymentsRes, todoRes, indentsRes, leavesRes, opsRes, finRes] = await Promise.all([
        fetch(`${apiHost}/apis/v3/planning/projects?company_id=${companyId}`, { headers: authHeaders }),
        fetch(`${apiHost}/apis/v3/finance/payment-requests/${companyId}`, { headers: authHeaders }),
        fetch(`${apiHost}/apis/v3/todos/company/${companyId}`, { headers: authHeaders }),
        fetch(`${apiHost}/apis/v3/procurement/indents?company_id=${companyId}`, { headers: authHeaders }),
        fetch(`${apiHost}/apis/v3/hr/leaves/${companyId}`, { headers: authHeaders }),
        // The planning list has no progress or cash; the dashboard analytics do.
        fetch(`${apiHost}/apis/v3/analytics/company/${companyId}/operational`, { headers: authHeaders }),
        fetch(`${apiHost}/apis/v3/analytics/company/${companyId}/financial`, { headers: authHeaders }),
      ]);

      if (planningProjectsRes.ok) {
        const list = extractProjects(await planningProjectsRes.json());
        const ops = opsRes.ok ? await opsRes.json().catch(() => null) : null;
        const fin = finRes.ok ? await finRes.json().catch(() => null) : null;
        const progressById = new Map<string, number>(
          (ops?.projects || []).map((o: { project_id: string; progress?: number }) => [String(o.project_id), Number(o.progress) || 0])
        );
        const cashById = new Map<string, { in: number; out: number }>(
          (fin?.project_summaries || []).map((f: { project_id: string; payment_in?: number; payment_out?: number }) => [
            String(f.project_id),
            { in: Number(f.payment_in) || 0, out: Number(f.payment_out) || 0 },
          ])
        );
        setProjects(
          list.map((p) => ({
            ...p,
            progress: progressById.get(String(p.id)) ?? p.progress,
            cashflow_in: cashById.get(String(p.id))?.in ?? p.cashflow_in,
            cashflow_out: cashById.get(String(p.id))?.out ?? p.cashflow_out,
          }))
        );
      }
      if (paymentsRes.ok) {
        setPaymentRequests(await paymentsRes.json());
      }
      if (todoRes.ok) {
        const todos = await todoRes.json();
        setTodoCount((todos as any[]).filter((t) => t.status === "pending").length);
      }
      if (indentsRes.ok) {
        setIndents(await indentsRes.json());
      }
      if (leavesRes.ok) {
        setLeaves(await leavesRes.json());
      }
    } catch (err) {
      console.error("Error fetching projects dashboard data:", err);
    } finally {
      setHubLoaded(true);
    }
  };

  useEffect(() => {
    fetchData();
  }, [companyId, accessToken]);

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch(`${apiHost}/apis/v3/planning/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          company_id: companyId,
          name: newProjectName,
          code: newProjectCode || `PROJ-${Math.floor(100 + Math.random() * 900)}`,
          city: newProjectCity,
          status: "Ongoing"
        })
      });
      if (res.ok) {
        showToast("Project created successfully!");
        setNewProjectName("");
        setNewProjectCode("");
        setIsNewProjectOpen(false);
        fetchData();
      } else {
        const errData = await res.json();
        showToast(`Failed: ${detailToMessage(errData.detail, "Unknown error")}`);
      }
    } catch (err) {
      console.error(err);
      showToast("Error creating project.");
    }
  };

  const handleApproveLeave = async (leaveId: string, targetStatus: "Approved" | "Rejected") => {
    try {
      const res = await fetch(`${apiHost}/apis/v3/hr/leaves/approve/${leaveId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`
        },
        body: JSON.stringify({ status: targetStatus })
      });
      if (res.ok) {
        fetchData();
        showToast(`Leave request ${targetStatus.toLowerCase()}!`);
      } else {
        const err = await readErrorDetail(res);
        showToast(err || 'Action failed');
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Computations
  const pendingApprovalsCount = paymentRequests.filter((p) => p.status.toLowerCase() === "pending").length;
  const pendingMaterialsCount = indents.filter((i) => i.status.toLowerCase() === "pending").length;
  const pendingLeavesCount = leaves.filter((l) => l.status.toLowerCase() === "pending").length;
  const normalizedStageFilter = normalizeText(stageFilter);
  const normalizedSearchQuery = normalizeText(searchQuery.trim());

  const filteredProjects = projects.filter((p) => {
    // Stage Filter
    if (normalizedStageFilter !== "all" && normalizeText(getProjectStatus(p)) !== normalizedStageFilter) return false;
    // Search Query
    if (normalizedSearchQuery) {
      const searchable = [
        getProjectName(p),
        getProjectCode(p),
        getProjectStatus(p),
        getProjectAddress(p),
        getProjectHealth(p)
      ].join(" ");
      return normalizeText(searchable).includes(normalizedSearchQuery);
    }
    return true;
  });

  const filteredIndents = indents.filter((ind) => {
    if (ind.status.toLowerCase() !== mrTab) return false;
    if (mrProjectFilter && ind.project_id !== mrProjectFilter) return false;
    if (mrSearchFilter) {
      const matchesMat = ind.items.some((item) => item.material_name.toLowerCase().includes(mrSearchFilter.toLowerCase()));
      const matchesNum = ind.indent_number.toLowerCase().includes(mrSearchFilter.toLowerCase());
      return matchesMat || matchesNum;
    }
    return true;
  });

  const featuredProject = filteredProjects[0];
  const projectDetailTiles = [
    {
      label: "Project Name",
      value: featuredProject ? getProjectName(featuredProject) : "—",
      tone: "default" as const
    },
    {
      label: "Project Code",
      value: featuredProject ? getProjectCode(featuredProject) : "—",
      tone: "default" as const
    },
    {
      label: "Project Status",
      value: featuredProject ? getProjectStatus(featuredProject) : "—",
      tone: "status" as const
    },
    {
      label: "Project Address",
      value: featuredProject ? getProjectAddress(featuredProject) : "—",
      tone: "default" as const
    },
    {
      label: "Project Health",
      value: featuredProject ? getProjectHealth(featuredProject) : "—",
      tone: "health" as const
    }
  ];

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title="Project Hub"
        subtitle="Central project status and navigation hub"
        action={
          canEditProjects && <button
            onClick={() => setIsNewProjectOpen(true)}
            className="flex items-center gap-1 px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-md text-xs font-medium transition-all cursor-pointer"
          >
            + New Project
          </button>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">
        <div className="space-y-6">
          {/* Leave Management Banner */}
      {seesLeaves && (
      <div className="rounded-lg bg-card border border-border-custom p-5 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 relative overflow-hidden">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded font-semibold uppercase tracking-wider">Leave Management</span>
            {pendingLeavesCount > 0 && (
              <span className="text-xs bg-success/10 text-success px-2 py-0.5 rounded font-semibold">{pendingLeavesCount} Pending</span>
            )}
          </div>
          <h2 className="text-base font-semibold text-foreground">Approve Leave Requests of your site team</h2>
          <p className="text-xs text-muted max-w-2xl">
            Enable auto attendance logs computation, leave balance updates & payroll line reconciliation directly inside SiteFlow.
          </p>
        </div>
        <button
          onClick={() => setIsLeaveModalOpen(true)}
          className="shrink-0 px-4 py-2 rounded-md bg-primary hover:bg-primary-hover text-xs font-medium text-white transition-all cursor-pointer"
        >
          Open Leave Manager
        </button>
      </div>
      )}

      {/* KPI Cards Hub */}
      <div className={`grid grid-cols-1 gap-6 ${kpiCols === 3 ? "md:grid-cols-3" : kpiCols === 2 ? "md:grid-cols-2" : ""}`}>
        {/* Approvals */}
        {seesFinance && (
        <Link
          href={`/c/${companyId}/d/payment-approval`}
          className="rounded-lg bg-card border border-border-custom p-5 hover:border-primary/35 transition-all flex flex-col justify-between"
        >
          <div className="flex justify-between items-start">
            <div className="text-muted text-xs font-medium uppercase tracking-wider">Approval (Pending)</div>
            <Icon name="banknote" className="w-5 h-5 shrink-0" />
          </div>
          <div className="flex items-baseline gap-2 mt-4">
            <span className="text-2xl font-semibold text-foreground">{pendingApprovalsCount}</span>
            <span className="text-xs text-muted font-normal">requests</span>
          </div>
        </Link>
        )}

        {/* Material Request */}
        {seesIndents && (
        <div
          onClick={() => setIsMaterialDrawerOpen(true)}
          className="rounded-lg bg-card border border-border-custom p-5 hover:border-primary/35 transition-all flex flex-col justify-between cursor-pointer"
        >
          <div className="flex justify-between items-start">
            <div className="text-muted text-xs font-medium uppercase tracking-wider">Material (Pending)</div>
            <Icon name="package" className="w-5 h-5 shrink-0" />
          </div>
          <div className="flex items-baseline gap-2 mt-4">
            <span className="text-2xl font-semibold text-foreground">{pendingMaterialsCount}</span>
            <span className="text-xs text-muted font-normal">indents</span>
          </div>
        </div>
        )}

        {/* To Do */}
        <Link
          href={`/c/${companyId}/d/todo`}
          className="rounded-lg bg-card border border-border-custom p-5 hover:border-primary/35 transition-all flex flex-col justify-between"
        >
          <div className="flex justify-between items-start">
            <div className="text-muted text-xs font-medium uppercase tracking-wider">To Do (Pending)</div>
            <Icon name="check_circle" className="w-5 h-5 shrink-0" />
          </div>
          <div className="flex items-baseline gap-2 mt-4">
            <span className="text-2xl font-semibold text-foreground">{todoCount}</span>
            <span className="text-xs text-muted font-normal">items</span>
          </div>
        </Link>
      </div>

      {/* Filter and Table Section */}
      <div className="space-y-4">
        {/* Filter bar */}
        <div className="flex flex-col md:flex-row justify-between items-stretch md:items-center gap-4">
          {/* Left Side Active Info */}
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">Project Portfolio</span>
              <span className="px-2 py-0.5 bg-elevated border border-border-custom rounded text-xs text-muted font-medium">
                {filteredProjects.length}
              </span>
            </div>
            <p className="text-xs text-muted">Planning projects with name, status, address, and health details.</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Stage filter dropdown */}
            <select
              value={stageFilter}
              onChange={(e) => setStageFilter(e.target.value)}
              className="input-field"
            >
              <option value="All">All Statuses</option>
              <option value="Ongoing">Ongoing</option>
              <option value="Onhold">On Hold</option>
              <option value="Completed">Completed</option>
            </select>

            {/* Search Input */}
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search name, code, address, or health..."
              className="input-field placeholder-muted"
            />

            <button
              onClick={() => showToast("Exporting project ledger report to CSV...")}
              className="px-3 py-2 bg-card border border-border-custom rounded-md text-xs font-medium hover:bg-elevated transition-all cursor-pointer"
            >
              Export Portfolio
            </button>
          </div>
        </div>

        {/* Project Details strip */}
        <div className="rounded-lg border border-border-custom bg-card p-5 space-y-4">
          <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div className="space-y-1">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">Project Details</div>
              <h3 className="text-sm font-semibold text-foreground">Project Name, Project Code, Project Status, Project Health, Project Address</h3>
              <p className="text-xs text-muted max-w-3xl">
                Overview of key project attributes including identifier codes, current status, health metrics, and location.
              </p>
            </div>
            <div className="px-3 py-1.5 rounded-md bg-elevated border border-border-custom text-xs font-medium text-muted">
              {filteredProjects.length} visible project{filteredProjects.length === 1 ? "" : "s"}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {projectDetailTiles.map((tile) => (
              <div key={tile.label} className="rounded-lg border border-border-custom bg-background/60 px-4 py-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{tile.label}</div>
                <div className="mt-1">
                  {tile.tone === "status" ? (
                    <Badge tone={getProjectStatusTone(tile.value)} className="uppercase tracking-wider">
                      {tile.value}
                    </Badge>
                  ) : tile.tone === "health" ? (
                    <Badge tone={getProjectHealthTone(tile.value)} className="uppercase tracking-wider">
                      {tile.value}
                    </Badge>
                  ) : (
                    <span className="block truncate text-sm font-semibold text-foreground">{tile.value}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Projects Table */}
        <div className="rounded-lg border border-border-custom bg-card overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-border-custom text-muted font-semibold uppercase tracking-wider bg-background/50">
                <th className="px-6 py-3.5">Project Name</th>
                <th className="px-6 py-3.5">Project Status</th>
                <th className="px-6 py-3.5">Project Address</th>
                <th className="px-6 py-3.5">Project Health</th>
                <th className="px-6 py-3.5">Progress</th>
                {seesFinance && <th className="px-6 py-3.5 text-right">Cash Flow In / Out</th>}
                <th className="px-6 py-3.5 text-center">Project Tasks</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-custom">
              {filteredProjects.length === 0 && hubLoading ? (
                <tr><td colSpan={seesFinance ? 7 : 6} className="p-8 text-center text-muted text-sm">Loading projects...</td></tr>
              ) : filteredProjects.length === 0 ? (
                <tr>
                  <td colSpan={seesFinance ? 7 : 6} className="px-6 py-12 text-center text-muted font-medium">
                    {canEditProjects ? 'No active projects. Click "+ New Project" to create one.' : "No active projects yet."}
                  </td>
                </tr>
              ) : (
                filteredProjects.map((p) => (
                  <tr key={p.id} className="hover:bg-elevated/20 transition-colors">
                    <td className="px-6 py-4">
                      <Link href={`/c/${companyId}/d/planning/gantt`} onClick={() => setActiveProjectId(p.id)} className="text-foreground hover:text-primary font-medium transition-colors text-sm">
                        {getProjectName(p)}
                      </Link>
                      <span className="block text-xs text-muted mt-1 uppercase tracking-wider font-normal">
                        {getProjectCode(p)} • {p.city}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <Badge tone={getProjectStatusTone(getProjectStatus(p))} className="uppercase tracking-wider">
                        {getProjectStatus(p)}
                      </Badge>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm font-medium text-foreground">{getProjectAddress(p)}</div>
                    </td>
                    <td className="px-6 py-4">
                      <Badge tone={getProjectHealthTone(getProjectHealth(p))} className="uppercase tracking-wider">
                        {getProjectHealth(p)}
                      </Badge>
                    </td>
                    <td className="px-6 py-4 w-52">
                      <div className="flex items-center gap-3">
                        <div className="h-1.5 bg-elevated rounded-full flex-1 overflow-hidden">
                          <div
                            className="h-full bg-primary rounded-full"
                            style={{ width: `${p.progress || 0}%` }}
                          />
                        </div>
                        <span className="text-xs font-medium text-muted">{Math.round(p.progress || 0)}%</span>
                      </div>
                    </td>
                    {seesFinance && (
                    <td className="px-6 py-4 text-right">
                      <div className="text-success font-semibold text-sm">₹{(p.cashflow_in || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</div>
                      <div className="text-danger font-medium text-xs mt-0.5">₹{(p.cashflow_out || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</div>
                    </td>
                    )}
                    <td className="px-6 py-4 text-center">
                      <div className="flex items-center justify-center gap-2">
                        <Link
                          href={`/c/${companyId}/d/todo`}
                          className="px-2.5 py-1 bg-elevated border border-border-custom text-foreground rounded text-xs hover:bg-elevated/80 font-medium transition-all"
                        >
                          View Tasks
                        </Link>
                        <button
                          onClick={async () => {
                            try {
                              const res = await fetch(`${apiHost}/apis/v3/todos/`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` },
                                body: JSON.stringify({ company_id: companyId, project_id: p.id, title: "Quick task" }),
                              });
                              if (res.ok) {
                                setTodoCount((c) => c + 1);
                                showToast("Task quick-added to WBS backlog!");
                              } else {
                                const err = await res.json().catch(() => ({}));
                                showToast(detailToMessage(err.detail, "Failed to add task"));
                              }
                            } catch (e) {
                              showToast("Failed to add task");
                            }
                          }}
                          className="h-6 w-6 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold hover:bg-primary/20 transition-all cursor-pointer"
                        >
                          +
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      </div>

      {/* Leave Management Modal */}
      {isLeaveModalOpen && (
        <div className="fixed inset-0 bg-background/80 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-2xl bg-card border border-border-custom rounded-lg overflow-hidden shadow-lg animate-in fade-in zoom-in-95 duration-150">
            {/* Header */}
            <div className="p-5 border-b border-border-custom flex justify-between items-center bg-card">
              <div>
                <h3 className="text-base font-semibold text-foreground">Leave Requests Manager</h3>
                <p className="text-xs text-muted mt-1">Review pending leave applications from your active site crew.</p>
              </div>
              <button
                onClick={() => setIsLeaveModalOpen(false)}
                className="text-muted hover:text-foreground cursor-pointer"
              >
                <Icon name="close" className="w-5 h-5" />
              </button>
            </div>

            {/* List */}
            <div className="p-5 space-y-4 max-h-[400px] overflow-y-auto">
              {leaves.length === 0 && hubLoading ? (
                <div className="p-6 text-center text-muted text-sm">Loading leave requests...</div>
              ) : leaves.length === 0 ? (
                <EmptyState
                  title="No leave requests found"
                  description="No leave applications submitted by site staff."
                />
              ) : (
                leaves.map((l) => (
                  <div key={l.id} className="p-4 bg-elevated/20 border border-border-custom rounded-lg flex justify-between items-center gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-foreground text-sm">{l.employee_name}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded font-medium uppercase tracking-wider ${
                          l.status === "Approved" ? "bg-success/10 text-success" : l.status === "Rejected" ? "bg-danger/10 text-danger" : "bg-warning/10 text-warning"
                        }`}>{formatLabel(l.status)}</span>
                      </div>
                      <p className="text-xs text-muted">
                        Type: <span className="text-foreground font-medium">{l.leave_type}</span> • Duration: <span className="text-foreground font-medium">{l.days_count} Days</span>
                      </p>
                    </div>

                    {l.status === "Pending" && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleApproveLeave(l.id, "Rejected")}
                          className="px-3 py-1.5 border border-border-custom text-foreground text-xs font-medium rounded-md hover:bg-elevated transition-all cursor-pointer"
                        >
                          Reject
                        </button>
                        <button
                          onClick={() => handleApproveLeave(l.id, "Approved")}
                          className="px-3 py-1.5 bg-success hover:bg-success/90 text-white text-xs font-medium rounded-md transition-all cursor-pointer"
                        >
                          Approve
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* New Project Drawer Modal */}
      {isNewProjectOpen && (
        <div className="fixed inset-0 bg-background/80 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-md bg-card border border-border-custom rounded-lg overflow-hidden shadow-lg animate-in fade-in zoom-in-95 duration-150">
            <div className="p-5 border-b border-border-custom flex justify-between items-center bg-card">
              <h3 className="text-xs font-semibold text-foreground uppercase tracking-wider">Add New Project</h3>
              <button onClick={() => setIsNewProjectOpen(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>

            <form onSubmit={handleCreateProject} className="p-5 space-y-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted uppercase tracking-wider">Project Name *</label>
                <input
                  type="text"
                  required
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="e.g. Skyline Residency"
                  className="input-field w-full"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted uppercase tracking-wider">Project Code</label>
                <input
                  type="text"
                  value={newProjectCode}
                  onChange={(e) => setNewProjectCode(e.target.value)}
                  placeholder="e.g. SKY-01"
                  className="input-field w-full"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted uppercase tracking-wider">City</label>
                <input
                  type="text"
                  value={newProjectCity}
                  onChange={(e) => setNewProjectCity(e.target.value)}
                  placeholder="e.g. Bangalore"
                  className="input-field w-full"
                />
              </div>

              <button
                type="submit"
                className="w-full py-2 bg-primary hover:bg-primary-hover text-white font-medium rounded-md text-sm transition-all mt-4 cursor-pointer"
              >
                Create Project
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Material requests drawer panel */}
      {isMaterialDrawerOpen && (
        <div className="fixed inset-y-0 right-0 w-full max-w-2xl bg-card border-l border-border-custom shadow-lg z-50 flex flex-col justify-between animate-in slide-in-from-right duration-200">
          <div className="flex flex-col flex-1 overflow-hidden">
            {/* Header */}
            <div className="p-5 border-b border-border-custom flex justify-between items-center bg-sidebar">
              <div>
                <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">Material Requests</h3>
                <p className="text-xs text-muted mt-0.5">Approve, order, and track status of project raw material indent requests.</p>
              </div>
              <button
                onClick={() => setIsMaterialDrawerOpen(false)}
                className="text-muted hover:text-foreground cursor-pointer"
              >
                <Icon name="close" className="w-5 h-5" />
              </button>
            </div>

            {/* Inner Subtabs */}
            <div className="flex border-b border-border-custom bg-sidebar px-5 py-2 gap-4">
              {(["pending", "approved", "ordered", "rejected"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setMrTab(tab)}
                  className={`text-xs font-semibold uppercase tracking-wider py-1 border-b-2 cursor-pointer transition-all ${
                    mrTab === tab
                      ? "border-primary text-primary"
                      : "border-transparent text-muted hover:text-foreground"
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>

            {/* Filters */}
            <div className="p-5 bg-elevated/20 border-b border-border-custom grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted uppercase tracking-wider">Filter by Project</label>
                <select
                  value={mrProjectFilter}
                  onChange={(e) => setMrProjectFilter(e.target.value)}
                  className="input-field"
                >
                  <option value="">All Projects</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-muted uppercase tracking-wider">Search Material / Indent</label>
                <input
                  type="text"
                  value={mrSearchFilter}
                  onChange={(e) => setMrSearchFilter(e.target.value)}
                  placeholder="e.g. Cement, Steel"
                  className="input-field placeholder-muted"
                />
              </div>
            </div>

            {/* Indent List */}
            <div className="p-5 overflow-y-auto flex-1">
              <div className="rounded-lg border border-border-custom bg-card overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1100px] text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-border-custom text-muted font-semibold uppercase tracking-wider bg-background/50">
                        <th className="px-6 py-3.5">Indent No.</th>
                        <th className="px-6 py-3.5">Project</th>
                        <th className="px-6 py-3.5">Created</th>
                        <th className="px-6 py-3.5">Materials</th>
                        <th className="px-6 py-3.5">Status</th>
                        <th className="px-6 py-3.5 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-custom">
                      {filteredIndents.length === 0 && hubLoading ? (
                        <tr><td colSpan={6} className="p-8 text-center text-muted text-sm">Loading indents...</td></tr>
                      ) : filteredIndents.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="p-8">
                            <EmptyState
                              title="No material indents found"
                              description={`No indents found matching tab "${mrTab}".`}
                            />
                          </td>
                        </tr>
                      ) : (
                        filteredIndents.map((ind) => {
                          return (
                            <tr key={ind.id} className="hover:bg-elevated/20 transition-colors">
                              <td className="px-6 py-4">
                                <div className="text-sm font-semibold text-foreground">{ind.indent_number}</div>
                              </td>
                              <td className="px-6 py-4">
                                <div className="text-sm font-medium text-foreground">{projects.find((p) => p.id === ind.project_id)?.name || 'Unknown Project'}</div>
                              </td>
                              <td className="px-6 py-4 text-muted">
                                {formatDate(ind.created_at)}
                              </td>
                              <td className="px-6 py-4">
                                {ind.items.length > 0 ? (
                                  <div className="space-y-1 text-sm text-foreground">
                                    {ind.items.map((item, idx) => (
                                      <div key={idx} className="leading-snug">
                                        <span className="font-medium">{item.material_name}</span>
                                        <span className="text-muted"> • {item.quantity} {item.unit}</span>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-muted">No items</span>
                                )}
                              </td>
                              <td className="px-6 py-4">
                                <Badge tone="neutral" className="uppercase tracking-wider">
                                  {formatLabel(ind.status)}
                                </Badge>
                              </td>
                              <td className="px-6 py-4 text-right">
                                {ind.status === "pending" ? (
                                  <button
                                    onClick={async () => {
                                      try {
                                        const res = await fetch(`${apiHost}/apis/v3/procurement/indents/${ind.id}/approve`, {
                                          method: "POST",
                                          headers: { "Authorization": `Bearer ${accessToken}` }
                                        });
                                        if (res.ok) {
                                          fetchData();
                                          showToast("Material indent approved!");
                                        } else {
        const err = await readErrorDetail(res);
        showToast(err || 'Action failed');
      }
                                      } catch (err) {
                                        console.error(err);
                                      }
                                    }}
                                    className="px-3 py-1.5 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-md transition-all cursor-pointer"
                                  >
                                    Approve Indent
                                  </button>
                                ) : (
                                  <span className="text-muted">-</span>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Global Toast Message in layout - but local backup in case layout not wrapped */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 bg-card border border-success/30 rounded-lg px-4 py-3 text-xs text-success shadow-lg z-50 animate-bounce flex items-center gap-2">
          <Icon name="bolt" className="w-4 h-4" />
          <span className="font-semibold">{toastMessage}</span>
        </div>
      )}
        </div>
      </PageShell>
      </div>
    </div>
  );
}
