"use client";
import Badge, { type BadgeTone } from "@/components/ui/Badge";
import UnitInput from "@/components/UnitInput";
import {  getApiHost , readErrorDetail, detailToMessage} from "@/lib/api";
import { authHeaders, formatLabel, formatDate } from "@/lib/siteflow";
import React, { useState, useEffect } from "react";
import { useProject } from "@/context/ProjectContext";
import { useParams } from "next/navigation";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import AuthImage from "@/components/ui/AuthImage";

interface Wastage {
  id: string;
  material_name: string;
  wastage_type: string;
  quantity: number;
  unit: string;
  estimated_value: number;
  reason?: string;
  reported_by?: string;
  photo_urls?: string[];
  status: string;
  created_at: string;
}

export default function WastagePage() {
  const params = useParams();
  const companyId = params?.company_id as string;
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;

  const [records, setRecords] = useState<Wastage[]>([]);
  // Project the records were last loaded for; until then show Loading, not "No wastage records".
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [message, setMessage] = useState("");
  // Wastage has to name a material that actually exists on site, otherwise the
  // record can never be reconciled against stock. The DPR modal already scopes
  // its material picker to on-hand inventory; this mirrors it.
  const [inventory, setInventory] = useState<Array<{ material_name: string; unit: string; on_hand_qty: number }>>([]);

  // Quantity and value start blank. A blank value means "price it at the
  // last purchase rate for this material", which the API works out.
  const emptyForm = {
    material_name: "",
    wastage_type: "scrap",
    quantity: "",
    unit: "kg",
    estimated_value: "",
    reason: "",
    photo_urls: [] as string[],
  };
  const [form, setForm] = useState(emptyForm);
  const [team, setTeam] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!companyId) return;
    fetch(`${getApiHost()}/apis/v3/crm/team-members/${companyId}`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setTeam(Array.isArray(d) ? d : []))
      .catch(() => setTeam([]));
  }, [companyId]);
  const memberName = (id?: string) => (id ? team.find((t) => t.id === id)?.name || "" : "");

  const fetchRecords = async () => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/wastage/${projectId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setRecords(data);
      }
    } catch (e) {
      console.error("Failed to load wastage", e);
    } finally {
      setLoadedFor(projectId);
    }
  };

  const fetchInventory = async () => {
    if (!projectId) { setInventory([]); return; }
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/procurement/inventory?project_id=${projectId}`, { headers: authHeaders() });
      if (res.ok) setInventory(await res.json());
    } catch (e) {
      console.error("Failed to load inventory", e);
    }
  };

  useEffect(() => {
    const id = setTimeout(() => { fetchRecords(); fetchInventory(); }, 0);
    return () => clearTimeout(id);
  }, [projectId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/wastage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        // task_id is deliberately absent rather than "". The backend declares it
        // Optional[uuid.UUID] and an empty string fails UUID parsing, which used
        // to 422 every single submission.
        body: JSON.stringify({
          ...form,
          quantity: Number(form.quantity),
          estimated_value: form.estimated_value === "" ? null : Number(form.estimated_value),
          estimated_value_override: form.estimated_value !== "",
          company_id: companyId,
          project_id: projectId,
        }),
      });
      if (res.ok) {
        setMessage("Wastage recorded successfully");
        setShowModal(false);
        setForm(emptyForm);
        fetchRecords();
      } else {
        const err = await res.json();
        setMessage(detailToMessage(err.detail, "Failed to record wastage"));
      }
    } catch (_e) {
      void _e;
      setMessage("Error recording wastage");
    }
  };

  const updateStatus = async (id: string, status: string) => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/wastage/${id}/status?status=${status}`, { method: "PATCH", headers: authHeaders() });
      if (res.ok) {
        fetchRecords();
      } else {
        const err = await readErrorDetail(res);
        setMessage(err || 'Action failed');
      }
    } catch (e) {
      console.error("Failed to update status", e);
    }
  };

  // Rejecting a report removes it and puts the quantity back into stock.
  const rejectRecord = async (r: Wastage) => {
    if (!window.confirm(`Reject this report? ${Number(r.quantity).toLocaleString("en-IN")} ${r.unit} of ${r.material_name} goes back into stock.`)) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/wastage/${r.id}`, { method: "DELETE", headers: authHeaders() });
      if (res.ok) {
        setMessage("Report rejected and stock restored successfully");
        fetchRecords();
      } else {
        setMessage((await readErrorDetail(res)) || "Could not reject this report");
      }
    } catch (e) {
      console.error("Failed to reject wastage", e);
      setMessage("Network error. The report was not rejected.");
    }
  };

  const totalValue = records.reduce((s, r) => s + Number(r.estimated_value || 0), 0);
  const pendingValue = records.filter((r) => r.status === "reported" || r.status === "reviewed").reduce((s, r) => s + Number(r.estimated_value || 0), 0);
  const pendingCount = records.filter((r) => r.status === "reported" || r.status === "reviewed").length;
  const inr = (v: number) => `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

  const statusTones: Record<string, BadgeTone> = {
    reported: "warning",
    reviewed: "info",
    approved: "success",
    disposed: "neutral",
  };

  const typeLabels: Record<string, string> = {
    scrap: "Scrap",
    offcut: "Offcut",
    damaged: "Damaged",
    expired: "Expired",
    theft: "Theft",
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title="Material Wastage"
        subtitle="Track scrap, offcuts, damage and theft on site"
      >
        <button
          onClick={() => { setShowModal(true); setMessage(""); }}
          className="px-3.5 py-1.5 bg-primary hover:bg-primary/90 text-white rounded-md text-xs font-semibold transition-all cursor-pointer"
        >
          + Record Wastage
        </button>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">

        {message && (
          <div className={`mb-6 p-4 rounded-md ${message.includes("success") ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>
            {message}
          </div>
        )}

        {records.length > 0 && (
          <div className="mb-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="rounded-lg border border-border-custom bg-card p-4">
              <div className="text-[10px] uppercase tracking-[0.2em] text-muted">Value Lost</div>
              <div className="mt-1 text-xl font-bold text-foreground">{inr(totalValue)}</div>
              <div className="text-xs text-muted">{records.length} {records.length === 1 ? "report" : "reports"} on this project</div>
            </div>
            <div className="rounded-lg border border-border-custom bg-card p-4">
              <div className="text-[10px] uppercase tracking-[0.2em] text-muted">Waiting for Sign-off</div>
              <div className={`mt-1 text-xl font-bold ${pendingCount > 0 ? "text-warning" : "text-foreground"}`}>{pendingCount}</div>
              <div className="text-xs text-muted">{inr(pendingValue)} not yet approved</div>
            </div>
            <div className="rounded-lg border border-border-custom bg-card p-4">
              <div className="text-[10px] uppercase tracking-[0.2em] text-muted">Biggest Cause</div>
              {(() => {
                const byType: Record<string, number> = {};
                for (const r of records) byType[r.wastage_type] = (byType[r.wastage_type] || 0) + Number(r.estimated_value || 0);
                const top = Object.entries(byType).sort((a, b) => b[1] - a[1])[0];
                return top ? (
                  <>
                    <div className="mt-1 text-xl font-bold text-foreground">{typeLabels[top[0]] || formatLabel(top[0])}</div>
                    <div className="text-xs text-muted">{inr(top[1])} of the total</div>
                  </>
                ) : null;
              })()}
            </div>
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {records.length === 0 && loadedFor !== projectId ? (
            <div className="col-span-full p-8 text-center text-muted text-sm">Loading wastage records...</div>
          ) : records.length === 0 ? (
            <div className="col-span-full">
              <EmptyState
                title="No wastage records found"
                description="Track scrap, offcuts, damaged, or expired materials on site."
                action={{ label: "Record Wastage", onClick: () => { setShowModal(true); setMessage(""); } }}
              />
            </div>
          ) : (
            records.map((r) => (
              <div key={r.id} className="bg-white/5 border border-border-custom rounded-lg p-6 hover:bg-elevated transition-all">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-foreground font-semibold">{r.material_name}</h3>
                    <p className="text-muted text-xs mt-1">{typeLabels[r.wastage_type] || r.wastage_type} · {formatDate(r.created_at)}{memberName(r.reported_by) ? ` · ${memberName(r.reported_by)}` : ""}</p>
                  </div>
                  <Badge tone={statusTones[r.status] || "neutral"}>{formatLabel(r.status)}</Badge>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted">Quantity</span>
                    <span className="text-foreground font-medium">{Number(r.quantity).toLocaleString("en-IN", { maximumFractionDigits: 2 })} {r.unit}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Est. Value</span>
                    <span className="text-foreground font-medium">₹{Number(r.estimated_value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                  </div>
                  {r.reason && (
                    <div>
                      <span className="text-muted text-xs">Reason</span>
                      <p className="text-muted text-xs mt-1">{r.reason}</p>
                    </div>
                  )}
                </div>
                <div className="mt-4 pt-4 border-t border-border-custom flex gap-2">
                  {r.photo_urls && r.photo_urls.length > 0 && (
                    <div className="flex gap-2 mb-3">
                      {r.photo_urls.map((url, i) => (
                        <AuthImage key={i} src={url} alt="Wastage photo" className="w-16 h-16 rounded-lg object-cover border border-border-custom" />
                      ))}
                    </div>
                  )}
                  {(r.status === "reported" || r.status === "reviewed") && (
                    <button onClick={() => rejectRecord(r)} className="px-3 py-1.5 bg-danger/10 text-danger rounded-lg text-xs font-medium hover:bg-danger/20 transition-all">Reject</button>
                  )}
                  {r.status === "reported" && (
                    <button onClick={() => updateStatus(r.id, "reviewed")} className="flex-1 px-3 py-1.5 bg-info/10 text-info rounded-lg text-xs font-medium hover:bg-info/10 transition-all">Review</button>
                  )}
                  {r.status === "reviewed" && (
                    <button onClick={() => updateStatus(r.id, "approved")} className="flex-1 px-3 py-1.5 bg-success/10 text-success rounded-lg text-xs font-medium hover:bg-success/10 transition-all">Approve</button>
                  )}
                  {r.status === "approved" && (
                    <button onClick={() => updateStatus(r.id, "disposed")} className="flex-1 px-3 py-1.5 bg-elevated text-muted rounded-lg text-xs font-medium hover:bg-elevated transition-all">Dispose</button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {showModal && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
            <div className="max-h-[calc(100dvh-2rem)] overflow-y-auto bg-elevated border border-border-custom rounded-lg p-6 w-full max-w-lg">
              <h2 className="text-xl font-bold text-foreground mb-4">Record Material Wastage</h2>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Material Name</label>
                  <select
                    required
                    className="w-full bg-input border border-border-custom rounded-md px-4 py-2 text-foreground"
                    value={form.material_name}
                    onChange={(e) => {
                      const picked = inventory.find((i) => i.material_name === e.target.value);
                      setForm({ ...form, material_name: e.target.value, unit: picked?.unit || form.unit });
                    }}
                  >
                    <option value="">Select material...</option>
                    {inventory.map((i) => (
                      <option key={i.material_name} value={i.material_name}>
                        {i.material_name} ({i.on_hand_qty} {i.unit} on hand)
                      </option>
                    ))}
                  </select>
                  {inventory.length === 0 && (
                    <p className="mt-1 text-[10px] text-muted">
                      No material has been received on this project yet. Record a goods receipt first.
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">Type</label>
                    <select className="w-full bg-input border border-border-custom rounded-md px-4 py-2 text-foreground" value={form.wastage_type} onChange={(e) => setForm({...form, wastage_type: e.target.value})}>
                      <option value="scrap">Scrap</option>
                      <option value="offcut">Offcut</option>
                      <option value="damaged">Damaged</option>
                      <option value="expired">Expired</option>
                      <option value="theft">Theft</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">Quantity</label>
                    <input type="number" required min="0.001" step="any" placeholder="0" className="w-full bg-input border border-border-custom rounded-md px-4 py-2 text-foreground" value={form.quantity} onChange={(e) => setForm({...form, quantity: e.target.value})} />
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">Unit</label>
                    <UnitInput type="text" required className="w-full bg-input border border-border-custom rounded-md px-4 py-2 text-foreground" autoComplete="off" value={form.unit} onChange={(e) => setForm({...form, unit: e.target.value})} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">Est. Value (₹)</label>
                    <input type="number" min="0" step="any" placeholder="Last purchase rate" className="w-full bg-input border border-border-custom rounded-md px-4 py-2 text-foreground" value={form.estimated_value} onChange={(e) => setForm({...form, estimated_value: e.target.value})} />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Reason</label>
                  <textarea className="w-full bg-input border border-border-custom rounded-md px-4 py-2 text-foreground" value={form.reason} onChange={(e) => setForm({...form, reason: e.target.value})} />
                </div>
                <div className="flex gap-3 pt-2">
                  <button type="submit" className="flex-1 px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded-md text-sm font-semibold">Record Wastage</button>
                  <button type="button" onClick={() => { setShowModal(false); setMessage(""); }} className="px-4 py-2 bg-elevated border border-border-custom hover:bg-card text-foreground rounded-md text-sm font-semibold">Cancel</button>
                </div>
              </form>
            </div>
          </div>
        )}
      </PageShell>
      </div>
    </div>
  );
}
