"use client";
import Badge, { type BadgeTone } from "@/components/ui/Badge";

import React, { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { getApiHost, readErrorDetail, detailToMessage} from "@/lib/api";
import { authHeaders, formatLabel, todayLocalISO, toLocalISODate } from "@/lib/siteflow";
import Icon from "@/components/marketing/Icon";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableSkeleton } from "@/components/ui/Skeleton";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import FieldHint from "@/components/ui/FieldHint";

interface WorkOrder {
  id: string;
  woNumber: string;
  sNo: number;
  subContractor: string;
  subcontractorId?: string;
  woDate?: string;
  progress: string;
  progressPct?: number | null;
  woValue: number;
  billedValue: number;
  status: string;
  terms?: string | null;
  items?: any[];
}

interface BOQItemOption {
  id: string;
  item_name: string;
  section_name?: string;
  unit: string;
  quantity: number;
  rate: number;
}

interface TaskOption {
  id: string;
  name: string;
  wbs_code?: string;
}

interface WOFormItem {
  referenceType: "boq" | "task";
  boq_item_id?: string;
  task_id?: string;
  quantity: number;
  rate: number;
}

interface Subcontractor {
  id: string;
  name: string;
  gstin?: string | null;
  phone?: string | null;
}

export default function SubconPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params?.company_id as string;
  const projectId = (params?.project_id as string) || "d0000000-0000-0000-0000-000000000001";

  // Real backend-backed data
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [subcontractors, setSubcontractors] = useState<Subcontractor[]>([]);
  const [loading, setLoading] = useState(false);

  // Scope & Terms state
  const [boqItems, setBoqItems] = useState<BOQItemOption[]>([]);
  const [tasks, setTasks] = useState<TaskOption[]>([]);
  const [defaultSubconTerms, setDefaultSubconTerms] = useState("");

  const [searchQuery, setSearchQuery] = useState("");
  const [toastMessage, setToastMessage] = useState("");

  // Modals & Drawers
  const [showWOModal, setShowWOModal] = useState(false);
  const [editingWoId, setEditingWoId] = useState<string | null>(null);
  const [showAddPartyDrawer, setShowAddPartyDrawer] = useState(false);

  // Form states
  const [woForm, setWoForm] = useState<{
    woNumber: string;
    partyId: string;
    date: string;
    terms: string;
    items: WOFormItem[];
  }>({
    woNumber: "",
    partyId: "",
    date: todayLocalISO(),
    terms: "",
    items: [{ referenceType: "boq", boq_item_id: "", task_id: "", quantity: 1, rate: 0 }],
  });

  const [partyForm, setPartyForm] = useState({
    name: "",
    phone: "",
    email: "",
    gstin: "",
    bank_name: "",
    account_number: "",
    ifsc_code: "",
    address: ""
  });

  const fetchProjectScopes = async () => {
    if (!projectId || projectId === "d0000000-0000-0000-0000-000000000001") return;
    try {
      const [bRes, tRes] = await Promise.all([
        fetch(`${getApiHost()}/apis/v3/budgeting/boq?project_id=${projectId}`, { headers: authHeaders() }),
        fetch(`${getApiHost()}/apis/v3/planning/tasks?project_id=${projectId}`, { headers: authHeaders() }),
      ]);
      if (bRes.ok) {
        const data = await bRes.json();
        setBoqItems(Array.isArray(data) ? data : []);
      }
      if (tRes.ok) {
        const data = await tRes.json();
        setTasks(Array.isArray(data) ? data : []);
      }
    } catch (e) {
      console.error("Failed to load BOQ or tasks", e);
    }
  };

  const fetchCompanyTerms = async () => {
    if (!companyId) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/settings/company-terms/${companyId}`, { headers: authHeaders() });
      if (res.ok) {
        const d = await res.json();
        const terms = d.subcon_terms || "";
        setDefaultSubconTerms(terms);
        setWoForm(prev => ({ ...prev, terms: prev.terms || terms }));
      }
    } catch (e) {
      /* ignore */
    }
  };

  const fetchSubconData = async () => {
    if (!projectId || projectId === "d0000000-0000-0000-0000-000000000001") return;
    setLoading(true);
    try {
      const [woRes, subRes] = await Promise.all([
        fetch(`${getApiHost()}/apis/v3/billing/work-orders?project_id=${projectId}`, { headers: authHeaders() }),
        fetch(`${getApiHost()}/apis/v3/billing/subcontractors?company_id=${companyId}`, { headers: authHeaders() }),
      ]);
      if (woRes.ok) {
        const data = await woRes.json();
        setWorkOrders(
          (data as any[]).map((wo: any, i: number) => ({
            id: wo.id,
            woNumber: wo.wo_number || `WO-${i + 1}`,
            sNo: i + 1,
            subContractor: wo.subcontractor_name || "Unknown",
            subcontractorId: wo.subcontractor_id || undefined,
            woDate: wo.wo_date || undefined,
            progress: wo.progress_pct !== null && wo.progress_pct !== undefined ? `${Math.min(100, Math.max(0, wo.progress_pct))}%` : "—",
            progressPct: wo.progress_pct !== null && wo.progress_pct !== undefined ? Number(wo.progress_pct) : null,
            woValue: Number(wo.estimated_work_amount) || 0,
            billedValue: Number(wo.billed_amount) || 0,
            status: wo.status || "—",
            terms: wo.terms ?? null,
            items: wo.items ?? [],
          }))
        );
      }
      if (subRes.ok) {
        const data = await subRes.json();
        setSubcontractors(
          (data as any[]).map((t: any) => ({
            id: String(t.company_team_id),
            name: t.name,
            gstin: t.gstin ?? null,
            phone: t.phone ?? null,
          }))
        );
      }
    } catch (e) {
      console.error("Failed to load subcon data", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSubconData();
    fetchCompanyTerms();
    fetchProjectScopes();
  }, [projectId, companyId]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(""), 3000);
  };

  const fmt = (n: number) => "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const handleCancelWorkOrder = async (woId: string, woNumber: string) => {
    if (!confirm(`Are you sure you want to cancel Work Order ${woNumber}?`)) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/billing/work-orders/${woId}/cancel`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const err = await readErrorDetail(res);
        alert(err || "Failed to cancel work order");
        return;
      }
      showToast(`Work Order ${woNumber} cancelled successfully`);
      fetchSubconData();
    } catch (err: any) {
      console.error("Cancel WO error:", err);
      alert(err?.message || "Failed to cancel work order");
    }
  };

  const handleOpenCreateWO = () => {
    setEditingWoId(null);
    setWoForm({
      woNumber: "",
      partyId: "",
      date: todayLocalISO(),
      terms: defaultSubconTerms,
      items: [{ referenceType: "boq", boq_item_id: "", task_id: "", quantity: 1, rate: 0 }],
    });
    setShowWOModal(true);
  };

  const handleOpenEditWO = (wo: WorkOrder) => {
    setEditingWoId(wo.id);
    const items: WOFormItem[] = (wo.items && wo.items.length > 0)
      ? wo.items.map((it: any) => ({
          referenceType: it.boq_item_id ? "boq" : "task",
          boq_item_id: it.boq_item_id || "",
          task_id: it.task_id || "",
          quantity: Number(it.quantity) || 1,
          rate: Number(it.rate) || 0,
        }))
      : [{ referenceType: "boq", boq_item_id: "", task_id: "", quantity: 1, rate: 0 }];

    setWoForm({
      woNumber: wo.woNumber,
      partyId: wo.subcontractorId || "",
      date: wo.woDate ? toLocalISODate(wo.woDate) : todayLocalISO(),
      terms: wo.terms ?? defaultSubconTerms,
      items,
    });
    setShowWOModal(true);
  };

  const handleSaveWorkorder = async () => {
    if (!woForm.partyId) {
      alert("Please select a subcontractor!");
      return;
    }
    if (!projectId || projectId === "d0000000-0000-0000-0000-000000000001") {
      alert("No active project selected.");
      return;
    }
    if (woForm.items.length === 0) {
      alert("Please add at least one line item to the work order.");
      return;
    }
    for (let i = 0; i < woForm.items.length; i++) {
      const it = woForm.items[i];
      const hasRef = it.referenceType === "boq" ? Boolean(it.boq_item_id) : Boolean(it.task_id);
      if (!hasRef) {
        alert(`Line ${i + 1}: Please select a ${it.referenceType === "boq" ? "BOQ item" : "planning task"}.`);
        return;
      }
      if (Number(it.quantity) <= 0) {
        alert(`Line ${i + 1}: Quantity must be greater than 0.`);
        return;
      }
      if (Number(it.rate) <= 0) {
        alert(`Line ${i + 1}: Rate must be greater than 0.`);
        return;
      }
    }

    try {
      const isEdit = Boolean(editingWoId);
      const url = isEdit
        ? `${getApiHost()}/apis/v3/billing/work-orders/${editingWoId}`
        : `${getApiHost()}/apis/v3/billing/work-orders`;
      const method = isEdit ? "PUT" : "POST";

      const payload: any = {
        subcontractor_id: woForm.partyId,
        wo_date: new Date(woForm.date).toISOString(),
        terms: woForm.terms || null,
        items: woForm.items.map((it) => ({
          boq_item_id: it.referenceType === "boq" ? it.boq_item_id : null,
          task_id: it.referenceType === "task" ? it.task_id : null,
          quantity: Number(it.quantity),
          rate: Number(it.rate),
        })),
      };
      // On create, omit wo_number when blank so the backend assigns the next sequential number.
      // On edit, always send the current wo_number (required by WOUpdateRequest).
      if (isEdit || woForm.woNumber.trim()) {
        payload.wo_number = woForm.woNumber.trim();
      }
      if (!isEdit) {
        payload.company_id = companyId;
        payload.project_id = projectId;
      }

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await readErrorDetail(res);
        alert(err || (isEdit ? "Failed to update work order" : "Failed to create work order"));
        return;
      }
      await fetchSubconData();
      setShowWOModal(false);
      setEditingWoId(null);
      setWoForm({
        woNumber: "",
        partyId: "",
        date: todayLocalISO(),
        terms: defaultSubconTerms,
        items: [{ referenceType: "boq", boq_item_id: "", task_id: "", quantity: 1, rate: 0 }],
      });
      showToast(isEdit ? "Work Order updated successfully!" : "Subcontractor Work Order created successfully!");
    } catch (err: any) {
      alert(err?.message || "Error saving work order");
    }
  };

  const handleSaveParty = async () => {
    if (!partyForm.name) {
      alert("Please specify the subcontractor name!");
      return;
    }
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/billing/subcontractors`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id: companyId,
          name: partyForm.name,
          phone: partyForm.phone || null,
          email: partyForm.email || null,
          tax_no: partyForm.gstin || null,
          bank_name: partyForm.bank_name || null,
          account_number: partyForm.account_number || null,
          ifsc_code: partyForm.ifsc_code || null,
          address: partyForm.address || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(detailToMessage(err.detail, "Failed to create subcontractor"));
      }
      await fetchSubconData();
      setShowAddPartyDrawer(false);
      showToast(`Subcontractor ${partyForm.name} created successfully!`);
      setPartyForm({
        name: "",
        phone: "",
        email: "",
        gstin: "",
        bank_name: "",
        account_number: "",
        ifsc_code: "",
        address: ""
      });
    } catch (err: any) {
      alert(err?.message || "Error creating subcontractor");
    }
  };

  const filteredWO = workOrders.filter(wo =>
    wo.subContractor.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden font-sans">
      <PageHeader
        title="Subcontractor Management"
        subtitle="Work orders, work billed against each order, and the subcontractor billing register"
      >
        <button
          onClick={handleOpenCreateWO}
          className="flex items-center gap-1.5 px-3.5 py-1.5 bg-primary text-white text-xs font-bold rounded-lg hover:bg-primary/95 transition-all cursor-pointer"
        >
          + Sub Con Work Order
        </button>
      </PageHeader>

      <main className="flex-1 flex flex-col h-full overflow-hidden relative">

        {/* Top actions bar */}
        <div className="bg-sidebar border-b border-border-custom px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4 shrink-0">
          <div className="relative w-full md:w-80">
            <input
              type="text"
              placeholder="Search Sub Contractor..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full bg-card border border-border-custom rounded-lg pl-9 pr-4 py-2 text-xs text-foreground placeholder:text-muted focus:outline-none focus:border-primary"
            />
            <span className="absolute left-3 top-2.5 text-muted text-sm inline-flex"><Icon name="search" className="w-3.5 h-3.5" /></span>
          </div>
        </div>

        {/* Main table view matching Screenshot 1/2 */}
        <div className="flex-1 overflow-y-auto bg-elevated/10">
          <PageShell width="wide">
            <div className="bg-card border border-border-custom rounded-xl overflow-hidden">
            <table className="w-full text-xs text-left">
              <thead className="bg-elevated border-b border-border-custom text-muted text-[10px] uppercase font-bold tracking-wider">
                <tr>
                  <th className="px-4 py-3">S.No.</th>
                  <th className="px-4 py-3">Work Order</th>
                  <th className="px-4 py-3">Sub Contractor</th>
                  <th className="px-4 py-3" title="Work value billed so far, as a share of the work order value (before GST)">Work Billed</th>
                  <th className="px-4 py-3">Work Order Value</th>
                  <th className="px-4 py-3">Billed Value</th>
                  <th className="px-4 py-3">Approval Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-custom/40">
                {loading ? (
                  <tr>
                    <td colSpan={8} className="p-4">
                      <TableSkeleton rows={5} cols={8} />
                    </td>
                  </tr>
                ) : filteredWO.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="p-8">
                      <EmptyState
                        title="No subcontractor work orders found"
                        description={searchQuery ? "No work orders match your search query." : "Create subcontractor work orders to track billed value and approvals."}
                        action={!searchQuery ? { label: "+ New Work Order", onClick: handleOpenCreateWO } : undefined}
                      />
                    </td>
                  </tr>
                ) : (
                  filteredWO.map(wo => (
                    <tr key={wo.id} className="hover:bg-elevated/40 transition-colors">
                      <td className="px-4 py-3 text-muted">{wo.sNo}</td>
                      <td className="px-4 py-3 font-sans font-semibold text-foreground">{wo.woNumber}</td>
                      <td className="px-4 py-3 font-semibold text-foreground">{wo.subContractor}</td>
                      <td className="px-4 py-3 text-muted">
                        {wo.progressPct !== null && wo.progressPct !== undefined ? (
                          <div className="flex items-center gap-2">
                            <div className="w-20 bg-background h-1.5 rounded-full overflow-hidden border border-border-custom">
                              <div className="bg-primary h-full" style={{ width: `${Math.min(100, Math.max(0, wo.progressPct))}%` }}></div>
                            </div>
                            <span>{wo.progress}</span>
                          </div>
                        ) : (
                          <span>—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-bold text-foreground">{fmt(wo.woValue)}</td>
                      <td className="px-4 py-3 text-muted">{fmt(wo.billedValue)}</td>
                      <td className="px-4 py-3">
                        <Badge tone={wo.status === "Approved" || wo.status === "active" ? "success" : wo.status === "Pending Approval" ? "warning" : wo.status === "cancelled" ? "danger" : "neutral"} className="font-bold">
                          {formatLabel(wo.status)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {wo.status !== "cancelled" ? (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => handleOpenEditWO(wo)}
                              className="p-1 text-muted hover:text-foreground rounded hover:bg-elevated transition-colors cursor-pointer"
                              title="Edit Work Order"
                            >
                              <Icon name="pencil" className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleCancelWorkOrder(wo.id, wo.woNumber)}
                              className="p-1 text-muted hover:text-danger rounded hover:bg-elevated transition-colors cursor-pointer"
                              title="Cancel Work Order"
                            >
                              <Icon name="close" className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <span className="text-[10px] text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Subcontractor Directory — company subcontractors (userless team + party) */}
          <div className="mt-6 bg-card border border-border-custom rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border-custom text-[10px] uppercase font-bold tracking-wider text-muted">Subcontractor Directory</div>
            {loading ? (
              <div className="px-4 py-8 text-center text-muted text-xs">Loading subcontractors...</div>
            ) : subcontractors.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  title="No subcontractors yet"
                  description="Subcontractors added during work order creation will appear in this company directory."
                  action={{
                    label: "+ New Work Order",
                    onClick: () => setShowWOModal(true),
                  }}
                />
              </div>
            ) : (
              <ul className="divide-y divide-border-custom/40">
                {subcontractors.map(p => (
                  <li key={p.id} className="px-4 py-3 flex items-center justify-between text-xs">
                    <span className="font-semibold text-foreground">{p.name}</span>
                    <span className="text-muted">{p.gstin ? `GSTIN ${p.gstin}` : (p.phone || "—")}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          </PageShell>
        </div>

        {/* Sub-Con Workorder Modal */}
        {showWOModal && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setShowWOModal(false)}>
            <div className="bg-card border border-border-custom rounded-xl w-full max-w-2xl p-6 relative shadow-2xl max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
              <div className="flex justify-between items-start border-b border-border-custom pb-3 mb-4">
                <div>
                  <h3 className="text-sm font-bold text-foreground uppercase tracking-wider">
                    {editingWoId ? "Edit Subcontractor Work Order" : "Create Subcontractor Work Order"}
                  </h3>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="text-[11px] text-muted font-sans">
                      {editingWoId ? `Updating work order ${woForm.woNumber}` : "Scope contract with itemised BOQ lines and tasks"}
                    </span>
                  </div>
                </div>
                <button onClick={() => setShowWOModal(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
              </div>

              <div className="space-y-4 text-xs">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-muted uppercase font-bold block mb-1">WO Number (leave blank for automatic)</label>
                    <input
                      type="text"
                      value={woForm.woNumber}
                      onChange={e => setWoForm({ ...woForm, woNumber: e.target.value })}
                      placeholder="Auto-assigned sequentially"
                      className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground text-xs focus:outline-none focus:border-primary"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] text-muted uppercase font-bold block mb-1">Date*</label>
                    <input type="date" value={woForm.date} onChange={e => setWoForm({ ...woForm, date: e.target.value })} className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground text-xs focus:outline-none focus:border-primary" />
                  </div>

                  <div>
                    <label className="text-[10px] text-muted uppercase font-bold block mb-1">Subcontractor*</label>
                    <select
                      value={woForm.partyId}
                      onChange={e => setWoForm({ ...woForm, partyId: e.target.value })}
                      className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs"
                    >
                      <option value="">Select subcontractor…</option>
                      {subcontractors.map(s => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                    {subcontractors.length === 0 && (
                      <FieldHint text="No subcontractors yet." onAction={() => setShowAddPartyDrawer(true)} actionLabel="Add a subcontractor" />
                    )}
                  </div>
                </div>

                {/* Line Items Section */}
                <div className="space-y-3 border-t border-border-custom pt-4">
                  <div className="flex justify-between items-center">
                    <div>
                      <span className="text-[10px] text-muted font-bold uppercase tracking-wider block">Scope Line Items*</span>
                      <span className="text-[11px] text-muted">Each line must reference a BOQ item or planning task.</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setWoForm({
                        ...woForm,
                        items: [...woForm.items, { referenceType: "boq", boq_item_id: "", task_id: "", quantity: 1, rate: 0 }]
                      })}
                      className="px-2.5 py-1 bg-primary/10 hover:bg-primary/20 text-primary font-bold rounded text-xs inline-flex items-center gap-1 transition-all cursor-pointer"
                    >
                      <Icon name="add" className="w-3.5 h-3.5" /> Add Item Line
                    </button>
                  </div>

                  <div className="space-y-2.5">
                    {woForm.items.map((item, idx) => (
                      <div key={idx} className="bg-elevated/40 border border-border-custom rounded-lg p-3 space-y-2.5 relative">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-bold text-muted uppercase">Line {idx + 1} Reference:</span>
                            <div className="flex rounded-md bg-background border border-border-custom p-0.5">
                              <button
                                type="button"
                                onClick={() => {
                                  const next = [...woForm.items];
                                  next[idx].referenceType = "boq";
                                  next[idx].task_id = undefined;
                                  setWoForm({ ...woForm, items: next });
                                }}
                                className={`px-2 py-0.5 text-[10px] font-bold rounded ${item.referenceType === "boq" ? "bg-primary text-white" : "text-muted hover:text-foreground"}`}
                              >
                                BOQ Item
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  const next = [...woForm.items];
                                  next[idx].referenceType = "task";
                                  next[idx].boq_item_id = undefined;
                                  setWoForm({ ...woForm, items: next });
                                }}
                                className={`px-2 py-0.5 text-[10px] font-bold rounded ${item.referenceType === "task" ? "bg-primary text-white" : "text-muted hover:text-foreground"}`}
                              >
                                Planning Task
                              </button>
                            </div>
                          </div>
                          {woForm.items.length > 1 && (
                            <button
                              type="button"
                              onClick={() => setWoForm({ ...woForm, items: woForm.items.filter((_, i) => i !== idx) })}
                              className="text-muted hover:text-danger p-1 cursor-pointer"
                              title="Remove Line"
                            >
                              <Icon name="trash" className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>

                        {item.referenceType === "boq" ? (
                          <div>
                            <select
                              value={item.boq_item_id || ""}
                              onChange={e => {
                                const bId = e.target.value;
                                const selectedBOQ = boqItems.find(b => b.id === bId);
                                const next = [...woForm.items];
                                next[idx].boq_item_id = bId;
                                if (selectedBOQ) {
                                  next[idx].rate = Number(selectedBOQ.rate) || 0;
                                  if (!next[idx].quantity || next[idx].quantity === 1) {
                                    next[idx].quantity = Number(selectedBOQ.quantity) || 1;
                                  }
                                }
                                setWoForm({ ...woForm, items: next });
                              }}
                              className="w-full bg-background border border-border-custom rounded px-2.5 py-1.5 text-foreground text-xs focus:outline-none focus:border-primary"
                            >
                              <option value="">Select BOQ item…</option>
                              {boqItems.map(b => (
                                <option key={b.id} value={b.id}>
                                  {b.section_name ? `${b.section_name} - ` : ""}{b.item_name} ({b.unit}) {b.rate ? `• ₹${b.rate}` : ""}
                                </option>
                              ))}
                            </select>
                            {boqItems.length === 0 && (
                              <FieldHint text="No BOQ items found for this project." href={`/c/${companyId}/p/${projectId}/boq`} linkLabel="Go to BOQ" />
                            )}
                          </div>
                        ) : (
                          <div>
                            <select
                              value={item.task_id || ""}
                              onChange={e => {
                                const tId = e.target.value;
                                const next = [...woForm.items];
                                next[idx].task_id = tId;
                                setWoForm({ ...woForm, items: next });
                              }}
                              className="w-full bg-background border border-border-custom rounded px-2.5 py-1.5 text-foreground text-xs focus:outline-none focus:border-primary"
                            >
                              <option value="">Select Planning Task…</option>
                              {tasks.map(t => (
                                <option key={t.id} value={t.id}>
                                  {t.wbs_code ? `${t.wbs_code} - ` : ""}{t.name}
                                </option>
                              ))}
                            </select>
                            {tasks.length === 0 && (
                              <FieldHint text="No planning tasks found for this project." href={`/c/${companyId}/d/planning/gantt`} linkLabel="Go to Gantt" />
                            )}
                          </div>
                        )}

                        <div className="grid grid-cols-3 gap-2 items-center">
                          <div>
                            <label className="text-[9px] text-muted uppercase font-bold block mb-0.5">Quantity</label>
                            <input
                              type="number"
                              min="0"
                              step="any"
                              value={item.quantity}
                              onChange={e => {
                                const next = [...woForm.items];
                                next[idx].quantity = parseFloat(e.target.value) || 0;
                                setWoForm({ ...woForm, items: next });
                              }}
                              className="w-full bg-background border border-border-custom rounded px-2 py-1 text-foreground text-xs"
                            />
                          </div>
                          <div>
                            <label className="text-[9px] text-muted uppercase font-bold block mb-0.5">Rate (₹)</label>
                            <input
                              type="number"
                              min="0"
                              step="any"
                              value={item.rate}
                              onChange={e => {
                                const next = [...woForm.items];
                                next[idx].rate = parseFloat(e.target.value) || 0;
                                setWoForm({ ...woForm, items: next });
                              }}
                              className="w-full bg-background border border-border-custom rounded px-2 py-1 text-foreground text-xs"
                            />
                          </div>
                          <div>
                            <label className="text-[9px] text-muted uppercase font-bold block mb-0.5">Amount</label>
                            <div className="text-xs font-bold text-foreground py-1">
                              {fmt((Number(item.quantity) || 0) * (Number(item.rate) || 0))}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Running Total Banner */}
                  <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg flex items-center justify-between">
                    <span className="text-xs font-bold text-foreground uppercase tracking-wider">Estimated Work Order Value</span>
                    <span className="text-sm font-extrabold text-primary">
                      {fmt(woForm.items.reduce((sum, it) => sum + (Number(it.quantity) || 0) * (Number(it.rate) || 0), 0))}
                    </span>
                  </div>
                </div>

                {/* Terms & Conditions */}
                <div className="space-y-1 border-t border-border-custom pt-3">
                  <label className="text-[10px] text-muted uppercase font-bold block">Terms & Conditions</label>
                  <textarea
                    rows={3}
                    value={woForm.terms}
                    onChange={e => setWoForm({ ...woForm, terms: e.target.value })}
                    placeholder="Work order payment terms, milestone release schedule, retention clauses..."
                    className="w-full bg-background border border-border-custom rounded-lg p-2.5 text-foreground text-xs focus:outline-none focus:border-primary"
                  />
                </div>
              </div>

              <div className="mt-5 flex items-center justify-end gap-2 border-t border-border-custom pt-3">
                <button
                  type="button"
                  onClick={() => setShowWOModal(false)}
                  className="px-4 py-2 bg-elevated hover:bg-card border border-border-custom text-muted hover:text-foreground text-xs font-semibold rounded-lg transition-all cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveWorkorder}
                  className="px-5 py-2 bg-primary hover:bg-primary/95 text-white text-xs font-bold rounded-lg transition-all cursor-pointer"
                >
                  {editingWoId ? "Save Changes" : "Create Workorder"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Add Party Drawer (Screenshot 4) */}
        {showAddPartyDrawer && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex justify-end" onClick={() => setShowAddPartyDrawer(false)}>
            <div className="bg-card w-full max-w-md h-full border-l border-border-custom shadow-2xl p-6 flex flex-col justify-between overflow-y-auto" onClick={e => e.stopPropagation()}>
              <div>
                <div className="flex items-center justify-between pb-4 border-b border-border-custom mb-5">
                  <h2 className="text-sm font-bold text-foreground uppercase tracking-wider">Create Subcontractor</h2>
                  <button onClick={() => setShowAddPartyDrawer(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
                </div>

                <div className="space-y-4 text-xs">
                  <div>
                    <label className="text-[10px] text-muted uppercase font-bold block mb-1">Subcontractor Name*</label>
                    <input
                      type="text"
                      placeholder="e.g. Yash Earthworks"
                      value={partyForm.name}
                      onChange={e => setPartyForm({ ...partyForm, name: e.target.value })}
                      className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] text-muted uppercase font-bold block mb-1">Phone Number</label>
                    <input
                      type="tel"
                      placeholder="Phone number"
                      value={partyForm.phone}
                      onChange={e => setPartyForm({ ...partyForm, phone: e.target.value })}
                      className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] text-muted uppercase font-bold block mb-1">Email ID</label>
                    <input
                      type="email"
                      placeholder="email@domain.com"
                      value={partyForm.email}
                      onChange={e => setPartyForm({ ...partyForm, email: e.target.value })}
                      className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] text-muted uppercase font-bold block mb-1">GSTIN</label>
                    <input
                      type="text"
                      placeholder="e.g. 27AAAAA0000A1Z5"
                      value={partyForm.gstin}
                      onChange={e => setPartyForm({ ...partyForm, gstin: e.target.value })}
                      className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] text-muted uppercase font-bold block mb-1">Bank Name</label>
                      <input
                        type="text"
                        placeholder="e.g. SBI"
                        value={partyForm.bank_name}
                        onChange={e => setPartyForm({ ...partyForm, bank_name: e.target.value })}
                        className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted uppercase font-bold block mb-1">IFSC Code</label>
                      <input
                        type="text"
                        placeholder="e.g. SBIN0001234"
                        value={partyForm.ifsc_code}
                        onChange={e => setPartyForm({ ...partyForm, ifsc_code: e.target.value })}
                        className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-[10px] text-muted uppercase font-bold block mb-1">Account Number</label>
                    <input
                      type="text"
                      placeholder="Bank account number"
                      value={partyForm.account_number}
                      onChange={e => setPartyForm({ ...partyForm, account_number: e.target.value })}
                      className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] text-muted uppercase font-bold block mb-1">Address</label>
                    <textarea
                      placeholder="Corporate address"
                      value={partyForm.address}
                      onChange={e => setPartyForm({ ...partyForm, address: e.target.value })}
                      className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary"
                      rows={2}
                    />
                  </div>

                </div>
              </div>

              <div className="flex gap-3 mt-8 pt-4 border-t border-border-custom">
                <button
                  onClick={handleSaveParty}
                  className="flex-1 py-2.5 bg-primary text-white font-bold rounded-lg hover:bg-primary/95 text-xs transition-all"
                >
                  Create Subcontractor
                </button>
                <button onClick={() => setShowAddPartyDrawer(false)} className="px-4 py-2.5 rounded-lg border border-border-custom text-muted hover:text-foreground hover:border-muted text-xs">Cancel</button>
              </div>
            </div>
          </div>
        )}

        {/* Global Toast */}
        {toastMessage && (
          <div className="fixed bottom-6 right-6 bg-card border border-success/30 rounded-lg px-4 py-3 text-xs text-success shadow-lg flex items-center gap-2 z-50 transition-all">
            <span className="inline-flex"><Icon name="bolt" className="w-3.5 h-3.5" /></span>
            <span className="font-semibold">{toastMessage}</span>
          </div>
        )}
      </main>
    </div>
  );
}