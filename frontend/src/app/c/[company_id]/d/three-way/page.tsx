"use client";
import Badge, { type BadgeTone } from "@/components/ui/Badge";
import { getApiHost, detailToMessage} from "@/lib/api";
import { authHeaders, fmtINR, formatLabel } from "@/lib/siteflow";
import React, { useState, useEffect } from "react";
import { useProject } from "@/context/ProjectContext";
import { useParams } from "next/navigation";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import FieldHint from "@/components/ui/FieldHint";

interface Match {
  id: string;
  po_id: string;
  grn_id: string;
  invoice_id?: string;
  match_status: string;
  po_amount: number;
  grn_qty: number;
  invoiced_amount: number;
  variance_amount: number;
  variance_reason?: string;
  po_number?: string;
  grn_number?: string;
  created_at: string;
}

interface PO {
  id: string;
  po_number: string;
  total_amount: number;
  vendor_id?: string | null;
}

interface GRN {
  id: string;
  grn_number: string;
  po_id?: string;
}

interface Bill {
  id: string;
  invoice_number: string;
  invoice_type: string;
  total_payable: number;
  status: string;
  party_company_user_id: string;
}

export default function ThreeWayPage() {
  const params = useParams();
  const companyId = params?.company_id as string;
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;
  // Project the page last loaded for; until it matches, show Loading rather than empty.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const matchLoading = loadedFor !== projectId;

  const [matches, setMatches] = useState<Match[]>([]);
  const [pos, setPos] = useState<PO[]>([]);
  const [grns, setGrns] = useState<GRN[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [message, setMessage] = useState("");

  const [form, setForm] = useState({
    po_id: "",
    grn_id: "",
    invoice_id: "",
    variance_reason: "",
  });

  const fetchMatches = async () => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/three-way/${companyId}?project_id=${projectId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setMatches(data);
      }
    } catch (e) {
      console.error("Failed to load matches", e);
    } finally {
      setLoadedFor(projectId);
    }
  };

  const fetchReferenceData = async () => {
    try {
      const [posRes, grnsRes, billsRes] = await Promise.all([
        fetch(`${getApiHost()}/apis/v3/three-way/pos/${companyId}?project_id=${projectId}`, { headers: authHeaders() }),
        fetch(`${getApiHost()}/apis/v3/three-way/grns/${companyId}?project_id=${projectId}`, { headers: authHeaders() }),
        fetch(`${getApiHost()}/apis/v3/billing/bills?project_id=${projectId}`, { headers: authHeaders() }),
      ]);
      if (posRes.ok) setPos(await posRes.json());
      if (grnsRes.ok) setGrns(await grnsRes.json());
      if (billsRes.ok) {
        const data: Bill[] = await billsRes.json();
        setBills(data.filter((b) => (b.invoice_type === "purchase" || b.invoice_type === "subcon") && (b.status || "").toLowerCase() !== "cancelled"));
      }
    } catch (e) {
      console.error("Failed to load reference data", e);
    }
  };

  useEffect(() => {
    const id = setTimeout(() => {
      fetchMatches();
      fetchReferenceData();
    }, 0);
    return () => clearTimeout(id);
  }, [companyId, projectId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");
    try {
      const body: Record<string, unknown> = {
        po_id: form.po_id,
        grn_id: form.grn_id,
        invoice_id: form.invoice_id,
        company_id: companyId,
        project_id: projectId,
      };
      if (form.variance_reason) body.variance_reason = form.variance_reason;
      const res = await fetch(`${getApiHost()}/apis/v3/three-way`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage("Match created successfully");
        setShowModal(false);
        setForm({ po_id: "", grn_id: "", invoice_id: "", variance_reason: "" });
        fetchMatches();
      } else {
        setMessage(detailToMessage(data.detail, "Failed to create match"));
      }
    } catch (_e) {
      void _e;
      setMessage("Error creating match");
    }
  };

  const handleApprove = async (id: string) => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/three-way/${id}/approve`, { method: "PATCH", headers: authHeaders() });
      const data = await res.json();
      if (res.ok) {
        setMessage("Match approved");
        fetchMatches();
      } else {
        setMessage(detailToMessage(data.detail, "Failed to approve match"));
      }
    } catch (e) { console.error("Failed to approve", e); }
  };

  const handleReject = async (id: string) => {
    const reason = prompt("Reason for rejection:");
    if (!reason) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/three-way/${id}/reject?reason=${encodeURIComponent(reason)}`, { method: "PATCH", headers: authHeaders() });
      const data = await res.json();
      if (res.ok) {
        setMessage("Match rejected");
        fetchMatches();
      } else {
        setMessage(detailToMessage(data.detail, "Failed to reject match"));
      }
    } catch (e) { console.error("Failed to reject", e); }
  };

  const handleRemove = async (m: Match) => {
    if (!confirm(`Remove the match for ${m.po_number || "this PO"} / ${m.grn_number || "this GRN"}? You can then match the right bill.`)) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/three-way/${m.id}`, { method: "DELETE", headers: authHeaders() });
      if (res.ok) {
        setMessage("Match removed");
        fetchMatches();
      } else {
        const data = await res.json().catch(() => ({}));
        setMessage(detailToMessage(data.detail, "Failed to remove match"));
      }
    } catch (e) { console.error("Failed to remove", e); }
  };

  // Only the receipts on the chosen PO, and only bills from its supplier;
  // the server refuses any other pairing.
  const selectedPo = pos.find((p) => p.id === form.po_id);
  const grnChoices = selectedPo ? grns.filter((g) => g.po_id === selectedPo.id) : grns;
  const billChoices = selectedPo?.vendor_id ? bills.filter((b) => b.party_company_user_id === selectedPo.vendor_id) : bills;
  const selectedBill = billChoices.find((b) => b.id === form.invoice_id);

  const statusTones: Record<string, BadgeTone> = {
    matched: "success",
    mismatch: "danger",
    pending: "warning",
    approved: "info",
    rejected: "danger",
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title="3-Way Matching"
        subtitle="Check each supplier bill against what was ordered and what reached site"
      >
        <button
          onClick={() => { setShowModal(true); setMessage(""); }}
          className="px-3.5 py-1.5 bg-primary hover:bg-primary/90 text-white rounded-md text-xs font-semibold transition-all cursor-pointer"
        >
          + New Match
        </button>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">

        {message && (
          <div className={`mb-6 p-4 rounded-md ${message.includes("success") || message.includes("approved") || message.includes("rejected") || message.includes("removed") ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>
            {message}
          </div>
        )}

        <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-elevated text-muted">
              <tr>
                <th className="px-6 py-4 font-medium">PO</th>
                <th className="px-6 py-4 font-medium">GRN</th>
                <th className="px-6 py-4 font-medium">Goods received</th>
                <th className="px-6 py-4 font-medium">Invoiced</th>
                <th className="px-6 py-4 font-medium">Bill minus Received</th>
                <th className="px-6 py-4 font-medium">Status</th>
                <th className="px-6 py-4 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-custom">
              {matches.length === 0 && matchLoading ? (
                <tr><td colSpan={7} className="p-8 text-center text-muted text-sm">Loading 3-way matches...</td></tr>
              ) : matches.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8">
                    <EmptyState
                      icon="check"
                      title="No 3-way matches found"
                      description="Check supplier bills against purchase orders and goods received (GRN)."
                      action={{
                        label: "New Match",
                        onClick: () => { setShowModal(true); setMessage(""); },
                        icon: "add",
                      }}
                    />
                  </td>
                </tr>
              ) : (
                matches.map((m) => (
                  <tr key={m.id} className="hover:bg-elevated transition-colors">
                    <td className="px-6 py-4">{m.po_number || m.po_id.slice(0, 8)}</td>
                    <td className="px-6 py-4">{m.grn_number || m.grn_id.slice(0, 8)}</td>
                    <td className="px-6 py-4">{fmtINR(m.po_amount)}</td>
                    <td className="px-6 py-4">{fmtINR(m.invoiced_amount)}</td>
                    <td className={`px-6 py-4 font-medium ${Number(m.variance_amount) < 0 ? "text-danger" : Number(m.variance_amount) > 0 ? "text-warning" : "text-success"}`}>
                      {fmtINR(m.variance_amount)}
                    </td>
                    <td className="px-6 py-4">
                      <Badge tone={statusTones[m.match_status] || "neutral"}>{formatLabel(m.match_status)}</Badge>
                    </td>
                    <td className="px-6 py-4 flex gap-2">
                      {(m.match_status === "matched" || m.match_status === "mismatch") && (
                        <>
                          <button onClick={() => handleApprove(m.id)} className="px-3 py-1 bg-success/10 text-success rounded-lg text-xs font-medium hover:bg-success/10 transition-all">Approve</button>
                          <button onClick={() => handleReject(m.id)} className="px-3 py-1 bg-danger/10 text-danger rounded-lg text-xs font-medium hover:bg-danger/10 transition-all">Reject</button>
                        </>
                      )}
                      {m.match_status !== "approved" && (
                        <button onClick={() => handleRemove(m)} className="px-3 py-1 bg-elevated text-muted border border-border-custom rounded-lg text-xs font-medium hover:text-foreground transition-all">Remove</button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {showModal && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
            <div className="max-h-[calc(100dvh-2rem)] overflow-y-auto bg-elevated border border-border-custom rounded-lg p-6 w-full max-w-lg">
              <h2 className="text-xl font-bold text-foreground mb-4">New 3-Way Match</h2>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Purchase Order</label>
                  <select required className="w-full bg-input border border-border-custom rounded-md px-4 py-2 text-foreground" value={form.po_id} onChange={(e) => setForm({...form, po_id: e.target.value, grn_id: "", invoice_id: ""})}>
                    <option value="">Select PO</option>
                    {pos.map((p) => <option key={p.id} value={p.id}>{p.po_number} — {fmtINR(p.total_amount)}</option>)}
                  </select>
                  {pos.length === 0 && (
                    <FieldHint text="No purchase orders yet. Create one in Procurement." href={`/c/${companyId}/d/procurement`} linkLabel="Go to Procurement" />
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Goods Receipt Note</label>
                  <select required className="w-full bg-input border border-border-custom rounded-md px-4 py-2 text-foreground" value={form.grn_id} onChange={(e) => setForm({...form, grn_id: e.target.value})}>
                    <option value="">Select GRN</option>
                    {grnChoices.map((g) => <option key={g.id} value={g.id}>{g.grn_number}</option>)}
                  </select>
                  {grnChoices.length === 0 && (
                    <FieldHint text={selectedPo ? "Nothing received on this PO yet. Record the GRN in Procurement." : "No goods receipt notes yet. Record one in Procurement."} href={`/c/${companyId}/d/procurement`} linkLabel="Go to Procurement" />
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Vendor Bill</label>
                  <select required className="w-full bg-input border border-border-custom rounded-md px-4 py-2 text-foreground" value={form.invoice_id} onChange={(e) => setForm({...form, invoice_id: e.target.value})}>
                    <option value="">Select bill</option>
                    {billChoices.map((b) => <option key={b.id} value={b.id}>{b.invoice_number} — {fmtINR(b.total_payable)}</option>)}
                  </select>
                  {billChoices.length === 0 && (
                    <FieldHint text={selectedPo ? "No bill from this PO's supplier yet. Enter it as a Material Purchase on the project's Transaction page." : "No supplier bills yet. Enter one as a Material Purchase on the project's Transaction page."} href={`/c/${companyId}/p/${projectId}/transaction`} linkLabel="Go to Transactions" />
                  )}
                  {selectedBill && (
                    <p className="text-xs text-muted mt-1">Bill amount {fmtINR(selectedBill.total_payable)}. It is checked against the value of the goods on the GRN, with GST.</p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Why the bill is different (if it is)</label>
                  <textarea className="w-full bg-input border border-border-custom rounded-md px-4 py-2 text-foreground" value={form.variance_reason} onChange={(e) => setForm({...form, variance_reason: e.target.value})} />
                </div>
                <div className="flex gap-3 pt-2">
                  <button type="submit" className="flex-1 px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded-md text-sm font-semibold">Create Match</button>
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
