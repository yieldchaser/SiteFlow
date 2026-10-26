"use client";
import Badge, { type BadgeTone } from "@/components/ui/Badge";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import { getApiHost } from "@/lib/api";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";

type DeleteLog = {
  id: string;
  company_id: string | null;
  entity_type: string;
  entity_id: string;
  entity_summary: string;
  party_name: string | null;
  deleted_by: string | null;
  deleted_at: string | null;
};

const ENTITY_TYPES = [
  "approval_rule",
  "asset_type",
  "chat_group_member",
  "cost_code",
  "crm_lead",
  "deduction",
  "drawing_pin",
  "holiday",
  "leave_template",
  "library_todo",
  "location",
  "material",
  "material_category",
  "mom",
  "party",
  "payment",
  "payment_request",
  "progress",
  "project",
  "project_member",
  "project_party",
  "rate",
  "retention",
  "salary_template",
  "task",
  "timesheet",
  "todo",
  "tower",
  "workforce",
];

const formatEntityType = (type: string): string => {
  if (!type) return "—";
  const map: Record<string, string> = {
    purchase_order: "Purchase Order",
    goods_receipt_note: "Goods Receipt Note",
    cash_voucher: "Cash Voucher",
    approval_rule: "Approval Rule",
    asset_type: "Asset Type",
    chat_group_member: "Chat Group Member",
    cost_code: "Cost Code",
    crm_lead: "CRM Lead",
    drawing_pin: "Drawing Pin",
    leave_template: "Leave Template",
    library_todo: "Library To Do",
    material_category: "Material Category",
    payment_request: "Payment Request",
    project_member: "Project Member",
    project_party: "Project Party",
    salary_template: "Salary Template",
  };
  if (map[type]) return map[type];
  return type
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
};

export default function DeleteLogsPage() {
  const params = useParams();
  const companyId = params.company_id as string;
  const accessToken = typeof window !== "undefined" ? localStorage.getItem("access_token") : "";
  const apiHost = getApiHost();

  const [logs, setLogs] = useState<DeleteLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [entityType, setEntityType] = useState("");
  const [party, setParty] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");

  const authHeaders = useMemo(
    () => (accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined),
    [accessToken]
  );

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (entityType) qs.set("entity_type", entityType);
      if (party) qs.set("party", party);
      if (fromDate) qs.set("from_date", fromDate);
      if (toDate) qs.set("to_date", toDate);
      const query = qs.toString();
      const res = await fetch(
        `${apiHost}/apis/v3/delete-logs/${companyId}${query ? `?${query}` : ""}`,
        { headers: authHeaders }
      );
      if (res.ok) {
        const data = await res.json();
        setLogs(Array.isArray(data) ? data : []);
        setError("");
      } else {
        setLogs([]);
        setError(`Could not load delete logs (HTTP ${res.status})`);
      }
    } catch {
      setLogs([]);
      setError("Could not load delete logs. Backend connection failed.");
    } finally {
      setLoading(false);
    }
  }, [apiHost, companyId, entityType, party, fromDate, toDate, authHeaders]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const handlePurge = async (log: DeleteLog) => {
    if (!confirm(`Permanently purge this delete log for "${log.entity_summary}"?`)) return;
    try {
      const res = await fetch(`${apiHost}/apis/v3/delete-logs/${companyId}/${log.id}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      if (res.ok) {
        setToast("Delete log purged successfully.");
        setLogs((prev) => prev.filter((l) => l.id !== log.id));
      } else {
        setToast("Failed to purge delete log.");
      }
    } catch {
      setToast("Failed to purge delete log.");
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title="Delete Logs"
        subtitle="Company-level audit trail of deleted records"
      />
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 mb-5 bg-card border border-border-custom rounded-lg p-4">
        <div className="flex flex-col">
          <label className="text-xs text-muted mb-1">Entity Type</label>
          <select
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            className="border border-border-custom rounded-md px-3 py-2 text-sm bg-background text-foreground"
          >
            <option value="">All</option>
            {ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {formatEntityType(t)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-muted mb-1">Party</label>
          <input
            type="text"
            value={party}
            onChange={(e) => setParty(e.target.value)}
            placeholder="Search party..."
            className="border border-border-custom rounded-md px-3 py-2 text-sm bg-background text-foreground"
          />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-muted mb-1">From Date</label>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="border border-border-custom rounded-md px-3 py-2 text-sm bg-background text-foreground"
          />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-muted mb-1">To Date</label>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="border border-border-custom rounded-md px-3 py-2 text-sm bg-background text-foreground"
          />
        </div>
        <button
          onClick={fetchLogs}
          className="px-4 py-2 rounded-md bg-primary text-white text-sm font-medium hover:opacity-90 cursor-pointer"
        >
          Apply Filters
        </button>
      </div>

      {/* Table */}
      <div className="border border-border-custom rounded-lg overflow-hidden bg-card">
        <table className="w-full text-sm">
          <thead className="bg-elevated text-muted">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Date</th>
              <th className="text-left px-4 py-3 font-medium">Entity Type</th>
              <th className="text-left px-4 py-3 font-medium">Summary</th>
              <th className="text-left px-4 py-3 font-medium">Party</th>
              <th className="text-left px-4 py-3 font-medium">Deleted By</th>
              <th className="text-right px-4 py-3 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-t border-border-custom">
                  <td className="px-4 py-3"><Skeleton className="h-4 w-24" /></td>
                  <td className="px-4 py-3"><Skeleton className="h-4 w-20" /></td>
                  <td className="px-4 py-3"><Skeleton className="h-4 w-40" /></td>
                  <td className="px-4 py-3"><Skeleton className="h-4 w-28" /></td>
                  <td className="px-4 py-3"><Skeleton className="h-4 w-24" /></td>
                  <td className="px-4 py-3 text-right"><Skeleton className="h-6 w-16 ml-auto rounded" /></td>
                </tr>
              ))
            ) : error ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-danger">
                  {error}
                </td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-6">
                  <EmptyState
                    icon="trash"
                    title="No delete logs found"
                    description="Deleted records and audit entries will appear here."
                    compact={true}
                  />
                </td>
              </tr>
            ) : (
              logs.map((log) => (
                <tr key={log.id} className="border-t border-border-custom hover:bg-elevated">
                  <td className="px-4 py-3 text-muted">
                    {log.deleted_at ? new Date(log.deleted_at).toLocaleString("en-IN") : "-"}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone="primary">{formatEntityType(log.entity_type)}</Badge>
                  </td>
                  <td className="px-4 py-3 text-foreground">{log.entity_summary}</td>
                  <td className="px-4 py-3 text-muted">{log.party_name || "-"}</td>
                  <td className="px-4 py-3 text-muted">{log.deleted_by || "-"}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handlePurge(log)}
                      className="px-3 py-1.5 rounded-md border border-danger/20 text-danger text-xs font-medium hover:bg-danger/10"
                    >
                      Purge
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {toast && (
        <div className="fixed bottom-6 right-6 bg-foreground text-background px-4 py-2 rounded-md text-sm shadow-lg">
          {toast}
        </div>
      )}
      </PageShell>
      </div>
    </div>
  );
}
