"use client";
import { readErrorDetail, detailToMessage} from "@/lib/api";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { getApi, authHeaders, downloadWithAuth, fmtINR } from "@/lib/siteflow";
import { useCompanySettings } from "@/context/CompanySettingsContext";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import Icon from "@/components/marketing/Icon";
import FieldHint from "@/components/ui/FieldHint";

// ─── Types ────────────────────────────────────────────────────────────────────
type BOQDocument = {
  id: string;
  project_id: string;
  client_party_id: string | null;
  client_name: string | null;
  title: string;
  milestone_done: number;
  milestone_total: number;
  boq_value: number;
  billed_value: number;
  physical_progress: number; // 0-100
  item_count: number;
};

type BOQItemLine = {
  id: string;
  section_name: string | null;
  item_name: string;
  unit: string;
  quantity: number;
  rate: number;
  supply_rate: number;
  installation_rate: number;
  amount: number;
};

type Party = { id: string; name: string; party_type: string | null };

// Response body of POST /budgeting/boq/import (R2-450 contract).
type BOQImportResult = {
  success: boolean;
  imported_count: number;
  skipped_count: number;
  warnings: string[];
  total_estimated_cost: number;
};

const UNCAT = "Uncategorized";

export default function BoqTab() {
  const { currencyDecimalPlaces } = useCompanySettings();
  const params = useParams();
  const companyId = params.company_id as string;
  const projectId = params.project_id as string;

  const [docs, setDocs] = useState<BOQDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Add BOQ modal
  const [showAdd, setShowAdd] = useState(false);
  const [title, setTitle] = useState("");
  const [clientId, setClientId] = useState<string | null>(null);
  const [clientSearch, setClientSearch] = useState("");
  const [milestoneDone, setMilestoneDone] = useState(0);
  const [milestoneTotal, setMilestoneTotal] = useState(0);
  const [terms, setTerms] = useState("");
  const [boqDefaultTerms, setBoqDefaultTerms] = useState("");
  const [savingDoc, setSavingDoc] = useState(false);

  // Inline add party
  const [showParty, setShowParty] = useState(false);
  const [partyName, setPartyName] = useState("");
  const [savingParty, setSavingParty] = useState(false);

  // Clients master
  const [clients, setClients] = useState<Party[]>([]);

  // Expanded doc items
  const [docItems, setDocItems] = useState<BOQItemLine[]>([]);
  const [docItemsLoading, setDocItemsLoading] = useState(false);
  const [docFile, setDocFile] = useState<File | null>(null);
  const [docImporting, setDocImporting] = useState(false);
  const [importNotice, setImportNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  // Inline manual entry — D5 (R2-030): POST /boq-documents/{doc_id}/items reuses import's BOQItemCreate + R2-334 cost-code gate
  const [showInlineRow, setShowInlineRow] = useState(false);
  const [inlineDraft, setInlineDraft] = useState({ item_name: "", unit: "Nos", quantity: "", rate: "", supply_rate: "", installation_rate: "", section_name: "", cost_code: "" });
  const [inlineSaving, setInlineSaving] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const loadDocs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(getApi(`/budgeting/boq-documents?project_id=${projectId}`), {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to load BOQ documents");
      setDocs(await res.json());
    } catch (e) {
      setError("Failed to load BOQ documents.");
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const loadClients = useCallback(async () => {
    try {
      const res = await fetch(getApi(`/library/parties/${companyId}`), { headers: authHeaders() });
      if (res.ok) {
        const all: Party[] = await res.json();
        setClients(all.filter((p) => (p.party_type || "").toLowerCase() === "client"));
      }
    } catch (e) {
      console.error(e);
    }
  }, [companyId]);

  useEffect(() => {
    loadDocs();
    loadClients();
  }, [loadDocs, loadClients]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(getApi(`/settings/company-terms/${companyId}`), { headers: authHeaders() || {} });
        if (r.ok) {
          const d = await r.json();
          setBoqDefaultTerms(d.boq_terms || "");
        }
      } catch {
        /* ignore: terms are optional */
      }
    })();
  }, [companyId]);

  useEffect(() => {
    if (showAdd && !terms) setTerms(boqDefaultTerms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAdd]);

  const filteredDocs = useMemo(() => {
    if (!search.trim()) return docs;
    const q = search.toLowerCase();
    return docs.filter(
      (d) =>
        (d.client_name || "").toLowerCase().includes(q) ||
        d.title.toLowerCase().includes(q)
    );
  }, [docs, search]);

  // Mirrors the server's _effective_unit_rate: composite rate wins; the
  // supply + installation split only fills in when no composite rate exists.
  const effectiveUnitRate = (i: BOQItemLine) => {
    const r = Number(i.rate) || 0;
    return r || (Number(i.supply_rate) || 0) + (Number(i.installation_rate) || 0);
  };

  const amountOf = (i: BOQItemLine) => Number(i.quantity) * effectiveUnitRate(i);

  const loadDocItems = useCallback(
    async (docId: string) => {
      setDocItemsLoading(true);
      try {
        const res = await fetch(
          getApi(`/budgeting/boq?project_id=${projectId}&boq_document_id=${docId}`),
          { headers: authHeaders() }
        );
        if (res.ok) setDocItems(await res.json());
      } catch (e) {
        console.error(e);
      } finally {
        setDocItemsLoading(false);
      }
    },
    [projectId]
  );

  const toggleExpand = (docId: string) => {
    if (expandedId === docId) {
      setExpandedId(null);
      setDocItems([]);
      setImportNotice(null);
      setShowInlineRow(false);
      setInlineError(null);
    } else {
      setExpandedId(docId);
      setDocFile(null);
      setImportNotice(null);
      setShowInlineRow(false);
      setInlineError(null);
      loadDocItems(docId);
    }
  };

  // Inline row validation mirrors BOQItemCreate (item_name min 1, quantity/rate ge 0) — same gate as import path (budgeting.py:405)
  const validateInlineDraft = (): string | null => {
    if (!inlineDraft.item_name.trim()) return "Item name is required";
    if (inlineDraft.quantity === "" || isNaN(Number(inlineDraft.quantity))) return "Quantity must be numeric";
    if (Number(inlineDraft.quantity) < 0) return "Quantity cannot be negative";
    if (inlineDraft.rate !== "" && (isNaN(Number(inlineDraft.rate)) || Number(inlineDraft.rate) < 0)) return "Rate cannot be negative";
    if (inlineDraft.supply_rate !== "" && (isNaN(Number(inlineDraft.supply_rate)) || Number(inlineDraft.supply_rate) < 0)) return "Supply rate cannot be negative";
    if (inlineDraft.installation_rate !== "" && (isNaN(Number(inlineDraft.installation_rate)) || Number(inlineDraft.installation_rate) < 0)) return "Installation rate cannot be negative";
    return null;
  };

  const resetInlineDraft = () => setInlineDraft({ item_name: "", unit: "Nos", quantity: "", rate: "", supply_rate: "", installation_rate: "", section_name: "", cost_code: "" });

  const addInlineItem = async (docId: string) => {
    const validationError = validateInlineDraft();
    if (validationError) { setInlineError(validationError); return; }
    setInlineSaving(true);
    setInlineError(null);
    try {
      const payload = {
        item_name: inlineDraft.item_name.trim(),
        unit: inlineDraft.unit.trim() || "Nos",
        quantity: inlineDraft.quantity === "" ? 0 : Number(inlineDraft.quantity),
        rate: inlineDraft.rate === "" ? 0 : Number(inlineDraft.rate),
        supply_rate: inlineDraft.supply_rate === "" ? 0 : Number(inlineDraft.supply_rate),
        installation_rate: inlineDraft.installation_rate === "" ? 0 : Number(inlineDraft.installation_rate),
        section_name: inlineDraft.section_name.trim() || null,
        cost_code: inlineDraft.cost_code.trim() || null,
      };
      const res = await fetch(getApi(`/budgeting/boq-documents/${docId}/items`), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify(payload),
      });
      let data: any = null;
      try { data = await res.json(); } catch { /* ignore */ }
      if (!res.ok) {
        const detail = data && typeof data.detail === "string" ? data.detail : Array.isArray(data?.detail) ? data.detail.map((d: any) => d.msg || JSON.stringify(d)).join("; ") : `Request failed (${res.status})`;
        setInlineError(detail);
        return;
      }
      resetInlineDraft();
      setShowInlineRow(false);
      await loadDocItems(docId);
      await loadDocs();
    } catch (e) {
      setInlineError(e instanceof Error ? e.message : "Backend not reachable. The BOQ was not modified.");
    } finally {
      setInlineSaving(false);
    }
  };

  const createParty = async () => {
    if (!partyName.trim()) return;
    setSavingParty(true);
    try {
      const res = await fetch(getApi("/library/parties"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id: companyId,
          name: partyName.trim(),
          party_type: "Client",
          project_id: projectId,
        }),
      });
      if (res.ok) {
        const p: Party = await res.json();
        await loadClients();
        setClientId(p.id);
        setPartyName("");
        setShowParty(false);
      } else {
        const err = await readErrorDetail(res);
        setError(err || 'Action failed');
      }
    } finally {
      setSavingParty(false);
    }
  };

  const createDoc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSavingDoc(true);
    try {
      const res = await fetch(getApi("/budgeting/boq-documents"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          project_id: projectId,
          title: title.trim(),
          client_party_id: clientId,
          milestone_done: milestoneDone,
          milestone_total: milestoneTotal,
          terms: terms || null,
        }),
      });
      if (res.ok) {
        setTitle("");
        setClientId(null);
        setClientSearch("");
        setMilestoneDone(0);
        setMilestoneTotal(0);
        setTerms("");
        setShowAdd(false);
        await loadDocs();
      } else {
        const err = await readErrorDetail(res);
        setError(err || 'Action failed');
      }
    } finally {
      setSavingDoc(false);
    }
  };

  const updateMilestone = async (doc: BOQDocument, done: number, total: number) => {
    try {
      const res = await fetch(getApi(`/budgeting/boq-documents/${doc.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ milestone_done: done, milestone_total: total }),
      });
      if (res.ok) {
        await loadDocs();
      } else {
        const err = await readErrorDetail(res);
        setError(err || "Failed to update milestone");
      }
    } catch (e) {
      console.error(e);
      setError("Network error updating milestone");
    }
  };

  const importIntoDoc = async (docId: string) => {
    if (!docFile) return;
    setDocImporting(true);
    setImportNotice(null);
    const formData = new FormData();
    formData.append("project_id", projectId);
    formData.append("boq_document_id", docId);
    formData.append("file", docFile);
    try {
      const res = await fetch(getApi("/budgeting/boq/import"), { method: "POST", body: formData, headers: authHeaders() });
      if (res.ok) {
        // R2-450: the importer skips malformed rows instead of failing; show
        // how many landed and why others were skipped.
        const d: BOQImportResult = await res.json();
        const imported = Number(d.imported_count) || 0;
        const skipped = Number(d.skipped_count) || 0;
        const warnings = Array.isArray(d.warnings) ? d.warnings : [];
        setImportNotice(
          skipped > 0
            ? { tone: "warn", text: `Imported ${imported} item(s), skipped ${skipped}. ${warnings.join("; ")}`.trim() }
            : { tone: "ok", text: `Imported ${imported} item(s).` }
        );
      } else {
        const err = await res.json().catch(() => ({}));
        setImportNotice({ tone: "warn", text: detailToMessage(err.detail, "BOQ import failed. Please check the file format.") });
      }
      setDocFile(null);
      await loadDocItems(docId);
      await loadDocs();
    } catch (e: any) {
      setImportNotice({ tone: "warn", text: e?.message || "Network error during BOQ import" });
    } finally {
      setDocImporting(false);
    }
  };

  const filteredClients = useMemo(() => {
    if (!clientSearch.trim()) return clients;
    const q = clientSearch.toLowerCase();
    return clients.filter((c) => c.name.toLowerCase().includes(q));
  }, [clients, clientSearch]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <PageHeader
        title="BOQ Documents"
        subtitle={
          <span>
            {docs.length} BOQ document(s) · Total BOQ Value{" "}
            <span className="text-primary font-semibold">
              {fmtINR(docs.reduce((s, d) => s + d.boq_value, 0), currencyDecimalPlaces)}
            </span>
          </span>
        }
      >
        <button
          onClick={() => {
            setShowAdd(true);
            loadClients();
          }}
          className="px-3.5 py-1.5 bg-primary text-white text-xs font-bold rounded-lg hover:opacity-90 transition-all cursor-pointer"
        >
          + BOQ
        </button>
      </PageHeader>

      {/* Search */}
      <div className="px-5 py-3 border-b border-border-custom shrink-0">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search client or BOQ title..."
          className="flex-1 bg-input border border-border-custom rounded-lg px-3 py-1.5 text-xs text-foreground placeholder-muted w-full"
        />
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        <PageShell width="wide">
          {loading ? (
            <TableSkeleton rows={5} cols={8} />
          ) : error ? (
            <div className="p-10 text-center text-danger text-xs">{error}</div>
          ) : filteredDocs.length === 0 ? (
            <EmptyState
              title="No BOQ documents yet"
              description="Click '+ BOQ' to create one per client."
              action={{ label: "+ BOQ", onClick: () => { setShowAdd(true); loadClients(); } }}
            />
          ) : (
          <table className="w-full text-xs text-left border-collapse">
            <thead className="sticky top-0 z-10 bg-background">
              <tr className="border-b border-border-custom text-muted font-bold uppercase tracking-wider text-[9px]">
                <th className="py-3 pl-5 pr-2">S.No</th>
                <th className="py-3 px-2">Client Name</th>
                <th className="py-3 px-2">BOQ Title</th>
                <th className="py-3 px-2 text-center">Milestone</th>
                <th className="py-3 px-2 text-right">Physical Progress</th>
                <th className="py-3 px-2 text-right">BOQ Value</th>
                <th className="py-3 px-2 text-right">Billed Value</th>
                <th className="py-3 pr-5"></th>
              </tr>
            </thead>
            <tbody>
              {filteredDocs.map((d, idx) => {
                const open = expandedId === d.id;
                const pct = Math.max(0, Math.min(100, d.physical_progress));
                const milestonePct =
                  d.milestone_total > 0 ? (d.milestone_done / d.milestone_total) * 100 : 0;
                return (
                  <React.Fragment key={d.id}>
                    <tr
                      className="border-b border-border-custom hover:bg-elevated transition-colors cursor-pointer"
                      onClick={() => toggleExpand(d.id)}
                    >
                      <td className="py-3 pl-5 pr-2 font-sans text-muted">{idx + 1}</td>
                      <td className="py-3 px-2 text-foreground font-medium">
                        {d.client_name || <span className="text-muted">—</span>}
                      </td>
                      <td className="py-3 px-2 text-muted">{d.title}</td>
                      <td className="py-3 px-2 text-center">
                        <span className="font-sans text-muted">
                          {d.milestone_done}/{d.milestone_total}
                        </span>
                        <div className="mt-1 h-1 w-16 bg-elevated rounded-full overflow-hidden mx-auto">
                          <div
                            className="h-full bg-warning rounded-full"
                            style={{ width: `${milestonePct}%` }}
                          />
                        </div>
                      </td>
                      <td className="py-3 px-2 text-right">
                        <span className="font-sans text-muted font-semibold">
                          {pct.toFixed(1)}%
                        </span>
                        <div className="mt-1 h-1 w-20 bg-elevated rounded-full overflow-hidden ml-auto">
                          <div
                            className={`h-full rounded-full ${
                              pct >= 100 ? "bg-success" : pct > 0 ? "bg-info" : "bg-elevated"
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </td>
                      <td className="py-3 px-2 text-right font-sans text-muted">
                        {fmtINR(d.boq_value, currencyDecimalPlaces)}
                      </td>
                      <td className="py-3 px-2 text-right font-sans font-semibold text-success">
                        {fmtINR(d.billed_value, currencyDecimalPlaces)}
                      </td>
                      <td className="py-3 pr-5 text-center text-muted">
                        {open ? "▾" : "▸"}
                      </td>
                    </tr>

                    {open && (
                      <tr className="border-b border-border-custom bg-elevated">
                        <td colSpan={8} className="px-5 py-4">
                          {/* Milestone editor */}
                          <div className="flex items-center gap-3 mb-4 text-[10px] text-muted">
                            <span>Milestone:</span>
                            <input
                              type="number"
                              min={0}
                              value={d.milestone_done}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) =>
                                updateMilestone(d, Math.max(0, Number(e.target.value) || 0), d.milestone_total)
                              }
                              className="w-14 bg-input border border-border-custom rounded px-2 py-1 text-foreground"
                            />
                            <span>/</span>
                            <input
                              type="number"
                              min={0}
                              value={d.milestone_total}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) =>
                                updateMilestone(d, d.milestone_done, Math.max(0, Number(e.target.value) || 0))
                              }
                              className="w-14 bg-input border border-border-custom rounded px-2 py-1 text-foreground"
                            />
                            <span>· {d.item_count} line item(s)</span>
                          </div>

                          {/* Import into this BOQ */}
                          <div
                            className="flex items-center gap-2 mb-3"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <label className="px-3 py-1.5 bg-elevated border border-border-custom text-muted text-xs rounded-lg cursor-pointer hover:bg-elevated">
                              {docFile ? docFile.name : "Import Excel items into this BOQ"}
                              <input
                                type="file"
                                accept=".xlsx,.xlsm"
                                className="hidden"
                                onChange={(e) => {
                                  if (e.target.files?.[0]) setDocFile(e.target.files[0]);
                                }}
                              />
                            </label>
                            {docFile && (
                              <button
                                onClick={() => importIntoDoc(d.id)}
                                disabled={docImporting}
                                className="px-3 py-1.5 bg-primary text-white text-xs font-bold rounded-lg disabled:opacity-40"
                              >
                                {docImporting ? "Importing..." : "Import & Add"}
                              </button>
                            )}
                            {importNotice && (
                              <span
                                className={`text-[10px] ${
                                  importNotice.tone === "warn" ? "text-warning" : "text-success"
                                }`}
                              >
                                {importNotice.text}
                              </span>
                            )}
                          </div>

                          {/* Inline manual entry — D5 (R2-030): typed row POSTs to /boq-documents/{doc_id}/items reusing import validation */}
                          <div className="flex items-center gap-2 mb-3" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={() => { setShowInlineRow((v) => !v); setInlineError(null); }}
                              className="px-3 py-1.5 bg-primary/10 border border-primary/20 text-primary text-xs font-bold rounded-lg hover:bg-primary/20"
                            >
                              {showInlineRow ? "Cancel" : "+ Add Item"}
                            </button>
                            {inlineError && <span className="text-[10px] text-danger">{inlineError}</span>}
                          </div>
                          {showInlineRow && (
                            <div className="mb-4 p-3 bg-card border border-border-custom rounded-lg space-y-2" onClick={(e) => e.stopPropagation()}>
                              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2">
                                <input value={inlineDraft.section_name} onChange={(e) => setInlineDraft({ ...inlineDraft, section_name: e.target.value })} placeholder="Section" className="bg-input border border-border-custom rounded-lg px-2 py-1.5 text-xs text-foreground placeholder-muted" />
                                <input value={inlineDraft.item_name} onChange={(e) => setInlineDraft({ ...inlineDraft, item_name: e.target.value })} placeholder="Item name *" className="bg-input border border-border-custom rounded-lg px-2 py-1.5 text-xs text-foreground placeholder-muted" />
                                <input value={inlineDraft.cost_code} onChange={(e) => setInlineDraft({ ...inlineDraft, cost_code: e.target.value })} placeholder="Cost code" className="bg-input border border-border-custom rounded-lg px-2 py-1.5 text-xs text-foreground placeholder-muted" />
                                <input value={inlineDraft.unit} onChange={(e) => setInlineDraft({ ...inlineDraft, unit: e.target.value })} placeholder="Unit (Nos)" className="bg-input border border-border-custom rounded-lg px-2 py-1.5 text-xs text-foreground placeholder-muted" />
                                <input type="number" min="0" step="any" value={inlineDraft.quantity} onChange={(e) => setInlineDraft({ ...inlineDraft, quantity: e.target.value })} placeholder="Qty *" className="bg-input border border-border-custom rounded-lg px-2 py-1.5 text-xs text-foreground placeholder-muted" />
                                <input type="number" min="0" step="any" value={inlineDraft.rate} onChange={(e) => setInlineDraft({ ...inlineDraft, rate: e.target.value })} placeholder="Rate" className="bg-input border border-border-custom rounded-lg px-2 py-1.5 text-xs text-foreground placeholder-muted" />
                                <input type="number" min="0" step="any" value={inlineDraft.supply_rate} onChange={(e) => setInlineDraft({ ...inlineDraft, supply_rate: e.target.value })} placeholder="Supply rate" className="bg-input border border-border-custom rounded-lg px-2 py-1.5 text-xs text-foreground placeholder-muted" />
                                <input type="number" min="0" step="any" value={inlineDraft.installation_rate} onChange={(e) => setInlineDraft({ ...inlineDraft, installation_rate: e.target.value })} placeholder="Install rate" className="bg-input border border-border-custom rounded-lg px-2 py-1.5 text-xs text-foreground placeholder-muted" />
                              </div>
                              <div className="flex items-center gap-2">
                                <button type="button" onClick={() => addInlineItem(d.id)} disabled={inlineSaving} className="px-3 py-1.5 bg-primary text-white text-xs font-bold rounded-lg disabled:opacity-40">
                                  {inlineSaving ? "Saving..." : "Save"}
                                </button>
                                <button type="button" onClick={() => { setShowInlineRow(false); setInlineError(null); resetInlineDraft(); }} className="px-3 py-1.5 bg-elevated border border-border-custom text-muted text-xs rounded-lg">
                                  Cancel
                                </button>
                                <span className="text-[10px] text-muted">Upload your BOQ spreadsheet (.xlsx or .xlsm) using the form below.</span>
                              </div>
                            </div>
                          )}

                          <div className="mb-3" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await downloadWithAuth(`/budgeting/boq-documents/${d.id}/pdf`);
                                } catch (e) {
                                  alert(`Download failed (${e instanceof Error ? e.message : "unknown error"}).`);
                                }
                              }}
                              className="inline-block px-3 py-1.5 bg-elevated border border-border-custom text-muted text-xs rounded-lg hover:bg-elevated"
                            >
                              Download PDF
                            </button>
                          </div>

                          {/* Line items */}
                          {docItemsLoading ? (
                            <div className="text-[10px] text-muted">Loading items…</div>
                          ) : docItems.length === 0 ? (
                            <div className="text-[10px] text-muted">
                              No line items yet: import an Excel with item_name, unit, qty, rate.
                            </div>
                          ) : (
                            <table className="w-full text-[11px] text-left border-collapse">
                              <thead>
                                <tr className="text-muted uppercase tracking-wider text-[9px] border-b border-border-custom">
                                  <th className="py-2 pl-1 pr-2">Item</th>
                                  <th className="py-2 px-2 text-center">Unit</th>
                                  <th className="py-2 px-2 text-right">Qty</th>
                                  <th className="py-2 px-2 text-right">Rate</th>
                                  <th className="py-2 px-2 text-right">Supply</th>
                                  <th className="py-2 px-2 text-right">Install</th>
                                  <th className="py-2 px-2 text-right">Amount</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-white/[0.03]">
                                {docItems.map((i) => (
                                  <tr key={i.id}>
                                    <td className="py-1.5 pl-1 pr-2 text-foreground">
                                      {i.item_name}
                                      {i.section_name && (
                                        <span className="text-muted ml-1">· {i.section_name}</span>
                                      )}
                                    </td>
                                    <td className="py-1.5 px-2 text-center text-muted">{i.unit}</td>
                                    <td className="py-1.5 px-2 text-right font-sans text-muted">
                                      {Number(i.quantity).toLocaleString("en-IN", { maximumFractionDigits: 4 })}
                                    </td>
                                    <td className="py-1.5 px-2 text-right font-sans text-muted">
                                      {fmtINR(i.rate, currencyDecimalPlaces)}
                                    </td>
                                    <td className="py-1.5 px-2 text-right font-sans text-muted">
                                      {fmtINR(i.supply_rate, currencyDecimalPlaces)}
                                    </td>
                                    <td className="py-1.5 px-2 text-right font-sans text-muted">
                                      {fmtINR(i.installation_rate, currencyDecimalPlaces)}
                                    </td>
                                    <td className="py-1.5 px-2 text-right font-sans font-semibold text-muted">
                                      {fmtINR(amountOf(i), currencyDecimalPlaces)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                              <tfoot>
                                <tr className="border-t border-border-custom">
                                  <td colSpan={6} className="py-2 pl-1 font-bold text-foreground">
                                    Subtotal
                                  </td>
                                  <td className="py-2 px-2 text-right font-bold text-foreground font-sans">
                                    {fmtINR(docItems.reduce((s, i) => s + amountOf(i), 0), currencyDecimalPlaces)}
                                  </td>
                                </tr>
                              </tfoot>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          )}
        </PageShell>
      </div>

      {/* Add BOQ modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg border border-border-custom bg-card p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-foreground">New BOQ Document</h3>
              <button onClick={() => setShowAdd(false)} className="text-muted hover:text-foreground cursor-pointer">
                <Icon name="close" className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={createDoc} className="space-y-4">
              <div>
                <label className="text-xs font-medium text-muted">BOQ Subject (Title)</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. BOQ for Tower A - Finishes"
                  className="mt-1 w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground placeholder-muted"
                  required
                />
              </div>

              <div>
                <label className="text-xs font-medium text-muted">Client Name</label>
                {!showParty ? (
                  <div className="mt-1 space-y-2">
                    <input
                      value={clientSearch}
                      onChange={(e) => setClientSearch(e.target.value)}
                      placeholder="Search clients..."
                      className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground placeholder-muted"
                    />
                    <select
                      value={clientId || ""}
                      onChange={(e) => setClientId(e.target.value || null)}
                      className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground"
                    >
                      <option value="">Select client</option>
                      {filteredClients.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    {filteredClients.length === 0 && (
                      <FieldHint text="No clients registered yet." onAction={() => setShowParty(true)} actionLabel="Add a party" />
                    )}
                    <button
                      type="button"
                      onClick={() => setShowParty(true)}
                      className="text-[11px] text-primary hover:underline"
                    >
                      + Add Party
                    </button>
                  </div>
                ) : (
                  <div className="mt-1 flex gap-2">
                    <input
                      value={partyName}
                      onChange={(e) => setPartyName(e.target.value)}
                      placeholder="New client name"
                      className="flex-1 bg-input border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground placeholder-muted"
                    />
                    <button
                      type="button"
                      onClick={createParty}
                      disabled={savingParty || !partyName.trim()}
                      className="px-3 py-2 bg-primary text-white text-xs font-bold rounded-lg disabled:opacity-40"
                    >
                      {savingParty ? "..." : "Add"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowParty(false)}
                      className="px-3 py-2 bg-elevated text-muted text-xs rounded-lg"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>

              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="text-xs font-medium text-muted">Milestone Done</label>
                  <input
                    type="number"
                    min={0}
                    value={milestoneDone}
                    onChange={(e) => setMilestoneDone(Math.max(0, Number(e.target.value) || 0))}
                    className="mt-1 w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground"
                  />
                </div>
                <div className="flex-1">
                  <label className="text-xs font-medium text-muted">Milestone Total</label>
                  <input
                    type="number"
                    min={0}
                    value={milestoneTotal}
                    onChange={(e) => setMilestoneTotal(Math.max(0, Number(e.target.value) || 0))}
                    className="mt-1 w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-medium text-muted">Terms &amp; Conditions</label>
                <textarea
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                  placeholder="Pre-filled from company BOQ Terms; edit as needed"
                  rows={3}
                  className="mt-1 w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground placeholder-muted"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAdd(false)}
                  className="px-4 py-2 bg-elevated text-muted text-sm rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingDoc || !title.trim()}
                  className="px-4 py-2 bg-primary text-white text-sm font-bold rounded-lg disabled:opacity-40"
                >
                  {savingDoc ? "Creating..." : "Create BOQ"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}