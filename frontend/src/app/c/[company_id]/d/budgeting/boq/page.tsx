"use client";
import Badge, { type BadgeTone } from "@/components/ui/Badge";
import { getApiHost, detailToMessage} from "@/lib/api";
import { authHeaders, formatDate } from "@/lib/siteflow";

import React, { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useProject } from "@/context/ProjectContext";
import { useParams } from "next/navigation";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import SegmentedTabs from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import Icon from "@/components/marketing/Icon";

// ─── Types ────────────────────────────────────────────────────────────────────
interface BOQItem {
  id: string;
  section: string;
  costCode: string;
  item_name: string;
  unit: string;
  quantity: number;
  rate: number;
  amount: number;
  actual_spent: number;
  revised_qty?: number;
  revised_rate?: number;
}

interface BOQDocumentLite {
  id: string;
  title: string;
  project_id: string;
  revised_amount?: number | null;
}

interface BOQRevision {
  id: string;
  boq_document_id: string;
  project_id: string;
  revision_no: number;
  revised_amount: number;
  previous_amount: number | null;
  delta: number | null;
  reason: string | null;
  revised_by_user_id: string | null;
  revised_by_name: string | null;
  created_at: string;
}

const SECTION_COLORS: Record<string, string> = {
  "1 — Civil Works": "bg-chart-1/10 text-chart-1 border-chart-1/20",
  "2 — Structural": "bg-chart-2/10 text-chart-2 border-chart-2/20",
  "3 — Masonry": "bg-chart-3/10 text-chart-3 border-chart-3/20",
  "4 — Finishes": "bg-chart-4/10 text-chart-4 border-chart-4/20",
  "5 — MEP": "bg-chart-5/10 text-chart-5 border-chart-5/20",
  "6 — Provisional / Contingency": "bg-chart-6/10 text-chart-6 border-chart-6/20",
};

function fmt(n: number) { return "₹" + n.toLocaleString("en-IN"); }
function fmtN(n: number) { return n.toLocaleString("en-IN", { maximumFractionDigits: 2 }); }

function varPct(budget: number, actual: number) {
  if (budget === 0) return 0;
  return ((actual - budget) / budget) * 100;
}

function varColor(pct: number) {
  if (pct > 10) return "text-danger";
  if (pct > 0) return "text-warning";
  return "text-success";
}

function statusBadge(pct: number) {
  if (pct > 10) return { label: "OVERSPENT", cls: "bg-danger/10 border-danger/20 text-danger" };
  if (pct > 0) return { label: "AT RISK", cls: "bg-warning/10 border-warning/20 text-warning" };
  if (pct > -5) return { label: "ON TRACK", cls: "bg-success/10 border-success/20 text-success" };
  return { label: "UNDER BUDGET", cls: "bg-info/10 border-info/20 text-info" };
}

export default function BOQPage() {
  const params = useParams();
  const companyId = params?.company_id as string;
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;

  const [tab, setTab] = useState<"boq" | "variance" | "revisions">("boq");
  const [boqItems, setBoqItems] = useState<BOQItem[]>([]);
  const [fileState, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  const [search, setSearch] = useState("");
  const [filterSection, setFilterSection] = useState("All");

  // Budget revision history (real, fetched from the API per project)
  const [revisions, setRevisions] = useState<BOQRevision[]>([]);
  const [revisionLoading, setRevisionLoading] = useState(false);
  const [documents, setDocuments] = useState<BOQDocumentLite[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<string>("");
  const [revAmount, setRevAmount] = useState("");
  const [revReason, setRevReason] = useState("");
  const [savingRev, setSavingRev] = useState(false);
  const [revMsg, setRevMsg] = useState("");

  // Inline manual entry — D5 (R2-030): POST /boq-documents/{doc_id}/items — reuses import validation (BOQItemCreate + R2-334 cost-code gate at budgeting.py:475)
  const [showInlineD, setShowInlineD] = useState(false);
  const [inlineD, setInlineD] = useState({ item_name: "", unit: "Nos", quantity: "", rate: "", supply_rate: "", installation_rate: "", section_name: "", cost_code: "" });
  const [inlineDSaving, setInlineDSaving] = useState(false);
  const [inlineDError, setInlineDError] = useState<string | null>(null);
  const [inlineDMsg, setInlineDMsg] = useState<string | null>(null);

  const selectedDoc = useMemo(() => documents.find(d => d.id === selectedDocId), [documents, selectedDocId]);
  const totalBudget = useMemo(() => {
    if (selectedDoc?.revised_amount != null) return Number(selectedDoc.revised_amount);
    return boqItems.reduce((s, i) => s + i.amount, 0);
  }, [boqItems, selectedDoc]);
  const totalActual = useMemo(() => boqItems.reduce((s, i) => s + i.actual_spent, 0), [boqItems]);
  const totalVariance = totalActual - totalBudget;
  const overallPct = varPct(totalBudget, totalActual);

  const sections = useMemo(() => [...new Set(boqItems.map(i => i.section))], [boqItems]);

  const filtered = useMemo(() => {
    let items = boqItems;
    if (filterSection !== "All") items = items.filter(i => i.section === filterSection);
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter(i => i.item_name.toLowerCase().includes(q) || i.costCode.includes(q) || i.section.toLowerCase().includes(q));
    }
    return items;
  }, [boqItems, filterSection, search]);

  const groupedFiltered = useMemo(() => {
    const map: Record<string, BOQItem[]> = {};
    filtered.forEach(i => {
      if (!map[i.section]) map[i.section] = [];
      map[i.section].push(i);
    });
    return map;
  }, [filtered]);

  // picked: the file chosen from the header button. State set in the same
  // handler is not visible yet, so it is passed straight in.
  const handleImport = async (e: React.FormEvent | null, picked?: File) => {
    e?.preventDefault();
    const file = picked ?? fileState;
    if (!file) return;
    setImporting(true);
    const formData = new FormData();
    formData.append("project_id", projectId);
    formData.append("file", file);
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/budgeting/boq/import`, { method: "POST", headers: authHeaders(), body: formData });
      const data = await res.json();
      if (res.ok && data.success) {
        // R2-450: report dropped rows so a partial import can't pass as complete.
        const skippedCount = typeof data.skipped_count === "number" ? data.skipped_count : 0;
        const skipWarnings: string[] = Array.isArray(data.warnings) ? data.warnings : [];
        setImportMsg(
          skippedCount > 0
            ? `BOQ imported: ${data.imported_count} row(s) kept, ${skippedCount} skipped. ${skipWarnings.join(" ")}`
            : "BOQ imported successfully!"
        );
        setFile(null);
        await loadBoq();
      } else {
        setImportMsg(detailToMessage(data.detail, "Import failed."));
      }
    } catch {
      setImportMsg("Import failed: backend not reachable. The BOQ was not modified.");
    } finally {
      setImporting(false);
    }
  };

  // ── Budget revision history (real) ──
  const fetchRevisions = async () => {
    if (!projectId) return;
    setRevisionLoading(true);
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/budgeting/boq-revisions?project_id=${projectId}`, { headers: authHeaders() });
      const data = await res.json();
      setRevisions(Array.isArray(data) ? data : []);
    } catch {
      setRevisions([]);
    } finally {
      setRevisionLoading(false);
    }
  };

  const loadBoq = async () => {
    if (!projectId) return;
    try {
      const dres = await fetch(`${getApiHost()}/apis/v3/budgeting/boq-documents?project_id=${projectId}`, { headers: authHeaders() });
      if (dres.ok) {
        const docs = await dres.json();
        const list: BOQDocumentLite[] = Array.isArray(docs) ? docs : [];
        setDocuments(list);
        if (list.length && !selectedDocId) setSelectedDocId(list[0].id);
      }
    } catch { /* ignore */ }

    // Real BOQ line items (replaces the old hardcoded SEED_BOQ array).
    try {
      const ires = await fetch(`${getApiHost()}/apis/v3/budgeting/boq?project_id=${projectId}`, { headers: authHeaders() });
      if (ires.ok) {
        const items: any[] = await ires.json();
        // "Actual spent" is the project's real billed value (client billing),
        // allocated across BOQ items by their budget-weight. The schema tracks
        // no per-item actual cost, so this is the honest real signal available.
        let totalBilled = 0;
        try {
          const bdres = await fetch(`${getApiHost()}/apis/v3/budgeting/boq-documents?project_id=${projectId}`, { headers: authHeaders() });
          if (bdres.ok) {
            const docs = await bdres.json();
            totalBilled = (Array.isArray(docs) ? docs : []).reduce((s: number, d: any) => s + (Number(d.billed_value) || 0), 0);
          }
        } catch { /* ignore */ }
        const totalBudget = items.reduce((s: number, i: any) => s + (Number(i.amount) || 0), 0);
        setBoqItems(items.map((i: any) => ({
          id: i.id,
          section: i.section_name || "Uncategorized",
          costCode: i.cost_code || "",
          item_name: i.item_name,
          unit: i.unit,
          quantity: Number(i.quantity) || 0,
          rate: Number(i.rate) || 0,
          amount: Number(i.amount) || 0,
          actual_spent: totalBudget > 0 ? (totalBilled * (Number(i.amount) || 0)) / totalBudget : 0,
        })));
      }
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (!projectId) return;
    (async () => {
      await loadBoq();
      await fetchRevisions();
    })();
  }, [projectId]);

  const handleRecordRevision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedDocId) { setRevMsg("Select a BOQ document first."); return; }
    const amt = parseFloat(revAmount);
    if (!amt || amt <= 0) { setRevMsg("Enter a valid revised amount."); return; }
    setSavingRev(true);
    setRevMsg("");
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/budgeting/boq-documents/${selectedDocId}/revisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ revised_amount: amt, reason: revReason || null }),
      });
      const data = await res.json();
      if (res.ok) {
        setRevMsg("Revision recorded.");
        setRevAmount("");
        setRevReason("");
        fetchRevisions();
      } else {
        setRevMsg(typeof data.detail === "string" ? data.detail : Array.isArray(data.detail) ? data.detail.map((d: any) => d.msg || JSON.stringify(d)).join("; ") : "Failed to record revision.");
      }
    } catch {
      setRevMsg("Backend not reachable.");
    } finally {
      setSavingRev(false);
    }
  };

  // Inline row validation — mirrors BOQItemCreate (budgeting.py BOQItemCreate) + cost_code gate shared with import
  const validateInlineD = (): string | null => {
    if (!inlineD.item_name.trim()) return "Item name is required";
    if (inlineD.quantity === "" || isNaN(Number(inlineD.quantity))) return "Quantity must be numeric";
    if (Number(inlineD.quantity) < 0) return "Quantity cannot be negative";
    if (inlineD.rate !== "" && (isNaN(Number(inlineD.rate)) || Number(inlineD.rate) < 0)) return "Rate cannot be negative";
    if (inlineD.supply_rate !== "" && (isNaN(Number(inlineD.supply_rate)) || Number(inlineD.supply_rate) < 0)) return "Supply rate cannot be negative";
    if (inlineD.installation_rate !== "" && (isNaN(Number(inlineD.installation_rate)) || Number(inlineD.installation_rate) < 0)) return "Installation rate cannot be negative";
    return null;
  };

  const resetInlineD = () => setInlineD({ item_name: "", unit: "Nos", quantity: "", rate: "", supply_rate: "", installation_rate: "", section_name: "", cost_code: "" });

  const handleAddInlineD = async () => {
    if (!selectedDocId) { setInlineDError("Select a BOQ document first."); return; }
    const v = validateInlineD();
    if (v) { setInlineDError(v); return; }
    setInlineDSaving(true);
    setInlineDError(null);
    setInlineDMsg(null);
    try {
      const payload = {
        item_name: inlineD.item_name.trim(),
        unit: inlineD.unit.trim() || "Nos",
        quantity: inlineD.quantity === "" ? 0 : Number(inlineD.quantity),
        rate: inlineD.rate === "" ? 0 : Number(inlineD.rate),
        supply_rate: inlineD.supply_rate === "" ? 0 : Number(inlineD.supply_rate),
        installation_rate: inlineD.installation_rate === "" ? 0 : Number(inlineD.installation_rate),
        section_name: inlineD.section_name.trim() || null,
        cost_code: inlineD.cost_code.trim() || null,
      };
      const res = await fetch(`${getApiHost()}/apis/v3/budgeting/boq-documents/${selectedDocId}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify(payload),
      });
      let data: any = null;
      try { data = await res.json(); } catch { /* ignore */ }
      if (!res.ok) {
        const detail = data && typeof data.detail === "string" ? data.detail : Array.isArray(data?.detail) ? data.detail.map((d: any) => d.msg || JSON.stringify(d)).join("; ") : `Request failed (${res.status})`;
        setInlineDError(detail);
        return;
      }
      setInlineDMsg("Item added.");
      resetInlineD();
      setShowInlineD(false);
      await loadBoq();
    } catch (e) {
      setInlineDError(e instanceof Error ? e.message : "Backend not reachable. The BOQ was not modified.");
    } finally {
      setInlineDSaving(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title={tab === "boq" ? "Bill of Quantities (BOQ)" : tab === "variance" ? "Budget vs Actual Variance" : "Budget Revisions"}
        subtitle={!projectId || boqItems.length === 0 ? "Track itemized quantities, unit rates, and budget variances." : `Total Budget: ${fmt(totalBudget)} · Spent: ${fmt(totalActual)}`}
      >
        <div className="flex items-center gap-3">
          {/* KPI pill */}
          {projectId && boqItems.length > 0 && (
            <Badge tone={overallPct > 10 ? "danger" : overallPct > 0 ? "warning" : "success"} className="font-bold">{overallPct > 0 ? "+" : ""}{overallPct.toFixed(1)}% overall variance</Badge>
          )}
          {/* Import trigger */}
          <label className="px-3.5 py-1.5 bg-primary text-white text-xs font-bold rounded-lg hover:opacity-90 cursor-pointer transition-all inline-flex items-center gap-1.5">
            <Icon name="arrow_up" className="w-3.5 h-3.5" /> Import Excel
            <input type="file" accept=".xlsx,.xlsm" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) { handleImport(null, f); e.target.value = ""; } }} />
          </label>
        </div>
      </PageHeader>

      <div className="flex items-center gap-1 px-6 py-2 border-b border-border-custom bg-card shrink-0 overflow-x-auto">
        <SegmentedTabs
          tabs={[
            { id: "boq", label: "BOQ Line Items" },
            { id: "variance", label: "Budget vs Actual" },
            { id: "revisions", label: "Budget Revisions" },
          ]}
          activeTab={tab}
          onChange={(t) => setTab(t as any)}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">
          <div className="flex-1 overflow-hidden">

          {/* ── BOQ TAB ── */}
          {tab === "boq" && (
            <div className="flex flex-col h-full overflow-hidden">
              {!projectId && (
                <EmptyState
                  title="No project selected"
                  description="Select a project from the top dropdown to view and manage its Bill of Quantities."
                />
              )}
              {projectId && boqItems.length === 0 && (
                <EmptyState
                  title="No BOQ items found"
                  description="Import a Bill of Quantities Excel (.xlsx) spreadsheet with item names, units, quantities, rates, and cost codes."
                  action={{
                    label: "Import Excel",
                    onClick: () => {
                      const el = document.getElementById("boq-upload");
                      if (el) (el as HTMLInputElement).click();
                    },
                  }}
                />
              )}
              {/* Filters */}
              <div className="flex items-center gap-3 px-5 py-3 border-b border-border-custom shrink-0">
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search item, code, section..." className="flex-1 bg-input border border-border-custom rounded-lg px-3 py-1.5 text-xs text-foreground placeholder-muted" />
                <div className="flex gap-1">
                  {["All", ...sections].map(s => (
                    <button key={s} onClick={() => setFilterSection(s)}
                      className={`px-2.5 py-1 text-[9px] font-bold rounded-lg transition-all ${filterSection === s ? "bg-primary text-white" : "bg-elevated text-muted hover:text-foreground"}`}>
                      {s === "All" ? "All" : s.split("—")[0].trim()}
                    </button>
                  ))}
                </div>
              </div>

              {/* Inline manual entry — D5 (R2-030): typed row POSTs to /boq-documents/{doc_id}/items reusing import validation */}
              <div className="px-5 py-3 border-b border-border-custom shrink-0 space-y-2">
                <div className="flex items-center gap-2">
                  <button onClick={() => { setShowInlineD(v => !v); setInlineDError(null); setInlineDMsg(null); }} disabled={!selectedDocId && documents.length === 0} className="px-3 py-1.5 bg-primary/10 border border-primary/20 text-primary text-xs font-bold rounded-lg hover:bg-primary/20 disabled:opacity-40">
                    {showInlineD ? "Cancel" : "+ Add Item"}
                  </button>
                  {!selectedDocId && documents.length > 0 && <span className="text-[10px] text-warning">Select a BOQ document to add items</span>}
                  {documents.length === 0 && <span className="text-[10px] text-muted">Create a BOQ document first, then add items</span>}
                  {inlineDError && <span className="text-[10px] text-danger">{inlineDError}</span>}
                  {inlineDMsg && <span className="text-[10px] text-success">{inlineDMsg}</span>}
                </div>
                {selectedDocId && (
                  <div className="flex items-center gap-2 text-[10px] text-muted">
                    <span>Target BOQ:</span>
                    <select value={selectedDocId} onChange={e => setSelectedDocId(e.target.value)} className="bg-input border border-border-custom rounded-lg px-2 py-1 text-xs text-foreground">
                      {documents.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
                    </select>
                  </div>
                )}
                {showInlineD && (
                  <div className="p-3 bg-card border border-border-custom rounded-lg space-y-2">
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2">
                      <input value={inlineD.section_name} onChange={e => setInlineD({ ...inlineD, section_name: e.target.value })} placeholder="Section" className="bg-input border border-border-custom rounded-lg px-2 py-1.5 text-xs text-foreground placeholder-muted" />
                      <input value={inlineD.item_name} onChange={e => setInlineD({ ...inlineD, item_name: e.target.value })} placeholder="Item name *" className="bg-input border border-border-custom rounded-lg px-2 py-1.5 text-xs text-foreground placeholder-muted" />
                      <input value={inlineD.cost_code} onChange={e => setInlineD({ ...inlineD, cost_code: e.target.value })} placeholder="Cost code" className="bg-input border border-border-custom rounded-lg px-2 py-1.5 text-xs text-foreground placeholder-muted" />
                      <input value={inlineD.unit} onChange={e => setInlineD({ ...inlineD, unit: e.target.value })} placeholder="Unit (Nos)" className="bg-input border border-border-custom rounded-lg px-2 py-1.5 text-xs text-foreground placeholder-muted" />
                      <input type="number" min="0" step="any" value={inlineD.quantity} onChange={e => setInlineD({ ...inlineD, quantity: e.target.value })} placeholder="Qty *" className="bg-input border border-border-custom rounded-lg px-2 py-1.5 text-xs text-foreground placeholder-muted" />
                      <input type="number" min="0" step="any" value={inlineD.rate} onChange={e => setInlineD({ ...inlineD, rate: e.target.value })} placeholder="Rate" className="bg-input border border-border-custom rounded-lg px-2 py-1.5 text-xs text-foreground placeholder-muted" />
                      <input type="number" min="0" step="any" value={inlineD.supply_rate} onChange={e => setInlineD({ ...inlineD, supply_rate: e.target.value })} placeholder="Supply rate" className="bg-input border border-border-custom rounded-lg px-2 py-1.5 text-xs text-foreground placeholder-muted" />
                      <input type="number" min="0" step="any" value={inlineD.installation_rate} onChange={e => setInlineD({ ...inlineD, installation_rate: e.target.value })} placeholder="Install rate" className="bg-input border border-border-custom rounded-lg px-2 py-1.5 text-xs text-foreground placeholder-muted" />
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={handleAddInlineD} disabled={inlineDSaving} className="px-3 py-1.5 bg-primary text-white text-xs font-bold rounded-lg disabled:opacity-40">
                        {inlineDSaving ? "Saving..." : "Save"}
                      </button>
                      <button onClick={() => { setShowInlineD(false); setInlineDError(null); resetInlineD(); }} className="px-3 py-1.5 bg-elevated border border-border-custom text-muted text-xs rounded-lg">Cancel</button>
                      <span className="text-[10px] text-muted">Many lines? Use Import Excel instead.</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Table */}
              <div className="flex-1 overflow-auto">
                <table className="w-full text-xs text-left border-collapse">
                  <thead className="sticky top-0 z-10 bg-background">
                    <tr className="border-b border-border-custom text-muted font-bold uppercase tracking-wider text-[9px]">
                      <th className="py-3 pl-5 pr-3">Cost Code</th>
                      <th className="py-3 pr-4">Description</th>
                      <th className="py-3 px-3 text-center">Unit</th>
                      <th className="py-3 px-3 text-right">Qty</th>
                      <th className="py-3 px-3 text-right">Rate (₹)</th>
                      <th className="py-3 px-3 text-right">Budget Amt</th>
                      <th className="py-3 px-3 text-right">Actual Spent</th>
                      <th className="py-3 px-3 text-right">Variance</th>
                      <th className="py-3 pr-5 text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys(groupedFiltered).length === 0 ? (
                      <tr>
                        <td colSpan={9} className="p-8">
                          <EmptyState
                            title={!projectId ? "No active project selected" : "No BOQ items uploaded"}
                            description={!projectId ? "Select or create a project to manage its bill of quantities." : "Upload your BOQ spreadsheet (.xlsx or .csv) or add line items manually."}
                            action={!projectId ? {
                              label: "View Projects",
                              href: `/c/${companyId}/projects`,
                              icon: "building",
                            } : {
                              label: "Add Item",
                              onClick: () => setShowInlineD(true),
                              icon: "add",
                            }}
                          />
                        </td>
                      </tr>
                    ) : (
                      Object.entries(groupedFiltered).map(([section, items]) => {
                        const secBudget = items.reduce((s, i) => s + i.amount, 0);
                        const secActual = items.reduce((s, i) => s + i.actual_spent, 0);
                        const sColor = SECTION_COLORS[section] ?? "bg-elevated text-muted border-border-custom";
                        return (
                          <React.Fragment key={section}>
                            {/* Section header */}
                            <tr className="border-b border-border-custom">
                              <td colSpan={9} className="py-2 pl-5 bg-elevated">
                                <div className="flex items-center gap-3">
                                  <span className={`text-[9px] font-bold px-2 py-0.5 rounded border ${sColor}`}>{section}</span>
                                  <span className="text-[10px] text-muted">Budget: {fmt(secBudget)} · Actual: {fmt(secActual)}</span>
                                </div>
                              </td>
                            </tr>
                            {/* Items */}
                            {items.map(item => {
                              const vPct = varPct(item.amount, item.actual_spent);
                              const vAmt = item.actual_spent - item.amount;
                              const sb = statusBadge(vPct);
                              return (
                                <tr key={item.id} className="border-b border-border-custom hover:bg-elevated transition-colors">
                                  <td className="py-3 pl-5 pr-3 font-sans text-muted">{item.costCode}</td>
                                  <td className="py-3 pr-4 text-foreground font-medium">{item.item_name}</td>
                                  <td className="py-3 px-3 text-center text-muted">{item.unit}</td>
                                  <td className="py-3 px-3 text-right font-sans text-muted">{fmtN(item.quantity)}</td>
                                  <td className="py-3 px-3 text-right font-sans text-muted">{fmtN(item.rate)}</td>
                                  <td className="py-3 px-3 text-right font-sans font-semibold text-foreground">{fmt(item.amount)}</td>
                                  <td className="py-3 px-3 text-right font-sans font-semibold text-foreground">{fmt(item.actual_spent)}</td>
                                  <td className={`py-3 px-3 text-right font-sans font-bold ${varColor(vPct)}`}>
                                    {vAmt >= 0 ? "+" : ""}{fmt(vAmt)}
                                    <span className="text-[9px] ml-1 opacity-70">({vPct > 0 ? "+" : ""}{vPct.toFixed(1)}%)</span>
                                  </td>
                                  <td className="py-3 pr-5 text-center">
                                    <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded border ${sb.cls}`}>{sb.label}</span>
                                  </td>
                                </tr>
                              );
                            })}
                          </React.Fragment>
                        );
                      })
                    )}
                  </tbody>
                  {boqItems.length > 0 && (
                    <tfoot className="border-t-2 border-border-custom">
                      <tr className="bg-input">
                        <td colSpan={5} className="py-3 pl-5 font-bold text-foreground text-xs">PROJECT TOTAL</td>
                        <td className="py-3 px-3 text-right font-bold text-foreground font-sans">{fmt(totalBudget)}</td>
                        <td className="py-3 px-3 text-right font-bold text-foreground font-sans">{fmt(totalActual)}</td>
                        <td className={`py-3 px-3 text-right font-bold font-sans ${varColor(overallPct)}`}>
                          {totalVariance >= 0 ? "+" : ""}{fmt(totalVariance)}
                          <span className="text-[9px] ml-1 opacity-70">({overallPct > 0 ? "+" : ""}{overallPct.toFixed(1)}%)</span>
                        </td>
                        <td className="py-3 pr-5 text-center">
                          <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded border ${statusBadge(overallPct).cls}`}>{statusBadge(overallPct).label}</span>
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          )}

          {/* ── VARIANCE TAB ── */}
          {tab === "variance" && (
            <div className="h-full overflow-y-auto p-5 space-y-4">
              {!projectId || boqItems.length === 0 ? (
                <EmptyState
                  title={!projectId ? "No active project selected" : "No variance data available"}
                  description={!projectId ? "Select or create a project to view budget vs actual variance analysis." : "Upload your BOQ or log project expenditures to view budget variance and cost projections."}
                  action={!projectId ? {
                    label: "View Projects",
                    href: `/c/${companyId}/projects`,
                    icon: "building",
                  } : {
                    label: "Add BOQ Item",
                    onClick: () => { setTab("boq"); setShowInlineD(true); },
                    icon: "add",
                  }}
                />
              ) : (
                <>
                  {/* KPI strip */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {[
                  { label: "Total Budget", value: fmt(totalBudget), sub: selectedDoc?.revised_amount != null ? "Latest applied revision" : "Original contract value", color: "text-info" },
                  { label: "Total Actual Spent", value: fmt(totalActual), sub: "As of today", color: "text-foreground" },
                  { label: "Variance (₹)", value: (totalVariance >= 0 ? "+" : "") + fmt(totalVariance), sub: totalVariance > 0 ? "Over budget" : "Under budget", color: varColor(overallPct) },
                  { label: "Variance (%)", value: (overallPct > 0 ? "+" : "") + overallPct.toFixed(1) + "%", sub: statusBadge(overallPct).label, color: varColor(overallPct) },
                ].map(k => (
                  <div key={k.label} className="bg-input border border-border-custom rounded-md p-4">
                    <div className="text-[9px] uppercase tracking-widest text-muted">{k.label}</div>
                    <div className={`text-xl font-black mt-1 ${k.color}`}>{k.value}</div>
                    <div className="text-[10px] text-muted mt-0.5">{k.sub}</div>
                  </div>
                ))}
              </div>

              {/* Section summary bars */}
              <div className="bg-input border border-border-custom rounded-md p-5 space-y-4">
                <h3 className="text-xs font-bold text-muted uppercase tracking-wider">Section-wise Budget vs Actual</h3>
                {sections.map(section => {
                  const secItems = boqItems.filter(i => i.section === section);
                  const sBudget = secItems.reduce((s, i) => s + i.amount, 0);
                  const sActual = secItems.reduce((s, i) => s + i.actual_spent, 0);
                  const pct = (sActual / sBudget) * 100;
                  const vp = varPct(sBudget, sActual);
                  const sColor = SECTION_COLORS[section] ?? "bg-elevated text-muted border-border-custom";
                  return (
                    <div key={section} className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className={`text-[9px] font-bold px-2 py-0.5 rounded border ${sColor}`}>{section}</span>
                        <div className="text-right">
                          <span className="text-muted font-sans">{fmt(sActual)}</span>
                          <span className="text-muted mx-1">/</span>
                          <span className="text-muted font-sans">{fmt(sBudget)}</span>
                          <span className={`ml-2 text-[10px] font-bold ${varColor(vp)}`}>({vp > 0 ? "+" : ""}{vp.toFixed(1)}%)</span>
                        </div>
                      </div>
                      <div className="h-2 bg-elevated rounded-full overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${pct > 110 ? "bg-danger" : pct > 100 ? "bg-warning" : "bg-success"}`}
                          style={{ width: `${Math.min(pct, 100)}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Variance table by cost code */}
              <div className="bg-input border border-border-custom rounded-md overflow-hidden">
                <div className="px-5 py-3 border-b border-border-custom text-xs font-bold text-muted">Cost Code Variance Detail</div>
                <table className="w-full text-xs text-left">
                  <thead>
                    <tr className="border-b border-border-custom text-muted text-[9px] uppercase tracking-wider">
                      <th className="py-2.5 pl-5 pr-3">Code</th>
                      <th className="py-2.5 pr-4">Description</th>
                      <th className="py-2.5 px-3 text-right">Budget</th>
                      <th className="py-2.5 px-3 text-right">Actual</th>
                      <th className="py-2.5 px-3 text-right">Variance</th>
                      <th className="py-2.5 pr-5 text-right">EAC*</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-custom">
                    {boqItems.map(item => {
                      const vPct = varPct(item.amount, item.actual_spent);
                      const vAmt = item.actual_spent - item.amount;
                      // EAC using 60% assumed completion (replace with real % from Gantt)
                      const pctComplete = item.actual_spent > 0 ? Math.min((item.actual_spent / item.amount) * 0.6, 0.95) : 0;
                      const eac = pctComplete > 0 ? item.actual_spent / pctComplete : item.amount;
                      return (
                        <tr key={item.id} className="hover:bg-elevated">
                          <td className="py-2.5 pl-5 pr-3 font-sans text-muted">{item.costCode}</td>
                          <td className="py-2.5 pr-4 text-muted line-clamp-1">{item.item_name}</td>
                          <td className="py-2.5 px-3 text-right font-sans text-muted">{fmt(item.amount)}</td>
                          <td className="py-2.5 px-3 text-right font-sans text-muted">{fmt(item.actual_spent)}</td>
                          <td className={`py-2.5 px-3 text-right font-sans font-bold ${varColor(vPct)}`}>
                            {vAmt >= 0 ? "+" : ""}{fmt(vAmt)}
                          </td>
                          <td className={`py-2.5 pr-5 text-right font-sans text-[10px] ${eac > item.amount ? "text-danger" : "text-muted"}`}>
                            {fmt(Math.round(eac))}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="px-5 py-2 border-t border-border-custom text-[9px] text-muted">* EAC = Estimate at Completion (extrapolated from actual spend). Assumes proportional burn rate.</div>
              </div>
            </>
          )}
        </div>
      )}

          {/* ── REVISIONS TAB ── */}
          {tab === "revisions" && (
            <div className="h-full overflow-y-auto p-5 space-y-4">
              {/* Record revision form */}
              <div className="bg-input border border-border-custom rounded-md p-5 space-y-3">
                <div className="text-xs font-bold text-foreground">Record Budget Revision</div>
                <div className="text-[10px] text-muted">Capture a revised budget against a BOQ document. The revision number and previous amount are tracked automatically.</div>
                <form onSubmit={handleRecordRevision} className="space-y-2">
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="flex-1 min-w-[200px]">
                      <label className="text-[10px] text-muted">BOQ Document</label>
                      <select value={selectedDocId} onChange={e => setSelectedDocId(e.target.value)}
                        className="w-full bg-elevated border border-border-custom rounded-lg px-3 py-1.5 text-xs text-foreground" disabled={documents.length === 0}>
                        {documents.length === 0 && <option value="">No BOQ documents</option>}
                        {documents.map(d => <option key={d.id} value={d.id}>{d.title || d.id}</option>)}
                      </select>
                    </div>
                    <div className="w-44">
                      <label className="text-[10px] text-muted">Revised Amount (₹)</label>
                      <input type="number" min="0" step="0.01" value={revAmount} onChange={e => setRevAmount(e.target.value)} placeholder="0.00"
                        className="w-full bg-elevated border border-border-custom rounded-lg px-3 py-1.5 text-xs text-foreground" />
                    </div>
                  </div>
                  <input value={revReason} onChange={e => setRevReason(e.target.value)} placeholder="Reason (optional)"
                    className="w-full bg-elevated border border-border-custom rounded-lg px-3 py-1.5 text-xs text-foreground" />
                  <div className="flex items-center gap-2">
                    <button type="submit" disabled={!selectedDocId || savingRev}
                      className="px-4 py-2 bg-primary text-white text-xs font-bold rounded-lg disabled:opacity-40 hover:opacity-90">
                      {savingRev ? "Saving..." : "Record Revision"}
                    </button>
                    {revMsg && <span className="text-[10px] text-success">{revMsg}</span>}
                  </div>
                </form>
              </div>

              {/* History */}
              <div className="grid gap-3">
                {revisionLoading && <div className="text-[10px] text-muted">Loading revisions...</div>}
                {!revisionLoading && revisions.length === 0 && (
                  <EmptyState
                    title="No revisions recorded yet"
                    description="BOQ revisions and budget amendment logs will appear here once new baselines are saved."
                  />
                )}
                {revisions.map((rev, idx) => (
                  <div key={rev.id} className={`bg-input border rounded-md p-5 ${idx === 0 ? "border-border-custom ring-1 ring-primary/10" : "border-border-custom"}`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-3">
                        <span className={`text-[9px] font-bold px-2 py-0.5 rounded border ${idx === 0 ? "bg-primary/10 border-primary/20 text-primary" : "bg-elevated border-border-custom text-muted"}`}>
                          {idx === 0 ? "LATEST" : `REV ${rev.revision_no}`}
                        </span>
                        <span className="text-sm font-bold text-foreground">Revision {rev.revision_no}</span>
                      </div>
                      <span className="text-[10px] text-muted">{formatDate(rev.created_at, "")}</span>
                    </div>
                    <div className="text-xs text-muted">{rev.reason || "—"}</div>
                    <div className="mt-2 flex items-center justify-between">
                      <div className="text-lg font-black text-primary">{fmt(rev.revised_amount)}</div>
                      <div className="text-[10px] text-muted text-right">
                        {rev.previous_amount != null && (
                          <div>Prev: {fmt(rev.previous_amount)} · Δ {rev.delta != null ? (rev.delta >= 0 ? "+" : "") + fmt(rev.delta) : "—"}</div>
                        )}
                        {rev.revised_by_name ? <div>By {rev.revised_by_name}</div> : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Import trigger for BOQ */}
              <div className="bg-input border border-dashed border-border-custom rounded-md p-5 text-center space-y-2">
                <div className="text-xs font-bold text-muted">Import New BOQ / Revised Budget</div>
                <div className="text-[10px] text-muted">Upload an Excel (.xlsx) with columns: item_name, unit, qty, rate, cost_code</div>
                {importMsg && <div className="text-xs text-success">{importMsg}</div>}
                <form onSubmit={handleImport} className="flex justify-center gap-2">
                  <label className="px-4 py-2 bg-elevated border border-border-custom text-muted text-xs rounded-lg cursor-pointer hover:bg-elevated/70">
                    {fileState ? fileState.name : "Select Excel File"}
                    <input type="file" accept=".xlsx,.xlsm" className="hidden" onChange={e => { if (e.target.files?.[0]) setFile(e.target.files[0]); }} />
                  </label>
                  <button type="submit" disabled={!fileState || importing}
                    className="px-4 py-2 bg-primary text-white text-xs font-bold rounded-lg disabled:opacity-40 hover:opacity-90">
                    {importing ? "Importing..." : "Import & Commit"}
                  </button>
                </form>
              </div>
            </div>
          )}
        </div>
        </PageShell>
      </div>
    </div>
  );
}