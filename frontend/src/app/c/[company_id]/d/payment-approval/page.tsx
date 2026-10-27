"use client";

import React, { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { getApiHost } from "@/lib/api";
import { formatDate, formatLabel } from "@/lib/siteflow";
import Icon from "@/components/marketing/Icon";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import SegmentedTabs from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";

interface Project {
  id: string;
  name?: string;
  code?: string;
  project_name?: string;
  project_code?: string;
}

interface PaymentRequest {
  id: string;
  party_name: string;
  amount: number;
  details: string;
  status: string;
  due_date?: string;
  created_at: string;
  project_id?: string | null;
}

const COMPANY_WIDE_FILTER = "__company_wide__";

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

const getProjectName = (project?: Project | null) => project?.project_name || project?.name || "—";

const getProjectCode = (project?: Project | null) => project?.project_code || project?.code || "";

const getProjectLabel = (project?: Project | null) => {
  if (!project) return "Company-wide";

  const projectCode = getProjectCode(project);
  return projectCode ? `${getProjectName(project)} (${projectCode})` : getProjectName(project);
};

export default function PaymentApprovalPage() {
  const params = useParams();
  const companyId = params.company_id as string;
  const accessToken = typeof window !== "undefined" ? localStorage.getItem("access_token") : "";

  const [requests, setRequests] = useState<PaymentRequest[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [filterStatus, setFilterStatus] = useState("Pending");
  const [projectFilter, setProjectFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [toastMessage, setToastMessage] = useState("");

  const apiHost = getApiHost();

  // False until the first load answers, so the list says Loading rather than empty.
  const [requestsLoaded, setRequestsLoaded] = useState(false);

  const fetchData = async () => {
    if (!companyId || !accessToken) return;
    const authHeaders = { "Authorization": `Bearer ${accessToken}` };

    try {
      const res = await fetch(`${apiHost}/apis/v3/finance/payment-requests/${companyId}`, {
        headers: authHeaders
      });
      if (res.ok) {
        const data = await res.json();
        setRequests(data);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setRequestsLoaded(true);
    }

    try {
      const res = await fetch(`${apiHost}/apis/v3/planning/projects?company_id=${companyId}`, {
        headers: authHeaders
      });
      if (res.ok) {
        const data = await res.json();
        setProjects(extractProjects(data));
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchData();
  }, [companyId, accessToken]);

  const handleUpdateStatus = async (requestId: string, action: "Approved" | "Rejected" | "Paid") => {
    try {
      const res = await fetch(`${apiHost}/apis/v3/finance/payment-requests/approve/${requestId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`
        },
        body: JSON.stringify({ status: action })
      });
      if (res.ok) {
        setToastMessage(`Payment request ${action.toLowerCase()} successfully!`);
        setTimeout(() => setToastMessage(""), 3000);
        fetchData();
      } else {
        let detail = "";
        try {
          const body = await res.json();
          if (typeof body?.detail === "string") detail = body.detail;
        } catch {}
        alert(`Approval failed: ${detail || `HTTP ${res.status}`}`);
      }
    } catch (err) {
      console.error(err);
      alert("Approval failed. Check your connection and try again.");
    }
  };

  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const normalizedSearch = searchQuery.toLowerCase();

  const filteredRequests = requests.filter((r) => {
    const matchesStatus = r.status.toLowerCase() === filterStatus.toLowerCase();
    const project = r.project_id ? projectMap.get(r.project_id) : undefined;
    const projectLabel = getProjectLabel(project);
    const matchesProject =
      !projectFilter ||
      (projectFilter === COMPANY_WIDE_FILTER ? !r.project_id : r.project_id === projectFilter);
    const matchesSearch =
      r.party_name.toLowerCase().includes(normalizedSearch) ||
      (r.details && r.details.toLowerCase().includes(normalizedSearch)) ||
      projectLabel.toLowerCase().includes(normalizedSearch);
    return matchesStatus && matchesProject && matchesSearch;
  });

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title="Payment Approvals"
        subtitle="Review, authorize, or decline transactions submitted by team members"
      />
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">
          <div className="space-y-6">

          {/* Filter and Search Bar */}
          <div className="flex flex-col md:flex-row justify-between items-stretch md:items-center gap-4 mb-6">
            <SegmentedTabs
              tabs={[
                { id: "Pending", label: "Pending" },
                { id: "Approved", label: "Approved" },
                { id: "Rejected", label: "Rejected" },
              ]}
              activeTab={filterStatus}
              onChange={(t) => setFilterStatus(t)}
            />

        <div className="flex flex-col sm:flex-row gap-3 w-full md:max-w-2xl">
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="input-field px-4 py-2 text-xs font-semibold focus:outline-none placeholder-muted w-full sm:max-w-xs"
          >
            <option value="">All Projects</option>
            <option value={COMPANY_WIDE_FILTER}>Company-wide</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {getProjectLabel(project)}
              </option>
            ))}
          </select>

          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by party name, details, or project..."
            className="input-field px-4 py-2 text-xs font-semibold focus:outline-none placeholder-muted w-full md:max-w-xs"
          />
        </div>
      </div>

      {/* Requests List */}
      <div className="space-y-4">
        {filteredRequests.length === 0 && !requestsLoaded ? (
          <div className="p-8 text-center text-muted text-sm">Loading approvals...</div>
        ) : filteredRequests.length === 0 ? (
          <EmptyState
            title="No approvals found"
            description="No requests match the selected status or project filter."
          />
        ) : (
          filteredRequests.map((r) => (
            <div
              key={r.id}
              className="p-6 bg-card border border-border-custom rounded-md flex flex-col md:flex-row justify-between items-start md:items-center gap-4 hover:border-border-custom transition-all"
            >
              <div className="space-y-2">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-semibold text-foreground text-base">{r.party_name}</span>
                  <span className={`text-[9px] px-2 py-0.5 rounded font-bold uppercase tracking-wider ${
                    r.status === "Approved"
                      ? "bg-success/10 text-success"
                      : r.status === "Rejected"
                      ? "bg-danger/10 text-danger"
                      : "bg-warning/10 text-warning"
                  }`}>{formatLabel(r.status)}</span>
                  <span className="text-[10px] px-2 py-0.5 rounded border border-border-custom bg-elevated text-muted font-medium">
                    Project: {getProjectLabel(r.project_id ? projectMap.get(r.project_id) : undefined)}
                  </span>
                </div>
                
                <p className="text-muted text-xs max-w-xl">{r.details || "—"}</p>
                
                <div className="flex gap-4 text-[10px] text-muted">
                  <span className="inline-flex items-center gap-1"><Icon name="calendar" className="w-3 h-3" /> Submitted: {formatDate(r.created_at)}</span>
                  {r.due_date && (
                    <span className="inline-flex items-center gap-1"><Icon name="schedule" className="w-3 h-3" /> Due: {formatDate(r.due_date)}</span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-4 w-full md:w-auto justify-between md:justify-end border-t border-border-custom md:border-t-0 pt-4 md:pt-0">
                <div className="text-right">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted block">Requested Amount</span>
                  <span className="text-lg font-semibold text-foreground">₹{r.amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                </div>

                {r.status === "Pending" && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleUpdateStatus(r.id, "Rejected")}
                      className="px-3.5 py-1.5 border border-border-custom text-foreground text-xs font-medium rounded-md hover:bg-elevated transition-all cursor-pointer"
                    >
                      Reject
                    </button>
                    <button
                      onClick={() => handleUpdateStatus(r.id, "Approved")}
                      className="px-3.5 py-1.5 bg-success hover:bg-success/90 text-white text-xs font-medium rounded-md transition-all cursor-pointer"
                    >
                      Approve
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Local Toast Alert */}
      {toastMessage && (
        <div className="absolute bottom-6 right-6 bg-card border border-success/30 rounded-md px-4 py-3 text-xs text-success shadow-2xl z-50">
          <span className="inline-flex"><Icon name="bolt" className="w-3.5 h-3.5" /></span>
          <span className="font-semibold">{toastMessage}</span>
        </div>
      )}
        </div>
      </PageShell>
      </div>
    </div>
  );
}
