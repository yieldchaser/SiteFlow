"use client";

import React, { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { useProject } from "@/context/ProjectContext";
import { getApiHost, readErrorDetail } from "@/lib/api";
import { authHeaders, formatDate, formatLabel, toLocalISODate } from "@/lib/siteflow";
import { UNITS } from "@/lib/units";
import Badge, { type BadgeTone } from "@/components/ui/Badge";
import FieldHint from "@/components/ui/FieldHint";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { CardSkeleton } from "@/components/ui/Skeleton";
import Icon from "@/components/marketing/Icon";

interface RFQItem {
  id: string;
  rfq_id: string;
  material_name: string;
  quantity: number;
  unit: string;
  specifications: string | null;
}

interface RFQ {
  id: string;
  company_id: string;
  project_id: string;
  rfq_number: string;
  status: "draft" | "sent" | "closed" | string;
  valid_until: string | null;
  notes: string | null;
  items: RFQItem[];
  created_at: string;
}

interface RFQQuote {
  id: string;
  rfq_id: string;
  vendor_id: string | null;
  vendor_name: string;
  item_id: string;
  quoted_rate: number;
  delivery_days: number | null;
  terms: string | null;
  validity_days: number;
  submitted_at: string;
  extended_total?: number;
  is_lowest?: boolean;
}

interface ComparisonRow {
  item_id: string;
  material_name: string;
  quantity: number;
  unit: string;
  vendors: RFQQuote[];
  lowest_rate?: number | null;
  highest_rate?: number | null;
  price_spread?: number | null;
  recommended_vendor_name?: string | null;
}

interface MaterialOption {
  id: string;
  name: string;
  unit?: string;
}

interface VendorOption {
  id: string;
  name: string;
  party_type?: string;
}

interface NewRFQItemForm {
  material_name: string;
  quantity: number;
  unit: string;
  specifications: string;
}

export default function RFQPage() {
  const { company_id } = useParams();
  const companyId = (company_id as string) || "demo-company";
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;

  const [rfqs, setRFQs] = useState<RFQ[]>([]);
  const [comparison, setComparison] = useState<ComparisonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [materials, setMaterials] = useState<MaterialOption[]>([]);
  const [vendors, setVendors] = useState<VendorOption[]>([]);

  // Modals & Drawers
  const [showCreate, setShowCreate] = useState(false);
  const [showQuoteDrawer, setShowQuoteDrawer] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [viewRfqId, setViewRfqId] = useState<string | null>(null);
  const [targetRfq, setTargetRfq] = useState<RFQ | null>(null);

  // Form State: Create RFQ
  const [newRfqNum, setNewRfqNum] = useState("");
  const [newValidUntil, setNewValidUntil] = useState(
    toLocalISODate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000))
  );
  const [newNotes, setNewNotes] = useState("");
  const [newItems, setNewItems] = useState<NewRFQItemForm[]>([
    { material_name: "", quantity: 1, unit: "bags", specifications: "" },
  ]);

  // Form State: Enter Quote
  const [quoteVendorId, setQuoteVendorId] = useState("");
  const [quoteVendorName, setQuoteVendorName] = useState("");
  const [quoteDeliveryDays, setQuoteDeliveryDays] = useState<number | "">("");
  const [quoteTerms, setQuoteTerms] = useState("");
  const [quoteValidityDays, setQuoteValidityDays] = useState(30);
  const [itemRates, setItemRates] = useState<Record<string, number>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchRFQs = async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/procurement/rfq/${projectId}`, {
        headers: authHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        setRFQs(data);
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  const fetchMaterialsAndVendors = async () => {
    try {
      const [matRes, partyRes] = await Promise.all([
        fetch(`${getApiHost()}/apis/v3/library/materials/${companyId}`, { headers: authHeaders() }),
        fetch(`${getApiHost()}/apis/v3/library/parties/${companyId}`, { headers: authHeaders() }),
      ]);
      if (matRes.ok) {
        const mats = await matRes.json();
        setMaterials(Array.isArray(mats) ? mats : []);
      }
      if (partyRes.ok) {
        const parties = await partyRes.json();
        const vList = (Array.isArray(parties) ? parties : []).filter((p: any) =>
          !p.party_type || /vendor|supplier|subcontractor|contractor/i.test(p.party_type)
        );
        setVendors(vList.length > 0 ? vList : Array.isArray(parties) ? parties : []);
      }
    } catch (e) {
      console.error("Failed to load materials / vendors", e);
    }
  };

  const fetchComparison = async (rfqId: string) => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/procurement/rfq/${rfqId}/comparison`, {
        headers: authHeaders(),
      });
      if (res.ok) {
        setComparison(await res.json());
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    if (projectId) {
      fetchRFQs();
    } else {
      setLoading(false);
    }
    if (companyId) {
      fetchMaterialsAndVendors();
    }
  }, [projectId, companyId]);

  const handleCreateRFQ = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRfqNum.trim()) {
      alert("Please enter an RFQ number.");
      return;
    }
    if (newItems.length === 0) {
      alert("Please add at least one line item.");
      return;
    }

    const payload = {
      company_id: companyId,
      project_id: projectId,
      rfq_number: newRfqNum.trim(),
      items: newItems.map((item) => ({
        material_name: item.material_name.trim(),
        quantity: Number(item.quantity) || 0,
        unit: item.unit.trim() || "nos",
        specifications: item.specifications.trim() || null,
      })),
      valid_until: newValidUntil ? new Date(`${newValidUntil}T23:59:59Z`).toISOString() : null,
      notes: newNotes.trim() || null,
    };

    try {
      const res = await fetch(`${getApiHost()}/apis/v3/procurement/rfq`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setShowCreate(false);
        setNewRfqNum("");
        setNewNotes("");
        setNewItems([{ material_name: "", quantity: 1, unit: "bags", specifications: "" }]);
        await fetchRFQs();
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to create RFQ");
      }
    } catch (e) {
      console.error(e);
      alert("Network error occurred while creating RFQ");
    }
  };

  const handleSendRFQ = async (rfqId: string) => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/procurement/rfq/${rfqId}/send`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (res.ok) {
        await fetchRFQs();
        if (viewRfqId === rfqId) await fetchComparison(rfqId);
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to send RFQ");
      }
    } catch (e) {
      console.error(e);
      alert("Network error occurred");
    }
  };

  const handleCloseRFQ = async (rfqId: string) => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/procurement/rfq/${rfqId}/close`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (res.ok) {
        await fetchRFQs();
        if (viewRfqId === rfqId) await fetchComparison(rfqId);
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to close RFQ");
      }
    } catch (e) {
      console.error(e);
      alert("Network error occurred");
    }
  };

  const handleDeleteRFQ = async () => {
    if (!targetRfq) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/procurement/rfq/${targetRfq.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (res.ok) {
        setShowDeleteModal(false);
        if (viewRfqId === targetRfq.id) {
          setViewRfqId(null);
          setComparison([]);
        }
        setTargetRfq(null);
        await fetchRFQs();
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to delete RFQ");
      }
    } catch (e) {
      console.error(e);
      alert("Network error occurred");
    }
  };

  const openQuoteDrawer = (rfq: RFQ) => {
    setTargetRfq(rfq);
    setQuoteVendorId("");
    setQuoteVendorName("");
    setQuoteDeliveryDays("");
    setQuoteTerms("");
    setQuoteValidityDays(30);
    const initialRates: Record<string, number> = {};
    (rfq.items || []).forEach((item) => {
      initialRates[item.id] = 0;
    });
    setItemRates(initialRates);
    setShowQuoteDrawer(true);
  };

  const handleSubmitQuotes = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetRfq) return;
    const finalVendorName = quoteVendorName.trim();
    if (!finalVendorName) {
      alert("Please select or enter a vendor name.");
      return;
    }

    const itemsToSubmit = (targetRfq.items || []).filter((item) => (itemRates[item.id] || 0) > 0);
    if (itemsToSubmit.length === 0) {
      alert("Please enter a quoted rate for at least one item.");
      return;
    }

    setIsSubmitting(true);
    let successCount = 0;
    let lastError = "";

    for (const item of itemsToSubmit) {
      const payload = {
        vendor_id: quoteVendorId || null,
        vendor_name: finalVendorName,
        item_id: item.id,
        quoted_rate: Number(itemRates[item.id]) || 0,
        delivery_days: quoteDeliveryDays === "" ? null : Number(quoteDeliveryDays),
        terms: quoteTerms.trim() || null,
        validity_days: Number(quoteValidityDays) || 30,
      };

      try {
        const res = await fetch(`${getApiHost()}/apis/v3/procurement/rfq/${targetRfq.id}/quotes`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          successCount++;
        } else {
          lastError = await readErrorDetail(res);
        }
      } catch (err) {
        lastError = "Network error occurred";
      }
    }

    setIsSubmitting(false);
    if (successCount > 0) {
      setShowQuoteDrawer(false);
      await fetchRFQs();
      if (viewRfqId === targetRfq.id) {
        await fetchComparison(targetRfq.id);
      }
    } else {
      alert(lastError || "Failed to submit quotes");
    }
  };

  const getStatusTone = (status: string): BadgeTone => {
    switch (status.toLowerCase()) {
      case "draft":
        return "warning";
      case "sent":
        return "info";
      case "closed":
        return "neutral";
      default:
        return "neutral";
    }
  };

  const selectedRfqForView = rfqs.find((r) => r.id === viewRfqId);
  const totalQuotesCount = comparison.reduce((acc, row) => acc + (row.vendors?.length || 0), 0);

  return (
    <div className="flex-1 flex flex-col overflow-hidden font-sans">
      <div className="flex-1 flex flex-col overflow-hidden relative font-sans">
        <PageHeader
          title="RFQ Management"
          subtitle="Request for Quotations · Multi-vendor comparison"
          action={
            <button
              onClick={() => setShowCreate(true)}
              className="px-3.5 py-1.5 rounded-md bg-primary text-xs font-bold text-white hover:opacity-90 cursor-pointer"
            >
              + Create RFQ
            </button>
          }
        />

        <div className="flex-1 overflow-y-auto z-10">
          <PageShell width="wide">
            {!projectId ? (
              <EmptyState
                icon="building"
                title="No project selected"
                description='No active projects. Click "+ New Project" to create one.'
                action={{
                  label: "New Project",
                  href: `/c/${companyId}/projects`,
                  icon: "add",
                }}
              />
            ) : loading ? (
              <CardSkeleton />
            ) : (
              <div className="space-y-6">
                {/* RFQ List Section */}
                <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
                  <div className="px-5 py-4 border-b border-border-custom flex items-center justify-between">
                    <h2 className="text-xs font-bold uppercase tracking-wider text-muted">RFQ Register</h2>
                    <span className="text-[10px] text-muted">{rfqs.length} Total</span>
                  </div>
                  <div className="divide-y divide-border-custom/30">
                    {rfqs.length === 0 ? (
                      <div className="p-8">
                        <EmptyState
                          icon="inbox"
                          title="No RFQs created yet"
                          description="Create a Request for Quotation to solicit rates from multiple vendors."
                          action={{
                            label: "+ Create RFQ",
                            onClick: () => setShowCreate(true),
                          }}
                        />
                      </div>
                    ) : (
                      rfqs.map((rfq) => (
                    <div
                      key={rfq.id}
                      className="px-5 py-4 flex flex-col md:flex-row md:items-center justify-between gap-3 hover:bg-elevated/30 transition-all"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-foreground">{rfq.rfq_number}</span>
                          <Badge tone={getStatusTone(rfq.status)} className="uppercase font-bold text-[9px]">
                            {formatLabel(rfq.status)}
                          </Badge>
                        </div>
                        <div className="text-[11px] text-muted flex flex-wrap gap-x-4 gap-y-1">
                          <span>{rfq.items?.length || 0} line items</span>
                          {rfq.valid_until && (
                            <span>
                              Valid until: {formatDate(rfq.valid_until)}
                            </span>
                          )}
                          {rfq.notes && <span className="italic truncate max-w-xs">{rfq.notes}</span>}
                        </div>
                      </div>

                      <div className="flex items-center flex-wrap gap-2">
                        {rfq.status === "draft" && (
                          <button
                            onClick={() => handleSendRFQ(rfq.id)}
                            className="px-2.5 py-1 rounded border border-border-custom text-[11px] font-semibold text-foreground hover:bg-elevated cursor-pointer"
                          >
                            Send RFQ
                          </button>
                        )}
                        {rfq.status === "sent" && (
                          <>
                            <button
                              onClick={() => openQuoteDrawer(rfq)}
                              className="px-2.5 py-1 rounded bg-primary/10 text-primary border border-primary/20 text-[11px] font-semibold hover:bg-primary/20 cursor-pointer"
                            >
                              Enter Quote
                            </button>
                            <button
                              onClick={() => handleCloseRFQ(rfq.id)}
                              className="px-2.5 py-1 rounded border border-border-custom text-[11px] font-semibold text-foreground hover:bg-elevated cursor-pointer"
                            >
                              Close RFQ
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => {
                            setViewRfqId(rfq.id);
                            fetchComparison(rfq.id);
                          }}
                          className={`px-2.5 py-1 rounded border text-[11px] font-semibold cursor-pointer ${
                            viewRfqId === rfq.id
                              ? "bg-primary text-white border-primary"
                              : "border-border-custom text-foreground hover:bg-elevated"
                          }`}
                        >
                          Compare Quotes
                        </button>
                        <button
                          onClick={() => {
                            setTargetRfq(rfq);
                            setShowDeleteModal(true);
                          }}
                          className="px-2 py-1 rounded text-muted hover:text-danger text-[11px] font-semibold cursor-pointer"
                          title="Delete RFQ"
                        >
                          <Icon name="trash" className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )))}
                </div>
              </div>

              {/* Comparison View Section */}
              {viewRfqId && selectedRfqForView && (
                <div className="bg-card border border-border-custom rounded-lg overflow-hidden space-y-4 p-5">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border-custom pb-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] uppercase tracking-wider font-extrabold text-primary">
                          Side-by-Side Analysis
                        </span>
                        <Badge tone={getStatusTone(selectedRfqForView.status)} className="uppercase text-[9px]">
                          {formatLabel(selectedRfqForView.status)}
                        </Badge>
                      </div>
                      <h2 className="text-sm font-bold text-foreground mt-0.5">
                        Comparison for RFQ {selectedRfqForView.rfq_number}
                      </h2>
                    </div>

                    {selectedRfqForView.status !== "closed" && (
                      <button
                        onClick={() => openQuoteDrawer(selectedRfqForView)}
                        className="px-3 py-1.5 rounded-md bg-primary text-xs font-bold text-white hover:opacity-90 cursor-pointer self-start sm:self-auto"
                      >
                        + Enter Vendor Quote
                      </button>
                    )}
                  </div>

                  {totalQuotesCount === 0 ? (
                    <EmptyState
                      title="No quotes submitted yet"
                      description="Record quotes from vendors for this RFQ's line items to unlock the comparison matrix and automated rate recommendations."
                      action={
                        selectedRfqForView.status !== "closed"
                          ? {
                              label: "Enter Quote",
                              onClick: () => openQuoteDrawer(selectedRfqForView),
                            }
                          : undefined
                      }
                    />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs text-left border-collapse">
                        <thead>
                          <tr className="border-b border-border-custom bg-elevated/50 text-muted">
                            <th className="px-4 py-3 font-bold">Line Item</th>
                            <th className="px-4 py-3 font-bold">Qty</th>
                            <th className="px-4 py-3 font-bold text-right">Lowest Rate</th>
                            <th className="px-4 py-3 font-bold text-right">Highest Rate</th>
                            <th className="px-4 py-3 font-bold text-right">Spread</th>
                            <th className="px-4 py-3 font-bold">Recommended</th>
                            {Array.from(new Set(comparison.flatMap((r) => r.vendors.map((v) => v.vendor_name)))).map(
                              (vendorName) => (
                                <th key={vendorName} className="px-4 py-3 font-bold text-right min-w-[130px]">
                                  {vendorName}
                                </th>
                              )
                            )}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border-custom/30">
                          {comparison.map((row) => (
                            <tr key={row.item_id} className="hover:bg-elevated/20 transition-all">
                              <td className="px-4 py-3 font-semibold text-foreground">{row.material_name}</td>
                              <td className="px-4 py-3 text-muted">
                                {row.quantity} {row.unit}
                              </td>
                              <td className="px-4 py-3 text-right font-medium text-foreground">
                                {row.lowest_rate != null ? `₹${row.lowest_rate.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : "—"}
                              </td>
                              <td className="px-4 py-3 text-right font-medium text-foreground">
                                {row.highest_rate != null ? `₹${row.highest_rate.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : "—"}
                              </td>
                              <td className="px-4 py-3 text-right text-muted">
                                {row.price_spread != null ? `₹${row.price_spread.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : "—"}
                              </td>
                              <td className="px-4 py-3">
                                {row.recommended_vendor_name ? (
                                  <Badge tone="success" className="font-semibold text-[10px]">
                                    {row.recommended_vendor_name}
                                  </Badge>
                                ) : (
                                  <span className="text-muted">—</span>
                                )}
                              </td>
                              {Array.from(
                                new Set(comparison.flatMap((r) => r.vendors.map((v) => v.vendor_name)))
                              ).map((vendorName) => {
                                const quote = row.vendors.find((q) => q.vendor_name === vendorName);
                                if (!quote) {
                                  return (
                                    <td key={vendorName} className="px-4 py-3 text-right text-muted">
                                      —
                                    </td>
                                  );
                                }
                                return (
                                  <td key={vendorName} className="px-4 py-3 text-right">
                                    <div className="flex flex-col items-end">
                                      <span
                                        className={`font-bold ${
                                          quote.is_lowest ? "text-success font-extrabold" : "text-foreground"
                                        }`}
                                      >
                                        ₹{quote.quoted_rate.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                                      </span>
                                      {quote.delivery_days && (
                                        <span className="text-[10px] text-muted">
                                          {quote.delivery_days} days delivery
                                        </span>
                                      )}
                                      {quote.extended_total && (
                                        <span className="text-[9px] text-muted">
                                          Total: ₹{quote.extended_total.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
            )}
          </PageShell>
        </div>
      </div>

      {/* Create RFQ Drawer / Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-card border border-border-custom rounded-lg w-full max-w-xl p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-border-custom pb-3">
              <div>
                <h3 className="text-sm font-bold text-foreground">Create RFQ</h3>
                <p className="text-xs text-muted mt-0.5">Define line items and validity for vendor quotation requests.</p>
              </div>
              <button
                onClick={() => setShowCreate(false)}
                className="text-muted hover:text-foreground cursor-pointer"
              >
                <Icon name="close" className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateRFQ} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">RFQ Number *</label>
                  <input
                    type="text"
                    required
                    value={newRfqNum}
                    onChange={(e) => setNewRfqNum(e.target.value)}
                    placeholder="e.g. RFQ-2026-001"
                    className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none font-sans"
                  />
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Valid Until</label>
                  <input
                    type="date"
                    value={newValidUntil}
                    onChange={(e) => setNewValidUntil(e.target.value)}
                    className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none font-sans"
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Notes / Instructions</label>
                <textarea
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  placeholder="Special instructions, delivery location, or terms"
                  rows={2}
                  className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none font-sans"
                />
              </div>

              {/* Repeatable Line Items */}
              <div className="space-y-3 border-t border-border-custom pt-3">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] uppercase font-bold text-muted">RFQ Line Items *</span>
                  <button
                    type="button"
                    onClick={() =>
                      setNewItems([
                        ...newItems,
                        { material_name: "", quantity: 1, unit: "bags", specifications: "" },
                      ])
                    }
                    className="text-[10px] font-bold text-primary hover:underline cursor-pointer"
                  >
                    + Add Item Line
                  </button>
                </div>

                {newItems.map((item, idx) => (
                  <div
                    key={idx}
                    className="bg-elevated p-3 rounded-lg border border-border-custom space-y-2 relative"
                  >
                    {newItems.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setNewItems(newItems.filter((_, i) => i !== idx))}
                        className="absolute top-2 right-2 text-muted hover:text-danger cursor-pointer"
                        title="Remove item"
                      >
                        <Icon name="close" className="w-3.5 h-3.5" />
                      </button>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <div className="sm:col-span-2">
                        <label className="text-[9px] text-muted font-bold block mb-1">Material Name *</label>
                        <select
                          value={item.material_name}
                          onChange={(e) => {
                            const updated = [...newItems];
                            updated[idx].material_name = e.target.value;
                            const matched = materials.find((m) => m.name === e.target.value);
                            if (matched?.unit) updated[idx].unit = matched.unit;
                            setNewItems(updated);
                          }}
                          required
                          className="w-full bg-input border border-border-custom rounded p-1.5 text-foreground text-xs"
                        >
                          <option value="">Select Material</option>
                          {materials.map((m) => (
                            <option key={m.id} value={m.name}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                        {materials.length === 0 && (
                          <FieldHint
                            text="No materials yet. Add one in Library."
                            href={`/c/${companyId}/d/library`}
                            linkLabel="Go to Library"
                          />
                        )}
                      </div>

                      <div>
                        <label className="text-[9px] text-muted font-bold block mb-1">Unit *</label>
                        <select
                          value={item.unit}
                          onChange={(e) => {
                            const updated = [...newItems];
                            updated[idx].unit = e.target.value;
                            setNewItems(updated);
                          }}
                          className="w-full bg-input border border-border-custom rounded p-1.5 text-foreground text-xs"
                        >
                          {UNITS.map((u) => (
                            <option key={u} value={u}>
                              {u}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <label className="text-[9px] text-muted font-bold block mb-1">Quantity *</label>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          required
                          value={item.quantity}
                          onChange={(e) => {
                            const updated = [...newItems];
                            updated[idx].quantity = parseFloat(e.target.value) || 0;
                            setNewItems(updated);
                          }}
                          className="w-full bg-input border border-border-custom rounded p-1.5 text-foreground text-xs"
                        />
                      </div>

                      <div>
                        <label className="text-[9px] text-muted font-bold block mb-1">Specifications (Optional)</label>
                        <input
                          type="text"
                          value={item.specifications}
                          onChange={(e) => {
                            const updated = [...newItems];
                            updated[idx].specifications = e.target.value;
                            setNewItems(updated);
                          }}
                          placeholder="e.g. OPC 53 Grade, ISI marked"
                          className="w-full bg-input border border-border-custom rounded p-1.5 text-foreground text-xs"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex gap-2 justify-end pt-3 border-t border-border-custom">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="px-4 py-2 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="bg-primary hover:opacity-90 text-white px-5 py-2 rounded-md text-xs font-bold cursor-pointer"
                >
                  Create RFQ
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Enter Quote Drawer */}
      {showQuoteDrawer && targetRfq && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-card border border-border-custom rounded-lg w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-border-custom pb-3">
              <div>
                <h3 className="text-sm font-bold text-foreground">Record Vendor Quote</h3>
                <p className="text-xs text-muted mt-0.5">
                  Enter quoted rates for RFQ {targetRfq.rfq_number} line items.
                </p>
              </div>
              <button
                onClick={() => setShowQuoteDrawer(false)}
                className="text-muted hover:text-foreground cursor-pointer"
              >
                <Icon name="close" className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmitQuotes} className="space-y-4">
              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Select Vendor *</label>
                <select
                  value={quoteVendorId}
                  onChange={(e) => {
                    const vid = e.target.value;
                    setQuoteVendorId(vid);
                    const selected = vendors.find((v) => v.id === vid);
                    if (selected) setQuoteVendorName(selected.name);
                  }}
                  className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none font-sans"
                >
                  <option value="">Select Vendor from Library</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
                {vendors.length === 0 && (
                  <FieldHint
                    text="No vendors yet. Add one in Subcontractors."
                    href={`/c/${companyId}/d/subcon`}
                    linkLabel="Go to Subcontractors"
                  />
                )}
              </div>

              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">
                  Vendor Name (or enter manually) *
                </label>
                <input
                  type="text"
                  required
                  value={quoteVendorName}
                  onChange={(e) => setQuoteVendorName(e.target.value)}
                  placeholder="Vendor legal name"
                  className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none font-sans"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">
                    Delivery Lead Time (Days)
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={quoteDeliveryDays}
                    onChange={(e) =>
                      setQuoteDeliveryDays(e.target.value === "" ? "" : parseInt(e.target.value) || 0)
                    }
                    placeholder="e.g. 5"
                    className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none font-sans"
                  />
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">
                    Quote Validity (Days)
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={quoteValidityDays}
                    onChange={(e) => setQuoteValidityDays(parseInt(e.target.value) || 30)}
                    className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none font-sans"
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Terms / Payment Notes</label>
                <input
                  type="text"
                  value={quoteTerms}
                  onChange={(e) => setQuoteTerms(e.target.value)}
                  placeholder="e.g. 30 days credit, delivery included"
                  className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none font-sans"
                />
              </div>

              {/* Per-Item Rates */}
              <div className="space-y-2 border-t border-border-custom pt-3">
                <label className="text-[10px] uppercase font-bold text-muted block">
                  Quoted Rates per Line Item *
                </label>
                {(targetRfq.items || []).map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-3 p-2.5 rounded bg-elevated border border-border-custom text-xs"
                  >
                    <div>
                      <span className="font-semibold text-foreground block">{item.material_name}</span>
                      <span className="text-[10px] text-muted">
                        Req: {item.quantity} {item.unit}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 w-36">
                      <span className="text-muted text-xs">₹</span>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={itemRates[item.id] || ""}
                        onChange={(e) =>
                          setItemRates({
                            ...itemRates,
                            [item.id]: parseFloat(e.target.value) || 0,
                          })
                        }
                        placeholder="Rate"
                        className="w-full bg-input border border-border-custom rounded px-2 py-1 text-foreground text-xs"
                      />
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex gap-2 justify-end pt-3 border-t border-border-custom">
                <button
                  type="button"
                  onClick={() => setShowQuoteDrawer(false)}
                  className="px-4 py-2 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="bg-primary hover:opacity-90 text-white px-5 py-2 rounded-md text-xs font-bold cursor-pointer disabled:opacity-50"
                >
                  {isSubmitting ? "Submitting..." : "Save Quote"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteModal && targetRfq && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-card border border-border-custom rounded-lg w-full max-w-sm p-5 space-y-4">
            <h3 className="text-sm font-bold text-foreground">Confirm Deletion</h3>
            <p className="text-xs text-muted">
              Are you sure you want to delete RFQ <span className="font-bold text-foreground">{targetRfq.rfq_number}</span>? This will permanently remove the RFQ, line items, and all associated vendor quotes.
            </p>
            <div className="flex gap-2 justify-end pt-2">
              <button
                onClick={() => setShowDeleteModal(false)}
                className="px-3.5 py-1.5 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteRFQ}
                className="px-4 py-1.5 rounded-md bg-danger text-white text-xs font-bold hover:opacity-90 cursor-pointer"
              >
                Delete RFQ
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}