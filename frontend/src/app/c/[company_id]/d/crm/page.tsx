"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import UnitInput from "@/components/UnitInput";
import { useParams } from "next/navigation";
import Link from "next/link";
import { getApi, authHeaders, resolveCompanyId, fmtINR, formatDate, formatLabel, toLocalISODate, todayLocalISO } from "@/lib/siteflow";
import { readErrorDetail } from "@/lib/api";
import { useCompanySettings } from "@/context/CompanySettingsContext";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import SegmentedTabs from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableSkeleton } from "@/components/ui/Skeleton";
import Icon from "@/components/marketing/Icon";
import Badge from "@/components/ui/Badge";
import FieldHint from "@/components/ui/FieldHint";

// ─── Types ────────────────────────────────────────────────────────────────────

type Project = { id: string; name: string; state?: string | null };

type Lead = {
  id: string;
  company_id: string;
  assignee_id: string | null;
  lead_date: string;
  lead_type: string;
  contact_name: string;
  phone_no: string;
  country_code: string | null;
  email: string | null;
  client_company_name: string | null;
  address: string | null;
  source: string | null;
  category: string | null;
  status: string;
  priority: string;
  budget: number;
  lead_name: string | null;
  description: string | null;
  last_contacted: string | null;
  next_follow_up: string | null;
  expected_closure: string | null;
  created_at: string;
  updated_at: string;
};

type TeamMember = { id: string; name: string };
type Lookup = { id: string; company_id: string; name: string };
type BankAccount = {
  id: string;
  company_id: string;
  account_holder_name: string;
  bank_name: string;
  account_number: string;
  ifsc_code: string;
  upi_id: string | null;
  balance: number;
};
type QItem = {
  id?: string;
  section_name: string;
  item_name: string;
  qty: number;
  unit: string;
  cost_price: number;
  selling_price: number;
  supply_rate: number;
  installation_rate: number;
  supply_tax_pct: number;
  installation_tax_pct: number;
  markup: number;
  item_code: string;
  hsn_sac: string;
  cost_code: string;
  length: number | null;
  width: number | null;
  height: number | null;
  total_amount: number;
};
type Quotation = {
  id: string;
  lead_id: string;
  subject: string;
  tax_type: string;
  status: string;
  gst_pct: number;
  cgst_pct: number;
  sgst_pct: number;
  cgst_amount: number;
  sgst_amount: number;
  tax_amount: number;
  discount: number;
  additional_charges: number;
  round_off: number;
  qt_no: string | null;
  qt_date: string | null;
  bank_account_id: string | null;
  total_amount: number;
  terms: string | null;
  created_at: string;
  items: QItem[];
};

// ─── API helpers ──────────────────────────────────────────────────────────────

const jget = async (p: string) => {
  const r = await fetch(getApi(p), { headers: authHeaders() || undefined });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
};
const jpost = async (p: string, body: any) => {
  const r = await fetch(getApi(p), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
};
const jput = async (p: string, body: any) => {
  const r = await fetch(getApi(p), {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
};

// ─── Small UI primitives ──────────────────────────────────────────────────────

const inputCls =
  "w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary";
// Filter-bar variant: no w-full so the controls sit inline in a horizontal
// flex-wrap row instead of each stacking full-width on its own line.
const filterCls =
  "w-auto min-w-[140px] rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary";
const btnPrimary =
  "rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";
const btnGhost =
  "rounded-md border border-border-custom px-3 py-2 text-sm text-foreground hover:bg-elevated";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

function Drawer({
  title,
  onClose,
  children,
  width = "max-w-md",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className={`h-full w-full ${width} overflow-y-auto border-l border-border-custom bg-background p-5 shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-foreground">{title}</h3>
          <button className="text-muted hover:text-foreground cursor-pointer" onClick={onClose}>
            <Icon name="close" className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CreatableSelect({
  label,
  items,
  value,
  onPick,
  onCreate,
  placeholder,
}: {
  label: string;
  items: Lookup[];
  value: string | null;
  onPick: (id: string | null, name: string) => void;
  onCreate: (name: string) => Promise<void>;
  placeholder: string;
}) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  return (
    <Field label={label}>
      <div className="flex gap-2">
        <select
          className={inputCls}
          value={value ?? ""}
          onChange={(e) => {
            const id = e.target.value || null;
            const it = items.find((i) => i.id === id);
            onPick(id, it?.name ?? "");
          }}
        >
          <option value="">{placeholder}</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        <button type="button" className={btnGhost} onClick={() => setAdding((a) => !a)}>
          +
        </button>
      </div>
      {adding && (
        <div className="mt-2 flex gap-2">
          <input
            className={inputCls}
            placeholder="New option"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button
            type="button"
            className={btnPrimary}
            disabled={!newName.trim()}
            onClick={async () => {
              await onCreate(newName.trim());
              setNewName("");
              setAdding(false);
            }}
          >
            Add
          </button>
        </div>
      )}
    </Field>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const toDateInput = (s: string | null): string =>
  s ? toLocalISODate(s) : "";
const fromDateInput = (s: string): string | null =>
  s ? (s.includes("T") ? s : `${s}T00:00:00Z`) : null;
const fmtDate = (s: string | null): string => formatDate(s);
const todayISO = () => todayLocalISO();
// No follow-up is owed on a lead that is already decided.
const CLOSED_STATUSES = ["won", "lost", "converted", "irrelevant lead"];

const PRIORITY_OPTS = ["High", "Medium", "Low"];
const COUNTRY_CODES = ["+91", "+1", "+44", "+971", "+65", "+61"];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CRMPage() {
  const { currencyDecimalPlaces } = useCompanySettings();
  const params = useParams();
  const slug = params.company_id as string;
  const [companyId, setCompanyId] = useState("");

  const [tab, setTab] = useState<"leads" | "quotation">("leads");

  const [leads, setLeads] = useState<Lead[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [sources, setSources] = useState<Lookup[]>([]);
  const [categories, setCategories] = useState<Lookup[]>([]);
  const [statuses, setStatuses] = useState<Lookup[]>([]);
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);

  // quotation sub-tab
  const [selLeadId, setSelLeadId] = useState("");
  const [quots, setQuots] = useState<Quotation[]>([]);
  const [qLoading, setQLoading] = useState(false);
  const [qDrawer, setQDrawer] = useState(false);
  const [qDetail, setQDetail] = useState<Quotation | null>(null);
  const [qSaving, setQSaving] = useState(false);
  const [qError, setQError] = useState("");

  // Quotation to Invoice Conversion state
  const [convertModal, setConvertModal] = useState<{
    quotation: Quotation;
    projectId: string;
    partyId: string;
    invoiceNumber: string;
  } | null>(null);
  const [convertSaving, setConvertSaving] = useState(false);
  const [convertError, setConvertError] = useState("");
  const [convertSuccess, setConvertSuccess] = useState<{ invoice_number: string } | null>(null);

  const emptyQItem = {
    section_name: "",
    item_name: "",
    qty: 1,
    unit: "Nos",
    cost_price: 0,
    selling_price: 0,
    supply_rate: 0,
    installation_rate: 0,
    supply_tax_pct: 18,
    installation_tax_pct: 12,
    markup: 0,
    item_code: "",
    hsn_sac: "",
    cost_code: "",
    length: null,
    width: null,
    height: null,
    total_amount: 0,
  };
  const emptyQ = {
    subject: "",
    tax_type: "bill_level",
    gst_pct: 18,
    cgst_pct: 9,
    sgst_pct: 9,
    discount: 0,
    additional_charges: 0,
    round_off: 0,
    qt_no: "",
    qt_date: todayISO(),
    bank_account_id: "",
    terms: "",
    items: [{ ...emptyQItem }] as QItem[],
  };
  const [qForm, setQForm] = useState({ ...emptyQ });

  // filters
  const [search, setSearch] = useState("");
  const [fAssignee, setFAssignee] = useState("");
  const [fPriority, setFPriority] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [fSource, setFSource] = useState("");
  const [fCategory, setFCategory] = useState("");
  const [fDate, setFDate] = useState("");

  // drawer / form
  const [drawerOpen, setDrawerOpen] = useState(false);
  const emptyForm = {
    assignee_id: "" as string | null,
    lead_type: "",
    contact_name: "",
    country_code: "+91",
    phone_no: "",
    email: "",
    client_company_name: "",
    address: "",
    source_id: "" as string | null,
    source_name: "",
    category_id: "" as string | null,
    category_name: "",
    status_id: "" as string | null,
    status_name: "",
    priority: "Medium",
    budget: "",
    lead_name: "",
    description: "",
    last_contacted: "",
    next_follow_up: "",
    expected_closure: "",
  };
  const [form, setForm] = useState({ ...emptyForm });
  // Set while an existing lead is open in the drawer.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  // column visibility
  const ALL_COLS: { key: string; label: string; def: boolean }[] = [
    { key: "sno", label: "S.No", def: true },
    { key: "lead_type", label: "Lead Type", def: true },
    { key: "contact_name", label: "Contact Name", def: true },
    { key: "updated_at", label: "Last Updated", def: true },
    { key: "phone", label: "Contact Number", def: true },
    { key: "status", label: "Status", def: true },
    { key: "source", label: "Source", def: true },
    { key: "lead_name", label: "Lead Name", def: false },
    { key: "country_code", label: "Country Code", def: true },
    { key: "category", label: "Lead Category", def: true },
    { key: "assignee", label: "Lead Assignee", def: true },
    { key: "priority", label: "Priority", def: true },
    { key: "email", label: "Email", def: true },
    { key: "company", label: "Company Name", def: true },
    { key: "address", label: "Address", def: true },
    { key: "budget", label: "Budget", def: true },
    { key: "created_at", label: "Creation Date", def: true },
    { key: "next_follow_up", label: "Next Follow Up", def: true },
    { key: "expected_closure", label: "Expected Closure", def: true },
    { key: "last_contacted", label: "Last Contacted", def: true },
  ];
  const [visible, setVisible] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(ALL_COLS.map((c) => [c.key, c.def]))
  );
  const [showColMenu, setShowColMenu] = useState(false);

  useEffect(() => {
    resolveCompanyId(slug).then(setCompanyId);
  }, [slug]);

  const loadAll = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const [ld, tm, src, cat, sts, bk, prj] = await Promise.all([
        jget(`/crm/leads?company_id=${companyId}`).catch(() => []),
        jget(`/crm/team-members/${companyId}`).catch(() => []),
        jget(`/crm/lead-sources/${companyId}`).catch(() => []),
        jget(`/crm/lead-categories/${companyId}`).catch(() => []),
        jget(`/crm/lead-statuses/${companyId}`).catch(() => []),
        jget(`/finance/accounts/${companyId}`).catch(() => []),
        jget(`/planning/projects?company_id=${companyId}`).catch(() => []),
      ]);
      setLeads(ld);
      setTeam(tm);
      setSources(src);
      setCategories(cat);
      setStatuses(sts);
      setBanks(bk);
      setProjects(prj || []);
      if (ld.length && !selLeadId) setSelLeadId(ld[0].id);
    } finally {
      setLoading(false);
    }
  }, [companyId, selLeadId]);

  const openConvertModal = async (quotation: Quotation) => {
    const currentLead = leads.find((l) => l.id === quotation.lead_id || l.id === selLeadId);
    const defaultParty = currentLead?.assignee_id || (team.length > 0 ? team[0].id : "");
    const defaultProject = projects.length > 0 ? projects[0].id : "";
    let invoiceNum = quotation.qt_no ? `INV-${quotation.qt_no}` : `INV-${quotation.id.slice(0, 8)}`;

    try {
      const res = await fetch(getApi(`/billing/next-number/${companyId}?invoice_type=sale`), {
        headers: authHeaders() || undefined,
      });
      if (res.ok) {
        const data = await res.json();
        if (data.invoice_number) {
          invoiceNum = data.invoice_number;
        }
      }
    } catch {
      /* fallback */
    }

    setConvertModal({
      quotation,
      projectId: defaultProject,
      partyId: defaultParty,
      invoiceNumber: invoiceNum,
    });
    setConvertError("");
  };

  const handleConvertToInvoice = async () => {
    if (!convertModal) return;
    if (!convertModal.projectId) {
      setConvertError("Please select a target project.");
      return;
    }
    if (!convertModal.partyId) {
      setConvertError("Please select a billing party / customer team member.");
      return;
    }
    setConvertSaving(true);
    setConvertError("");
    try {
      const res = await fetch(getApi(`/crm/quotations/${convertModal.quotation.id}/convert-to-invoice`), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          project_id: convertModal.projectId,
          party_company_user_id: convertModal.partyId,
          invoice_number: convertModal.invoiceNumber || undefined,
        }),
      });
      if (!res.ok) {
        const err = await readErrorDetail(res);
        setConvertError(err || "Failed to convert quotation to invoice");
        return;
      }
      const data = await res.json();
      setConvertSuccess({ invoice_number: data.invoice_number });
      setConvertModal(null);
      if (qDetail && qDetail.id === convertModal.quotation.id) {
        setQDetail(prev => prev ? { ...prev, status: "converted" } : null);
      }
      loadQuots();
    } catch (e: any) {
      setConvertError(e?.message || "Failed to convert quotation to invoice");
    } finally {
      setConvertSaving(false);
    }
  };

  const loadQuots = useCallback(async () => {
    if (!selLeadId) {
      setQuots([]);
      return;
    }
    setQLoading(true);
    try {
      const data = await jget(`/crm/leads/${selLeadId}/quotations`).catch(() => []);
      setQuots(data);
    } finally {
      setQLoading(false);
    }
  }, [selLeadId]);

  useEffect(() => {
    if (tab === "quotation") loadQuots();
  }, [tab, loadQuots]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const nameById = (list: TeamMember[], id: string | null) =>
    list.find((t) => t.id === id)?.name ?? "—";

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return leads.filter((l) => {
      if (fAssignee && l.assignee_id !== fAssignee) return false;
      // R2-438: legacy rows store the same priority in different cases
      // ("Medium" vs "medium"); the filter must treat them as one value.
      if (fPriority && (l.priority || "").toLowerCase() !== fPriority.toLowerCase()) return false;
      if (fStatus && l.status !== fStatus) return false;
      if (fSource && l.source !== fSource) return false;
      if (fCategory && l.category !== fCategory) return false;
      if (fDate) {
        const d = (l.lead_date || "").slice(0, 10);
        if (d !== fDate) return false;
      }
      if (q) {
        const hay = `${l.contact_name} ${l.lead_name || ""} ${l.client_company_name || ""} ${l.phone_no} ${l.email || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [leads, search, fAssignee, fPriority, fStatus, fSource, fCategory, fDate]);

  const openNew = () => {
    setForm({ ...emptyForm });
    setEditingId(null);
    setFormError("");
    setDrawerOpen(true);
  };

  // Open a lead to move it along: status, next follow-up, notes.
  const openEdit = (l: Lead) => {
    const idOf = (list: Lookup[], name: string | null) => list.find((x) => x.name === name)?.id || "";
    setForm({
      ...emptyForm,
      assignee_id: l.assignee_id || "",
      lead_type: l.lead_type || "",
      contact_name: l.contact_name || "",
      country_code: l.country_code || "+91",
      phone_no: l.phone_no || "",
      email: l.email || "",
      client_company_name: l.client_company_name || "",
      address: l.address || "",
      source_id: idOf(sources, l.source),
      source_name: l.source || "",
      category_id: idOf(categories, l.category),
      category_name: l.category || "",
      status_id: idOf(statuses, l.status),
      status_name: l.status || "",
      priority: l.priority ? l.priority.charAt(0).toUpperCase() + l.priority.slice(1).toLowerCase() : "Medium",
      budget: l.budget ? String(l.budget) : "",
      lead_name: l.lead_name || "",
      description: l.description || "",
      last_contacted: toDateInput(l.last_contacted),
      next_follow_up: toDateInput(l.next_follow_up),
      expected_closure: toDateInput(l.expected_closure),
    });
    setEditingId(l.id);
    setFormError("");
    setDrawerOpen(true);
  };

  const removeLead = async () => {
    if (!editingId) return;
    if (!window.confirm(`Delete the lead for ${form.contact_name}? It is recorded in Delete Logs.`)) return;
    setSaving(true);
    try {
      const r = await fetch(getApi(`/crm/leads/${editingId}`), { method: "DELETE", headers: authHeaders() || {} });
      if (!r.ok) throw new Error((await r.text()) || "Could not delete the lead");
      setDrawerOpen(false);
      setEditingId(null);
      await loadAll();
    } catch (e: any) {
      setFormError(e.message || "Could not delete the lead");
    } finally {
      setSaving(false);
    }
  };

  const createLookup = async (kind: "source" | "category" | "status", name: string) => {
    if (!companyId) return;
    await jpost(`/crm/lead-${kind}s/${companyId}`, { name });
    const [src, cat, sts] = await Promise.all([
      jget(`/crm/lead-sources/${companyId}`).catch(() => []),
      jget(`/crm/lead-categories/${companyId}`).catch(() => []),
      jget(`/crm/lead-statuses/${companyId}`).catch(() => []),
    ]);
    setSources(src);
    setCategories(cat);
    setStatuses(sts);
  };

  const submit = async () => {
    setFormError("");
    if (!form.lead_type.trim()) return setFormError("Lead Type is required");
    if (!form.contact_name.trim()) return setFormError("Contact Name is required");
    if (!form.phone_no.trim()) return setFormError("Phone No. is required");
    if (!companyId) return setFormError("Company not resolved");
    setSaving(true);
    try {
      const body = {
        company_id: companyId,
        assignee_id: form.assignee_id || null,
        lead_type: form.lead_type.trim(),
        contact_name: form.contact_name.trim(),
        country_code: form.country_code,
        phone_no: form.phone_no.trim(),
        email: form.email.trim() || null,
        client_company_name: form.client_company_name.trim() || null,
        address: form.address.trim() || null,
        source: form.source_name || null,
        category: form.category_name || null,
        status: form.status_name || "New Lead",
        priority: form.priority,
        budget: parseFloat(form.budget || "0") || 0,
        lead_name: form.lead_name.trim() || null,
        description: form.description.trim() || null,
        last_contacted: fromDateInput(form.last_contacted),
        next_follow_up: fromDateInput(form.next_follow_up),
        expected_closure: fromDateInput(form.expected_closure),
      };
      if (editingId) {
        const { company_id: _c, ...changes } = body;
        await jput(`/crm/leads/${editingId}`, changes);
      } else {
        await jpost("/crm/leads", body);
      }
      setDrawerOpen(false);
      setEditingId(null);
      await loadAll();
    } catch (e: any) {
      setFormError(e.message || "Failed to save lead");
    } finally {
      setSaving(false);
    }
  };

  const setF = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  // ─── Quotation helpers ───────────────────────────────────────────────────
  const qSet = (patch: Partial<typeof qForm>) => setQForm((q) => ({ ...q, ...patch }));
  const qSetItem = (idx: number, patch: Partial<QItem>) =>
    setQForm((q) => ({ ...q, items: q.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) }));
  const qAddItem = () => setQForm((q) => ({ ...q, items: [...q.items, { ...emptyQItem }] }));
  const qDelItem = (idx: number) =>
    setQForm((q) => ({ ...q, items: q.items.filter((_, i) => i !== idx) }));

  const dimFactor = (it: QItem) =>
    it.length && it.width && it.height ? it.length * it.width * it.height : 1;
  const itemBase = (it: QItem) => {
    const unit = it.selling_price + it.supply_rate + it.installation_rate;
    return it.qty * dimFactor(it) * unit;
  };

  const { qSubtotal, qDiscounted, qTax, qCgst, qSgst, qGrand } = React.useMemo(() => {
    const subtotal = qForm.items.reduce((s, it) => s + itemBase(it), 0);
    const discounted = Math.max(subtotal - (Number(qForm.discount) || 0), 0);
    const tax = qForm.tax_type === "bill_level" ? discounted * ((Number(qForm.gst_pct) || 0) / 100) : 0;
    const totalGst = (Number(qForm.cgst_pct) || 0) + (Number(qForm.sgst_pct) || 0) || 1;
    const cgst = tax * ((Number(qForm.cgst_pct) || 0) / totalGst);
    const sgst = tax * ((Number(qForm.sgst_pct) || 0) / totalGst);
    const grand = discounted + tax + (Number(qForm.additional_charges) || 0) + (Number(qForm.round_off) || 0);
    return { qSubtotal: subtotal, qDiscounted: discounted, qTax: tax, qCgst: cgst, qSgst: sgst, qGrand: grand };
  }, [qForm.items, qForm.discount, qForm.tax_type, qForm.gst_pct, qForm.cgst_pct, qForm.sgst_pct, qForm.additional_charges, qForm.round_off]);

  const submitQuotation = async () => {
    setQError("");
    if (!qForm.subject.trim()) return setQError("Subject is required");
    if (!selLeadId) return setQError("Select a lead first");
    if (qForm.items.some((it) => !it.item_name.trim())) return setQError("Every item needs a name");
    setQSaving(true);
    try {
      const body = {
        subject: qForm.subject.trim(),
        tax_type: qForm.tax_type,
        gst_pct: Number(qForm.gst_pct) || 0,
        cgst_pct: Number(qForm.cgst_pct) || 0,
        sgst_pct: Number(qForm.sgst_pct) || 0,
        discount: Number(qForm.discount) || 0,
        additional_charges: Number(qForm.additional_charges) || 0,
        round_off: Number(qForm.round_off) || 0,
        qt_no: qForm.qt_no.trim() || null,
        qt_date: fromDateInput(qForm.qt_date),
        bank_account_id: qForm.bank_account_id || null,
        terms: qForm.terms.trim() || null,
        items: qForm.items.map((it) => ({
          section_name: it.section_name.trim() || null,
          item_name: it.item_name.trim(),
          qty: Number(it.qty) || 0,
          unit: it.unit.trim() || "Nos",
          cost_price: Number(it.cost_price) || 0,
          selling_price: Number(it.selling_price) || 0,
          supply_rate: Number(it.supply_rate) || 0,
          installation_rate: Number(it.installation_rate) || 0,
          supply_tax_pct: Number(it.supply_tax_pct) || 0,
          installation_tax_pct: Number(it.installation_tax_pct) || 0,
          markup: Number(it.markup) || 0,
          item_code: it.item_code.trim() || null,
          hsn_sac: it.hsn_sac.trim() || null,
          cost_code: it.cost_code.trim() || null,
          length: it.length ?? null,
          width: it.width ?? null,
          height: it.height ?? null,
          billed_qty: 0,
          unbilled_qty: 0,
        })),
      };
      await jpost(`/crm/leads/${selLeadId}/quotations`, body);
      setQDrawer(false);
      setQForm({ ...emptyQ });
      await loadQuots();
    } catch (e: any) {
      setQError(e.message || "Failed to save quotation");
    } finally {
      setQSaving(false);
    }
  };

  const bankById = (id: string | null) => banks.find((b) => b.id === id);

  const renderCell = (l: Lead, key: string) => {
    switch (key) {
      case "sno":
        return null; // handled separately
      case "lead_type":
        return l.lead_type;
      case "contact_name":
        return l.contact_name;
      case "updated_at":
        return fmtDate(l.updated_at);
      case "phone": {
        // R2-438: the country-code prefix is a validity claim - only decorate
        // values that actually form a dialable number, so legacy junk like
        // "not-a-phone" no longer renders as "+91 not-a-phone".
        const combined = `${l.country_code || ""}${l.phone_no || ""}`.replace(/[\s()-]/g, "");
        if (/^\+?\d{8,15}$/.test(combined)) {
          return `${l.country_code || ""} ${l.phone_no}`.trim();
        }
        return l.phone_no || "";
      }
      case "status":
        return l.status;
      case "source":
        return l.source || "—";
      case "lead_name":
        return l.lead_name || "—";
      case "country_code":
        return l.country_code || "—";
      case "category":
        return l.category || "—";
      case "assignee":
        return nameById(team, l.assignee_id);
      case "priority": {
        // R2-438: one value must not render as two ("Medium" vs "medium");
        // normalise the display so sorting/filtering sees a single vocabulary.
        const p = l.priority || "";
        return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p;
      }
      case "email":
        return l.email || "—";
      case "company":
        return l.client_company_name || "—";
      case "address":
        return l.address || "—";
      case "budget":
        return fmtINR(l.budget, currencyDecimalPlaces);
      case "created_at":
        return fmtDate(l.created_at);
      case "next_follow_up": {
        if (!l.next_follow_up) return "—";
        const due = toDateInput(l.next_follow_up);
        if (due < todayISO() && !CLOSED_STATUSES.includes((l.status || "").toLowerCase())) {
          return <span className="font-semibold text-danger">{fmtDate(l.next_follow_up)} (overdue)</span>;
        }
        return fmtDate(l.next_follow_up);
      }
      case "expected_closure":
        return fmtDate(l.expected_closure);
      case "last_contacted":
        return fmtDate(l.last_contacted);
      default:
        return "—";
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title="CRM & Quotations"
        subtitle="Lead tracking, client pipeline and quotation register"
        action={
          tab === "leads" ? (
            <button className={btnPrimary} onClick={openNew}>
              New Lead +
            </button>
          ) : (
            <button
              className={btnPrimary}
              disabled={!selLeadId}
              onClick={() => {
                setQForm({ ...emptyQ });
                setQError("");
                setQDrawer(true);
              }}
            >
              New Quotation +
            </button>
          )
        }
      />
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">
      {/* Sub-tabs */}
      <div className="mb-4">
        <SegmentedTabs
          tabs={[
            { id: "leads", label: "Leads" },
            { id: "quotation", label: "Quotation" },
          ]}
          activeTab={tab}
          onChange={(t) => setTab(t as any)}
        />
      </div>

      {tab === "leads" && (
        <>
          {/* Toolbar */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative">
              <input
                className={`${filterCls} pl-8`}
                placeholder="Search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <span className="pointer-events-none absolute left-2.5 top-2.5 text-muted"><Icon name="search" className="w-3.5 h-3.5" /></span>
            </div>
            <select className={filterCls} value={fAssignee} onChange={(e) => setFAssignee(e.target.value)}>
              <option value="">Assignee</option>
              {team.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <input type="date" className={filterCls} value={fDate} onChange={(e) => setFDate(e.target.value)} />
            <select className={filterCls} value={fPriority} onChange={(e) => setFPriority(e.target.value)}>
              <option value="">Priority</option>
              {PRIORITY_OPTS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <select className={filterCls} value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
              <option value="">Status</option>
              {statuses.map((s) => (
                <option key={s.id} value={s.name}>{s.name}</option>
              ))}
            </select>
            <select className={filterCls} value={fSource} onChange={(e) => setFSource(e.target.value)}>
              <option value="">Source</option>
              {sources.map((s) => (
                <option key={s.id} value={s.name}>{s.name}</option>
              ))}
            </select>
            <select className={filterCls} value={fCategory} onChange={(e) => setFCategory(e.target.value)}>
              <option value="">Category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.name}>{c.name}</option>
              ))}
            </select>
            <div className="ml-auto relative">
              <button className={`${btnGhost} flex items-center gap-1 cursor-pointer`} onClick={() => setShowColMenu((v) => !v)} title="Columns">
                <Icon name="table_chart" className="w-3.5 h-3.5" /> Columns
              </button>
              {showColMenu && (
                <div
                  className="absolute right-0 z-50 mt-1 w-56 rounded-md border border-border-custom bg-background p-2 shadow-xl"
                  onMouseLeave={() => setShowColMenu(false)}
                >
                  {ALL_COLS.filter((c) => c.key !== "sno").map((c) => (
                    <label key={c.key} className="flex items-center gap-2 py-1 text-sm">
                      <input
                        type="checkbox"
                        checked={!!visible[c.key]}
                        onChange={(e) => setVisible((v) => ({ ...v, [c.key]: e.target.checked }))}
                      />
                      {c.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="mb-2 text-xs text-muted">
            Showing {filtered.length} of {leads.length} leads
          </div>

          {/* Table */}
          <div className="overflow-x-auto rounded-md border border-border-custom">
            <table className="w-full text-sm">
              <thead className="bg-elevated text-left text-muted">
                <tr>
                  {ALL_COLS.filter((c) => visible[c.key]).map((c) => (
                    <th key={c.key} className="whitespace-nowrap px-3 py-2 font-medium">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={ALL_COLS.length} className="p-4">
                      <TableSkeleton rows={5} cols={ALL_COLS.length} />
                    </td>
                  </tr>
                )}
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={ALL_COLS.length} className="p-8">
                      <EmptyState
                        title="No leads found"
                        description={search ? "No leads match your search query." : "Track incoming customer inquiries and opportunities."}
                        action={!search ? { label: "New Lead", onClick: () => setDrawerOpen(true) } : undefined}
                      />
                    </td>
                  </tr>
                )}
                {filtered.map((l, i) => (
                  <tr key={l.id} className="border-t border-border-custom hover:bg-elevated cursor-pointer" onClick={() => openEdit(l)} title="Open lead">
                    {ALL_COLS.filter((c) => visible[c.key]).map((c) => (
                      <td key={c.key} className="whitespace-nowrap px-3 py-2 text-foreground">
                        {c.key === "sno" ? i + 1 : renderCell(l, c.key)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* New Lead Drawer */}
          {drawerOpen && (
            <Drawer title={editingId ? "Edit Lead" : "New Lead"} onClose={() => { setDrawerOpen(false); setEditingId(null); }} width="max-w-lg">
              <CreatableSelect
                label="Lead Assignee"
                items={team.map((t) => ({ id: t.id, company_id: companyId, name: t.name }))}
                value={form.assignee_id}
                onPick={(id) => setF({ assignee_id: id })}
                onCreate={async () => {}}
                placeholder="Select assignee"
              />
              <Field label="Lead Type *">
                <input
                  className={inputCls}
                  value={form.lead_type}
                  onChange={(e) => setF({ lead_type: e.target.value })}
                  placeholder="e.g. Residential, Commercial"
                />
              </Field>
              <Field label="Contact Name *">
                <input
                  className={inputCls}
                  value={form.contact_name}
                  onChange={(e) => setF({ contact_name: e.target.value })}
                />
              </Field>
              <Field label="Phone No. *">
                <div className="flex gap-2">
                  <select
                    className={inputCls}
                    value={form.country_code}
                    onChange={(e) => setF({ country_code: e.target.value })}
                  >
                    {COUNTRY_CODES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <input
                    className={inputCls}
                    value={form.phone_no}
                    onChange={(e) => setF({ phone_no: e.target.value })}
                    placeholder="Phone number"
                  />
                </div>
              </Field>
              <Field label="Email">
                <input className={inputCls} value={form.email} onChange={(e) => setF({ email: e.target.value })} />
              </Field>
              <Field label="Company Name">
                <input
                  className={inputCls}
                  value={form.client_company_name}
                  onChange={(e) => setF({ client_company_name: e.target.value })}
                />
              </Field>
              <Field label="Address">
                <textarea
                  className={inputCls}
                  rows={2}
                  value={form.address}
                  onChange={(e) => setF({ address: e.target.value })}
                />
              </Field>
              <CreatableSelect
                label="Source"
                items={sources}
                value={form.source_id}
                onPick={(_id, name) => setF({ source_id: _id, source_name: name })}
                onCreate={(name) => createLookup("source", name).then(() => {
                  const found = sources.find((s) => s.name === name);
                  if (found) setF({ source_id: found.id, source_name: name });
                })}
                placeholder="Select source"
              />
              <CreatableSelect
                label="Category"
                items={categories}
                value={form.category_id}
                onPick={(_id, name) => setF({ category_id: _id, category_name: name })}
                onCreate={(name) => createLookup("category", name).then(() => {
                  const found = categories.find((c) => c.name === name);
                  if (found) setF({ category_id: found.id, category_name: name });
                })}
                placeholder="Select category"
              />
              <CreatableSelect
                label="Lead Status"
                items={statuses}
                value={form.status_id}
                onPick={(_id, name) => setF({ status_id: _id, status_name: name })}
                onCreate={(name) => createLookup("status", name).then(() => {
                  const found = statuses.find((s) => s.name === name);
                  if (found) setF({ status_id: found.id, status_name: name });
                })}
                placeholder="Select status"
              />
              <Field label="Priority">
                <select
                  className={inputCls}
                  value={form.priority}
                  onChange={(e) => setF({ priority: e.target.value })}
                >
                  {PRIORITY_OPTS.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </Field>
              <Field label="Last Contacted Date">
                <input
                  type="date"
                  className={inputCls}
                  value={form.last_contacted}
                  onChange={(e) => setF({ last_contacted: e.target.value })}
                />
              </Field>
              <Field label="Next Follow Up">
                <input
                  type="date"
                  className={inputCls}
                  value={form.next_follow_up}
                  onChange={(e) => setF({ next_follow_up: e.target.value })}
                />
              </Field>
              <Field label="Expected Closure Date">
                <input
                  type="date"
                  className={inputCls}
                  value={form.expected_closure}
                  onChange={(e) => setF({ expected_closure: e.target.value })}
                />
              </Field>
              <Field label="Budget">
                <input
                  type="number"
                  className={inputCls}
                  value={form.budget}
                  onChange={(e) => setF({ budget: e.target.value })}
                />
              </Field>
              <Field label="Description">
                <textarea
                  className={inputCls}
                  rows={3}
                  value={form.description}
                  onChange={(e) => setF({ description: e.target.value })}
                />
              </Field>

              {formError && <div className="mb-3 rounded bg-danger/10 px-3 py-2 text-sm text-danger">{formError}</div>}
              <div className="flex justify-end gap-2">
                {editingId && (
                  <button className={`${btnGhost} mr-auto text-danger`} onClick={removeLead} disabled={saving}>
                    Delete
                  </button>
                )}
                <button className={btnGhost} onClick={() => { setDrawerOpen(false); setEditingId(null); }}>
                  Cancel
                </button>
                <button className={btnPrimary} onClick={submit} disabled={saving}>
                  {saving ? "Saving…" : "Save Lead"}
                </button>
              </div>
            </Drawer>
          )}
        </>
      )}

      {tab === "quotation" && (
        <div>
          {/* Lead selector + new */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <select
              className={inputCls}
              value={selLeadId}
              onChange={(e) => setSelLeadId(e.target.value)}
            >
              <option value="">Select Lead</option>
              {leads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.contact_name} · {l.client_company_name || l.lead_type}
                </option>
              ))}
            </select>
            {leads.length === 0 && (
              <FieldHint text="No leads yet." onAction={() => setTab("leads")} actionLabel="Add a lead in CRM" />
            )}
          </div>

          {/* Quotations list */}
          <div className="overflow-x-auto rounded-md border border-border-custom">
            <table className="w-full text-sm">
              <thead className="bg-elevated text-left text-muted">
                <tr>
                  {["QT No", "Date", "Subject", "Items", "Tax", "CGST", "SGST", "Total", "Status", "Actions"].map((h) => (
                    <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {qLoading && (
                  <tr>
                    <td colSpan={10} className="p-4">
                      <TableSkeleton rows={3} cols={10} />
                    </td>
                  </tr>
                )}
                {!qLoading && quots.length === 0 && (
                  <tr>
                    <td colSpan={10} className="p-8">
                      <EmptyState
                        title={selLeadId ? "No quotations yet" : "No quotations to display"}
                        description={selLeadId ? "Create a quotation for this lead to send proposals and estimates." : "Select a lead from the list above to view associated quotations."}
                      />
                    </td>
                  </tr>
                )}
                {quots.map((q) => (
                  <tr
                    key={q.id}
                    className="cursor-pointer border-t border-border-custom hover:bg-elevated"
                    onClick={() => setQDetail(q)}
                  >
                    <td className="px-3 py-2 text-foreground font-semibold">{q.qt_no || "—"}</td>
                    <td className="px-3 py-2 text-foreground">{fmtDate(q.qt_date)}</td>
                    <td className="px-3 py-2 text-foreground">{q.subject}</td>
                    <td className="px-3 py-2 text-foreground">{q.items.length}</td>
                    <td className="px-3 py-2 text-foreground">{q.gst_pct}%</td>
                    <td className="px-3 py-2 text-foreground">{fmtINR(q.cgst_amount, currencyDecimalPlaces)}</td>
                    <td className="px-3 py-2 text-foreground">{fmtINR(q.sgst_amount, currencyDecimalPlaces)}</td>
                    <td className="px-3 py-2 text-foreground font-bold">{fmtINR(q.total_amount, currencyDecimalPlaces)}</td>
                    <td className="px-3 py-2">
                      <Badge
                        tone={
                          q.status === "converted"
                            ? "success"
                            : q.status === "accepted"
                            ? "success"
                            : q.status === "rejected"
                            ? "danger"
                            : "neutral"
                        }
                        className="uppercase font-bold text-[9px]"
                      >
                        {formatLabel(q.status)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                        {q.status === "converted" ? (
                          <Link
                            href={`/c/${companyId}/d/billing`}
                            className="bg-success/10 border border-success/20 text-success rounded px-2.5 py-1 text-xs font-bold hover:bg-success/20 transition-all inline-flex items-center gap-1"
                          >
                            <Icon name="check" className="w-3 h-3" /> View Invoice
                          </Link>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openConvertModal(q)}
                            className="bg-primary hover:bg-primary/95 text-white rounded px-2.5 py-1 text-xs font-bold transition-all cursor-pointer inline-flex items-center gap-1"
                          >
                            Convert to Invoice
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* New Quotation Drawer */}
          {qDrawer && (
            <Drawer title="New Quotation" onClose={() => setQDrawer(false)} width="max-w-4xl">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Subject *">
                  <input className={inputCls} value={qForm.subject} onChange={(e) => qSet({ subject: e.target.value })} />
                </Field>
                <Field label="QT No">
                  <input className={inputCls} value={qForm.qt_no} onChange={(e) => qSet({ qt_no: e.target.value })} placeholder="Leave blank for the next number" />
                </Field>
                <Field label="QT Date">
                  <input type="date" className={inputCls} value={qForm.qt_date} onChange={(e) => qSet({ qt_date: e.target.value })} />
                </Field>
                <Field label="Tax Type">
                  <select className={inputCls} value={qForm.tax_type} onChange={(e) => qSet({ tax_type: e.target.value })}>
                    <option value="bill_level">Bill Level</option>
                    <option value="item_level">Item Level</option>
                  </select>
                </Field>
                <Field label="GST %">
                  <input type="number" className={inputCls} value={qForm.gst_pct} onChange={(e) => qSet({ gst_pct: Number(e.target.value) })} />
                </Field>
                <Field label="CGST %">
                  <input type="number" className={inputCls} value={qForm.cgst_pct} onChange={(e) => qSet({ cgst_pct: Number(e.target.value) })} />
                </Field>
                <Field label="SGST %">
                  <input type="number" className={inputCls} value={qForm.sgst_pct} onChange={(e) => qSet({ sgst_pct: Number(e.target.value) })} />
                </Field>
                <Field label="Discount">
                  <input type="number" className={inputCls} value={qForm.discount} onChange={(e) => qSet({ discount: Number(e.target.value) })} />
                </Field>
                <Field label="Additional Charges">
                  <input type="number" className={inputCls} value={qForm.additional_charges} onChange={(e) => qSet({ additional_charges: Number(e.target.value) })} />
                </Field>
                <Field label="Round Off">
                  <input type="number" className={inputCls} value={qForm.round_off} onChange={(e) => qSet({ round_off: Number(e.target.value) })} />
                </Field>
                <Field label="Bank Account">
                  <select className={inputCls} value={qForm.bank_account_id} onChange={(e) => qSet({ bank_account_id: e.target.value })}>
                    <option value="">Select bank</option>
                    {banks.map((b) => (
                      <option key={b.id} value={b.id}>{b.bank_name} — {b.account_number}</option>
                    ))}
                  </select>
                  {banks.length === 0 && (
                    <FieldHint text="No bank accounts yet. Add one in Settings." href={`/c/${companyId}/settings`} linkLabel="Go to Settings" />
                  )}
                </Field>
              </div>

              <div className="mb-2 mt-2 text-xs font-medium uppercase tracking-wide text-muted">Line Items (N × L × W × H)</div>
              <div className="overflow-x-auto rounded-md border border-border-custom">
                <table className="w-full text-xs">
                  <thead className="bg-elevated text-muted">
                    <tr>
                      {["Item", "Section", "N (Qty)", "Unit", "L", "W", "H", "Cost", "Selling", "Supply", "Install", "Markup", "Amount"].map((h) => (
                        <th key={h} className="whitespace-nowrap px-2 py-1 font-medium">{h}</th>
                      ))}
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {qForm.items.map((it, idx) => (
                      <tr key={idx} className="border-t border-border-custom">
                        <td className="p-1"><input className={inputCls + " px-1 py-1"} value={it.item_name} onChange={(e) => qSetItem(idx, { item_name: e.target.value })} /></td>
                        <td className="p-1"><input className={inputCls + " px-1 py-1"} value={it.section_name} onChange={(e) => qSetItem(idx, { section_name: e.target.value })} /></td>
                        <td className="p-1"><input type="number" className={inputCls + " px-1 py-1 w-16"} value={it.qty} onChange={(e) => qSetItem(idx, { qty: Number(e.target.value) })} /></td>
                        <td className="p-1"><UnitInput className={inputCls + " px-1 py-1 w-16"} autoComplete="off" value={it.unit} onChange={(e) => qSetItem(idx, { unit: e.target.value })} /></td>
                        <td className="p-1"><input type="number" className={inputCls + " px-1 py-1 w-14"} value={it.length ?? ""} onChange={(e) => qSetItem(idx, { length: e.target.value === "" ? null : Number(e.target.value) })} /></td>
                        <td className="p-1"><input type="number" className={inputCls + " px-1 py-1 w-14"} value={it.width ?? ""} onChange={(e) => qSetItem(idx, { width: e.target.value === "" ? null : Number(e.target.value) })} /></td>
                        <td className="p-1"><input type="number" className={inputCls + " px-1 py-1 w-14"} value={it.height ?? ""} onChange={(e) => qSetItem(idx, { height: e.target.value === "" ? null : Number(e.target.value) })} /></td>
                        <td className="p-1"><input type="number" className={inputCls + " px-1 py-1 w-20"} value={it.cost_price} onChange={(e) => qSetItem(idx, { cost_price: Number(e.target.value) })} /></td>
                        <td className="p-1"><input type="number" className={inputCls + " px-1 py-1 w-20"} value={it.selling_price} onChange={(e) => qSetItem(idx, { selling_price: Number(e.target.value) })} /></td>
                        <td className="p-1"><input type="number" className={inputCls + " px-1 py-1 w-20"} value={it.supply_rate} onChange={(e) => qSetItem(idx, { supply_rate: Number(e.target.value) })} /></td>
                        <td className="p-1"><input type="number" className={inputCls + " px-1 py-1 w-20"} value={it.installation_rate} onChange={(e) => qSetItem(idx, { installation_rate: Number(e.target.value) })} /></td>
                        <td className="p-1"><input type="number" className={inputCls + " px-1 py-1 w-16"} value={it.markup} onChange={(e) => qSetItem(idx, { markup: Number(e.target.value) })} /></td>
                        <td className="p-1 whitespace-nowrap text-foreground">{fmtINR(itemBase(it), currencyDecimalPlaces)}</td>
                        <td className="p-1"><button className={btnGhost} onClick={() => qDelItem(idx)}><Icon name="close" className="w-3.5 h-3.5" /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button className={btnGhost + " mt-2"} onClick={qAddItem}>+ Add Item</button>

              <Field label="Terms">
                <textarea className={inputCls} rows={2} value={qForm.terms} onChange={(e) => qSet({ terms: e.target.value })} />
              </Field>

              {/* Totals */}
              <div className="mt-2 space-y-1 rounded-md border border-border-custom p-3 text-sm">
                <div className="flex justify-between"><span className="text-muted">Subtotal</span><span>{fmtINR(qSubtotal, currencyDecimalPlaces)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Discount</span><span>- {fmtINR(qForm.discount, currencyDecimalPlaces)}</span></div>
                <div className="flex justify-between"><span className="text-muted">GST ({qForm.gst_pct}%)</span><span>{fmtINR(qTax, currencyDecimalPlaces)}</span></div>
                <div className="flex justify-between"><span className="text-muted">CGST ({qForm.cgst_pct}%)</span><span>{fmtINR(qCgst, currencyDecimalPlaces)}</span></div>
                <div className="flex justify-between"><span className="text-muted">SGST ({qForm.sgst_pct}%)</span><span>{fmtINR(qSgst, currencyDecimalPlaces)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Additional Charges</span><span>{fmtINR(qForm.additional_charges, currencyDecimalPlaces)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Round Off</span><span>{fmtINR(qForm.round_off, currencyDecimalPlaces)}</span></div>
                <div className="flex justify-between border-t border-border-custom pt-1 font-semibold"><span>Grand Total</span><span>{fmtINR(qGrand, currencyDecimalPlaces)}</span></div>
              </div>

              {qError && <div className="mb-3 mt-3 rounded bg-danger/10 px-3 py-2 text-sm text-danger">{qError}</div>}
              <div className="mt-3 flex justify-end gap-2">
                <button className={btnGhost} onClick={() => setQDrawer(false)}>Cancel</button>
                <button className={btnPrimary} onClick={submitQuotation} disabled={qSaving}>
                  {qSaving ? "Saving…" : "Save Quotation"}
                </button>
              </div>
            </Drawer>
          )}

          {/* Detail Drawer */}
          {qDetail && (
            <Drawer title={`Quotation · ${qDetail.qt_no || qDetail.subject}`} onClose={() => setQDetail(null)} width="max-w-4xl">
              <div className="mb-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div><span className="text-muted">Subject: </span>{qDetail.subject}</div>
                <div><span className="text-muted">Date: </span>{fmtDate(qDetail.qt_date)}</div>
                <div className="flex items-center gap-2">
                  <span className="text-muted">Status: </span>
                  <Badge tone={qDetail.status === "converted" ? "success" : qDetail.status === "accepted" ? "success" : "neutral"} className="uppercase font-bold text-[9px]">
                    {formatLabel(qDetail.status)}
                  </Badge>
                </div>
                <div><span className="text-muted">Tax: </span>{qDetail.gst_pct}% ({qDetail.tax_type})</div>
                <div className="col-span-2"><span className="text-muted">Bank: </span>{bankById(qDetail.bank_account_id) ? `${bankById(qDetail.bank_account_id)!.bank_name} — ${bankById(qDetail.bank_account_id)!.account_number}` : "—"}</div>
              </div>
              <div className="overflow-x-auto rounded-md border border-border-custom">
                <table className="w-full text-xs">
                  <thead className="bg-elevated text-muted">
                    <tr>
                      {["Item", "Section", "N", "L", "W", "H", "Unit", "Cost", "Selling", "Supply", "Install", "Markup", "Amount"].map((h) => (
                        <th key={h} className="whitespace-nowrap px-2 py-1 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {qDetail.items.map((it) => (
                      <tr key={it.id} className="border-t border-border-custom">
                        <td className="p-1 text-foreground">{it.item_name}</td>
                        <td className="p-1 text-foreground">{it.section_name || "—"}</td>
                        <td className="p-1 text-foreground">{it.qty}</td>
                        <td className="p-1 text-foreground">{it.length ?? "—"}</td>
                        <td className="p-1 text-foreground">{it.width ?? "—"}</td>
                        <td className="p-1 text-foreground">{it.height ?? "—"}</td>
                        <td className="p-1 text-foreground">{it.unit}</td>
                        <td className="p-1 text-foreground">{fmtINR(it.cost_price, currencyDecimalPlaces)}</td>
                        <td className="p-1 text-foreground">{fmtINR(it.selling_price, currencyDecimalPlaces)}</td>
                        <td className="p-1 text-foreground">{fmtINR(it.supply_rate, currencyDecimalPlaces)}</td>
                        <td className="p-1 text-foreground">{fmtINR(it.installation_rate, currencyDecimalPlaces)}</td>
                        <td className="p-1 text-foreground">{fmtINR(it.markup, currencyDecimalPlaces)}</td>
                        <td className="p-1 text-foreground">{fmtINR(it.total_amount, currencyDecimalPlaces)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 space-y-1 rounded-md border border-border-custom p-3 text-sm">
                <div className="flex justify-between"><span className="text-muted">CGST ({qDetail.cgst_pct}%)</span><span>{fmtINR(qDetail.cgst_amount, currencyDecimalPlaces)}</span></div>
                <div className="flex justify-between"><span className="text-muted">SGST ({qDetail.sgst_pct}%)</span><span>{fmtINR(qDetail.sgst_amount, currencyDecimalPlaces)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Additional Charges</span><span>{fmtINR(qDetail.additional_charges, currencyDecimalPlaces)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Round Off</span><span>{fmtINR(qDetail.round_off, currencyDecimalPlaces)}</span></div>
                <div className="flex justify-between border-t border-border-custom pt-1 font-semibold"><span>Grand Total</span><span>{fmtINR(qDetail.total_amount, currencyDecimalPlaces)}</span></div>
              </div>
              {qDetail.terms && <div className="mt-3 text-sm text-muted">Terms: {qDetail.terms}</div>}

              <div className="mt-4 flex items-center justify-between border-t border-border-custom pt-3">
                {qDetail.status === "converted" ? (
                  <Link
                    href={`/c/${companyId}/d/billing`}
                    className="bg-success/10 border border-success/20 text-success rounded-md px-3 py-2 text-xs font-bold hover:bg-success/20 transition-all inline-flex items-center gap-1.5"
                  >
                    <Icon name="check" className="w-4 h-4" /> Converted · View in Billing
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      const q = qDetail;
                      setQDetail(null);
                      openConvertModal(q);
                    }}
                    className="bg-primary hover:bg-primary/95 text-white rounded-md px-4 py-2 text-xs font-bold transition-all cursor-pointer inline-flex items-center gap-1.5"
                  >
                    <Icon name="receipt" className="w-4 h-4" /> Convert to Invoice
                  </button>
                )}
                <button className={btnGhost} onClick={() => setQDetail(null)}>Close</button>
              </div>
            </Drawer>
          )}

          {/* Convert to Invoice Modal */}
          {convertModal && (
            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setConvertModal(null)}>
              <div className="bg-card border border-border-custom rounded-xl w-full max-w-lg p-6 relative shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between border-b border-border-custom pb-3">
                  <div>
                    <h3 className="text-sm font-bold text-foreground uppercase tracking-wider font-sans">Convert Quotation to Invoice</h3>
                    <p className="text-xs text-muted mt-0.5">
                      QT #{convertModal.quotation.qt_no || convertModal.quotation.subject} · {fmtINR(convertModal.quotation.total_amount, currencyDecimalPlaces)}
                    </p>
                  </div>
                  <button onClick={() => setConvertModal(null)} className="text-muted hover:text-foreground cursor-pointer p-1">
                    <Icon name="close" className="w-5 h-5" />
                  </button>
                </div>

                <div className="space-y-3 text-xs">
                  <div>
                    <label className="text-[10px] uppercase font-bold text-muted block mb-1">Target Project *</label>
                    <select
                      value={convertModal.projectId}
                      onChange={(e) => setConvertModal({ ...convertModal, projectId: e.target.value })}
                      className="w-full bg-background border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-primary font-semibold"
                    >
                      <option value="">Select project</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}{p.state ? ` (${p.state})` : ""}</option>
                      ))}
                    </select>
                    {projects.length === 0 && (
                      <FieldHint text="No projects found. Create a project in Projects." href={`/c/${companyId}/projects`} linkLabel="Go to Projects" />
                    )}
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-bold text-muted block mb-1">Billing Party / Customer Team Member *</label>
                    <select
                      value={convertModal.partyId}
                      onChange={(e) => setConvertModal({ ...convertModal, partyId: e.target.value })}
                      className="w-full bg-background border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-primary font-semibold"
                    >
                      <option value="">Select party/member</option>
                      {team.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                    {team.length === 0 && (
                      <FieldHint text="No team members or parties found. Add team members in Settings." href={`/c/${companyId}/settings`} linkLabel="Go to Settings" />
                    )}
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-bold text-muted block mb-1">Invoice Number</label>
                    <input
                      type="text"
                      value={convertModal.invoiceNumber}
                      onChange={(e) => setConvertModal({ ...convertModal, invoiceNumber: e.target.value })}
                      placeholder="e.g. INV-2026-001"
                      className="w-full bg-background border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-primary font-sans font-bold"
                    />
                    <span className="text-[10px] text-muted block mt-1">Pre-filled sequence number; editable.</span>
                  </div>

                  {convertError && (
                    <div className="bg-danger/10 border border-danger/20 rounded-md p-3 text-xs text-danger">
                      {convertError}
                    </div>
                  )}

                  <div className="flex items-center justify-end gap-2 pt-3 border-t border-border-custom">
                    <button
                      type="button"
                      onClick={() => setConvertModal(null)}
                      className="px-4 py-2 bg-elevated hover:bg-card border border-border-custom text-muted hover:text-foreground text-xs font-semibold rounded-lg transition-all cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleConvertToInvoice}
                      disabled={convertSaving}
                      className="px-5 py-2 bg-primary hover:bg-primary/95 text-white text-xs font-bold rounded-lg transition-all cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
                    >
                      {convertSaving ? "Converting…" : "Confirm Conversion"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Convert Success Dialog */}
          {convertSuccess && (
            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setConvertSuccess(null)}>
              <div className="bg-card border border-border-custom rounded-xl w-full max-w-md p-6 relative shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-success/20 text-success flex items-center justify-center">
                    <Icon name="check" className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-foreground font-sans">Quotation Converted Successfully</h3>
                    <p className="text-xs text-muted mt-0.5">
                      Sale Invoice #{convertSuccess.invoice_number} has been created.
                    </p>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2 pt-3 border-t border-border-custom">
                  <button
                    type="button"
                    onClick={() => setConvertSuccess(null)}
                    className="px-4 py-2 bg-elevated hover:bg-card border border-border-custom text-muted hover:text-foreground text-xs font-semibold rounded-lg transition-all cursor-pointer"
                  >
                    Done
                  </button>
                  <Link
                    href={`/c/${companyId}/d/billing`}
                    onClick={() => setConvertSuccess(null)}
                    className="px-5 py-2 bg-primary hover:bg-primary/95 text-white text-xs font-bold rounded-lg transition-all inline-flex items-center gap-1.5"
                  >
                    View in Billing Register
                  </Link>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      </PageShell>
      </div>
    </div>
  );
}
