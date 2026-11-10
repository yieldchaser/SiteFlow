"use client";
import React, { useState, useEffect, useCallback } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { useProject } from "@/context/ProjectContext";
import { getApiHost, readErrorDetail } from "@/lib/api";
import { authHeaders, formatDate } from "@/lib/siteflow";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";

// A work order amendment changes a work order's value or terms after it was
// issued. Once a bill is raised against a work order it can no longer be
// edited, so this is the only way to change it, and every change is kept with
// what it was, what it became, who changed it and why.
//
// This page used to read the work order id from a route segment that does not
// exist, so it never loaded one, and it asked for the change as typed JSON
// whose example fields the server refuses.

interface Amendment {
  id: string;
  amendment_number: number;
  amended_fields: { estimated_work_amount?: number; terms?: string };
  previous_values?: { estimated_work_amount?: number; terms?: string } | null;
  amended_by: string | null;
  amended_at: string;
  reason: string | null;
}

interface WorkOrder {
  id: string;
  wo_number: string;
  subcontractor_name: string;
  status: string;
  estimated_work_amount: number;
  billed_amount: number;
  terms?: string | null;
}

const inr = (n: number) => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export default function WOAmendmentsPage() {
  const { company_id } = useParams();
  const companyId = company_id as string;
  const search = useSearchParams();
  const router = useRouter();
  const { activeProjectId } = useProject();
  const projectId = search.get("project") || activeProjectId;
  const woId = search.get("wo") || "";

  const [orders, setOrders] = useState<WorkOrder[] | null>(null);
  const [amendments, setAmendments] = useState<Amendment[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [newValue, setNewValue] = useState("");
  const [newTerms, setNewTerms] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const wo = orders?.find((w) => w.id === woId) || null;

  const fetchOrders = useCallback(async () => {
    if (!projectId) {
      setOrders([]);
      return;
    }
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/billing/work-orders?project_id=${projectId}`, { headers: authHeaders() });
      setOrders(res.ok ? await res.json() : []);
    } catch {
      setOrders([]);
    }
  }, [projectId]);

  const fetchAmendments = useCallback(async () => {
    if (!woId) {
      setAmendments([]);
      return;
    }
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/subcon/work-orders/${woId}/amendments`, { headers: authHeaders() });
      setAmendments(res.ok ? await res.json() : []);
    } catch {
      setAmendments([]);
    }
  }, [woId]);

  useEffect(() => {
    const id = setTimeout(() => { fetchOrders(); }, 0);
    return () => clearTimeout(id);
  }, [fetchOrders]);

  useEffect(() => {
    const id = setTimeout(() => { fetchAmendments(); }, 0);
    return () => clearTimeout(id);
  }, [fetchAmendments]);

  const pickWO = (id: string) => {
    const q = new URLSearchParams();
    if (projectId) q.set("project", projectId);
    if (id) q.set("wo", id);
    router.replace(`/c/${companyId}/d/subcon/work-orders/amendments?${q.toString()}`);
  };

  const openModal = () => {
    if (!wo) return;
    setNewValue(String(wo.estimated_work_amount ?? ""));
    setNewTerms(wo.terms || "");
    setReason("");
    setError("");
    setShowModal(true);
  };

  const save = async () => {
    if (!wo) return;
    const fields: { estimated_work_amount?: number; terms?: string } = {};
    const v = Number(newValue);
    if (newValue.trim() === "" || !Number.isFinite(v) || v < 0) {
      setError("Enter the new work order value");
      return;
    }
    if (Math.abs(v - Number(wo.estimated_work_amount || 0)) > 0.004) fields.estimated_work_amount = v;
    if (newTerms !== (wo.terms || "")) fields.terms = newTerms;
    if (Object.keys(fields).length === 0) {
      setError("Nothing changed. Change the value or the terms.");
      return;
    }
    if (!reason.trim()) {
      setError("Say why the work order is changing");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/subcon/work-orders/${wo.id}/amendments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ amended_fields: fields, reason: reason.trim() }),
      });
      if (res.ok) {
        setShowModal(false);
        fetchAmendments();
        fetchOrders();
      } else {
        setError((await readErrorDetail(res)) || "Could not save the change. Try again.");
      }
    } catch {
      setError("Could not reach the server. Check the connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  const change = (label: string, before: React.ReactNode, after: React.ReactNode) => (
    <div className="text-xs">
      <span className="text-muted">{label}: </span>
      {before !== undefined && <span className="text-muted line-through mr-1">{before}</span>}
      <span className="font-semibold text-foreground">{after}</span>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden font-sans">
      <PageHeader
        title="Work Order Amendments"
        subtitle={wo ? `${wo.wo_number} · ${wo.subcontractor_name}` : "Change a work order's value or terms after it was issued"}
      >
        {wo && wo.status !== "cancelled" && (
          <button onClick={openModal} className="px-3.5 py-1.5 rounded-md bg-primary text-xs font-bold text-white hover:opacity-90 cursor-pointer">
            + New Amendment
          </button>
        )}
      </PageHeader>

      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">
          <div className="bg-card border border-border-custom rounded-lg p-4 mb-4 flex flex-wrap items-end gap-4">
            <div className="min-w-[260px]">
              <label className="text-[10px] uppercase font-bold text-muted block mb-1">Work order</label>
              <select
                value={woId}
                onChange={(e) => pickWO(e.target.value)}
                className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-xs text-foreground"
              >
                <option value="">{orders === null ? "Loading..." : orders.length ? "Pick a work order" : "No work orders on this project"}</option>
                {(orders || []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.wo_number} · {w.subcontractor_name}{w.status === "cancelled" ? " (cancelled)" : ""}
                  </option>
                ))}
              </select>
            </div>
            {wo && (
              <div className="flex flex-wrap gap-6 text-xs">
                <div><p className="text-muted">Value now</p><p className="font-bold text-foreground">{inr(wo.estimated_work_amount)}</p></div>
                <div><p className="text-muted">Billed so far</p><p className="font-bold text-foreground">{inr(wo.billed_amount)}</p></div>
                <div><p className="text-muted">Status</p><p className="font-bold text-foreground capitalize">{wo.status}</p></div>
              </div>
            )}
          </div>

          {!projectId ? (
            <EmptyState title="Pick a project first" description="Choose a project at the top, then pick one of its work orders." />
          ) : !wo ? (
            <EmptyState
              title="Pick a work order"
              description="Amendments are kept per work order. You can also open them from the clock button next to a work order on the Subcontractors page."
            />
          ) : (
            <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
              <div className="px-5 py-4 border-b border-border-custom">
                <h2 className="text-xs font-bold uppercase tracking-wider text-muted">Amendment history</h2>
              </div>
              <div className="divide-y divide-border-custom">
                {amendments.map((am) => (
                  <div key={am.id} className="px-5 py-4">
                    <div className="flex items-start justify-between gap-4">
                      <span className="text-xs font-bold text-foreground">Amendment {am.amendment_number}</span>
                      <span className="text-[10px] text-muted">
                        {formatDate(am.amended_at)}{am.amended_by ? ` · ${am.amended_by}` : ""}
                      </span>
                    </div>
                    <div className="mt-2 space-y-1">
                      {am.amended_fields.estimated_work_amount !== undefined &&
                        change(
                          "Value",
                          am.previous_values?.estimated_work_amount !== undefined ? inr(am.previous_values.estimated_work_amount) : undefined,
                          inr(am.amended_fields.estimated_work_amount),
                        )}
                      {am.amended_fields.terms !== undefined &&
                        change(
                          "Terms",
                          am.previous_values?.terms !== undefined ? (am.previous_values.terms || "(none)") : undefined,
                          am.amended_fields.terms || "(none)",
                        )}
                    </div>
                    {am.reason && <p className="text-xs text-muted mt-2">Why: {am.reason}</p>}
                  </div>
                ))}
                {amendments.length === 0 && (
                  <EmptyState
                    title="No amendments yet"
                    description="When this work order's value or terms change after it was issued, record it here."
                    action={wo.status !== "cancelled" ? { label: "New Amendment", onClick: openModal } : undefined}
                  />
                )}
              </div>
            </div>
          )}
        </PageShell>
      </div>

      {showModal && wo && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-card border border-border-custom rounded-lg w-full max-w-md p-6 space-y-4">
            <div>
              <h3 className="text-sm font-extrabold text-foreground">New Amendment · {wo.wo_number}</h3>
              <p className="text-xs text-muted mt-1">
                Value now {inr(wo.estimated_work_amount)}, billed so far {inr(wo.billed_amount)}. The new value cannot be lower than what is already billed.
              </p>
            </div>
            {error && <div className="p-3 rounded-md bg-danger/10 border border-danger/20 text-xs text-danger">{error}</div>}
            <div className="space-y-3">
              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">New work order value (₹)</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Terms</label>
                <textarea
                  value={newTerms}
                  onChange={(e) => setNewTerms(e.target.value)}
                  rows={3}
                  className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Why is it changing? *</label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder="For example: extra 2nd floor slab area added by the client"
                  className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none"
                />
              </div>
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <button onClick={() => setShowModal(false)} className="px-4 py-2 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer">Cancel</button>
              <button
                onClick={save}
                disabled={saving}
                className="bg-primary hover:opacity-90 text-white px-5 py-2 rounded-md text-xs font-bold cursor-pointer disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save Amendment"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
