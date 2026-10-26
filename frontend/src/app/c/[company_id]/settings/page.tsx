"use client";
import AuthImage from "@/components/ui/AuthImage";
import Badge, { type BadgeTone } from "@/components/ui/Badge";
import { getApiHost, readErrorDetail, detailToMessage} from "@/lib/api";
import { authHeaders, formatDate, formatLabel } from "@/lib/siteflow";

import { useParams } from "next/navigation";
import { useEffect, useState, useRef, useCallback } from "react";
import PwaControls from "@/components/pwa/PwaControls";
import RolePermissionsModal, { RoleForEditor } from "@/components/rbac/RolePermissionsModal";
import TeamSection, { ROLE_SUMMARIES } from "@/components/rbac/TeamSection";
import { usePermissions } from "@/context/PermissionsContext";
import { LOCKED_ROLES } from "@/lib/rbac";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import Icon from "@/components/marketing/Icon";
import { EmptyState } from "@/components/ui/EmptyState";
import { CardSkeleton } from "@/components/ui/Skeleton";

interface CompanySettings {
  id: string;
  name: string;
  legal_business_name?: string | null;
  gstin?: string | null;
  phone?: string | null;
  billing_address?: string | null;
  business_segment?: string | null;
  company_size?: string | null;
  construction_types?: string[] | null;
  weekly_off?: string | null;
  weekly_off_days?: string[] | null;
  restrict_entry_creation_enabled?: boolean;
  restrict_entry_creation_days?: number;
  restrict_entry_editing_enabled?: boolean;
  restrict_entry_editing_days?: number;
  restrict_progress_over_estimate?: boolean;
  pretax_deduction_retention?: boolean;
  restrict_subcon_material_issue?: boolean;
  restrict_material_transfer?: boolean;
  restrict_production_material?: boolean;
  grn_numbering?: string | null;
  logo_url?: string | null;
  signature_url?: string | null;
  stamp_url?: string | null;
  watermark_url?: string | null;
  currency_decimal_places: number;
  quantity_decimal_places: number;
  back_dated_limit_days: number;
  negative_stock_lock: boolean;
  bom_restriction: boolean;
  po_restriction: boolean;
  material_request_restriction: boolean;
  negative_balance_warning: boolean;
  custom_pdf_template_enabled: boolean;
  document_company_name_display?: string | null;
  google_sheets_auth_phone?: string | null;
  google_sheets_enabled?: boolean;
  google_sheets_authorized_phones?: string[] | null;
  subscription_plan?: string | null;
  subscription_start?: string | null;
  subscription_end?: string | null;
  subscription_renewal?: string | null;
  is_zatca_enable?: boolean;
  vat_number?: string | null;
}

interface Branch {
  id: string;
  branch_name: string;
  gstin: string;
  billing_address: string;
  is_primary: boolean;
  geo_location?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  created_at: string;
}

interface Role {
  id: string;
  company_id: string;
  role_name: string;
  permissions?: Record<string, boolean> | null;
  created_at: string;
}

interface PayrollSettings {
  id: string;
  company_id: string;
  pf_employee_pct: number;
  pf_employer_pct: number;
  esi_employee_pct: number;
  esi_employer_pct: number;
  tds_monthly: number;
  is_esi_applicable: boolean;
  pf_wage_ceiling?: number;
  assume_full_month_when_no_attendance?: boolean;
}

interface LeaveTemplate {
  id: string;
  company_id: string;
  name: string;
  casual_leave_days: number;
  sick_leave_days: number;
  earned_leave_days: number;
  leave_types: { type: string; days: number }[];
  created_at: string;
}

interface Holiday {
  id: string;
  company_id: string;
  name: string;
  date: string;
}

interface SalaryBreakup {
  monthly_ctc: number;
  day_off: string;
  basic_pct: number;
  basic: number;
  allowances: { name: string; amount: number }[];
  gross: number;
  deductions: { name: string; amount: number }[];
  net: number;
}

interface SalaryTemplate {
  id: string;
  company_id: string;
  name: string;
  description: string | null;
  status: string;
  breakup: SalaryBreakup;
  created_at: string;
}

interface CustomField {
  id: string;
  company_id: string;
  entity_type: string;
  field_name: string;
  field_label: string;
  field_type: string;
  is_required: boolean;
  options: string[];
  display_order: number;
  is_active: boolean;
  default_value: string | null;
  set_default: boolean;
  created_at: string;
}

interface ApprovalRule {
  id: string;
  company_id: string;
  feature_type: string;
  min_amount: number;
  max_amount: number | null;
  levels: number;
  approvers: string;
  created_at: string;
}

const DEFAULT_ROLES = [
  "Admin", "Client", "Accountant", "Sub Contractor", "Associate HR",
  "Project partner", "Site Engineer", "Manager", "Supervisor", "Viewer",
];

type SectionId =
  | "profile" | "company" | "roles" | "team" | "payroll" | "holiday" | "workflow"
  | "docfields" | "approval" | "integrations" | "subscription";

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: "profile", label: "My Profile" },
  { id: "company", label: "Company" },
  { id: "roles", label: "Roles & Access" },
  { id: "team", label: "Team" },
  { id: "payroll", label: "Payroll" },
  { id: "holiday", label: "Holiday & Weekoff" },
  { id: "workflow", label: "Workflow Controls" },
  { id: "docfields", label: "Document & Fields" },
  { id: "approval", label: "Multi Level Approval" },
  { id: "integrations", label: "Integrations" },
  { id: "subscription", label: "Subscription" },
];

const COUNTRIES = ["India", "United Arab Emirates", "United States", "United Kingdom", "Singapore", "Australia", "Canada", "Germany", "Other"];
const BUSINESS_SEGMENTS = ["1cr-10cr", "10cr-20cr", "20cr-50cr", "50cr-100cr"];
const COMPANY_SIZES = ["1-20", "20-50", "50-100", "100-200"];
const CONSTRUCTION_TYPES = ["Developer", "Residential Real Estate", "Commercial Real Estate", "Infrastructure", "Industrial", "Renovation / Retrofit"];

const ASSET_LABELS: { type: "logo" | "signature" | "stamp" | "watermark"; label: string }[] = [
  { type: "logo", label: "Logo" },
  { type: "signature", label: "Signature" },
  { type: "stamp", label: "Stamp" },
  { type: "watermark", label: "Watermark" },
];

export default function CompanySettingsPage() {
  const { company_id } = useParams();
  const { can } = usePermissions();
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  // Someone who can manage the team but not company settings (a Project Manager)
  // sees only their own profile and the Team list.
  const managesSettings = can("settings:manage");
  const visibleSections = SECTIONS.filter((s) =>
    s.id === "team" ? can("team:manage") : managesSettings || s.id === "profile",
  );
  const [activeSection, setActiveSection] = useState<SectionId>("company");
  // Links such as Help and Attendance open a section directly with ?tab=team.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("tab");
    const ids = visibleSections.map((s) => s.id);
    if (wanted && ids.includes(wanted as SectionId)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveSection(wanted as SectionId);
    } else if (!ids.includes(activeSection)) {
      setActiveSection(ids.includes("team") ? "team" : "profile");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managesSettings]);
  const [companyTab, setCompanyTab] = useState<"details" | "branches" | "business">("details");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [uploading, setUploading] = useState<string | null>(null);

  const apiHost = `${getApiHost()}`;

  const loadSettings = useCallback(() => {
    if (!company_id) return;
    setLoading(true);
    fetch(`${apiHost}/apis/v3/settings/company/${company_id}`, { headers: authHeaders() })
      .then((res) => { if (!res.ok) throw new Error("Failed to load settings"); return res.json(); })
      .then((data) => setSettings(data))
      .catch((err) => setError(err.message));
    fetch(`${apiHost}/apis/v3/settings/branches/${company_id}`, { headers: authHeaders() })
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setBranches(Array.isArray(data) ? data : []))
      .catch(() => setBranches([]))
      .finally(() => setLoading(false));
  }, [company_id, apiHost]);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  const [cDraft, setCDraft] = useState<{ name: string; legal_business_name: string; gstin: string; phone: string; billing_address: string }>({
    name: "", legal_business_name: "", gstin: "", phone: "", billing_address: "",
  });

  // ─── User Profile (A6) ─────────────────────────────────────────────────────
  const [profileData, setProfileData] = useState<{ id: string; name: string; email: string; mobile: string }>({
    id: "",
    name: typeof window !== "undefined" ? localStorage.getItem("user_name") || "" : "",
    email: "",
    mobile: "",
  });
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const fetchProfile = async () => {
    try {
      const res = await fetch(`${apiHost}/apis/v3/profile/me`, { headers: authHeaders() });
      if (res.ok) {
        const d = await res.json();
        setProfileData({
          id: d.id || "",
          name: d.name || "",
          email: d.email || "",
          mobile: d.mobile || "",
        });
        if (d.name) {
          localStorage.setItem("user_name", d.name);
          localStorage.setItem("creator_name", d.name);
        }
      }
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (activeSection === "profile") {
      fetchProfile();
    }
  }, [activeSection]);

  const saveProfile = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!profileData.name.trim()) {
      setProfileMsg({ type: "err", text: "Display name cannot be empty" });
      return;
    }
    setProfileSaving(true);
    setProfileMsg(null);
    try {
      const res = await fetch(`${apiHost}/apis/v3/profile/me`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ name: profileData.name.trim() }),
      });
      if (res.ok) {
        const d = await res.json();
        setProfileMsg({ type: "ok", text: "Profile display name updated successfully" });
        if (d.user?.name) {
          localStorage.setItem("user_name", d.user.name);
          localStorage.setItem("creator_name", d.user.name);
        }
      } else {
        const err = await res.json().catch(() => ({}));
        setProfileMsg({ type: "err", text: detailToMessage(err.detail, "Failed to update profile") });
      }
    } catch {
      setProfileMsg({ type: "err", text: "Failed to update profile" });
    } finally {
      setProfileSaving(false);
    }
  };

  useEffect(() => {
    if (settings) {
      setCDraft({
        name: settings.name || "",
        legal_business_name: settings.legal_business_name ?? "",
        gstin: settings.gstin ?? "",
        phone: settings.phone ?? "",
        billing_address: settings.billing_address ?? "",
      });
      setWeeklyOffDays(
        Array.isArray(settings.weekly_off_days)
          ? settings.weekly_off_days
          : settings.weekly_off
            ? [settings.weekly_off]
            : []
      );
      setWf({
        restrict_entry_creation_enabled: settings.restrict_entry_creation_enabled ?? false,
        restrict_entry_creation_days: settings.restrict_entry_creation_days ?? 0,
        restrict_entry_editing_enabled: settings.restrict_entry_editing_enabled ?? false,
        restrict_entry_editing_days: settings.restrict_entry_editing_days ?? 0,
        restrict_progress_over_estimate: settings.restrict_progress_over_estimate ?? false,
        pretax_deduction_retention: settings.pretax_deduction_retention ?? false,
        negative_stock_lock: settings.negative_stock_lock ?? false,
        restrict_subcon_material_issue: settings.restrict_subcon_material_issue ?? false,
        restrict_material_transfer: settings.restrict_material_transfer ?? false,
        restrict_production_material: settings.restrict_production_material ?? false,
        material_request_restriction: settings.material_request_restriction ?? false,
        po_restriction: settings.po_restriction ?? false,
        bom_restriction: settings.bom_restriction ?? false,
        grn_numbering: settings.grn_numbering ?? "—",
      });
    }
  }, [settings]);

  const [weeklyOffDays, setWeeklyOffDays] = useState<string[]>([]);
  const [weeklyOffStatus, setWeeklyOffStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveWeeklyOff = async () => {
    setWeeklyOffStatus("saving");
    try {
      const res = await fetch(`${apiHost}/apis/v3/settings/company/${company_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ weekly_off_days: weeklyOffDays }),
      });
      if (res.ok) { setSettings(await res.json()); setWeeklyOffStatus("saved"); setTimeout(() => setWeeklyOffStatus("idle"), 2000); }
      else setWeeklyOffStatus("error");
    } catch { setWeeklyOffStatus("error"); }
  };

  const toggleWeeklyOffDay = (d: string) =>
    setWeeklyOffDays(weeklyOffDays.includes(d) ? weeklyOffDays.filter((x) => x !== d) : [...weeklyOffDays, d]);

  // ─── Workflow Controls (company restriction flags) ──────────────────────────
  const [wf, setWf] = useState({
    restrict_entry_creation_enabled: false, restrict_entry_creation_days: 0,
    restrict_entry_editing_enabled: false, restrict_entry_editing_days: 0,
    restrict_progress_over_estimate: false,
    pretax_deduction_retention: false,
    negative_stock_lock: false,
    restrict_subcon_material_issue: false,
    restrict_material_transfer: false,
    restrict_production_material: false,
    material_request_restriction: false,
    po_restriction: false,
    bom_restriction: false,
    grn_numbering: "Project Level",
  });
  const [wfTab, setWfTab] = useState<"entry" | "progress" | "finance" | "material">("entry");
  const [wfStatus, setWfStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveWorkflow = async () => {
    setWfStatus("saving");
    try {
      const res = await fetch(`${apiHost}/apis/v3/settings/company/${company_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify(wf),
      });
      if (res.ok) { setSettings(await res.json()); setWfStatus("saved"); setTimeout(() => setWfStatus("idle"), 2000); }
      else setWfStatus("error");
    } catch { setWfStatus("error"); }
  };

  // ─── Document & Fields (PDF Template / Terms / Number Format / Custom Fields) ─
  const [docTab, setDocTab] = useState<"pdf" | "terms" | "number" | "custom">("pdf");

  // PDF Template settings
  const [pdfStatus, setPdfStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const savePdfSettings = async (patch: { custom_pdf_template_enabled?: boolean; document_company_name_display?: string }) => {
    setPdfStatus("saving");
    try {
      const res = await fetch(`${apiHost}/apis/v3/settings/company/${company_id}`, {
        method: "PUT", headers: { "Content-Type": "application/json", ...(authHeaders() || {}) }, body: JSON.stringify(patch),
      });
      if (res.ok) { setSettings(await res.json()); setPdfStatus("saved"); setTimeout(() => setPdfStatus("idle"), 2000); }
      else setPdfStatus("error");
    } catch { setPdfStatus("error"); }
  };

  // ZATCA e-invoicing settings
  const [vatNumber, setVatNumber] = useState("");
  const [zatcaStatus, setZatcaStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  useEffect(() => {
    if (settings) setVatNumber(settings.vat_number ?? "");
  }, [settings]);
  const saveZatca = async (patch: { is_zatca_enable?: boolean; vat_number?: string }) => {
    setZatcaStatus("saving");
    try {
      const res = await fetch(`${apiHost}/apis/v3/settings/company/${company_id}`, {
        method: "PUT", headers: { "Content-Type": "application/json", ...(authHeaders() || {}) }, body: JSON.stringify(patch),
      });
      if (res.ok) { setSettings(await res.json()); setZatcaStatus("saved"); setTimeout(() => setZatcaStatus("idle"), 2000); }
      else setZatcaStatus("error");
    } catch { setZatcaStatus("error"); }
  };

  // Terms & Conditions — 5 independent documents; central source of default T&C
  const TERMS_BOILERPLATE: Record<string, string> = {
    invoice_terms:
      "1. Payment due within 30 days of invoice date.\n2. Interest @ 18% p.a. shall be charged on all overdue amounts.\n3. Goods remain the property of the Company until payment is made in full.\n4. Disputes, if any, shall be subject to the jurisdiction of the Company's registered office.",
    quotation_terms:
      "1. This quotation is valid for 30 days from the date of issue.\n2. Prices are exclusive of applicable taxes unless stated otherwise.\n3. Rates are subject to revision on account of statutory changes.\n4. Confirmation of acceptance is required to proceed with the work.",
    subcon_terms:
      "1. Work Order value is lumpsum inclusive of all labour, tools and applicable taxes unless specified.\n2. Measurements will be taken as per actual completed and approved work.\n3. Statutory compliance (labour, safety) is the sole responsibility of the Subcontractor.\n4. Retention @ 10% shall be deducted and released on satisfactory completion.",
    boq_terms:
      "1. Quantities are indicative and subject to verification at site.\n2. Rates are firm for the contract duration.\n3. Variations require written approval before execution.\n4. All works to be executed as per approved drawings and specifications.",
    purchase_order_terms:
      "1. Delivery within the agreed lead time to the specified site.\n2. Materials to be accompanied by test certificates and valid tax invoices.\n3. Defective or short supplies to be replaced at no extra cost.\n4. Payment released against submission of matched documents.",
  };
  const TERMS_FIELDS: { key: keyof typeof TERMS_BOILERPLATE; label: string }[] = [
    { key: "invoice_terms", label: "Invoice Terms" },
    { key: "quotation_terms", label: "Quotation Terms" },
    { key: "subcon_terms", label: "Subcon Terms" },
    { key: "boq_terms", label: "BOQ Terms" },
    { key: "purchase_order_terms", label: "Purchase Order Terms" },
  ];
  const [terms, setTerms] = useState<Record<string, string>>({
    invoice_terms: "", quotation_terms: "", subcon_terms: "", boq_terms: "", purchase_order_terms: "",
  });
  const [termsLoaded, setTermsLoaded] = useState(false);
  const [termsStatus, setTermsStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const loadTerms = useCallback(() => {
    if (!company_id) return;
    fetch(`${apiHost}/apis/v3/settings/company-terms/${company_id}`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => {
        setTerms({
          invoice_terms: d.invoice_terms || TERMS_BOILERPLATE.invoice_terms,
          quotation_terms: d.quotation_terms || TERMS_BOILERPLATE.quotation_terms,
          subcon_terms: d.subcon_terms || TERMS_BOILERPLATE.subcon_terms,
          boq_terms: d.boq_terms || TERMS_BOILERPLATE.boq_terms,
          purchase_order_terms: d.purchase_order_terms || TERMS_BOILERPLATE.purchase_order_terms,
        });
        setTermsLoaded(true);
      })
      .catch(() => setTermsLoaded(true));
  }, [company_id, apiHost]);
  const saveTerms = async () => {
    setTermsStatus("saving");
    try {
      const res = await fetch(`${apiHost}/apis/v3/settings/company-terms/${company_id}`, {
        method: "PUT", headers: { "Content-Type": "application/json", ...(authHeaders() || {}) }, body: JSON.stringify(terms),
      });
      if (res.ok) { setTermsStatus("saved"); setTimeout(() => setTermsStatus("idle"), 2000); }
      else setTermsStatus("error");
    } catch { setTermsStatus("error"); }
  };

  // Number Format (currency / quantity decimal places)
  const [numFmt, setNumFmt] = useState({ currency_decimal_places: 2, quantity_decimal_places: 3 });
  const [numStatus, setNumStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  useEffect(() => {
    if (settings) {
      setNumFmt({
        currency_decimal_places: settings.currency_decimal_places ?? 2,
        quantity_decimal_places: settings.quantity_decimal_places ?? 3,
      });
    }
  }, [settings]);
  const saveNumFmt = async () => {
    setNumStatus("saving");
    try {
      const res = await fetch(`${apiHost}/apis/v3/settings/company/${company_id}`, {
        method: "PUT", headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          currency_decimal_places: Number(numFmt.currency_decimal_places) || 0,
          quantity_decimal_places: Number(numFmt.quantity_decimal_places) || 0,
        }),
      });
      if (res.ok) { setSettings(await res.json()); setNumStatus("saved"); setTimeout(() => setNumStatus("idle"), 2000); }
      else setNumStatus("error");
    } catch { setNumStatus("error"); }
  };

  // Custom Fields (entity_type-based, wired to /custom-fields)
  const DOC_TYPES = [
    "Project", "Task", "Lead", "Vendor", "Customer", "Invoice", "Bill",
    "Work Order", "Purchase Order", "Quotation", "BOQ", "Payment", "Expense", "Material", "Equipment",
    "Party", "Labour Party", "Sales Invoice", "Subcon Work Order", "Payroll", "CRM Lead",
  ];
  const CF_DATA_TYPES = ["text", "number", "date", "select", "multiselect", "checkbox"];
  const [cfEntity, setCfEntity] = useState(DOC_TYPES[0]);
  const [cfList, setCfList] = useState<CustomField[]>([]);
  const [showAddCf, setShowAddCf] = useState(false);
  const [cfBusy, setCfBusy] = useState(false);
  const [cfMsg, setCfMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [cfDraft, setCfDraft] = useState({ field_name: "", field_type: "text", default_value: "", set_default: false });
  const loadCf = useCallback(() => {
    if (!company_id) return;
    fetch(`${apiHost}/apis/v3/custom-fields/fields/${company_id}?entity_type=${encodeURIComponent(cfEntity)}`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => setCfList(Array.isArray(d) ? d : []))
      .catch(() => setCfList([]));
  }, [company_id, apiHost, cfEntity]);
  useEffect(() => { if (activeSection === "docfields") loadCf(); }, [activeSection, loadCf]);
  useEffect(() => { if (activeSection === "docfields") loadTerms(); }, [activeSection, loadTerms]);
  const addCf = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = cfDraft.field_name.trim();
    if (!name) return;
    setCfBusy(true); setCfMsg(null);
    try {
      const res = await fetch(`${apiHost}/apis/v3/custom-fields/fields`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id, entity_type: cfEntity, field_name: name, field_label: name,
          field_type: cfDraft.field_type, is_required: false, options: [], display_order: cfList.length,
          default_value: cfDraft.set_default ? cfDraft.default_value : null,
          set_default: cfDraft.set_default,
        }),
      });
      if (res.ok) {
        const f = await res.json();
        setCfList([...cfList, f]);
        setCfDraft({ field_name: "", field_type: "text", default_value: "", set_default: false });
        setShowAddCf(false);
        setCfMsg({ type: "ok", text: "Custom field added" });
      } else {
        setCfMsg({ type: "err", text: "Failed to add custom field" });
      }
    } catch {
      setCfMsg({ type: "err", text: "Failed to add custom field" });
    } finally {
      setCfBusy(false);
    }
  };

  // ─── Multi Level Approval (CD-1: only enforcement-wired categories offered) ──
  // Mirrors APPROVAL_FEATURE_TYPES in backend/app/approvals.py (contract-pinned).
  const APPROVAL_CATEGORIES = [
    "Payment Entries", "Payment Request", "Purchase Order",
  ];
  const emptyRuleDraft = () => ({ min_amount: 0, max_amount: "", levels: 1, approvers: "" });
  const [approvalCat, setApprovalCat] = useState(APPROVAL_CATEGORIES[0]);
  const [approvalRules, setApprovalRules] = useState<ApprovalRule[]>([]);
  const [newRule, setNewRule] = useState(emptyRuleDraft);
  const [ruleEdits, setRuleEdits] = useState<Record<string, { min_amount: number; max_amount: string; levels: number; approvers: string }>>({});
  const [ruleBusy, setRuleBusy] = useState(false);
  const [ruleMsg, setRuleMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const loadApprovalRules = useCallback(() => {
    if (!company_id) return;
    fetch(`${apiHost}/apis/v3/settings/approval-rules/${company_id}`, { headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => setApprovalRules(Array.isArray(d) ? d : []))
      .catch(() => setApprovalRules([]));
  }, [company_id, apiHost]);
  useEffect(() => { if (activeSection === "approval") loadApprovalRules(); }, [activeSection, loadApprovalRules]);

  const publishNewRule = async () => {
    if (!newRule.approvers.trim()) { setRuleMsg({ type: "err", text: "Approvers are required" }); return; }
    setRuleBusy(true); setRuleMsg(null);
    try {
      const res = await fetch(`${apiHost}/apis/v3/settings/approval-rules/${company_id}`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          feature_type: approvalCat,
          min_amount: Number(newRule.min_amount) || 0,
          max_amount: newRule.max_amount === "" || newRule.max_amount == null ? null : Number(newRule.max_amount),
          levels: Number(newRule.levels) || 1,
          approvers: newRule.approvers.trim(),
        }),
      });
      if (res.ok) {
        const r = await res.json();
        setApprovalRules([...approvalRules, r]);
        setNewRule(emptyRuleDraft());
        setRuleMsg({ type: "ok", text: "Approval rule published" });
      } else {
        setRuleMsg({ type: "err", text: "Failed to publish approval rule" });
      }
    } catch {
      setRuleMsg({ type: "err", text: "Failed to publish approval rule" });
    } finally {
      setRuleBusy(false);
    }
  };

  const publishEditRule = async (r: ApprovalRule) => {
    const e = ruleEdits[r.id] ?? { min_amount: r.min_amount, max_amount: r.max_amount ?? "", levels: r.levels, approvers: r.approvers };
    setRuleBusy(true); setRuleMsg(null);
    try {
      const res = await fetch(`${apiHost}/apis/v3/settings/approval-rules/${r.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          feature_type: r.feature_type,
          min_amount: Number(e.min_amount) || 0,
          max_amount: e.max_amount === "" || e.max_amount == null ? null : Number(e.max_amount),
          levels: Number(e.levels) || 1,
          approvers: e.approvers.trim(),
        }),
      });
      if (res.ok) {
        const updated = await res.json();
        setApprovalRules(approvalRules.map((x) => (x.id === r.id ? updated : x)));
        setRuleEdits((prev) => { const n = { ...prev }; delete n[r.id]; return n; });
        setRuleMsg({ type: "ok", text: "Approval rule published" });
      } else {
        setRuleMsg({ type: "err", text: "Failed to publish approval rule" });
      }
    } catch {
      setRuleMsg({ type: "err", text: "Failed to publish approval rule" });
    } finally {
      setRuleBusy(false);
    }
  };

  const deleteRule = async (id: string) => {
    const res = await fetch(`${apiHost}/apis/v3/settings/approval-rules/${id}`, { method: "DELETE", headers: authHeaders() });
    if (res.ok || res.status === 404) setApprovalRules(approvalRules.filter((x) => x.id !== id));
  };

  const approveEdit = (id: string, patch: Partial<{ min_amount: number; max_amount: string; levels: number; approvers: string }>) =>
    setRuleEdits((prev) => {
      const base = prev[id] ?? { min_amount: 0, max_amount: "", levels: 1, approvers: "" };
      return { ...prev, [id]: { ...base, ...patch } };
    });

  const approvalRulesForCat = (cat: string) =>
    approvalRules.filter((r) => r.feature_type === cat).sort((a, b) => (a.min_amount || 0) - (b.min_amount || 0));

  // ─── Integrations (Google Sheets — auth/storage layer only) ──────────────────
  const [gsEnabled, setGsEnabled] = useState(false);
  const [gsPhones, setGsPhones] = useState<string[]>([]);
  const [gsPhoneInput, setGsPhoneInput] = useState("");
  const [gsStatus, setGsStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [gsConnection, setGsConnection] = useState<{ connected: boolean; connected_by_phone?: string | null; connected_by_name?: string | null }>({ connected: false });
  useEffect(() => {
    if (!company_id) return;
    const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : "";
    fetch(`${apiHost}/apis/v3/integrations/google-sheets/status/${company_id}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setGsConnection(data); })
      .catch(() => {});
  }, [company_id, apiHost]);
  useEffect(() => {
    if (settings) {
      setGsEnabled(settings.google_sheets_enabled ?? false);
      setGsPhones(Array.isArray(settings.google_sheets_authorized_phones) ? settings.google_sheets_authorized_phones : []);
    }
  }, [settings]);
  const saveGs = async (patch: { google_sheets_enabled?: boolean; google_sheets_authorized_phones?: string[] }) => {
    setGsStatus("saving");
    try {
      const res = await fetch(`${apiHost}/apis/v3/settings/company/${company_id}`, {
        method: "PUT", headers: { "Content-Type": "application/json", ...(authHeaders() || {}) }, body: JSON.stringify(patch),
      });
      if (res.ok) { setSettings(await res.json()); setGsStatus("saved"); setTimeout(() => setGsStatus("idle"), 2000); }
      else setGsStatus("error");
    } catch { setGsStatus("error"); }
  };
  const addGsPhone = () => {
    const p = gsPhoneInput.trim();
    if (!p) return;
    const next = gsPhones.includes(p) ? gsPhones : [...gsPhones, p];
    setGsPhones(next); setGsPhoneInput(""); saveGs({ google_sheets_authorized_phones: next });
  };
  const removeGsPhone = (p: string) => {
    const next = gsPhones.filter((x) => x !== p);
    setGsPhones(next); saveGs({ google_sheets_authorized_phones: next });
  };

  // ─── Integrations: Google Drive (OAuth backup) ──────────────────────────────
  const [gdConnected, setGdConnected] = useState(false);
  const [gdBusy, setGdBusy] = useState(false);
  const [gdMsg, setGdMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  useEffect(() => {
    if (!company_id) return;
    const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : "";
    fetch(`${apiHost}/apis/v3/integrations/google-drive/status/${company_id}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setGdConnected(Boolean(data.connected)); })
      .catch(() => {});
  }, [company_id, apiHost]);
  const connectDrive = async () => {
    setGdBusy(true); setGdMsg(null);
    try {
      const res = await fetch(`${apiHost}/apis/v3/integrations/google-drive/authorize?company_id=${company_id}`, { headers: authHeaders() });
      if (!res.ok) { setGdMsg({ type: "err", text: (await res.text()) || "Could not start Google Drive connect" }); return; }
      const data = await res.json();
      if (data.consent_url) { window.location.href = data.consent_url; return; }
      setGdMsg({ type: "err", text: "Missing consent URL" });
    } catch (e: any) { setGdMsg({ type: "err", text: e?.message || "error" }); }
    finally { setGdBusy(false); }
  };
  const disconnectDrive = async () => {
    setGdBusy(true); setGdMsg(null);
    try {
      const res = await fetch(`${apiHost}/apis/v3/integrations/google-drive/companies/${company_id}/connection`, { method: "DELETE", headers: authHeaders() });
      if (res.ok) { setGdConnected(false); setGdMsg({ type: "ok", text: "Google Drive disconnected" }); }
      else setGdMsg({ type: "err", text: "Failed to disconnect Google Drive" });
    } catch { setGdMsg({ type: "err", text: "Failed to disconnect Google Drive" }); }
    finally { setGdBusy(false); }
  };

  // ─── Integrations: Zoho Books (OAuth accounting) ──────────────────────────
  const [zbConnected, setZbConnected] = useState(false);
  const [zbBusy, setZbBusy] = useState(false);
  const [zbMsg, setZbMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  useEffect(() => {
    if (!company_id) return;
    const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : "";
    fetch(`${apiHost}/apis/v3/integrations/zoho-books/status/${company_id}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setZbConnected(Boolean(data.connected)); })
      .catch(() => {});
  }, [company_id, apiHost]);
  const connectZoho = async () => {
    setZbBusy(true); setZbMsg(null);
    try {
      const res = await fetch(`${apiHost}/apis/v3/integrations/zoho-books/authorize?company_id=${company_id}`, { headers: authHeaders() });
      if (!res.ok) { setZbMsg({ type: "err", text: (await res.text()) || "Could not start Zoho Books connect" }); return; }
      const data = await res.json();
      if (data.consent_url) { window.location.href = data.consent_url; return; }
      setZbMsg({ type: "err", text: "Missing consent URL" });
    } catch (e: any) { setZbMsg({ type: "err", text: e?.message || "error" }); }
    finally { setZbBusy(false); }
  };
  const disconnectZoho = async () => {
    setZbBusy(true); setZbMsg(null);
    try {
      const res = await fetch(`${apiHost}/apis/v3/integrations/zoho-books/companies/${company_id}/connection`, { method: "DELETE", headers: authHeaders() });
      if (res.ok) { setZbConnected(false); setZbMsg({ type: "ok", text: "Zoho Books disconnected" }); }
      else setZbMsg({ type: "err", text: "Failed to disconnect Zoho Books" });
    } catch { setZbMsg({ type: "err", text: "Failed to disconnect Zoho Books" }); }
    finally { setZbBusy(false); }
  };

  // ─── Integrations: Tally (accounting sync) ─────────────────────────────────
  const [tallyConn, setTallyConn] = useState<{ connected: boolean; tally_company_name?: string } | null>(null);
  useEffect(() => {
    if (!company_id) return;
    fetch(`${apiHost}/apis/v3/tally/connections?company_id=${company_id}`, { headers: authHeaders() })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && typeof data.connected === "boolean") {
          setTallyConn({ connected: data.connected, tally_company_name: data.tally_company_name });
        } else {
          setTallyConn({ connected: false });
        }
      })
      .catch(() => setTallyConn({ connected: false }));
  }, [company_id, apiHost]);

  // ─── Integrations: BI Data Export (API keys) ───────────────────────────────
  interface BiKey { id: string; label: string; masked_key: string; created_at: string | null; last_used_at: string | null; revoked: boolean; }
  const [biKeys, setBiKeys] = useState<BiKey[]>([]);
  const [biLabel, setBiLabel] = useState("");
  const [biNewKey, setBiNewKey] = useState<string | null>(null);
  const [biBusy, setBiBusy] = useState(false);
  const [biMsg, setBiMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const loadBiKeys = async () => {
    try {
      const res = await fetch(`${apiHost}/apis/v3/integrations/bi/companies/${company_id}/keys`, { headers: authHeaders() });
      if (res.ok) setBiKeys(await res.json());
    } catch { /* leave as-is */ }
  };
  useEffect(() => { if (company_id) loadBiKeys(); }, [company_id, apiHost]);
  const createBiKey = async () => {
    setBiBusy(true); setBiMsg(null); setBiNewKey(null);
    try {
      const res = await fetch(`${apiHost}/apis/v3/integrations/bi/companies/${company_id}/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ label: biLabel || "—" }),
      });
      if (!res.ok) { setBiMsg({ type: "err", text: "Failed to create API key" }); return; }
      const data = await res.json();
      setBiNewKey(data.key);
      setBiLabel("");
      await loadBiKeys();
    } catch { setBiMsg({ type: "err", text: "Failed to create API key" }); }
    finally { setBiBusy(false); }
  };
  const revokeBiKey = async (id: string) => {
    try {
      const res = await fetch(`${apiHost}/apis/v3/integrations/bi/companies/${company_id}/keys/${id}`, { method: "DELETE", headers: authHeaders() });
      if (res.ok) {
        await loadBiKeys();
      } else {
        const err = await readErrorDetail(res);
        setBiMsg({ type: "err", text: err || "Failed to revoke API key" });
      }
    } catch {
      setBiMsg({ type: "err", text: "Failed to revoke API key" });
    }
  };

  // ─── Subscription (display-only; no billing UI) ──────────────────────────────
  const fmtDate = (d?: string | null) => formatDate(d);

  const validateGSTIN = (g: string) => /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(g.toUpperCase());
  const [gstinError, setGstinError] = useState(false);

  const saveDetails = async () => {
    if (!settings) return;
    setSaveStatus("saving");
    try {
      const res = await fetch(`${apiHost}/apis/v3/settings/company/${company_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify(cDraft),
      });
      if (res.ok) { setSettings(await res.json()); setSaveStatus("saved"); setTimeout(() => setSaveStatus("idle"), 2000); }
      else setSaveStatus("error");
    } catch { setSaveStatus("error"); }
  };

  // ─── Business Profile draft + save ──────────────────────────────────────────
  const [bSeg, setBSeg] = useState<string | null>(null);
  const [bSize, setBSize] = useState<string | null>(null);
  const [bTypes, setBTypes] = useState<string[]>([]);
  const [ctypeInput, setCtypeInput] = useState("");
  useEffect(() => {
    if (settings) {
      setBSeg(settings.business_segment ?? null);
      setBSize(settings.company_size ?? null);
      setBTypes(settings.construction_types ?? []);
    }
  }, [settings]);
  const toggleCType = (t: string) => setBTypes((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]);
  const addCType = () => { const v = ctypeInput.trim(); if (v && !bTypes.includes(v)) setBTypes([...bTypes, v]); setCtypeInput(""); };
  const saveBusiness = async () => {
    setSaveStatus("saving");
    try {
      const res = await fetch(`${apiHost}/apis/v3/settings/company/${company_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ business_segment: bSeg, company_size: bSize, construction_types: bTypes }),
      });
      if (res.ok) { setSettings(await res.json()); setSaveStatus("saved"); setTimeout(() => setSaveStatus("idle"), 2000); }
      else setSaveStatus("error");
    } catch { setSaveStatus("error"); }
  };

  // ─── Branding uploads ───────────────────────────────────────────────────────
  const uploadAsset = async (type: "logo" | "signature" | "stamp" | "watermark", file: File) => {
    setUploading(type);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${apiHost}/apis/v3/settings/company-file/${company_id}?asset_type=${type}`, { method: "POST", headers: authHeaders(), body: fd });
      if (res.ok) {
        setSettings((prev) => prev ? {
          ...prev,
          logo_url: type === "logo" ? `${apiHost}/apis/v3/settings/company-file/${company_id}/logo?v=${Date.now()}` : prev.logo_url,
          signature_url: type === "signature" ? `${apiHost}/apis/v3/settings/company-file/${company_id}/signature?v=${Date.now()}` : prev.signature_url,
          stamp_url: type === "stamp" ? `${apiHost}/apis/v3/settings/company-file/${company_id}/stamp?v=${Date.now()}` : prev.stamp_url,
          watermark_url: type === "watermark" ? `${apiHost}/apis/v3/settings/company-file/${company_id}/watermark?v=${Date.now()}` : prev.watermark_url,
        } : prev);
      } else {
        const err = await readErrorDetail(res);
        setError(err || 'Action failed');
      }
    } finally { setUploading(null); }
  };

  // ─── Branches ───────────────────────────────────────────────────────────────
  const [showAddBranch, setShowAddBranch] = useState(false);
  const [nb, setNb] = useState({ branch_name: "", gstin: "", geo_location: "", address_line1: "", city: "", state: "", zip: "", country: "India" });
  const addBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    const billing = [nb.address_line1, [nb.city, nb.state].filter(Boolean).join(", "), nb.zip, nb.country].filter(Boolean).join(", ") || nb.geo_location;
    try {
      const res = await fetch(`${apiHost}/apis/v3/settings/branches/${company_id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ ...nb, billing_address: billing }),
      });
      if (res.ok) { const added = await res.json(); setBranches([...branches, added]); setNb({ branch_name: "", gstin: "", geo_location: "", address_line1: "", city: "", state: "", zip: "", country: "India" }); setShowAddBranch(false); } else {
        const err = await readErrorDetail(res);
        setError(err || 'Action failed');
      }
    } catch (err) { console.error(err); }
  };
  const setPrimary = async (id: string) => {
    const res = await fetch(`${apiHost}/apis/v3/settings/branches/${id}/primary`, { method: "PATCH", headers: authHeaders() });
    if (res.ok) { const updated = await res.json(); setBranches(branches.map((b) => ({ ...b, is_primary: b.id === id }))); void updated; } else {
        const err = await readErrorDetail(res);
        setError(err || 'Action failed');
      }
  };

  // ─── Roles & Access (flat list of roles) ──────────────────────────────────
  const [roles, setRoles] = useState<Role[]>([]);
  const [permRole, setPermRole] = useState<RoleForEditor | null>(null);
  const [roleName, setRoleName] = useState("");
  const [showAddRole, setShowAddRole] = useState(false);
  const [roleBusy, setRoleBusy] = useState(false);
  const [roleMsg, setRoleMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const loadRoles = useCallback(() => {
    if (!company_id) return;
    fetch(`${apiHost}/apis/v3/settings/roles/${company_id}`, { headers: authHeaders() })
      .then((res) => res.json())
      .then((data) => setRoles(Array.isArray(data) ? data : []))
      .catch(() => setRoles([]));
  }, [company_id, apiHost]);

  useEffect(() => { if (activeSection === "roles") loadRoles(); }, [activeSection, loadRoles]);

  const addRole = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = roleName.trim();
    if (!name) return;
    setRoleBusy(true); setRoleMsg(null);
    try {
      const res = await fetch(`${apiHost}/apis/v3/settings/roles/${company_id}`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ role_name: name }),
      });
      if (res.ok) {
        const r = await res.json();
        setRoles([...roles, r]); setRoleName(""); setShowAddRole(false);
        setRoleMsg({ type: "ok", text: "Role added" });
      } else if (res.status === 409) {
        setRoleMsg({ type: "err", text: "Role already exists" });
      } else {
        setRoleMsg({ type: "err", text: "Failed to add role" });
      }
    } catch {
      setRoleMsg({ type: "err", text: "Failed to add role" });
    } finally {
      setRoleBusy(false);
    }
  };

  const seedRoles = async () => {
    setRoleBusy(true); setRoleMsg(null);
    try {
      const res = await fetch(`${apiHost}/apis/v3/settings/roles/seed/${company_id}`, { method: "POST", headers: authHeaders() });
      if (res.ok) {
        const created = await res.json();
        loadRoles();
        setRoleMsg({ type: "ok", text: `Added ${created.length} standard role${created.length === 1 ? "" : "s"}` });
      } else if (res.status === 409) {
        setRoleMsg({ type: "err", text: "The standard roles are already added" });
      } else {
        setRoleMsg({ type: "err", text: "Could not add the standard roles" });
      }
    } catch {
      setRoleMsg({ type: "err", text: "Could not add the standard roles" });
    } finally {
      setRoleBusy(false);
    }
  };

  const deleteRole = async (r: { id: string; role_name: string }) => {
    if (!confirm(`Delete the role "${r.role_name}"?`)) return;
    setRoleBusy(true); setRoleMsg(null);
    try {
      const res = await fetch(`${apiHost}/apis/v3/settings/roles/${r.id}`, { method: "DELETE", headers: authHeaders() });
      if (res.ok) {
        setRoles((prev) => prev.filter((x) => x.id !== r.id));
        setRoleMsg({ type: "ok", text: `Deleted ${r.role_name}` });
      } else {
        setRoleMsg({ type: "err", text: (await readErrorDetail(res)) || "Could not delete the role" });
      }
    } catch {
      setRoleMsg({ type: "err", text: "Could not delete the role" });
    } finally {
      setRoleBusy(false);
    }
  };

  // ─── Payroll Settings (company-level statutory defaults) ───────────────────
  const [payroll, setPayroll] = useState<PayrollSettings | null>(null);
  const [pDraft, setPDraft] = useState({
    pf_employee_pct: 12, pf_employer_pct: 12, esi_employee_pct: 0.75,
    esi_employer_pct: 3.25, tds_monthly: 0, is_esi_applicable: true,
    pf_wage_ceiling: 15000,
    assume_full_month_when_no_attendance: false,
  });
  const [payrollStatus, setPayrollStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [payrollError, setPayrollError] = useState<string | null>(null);
  const [showPayrollConfirm, setShowPayrollConfirm] = useState(false);

  const getPayrollDiff = () => {
    const diffs: string[] = [];
    if (!payroll) return diffs;
    if (Number(pDraft.pf_employee_pct) !== Number(payroll.pf_employee_pct)) {
      diffs.push(`PF Employee Rate: ${payroll.pf_employee_pct}% → ${pDraft.pf_employee_pct}%`);
    }
    if (Number(pDraft.pf_employer_pct) !== Number(payroll.pf_employer_pct)) {
      diffs.push(`PF Employer Rate: ${payroll.pf_employer_pct}% → ${pDraft.pf_employer_pct}%`);
    }
    if (Number(pDraft.esi_employee_pct) !== Number(payroll.esi_employee_pct)) {
      diffs.push(`ESI Employee Rate: ${payroll.esi_employee_pct}% → ${pDraft.esi_employee_pct}%`);
    }
    if (Number(pDraft.esi_employer_pct) !== Number(payroll.esi_employer_pct)) {
      diffs.push(`ESI Employer Rate: ${payroll.esi_employer_pct}% → ${pDraft.esi_employer_pct}%`);
    }
    if (Number(pDraft.tds_monthly) !== Number(payroll.tds_monthly)) {
      diffs.push(`TDS Monthly: ₹${payroll.tds_monthly} → ₹${pDraft.tds_monthly}`);
    }
    if (Boolean(pDraft.is_esi_applicable) !== Boolean(payroll.is_esi_applicable)) {
      diffs.push(`ESI Applicable: ${payroll.is_esi_applicable ? "Yes" : "No"} → ${pDraft.is_esi_applicable ? "Yes" : "No"}`);
    }
    if (Number(pDraft.pf_wage_ceiling) !== Number(payroll.pf_wage_ceiling ?? 15000)) {
      diffs.push(`PF Wage Ceiling: ₹${payroll.pf_wage_ceiling ?? 15000} → ₹${pDraft.pf_wage_ceiling}`);
    }
    if (Boolean(pDraft.assume_full_month_when_no_attendance) !== Boolean(payroll.assume_full_month_when_no_attendance ?? false)) {
      diffs.push(`Assume Full Month on Zero Attendance: ${payroll.assume_full_month_when_no_attendance ? "Enabled" : "Disabled"} → ${pDraft.assume_full_month_when_no_attendance ? "Enabled" : "Disabled"}`);
    }
    return diffs;
  };

  const loadPayroll = useCallback(() => {
    if (!company_id) return;
    fetch(`${apiHost}/apis/v3/settings/payroll/${company_id}`, { headers: authHeaders() })
      .then((res) => res.json())
      .then((data) => {
        setPayroll(data);
        setPDraft({
          pf_employee_pct: data.pf_employee_pct, pf_employer_pct: data.pf_employer_pct,
          esi_employee_pct: data.esi_employee_pct, esi_employer_pct: data.esi_employer_pct,
          tds_monthly: data.tds_monthly, is_esi_applicable: data.is_esi_applicable,
          pf_wage_ceiling: data.pf_wage_ceiling ?? 15000,
          assume_full_month_when_no_attendance: data.assume_full_month_when_no_attendance ?? false,
        });
      })
      .catch(() => {});
  }, [company_id, apiHost]);

  useEffect(() => { if (activeSection === "payroll") loadPayroll(); }, [activeSection, loadPayroll]);

  const handleSavePayrollClick = () => {
    setPayrollError(null);
    const diffs = getPayrollDiff();
    if (diffs.length > 0) {
      setShowPayrollConfirm(true);
    } else {
      savePayroll(false);
    }
  };

  const savePayroll = async (confirmed: boolean = false) => {
    setPayrollStatus("saving");
    setPayrollError(null);
    try {
      const res = await fetch(`${apiHost}/apis/v3/settings/payroll/${company_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          ...pDraft,
          confirm_changes: confirmed,
        }),
      });
      if (res.ok) {
        const updated = await res.json();
        setPayroll(updated);
        setPayrollStatus("saved");
        setShowPayrollConfirm(false);
        setTimeout(() => setPayrollStatus("idle"), 2000);
      } else {
        const err = await readErrorDetail(res);
        setPayrollError(err || "Failed to save statutory payroll settings");
        setPayrollStatus("error");
        setShowPayrollConfirm(false);
      }
    } catch (e: any) {
      setPayrollError(e?.message || "Failed to save payroll settings. Check your connection.");
      setPayrollStatus("error");
      setShowPayrollConfirm(false);
    }
  };

  // ─── Payroll sub-tabs: Leave Policy | Holiday Calendar | Salary Template | Statutory ──
  const [payrollTab, setPayrollTab] = useState<"leave" | "holiday" | "salary" | "statutory">("leave");
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // Leave Policy
  const [leaveTemplates, setLeaveTemplates] = useState<LeaveTemplate[]>([]);
  const [showAddLeave, setShowAddLeave] = useState(false);
  const [ltBusy, setLtBusy] = useState(false);
  const [ltName, setLtName] = useState("");
  const [ltTypes, setLtTypes] = useState<{ type: string; days: number }[]>([{ type: "", days: 0 }]);
  const addLtType = () => setLtTypes([...ltTypes, { type: "", days: 0 }]);
  const editLtType = (i: number, key: "type" | "days", val: any) =>
    setLtTypes(ltTypes.map((t, j) => (j === i ? { ...t, [key]: val } : t)));
  const removeLtType = (i: number) => setLtTypes(ltTypes.filter((_, j) => j !== i));
  const createLeaveTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ltName.trim()) return;
    const rows = ltTypes.filter((t) => t.type.trim()).map((t) => ({ type: t.type.trim(), days: Number(t.days) || 0 }));
    setLtBusy(true);
    try {
      const res = await fetch(`${apiHost}/apis/v3/hr/leave-templates/${company_id}`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ name: ltName.trim(), leave_types: rows }),
      });
      if (res.ok) {
        const t = await res.json();
        setLeaveTemplates([...leaveTemplates, t]);
        setLtName("");
        setLtTypes([{ type: "", days: 0 }]);
        setShowAddLeave(false);
      } else {
        const err = await res.json().catch(() => ({}));
        alert(detailToMessage(err.detail, "Failed to create leave template"));
      }
    } catch (e: any) {
      alert(e?.message || "Network error creating leave template");
    } finally {
      setLtBusy(false);
    }
  };
  const deleteLeaveTemplate = async (id: string) => {
    try {
      const res = await fetch(`${apiHost}/apis/v3/hr/leave-templates/${id}`, { method: "DELETE", headers: authHeaders() });
      if (res.ok) {
        setLeaveTemplates(leaveTemplates.filter((t) => t.id !== id));
      } else {
        const err = await res.json().catch(() => ({}));
        alert(detailToMessage(err.detail, "Failed to delete leave template"));
      }
    } catch (e: any) {
      alert(e?.message || "Network error deleting leave template");
    }
  };

  // Holiday Calendar
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [showAddHoliday, setShowAddHoliday] = useState(false);
  const [hName, setHName] = useState("");
  const [hDate, setHDate] = useState("");
  const createHoliday = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hName.trim() || !hDate) return;
    try {
      const res = await fetch(`${apiHost}/apis/v3/hr/holidays/${company_id}`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ name: hName.trim(), date: hDate }),
      });
      if (res.ok) { const h = await res.json(); setHolidays([...holidays, h]); setHName(""); setHDate(""); setShowAddHoliday(false); } else {
        const err = await readErrorDetail(res);
        setError(err || 'Action failed');
      }
    } catch { /* ignore */ }
  };
  const deleteHoliday = async (id: string) => {
    try {
      const res = await fetch(`${apiHost}/apis/v3/hr/holidays/${id}`, { method: "DELETE", headers: authHeaders() });
      if (res.ok) {
        setHolidays(holidays.filter((h) => h.id !== id));
      } else {
        const err = await readErrorDetail(res);
        setError(err || "Failed to delete holiday");
      }
    } catch {
      setError("Failed to delete holiday");
    }
  };

  // Salary Template (reusable named salary breakup cascade)
  const [salaryTemplates, setSalaryTemplates] = useState<SalaryTemplate[]>([]);
  const [showAddSalary, setShowAddSalary] = useState(false);
  const [stName, setStName] = useState("");
  const [stDesc, setStDesc] = useState("");
  const [stCtc, setStCtc] = useState(0);
  const [stDayOff, setStDayOff] = useState("Sunday");
  const [stBasicPct, setStBasicPct] = useState(40);
  const [stAllowances, setStAllowances] = useState<{ name: string; amount: number }[]>([]);
  const [stDeductions, setStDeductions] = useState<{ name: string; amount: number }[]>([]);
  const stBasic = Math.round(stCtc * (stBasicPct / 100) * 100) / 100;
  const stFixedAllowance = Math.round(stAllowances.reduce((s, a) => s + (a.amount || 0), 0) * 100) / 100;
  const stGross = Math.round((stBasic + stFixedAllowance) * 100) / 100;
  const stTotalDed = Math.round(stDeductions.reduce((s, d) => s + (d.amount || 0), 0) * 100) / 100;
  const stNet = Math.round((stGross - stTotalDed) * 100) / 100;
  const editLine = (list: { name: string; amount: number }[], set: (v: { name: string; amount: number }[]) => void, idx: number, key: "name" | "amount", val: any) =>
    set(list.map((x, j) => (j === idx ? { ...x, [key]: val } : x)));
  const resetSt = () => { setStName(""); setStDesc(""); setStCtc(0); setStDayOff("Sunday"); setStBasicPct(40); setStAllowances([]); setStDeductions([]); };
  const createSalaryTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stName.trim()) return;
    try {
      const res = await fetch(`${apiHost}/apis/v3/settings/salary-templates/${company_id}`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          name: stName.trim(), description: stDesc.trim() || null, status: "Active",
          breakup: { monthly_ctc: stCtc, day_off: stDayOff, basic_pct: stBasicPct, basic: stBasic,
            allowances: stAllowances, gross: stGross, deductions: stDeductions, net: stNet },
        }),
      });
      if (res.ok) { const t = await res.json(); setSalaryTemplates([...salaryTemplates, t]); resetSt(); setShowAddSalary(false); } else {
        const err = await readErrorDetail(res);
        setError(err || 'Action failed');
      }
    } catch { /* ignore */ }
  };
  const deleteSalaryTemplate = async (id: string) => {
    try {
      const res = await fetch(`${apiHost}/apis/v3/settings/salary-templates/${id}`, { method: "DELETE", headers: authHeaders() });
      if (res.ok) {
        setSalaryTemplates(salaryTemplates.filter((t) => t.id !== id));
      } else {
        const err = await readErrorDetail(res);
        setError(err || "Failed to delete salary template");
      }
    } catch {
      setError("Failed to delete salary template");
    }
  };

  const loadPayrollSubs = useCallback(() => {
    if (!company_id) return;
    fetch(`${apiHost}/apis/v3/hr/leave-templates/${company_id}`, { headers: authHeaders() }).then((r) => r.json()).then((d) => setLeaveTemplates(Array.isArray(d) ? d : [])).catch(() => {});
    fetch(`${apiHost}/apis/v3/hr/holidays/${company_id}`, { headers: authHeaders() }).then((r) => r.json()).then((d) => setHolidays(Array.isArray(d) ? d : [])).catch(() => {});
    fetch(`${apiHost}/apis/v3/settings/salary-templates/${company_id}`, { headers: authHeaders() }).then((r) => r.json()).then((d) => setSalaryTemplates(Array.isArray(d) ? d : [])).catch(() => {});
  }, [company_id, apiHost]);
  useEffect(() => { if (activeSection === "payroll") loadPayrollSubs(); }, [activeSection, loadPayrollSubs]);

  useEffect(() => {
    if (activeSection === "holiday") {
      fetch(`${apiHost}/apis/v3/hr/holidays/${company_id}`, { headers: authHeaders() })
        .then((r) => r.json())
        .then((d) => setHolidays(Array.isArray(d) ? d : []))
        .catch(() => setHolidays([]));
    }
  }, [activeSection, company_id, apiHost]);

  const primaryBranch = branches.find((b) => b.is_primary);
  const otherCount = branches.length - (primaryBranch ? 1 : 0);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-card text-muted">
        <div className="text-center space-y-4">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-border-custom border-t-transparent mx-auto" />
          <div>Loading Settings...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Left section nav */}
      <aside className="w-60 shrink-0 border-r border-border-custom bg-card p-4 overflow-y-auto">
        <div className="px-2 pb-4 text-[10px] uppercase tracking-[0.2em] text-muted font-bold">Settings</div>
        <nav className="space-y-1">
          {visibleSections.map((s) => (
            <button
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              className={`w-full text-left px-3 py-2.5 rounded-md text-xs font-bold transition-all duration-200 ${
                activeSection === s.id ? "bg-primary text-white" : "text-muted hover:text-foreground hover:bg-elevated"
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <PageShell width="wide">
          <PageHeader
            title={SECTIONS.find((s) => s.id === activeSection)?.label || "Settings"}
            subtitle="Configure company-wide settings for this organization."
          >
            <PwaControls />
          </PageHeader>

          {error && (
            <div className="mt-6 p-4 bg-danger/10 border border-danger/20 text-danger text-xs rounded-lg">{error}</div>
          )}
          {saveStatus === "saved" && (
            <div className="mt-6 p-4 bg-success/10 border border-success/20 text-success text-xs rounded-lg">Settings saved successfully</div>
          )}
          {saveStatus === "error" && (
            <div className="mt-6 p-4 bg-danger/10 border border-danger/20 text-danger text-xs rounded-lg">Failed to save settings. Please try again.</div>
          )}

          <div className="mt-8">
            {/* ════════════════════════════ USER PROFILE ════════════════════════════ */}
            {activeSection === "profile" && (
              <div className="bg-card border border-border-custom rounded-lg p-6 space-y-6 max-w-2xl">
                <div>
                  <h2 className="text-sm font-bold text-foreground uppercase tracking-wider text-muted border-b border-border-custom pb-3">User Profile</h2>
                  <p className="text-xs text-muted mt-2">Update your personal display name shown across assignments, audit logs, and reports.</p>
                </div>

                {profileMsg && (
                  <div className={`p-4 rounded-lg text-xs font-semibold ${profileMsg.type === "ok" ? "bg-success/10 border border-success/20 text-success" : "bg-danger/10 border border-danger/20 text-danger"}`}>
                    {profileMsg.text}
                  </div>
                )}

                <form onSubmit={saveProfile} className="space-y-4">
                  <Field label="Display Name">
                    <input
                      type="text"
                      value={profileData.name}
                      onChange={(e) => setProfileData({ ...profileData, name: e.target.value })}
                      placeholder="Your full name"
                      className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-4 py-2.5 text-xs text-foreground outline-none font-medium"
                    />
                  </Field>

                  <Field label="Email Address">
                    <input
                      type="email"
                      value={profileData.email || "—"}
                      disabled
                      className="w-full bg-elevated/50 border border-border-custom text-muted rounded-md px-4 py-2.5 text-xs outline-none cursor-not-allowed"
                    />
                  </Field>

                  {profileData.mobile && (
                    <Field label="Phone Number">
                      <input
                        type="text"
                        value={profileData.mobile}
                        disabled
                        className="w-full bg-elevated/50 border border-border-custom text-muted rounded-md px-4 py-2.5 text-xs outline-none cursor-not-allowed"
                      />
                    </Field>
                  )}

                  <div className="pt-2">
                    <button
                      type="submit"
                      disabled={profileSaving}
                      className="px-5 py-2.5 bg-primary hover:bg-primary/90 text-white rounded-md text-xs font-bold transition-all disabled:opacity-50 cursor-pointer"
                    >
                      {profileSaving ? "Saving..." : "Save Display Name"}
                    </button>
                  </div>
                </form>
              </div>
            )}

            {/* ════════════════════════════ COMPANY ════════════════════════════ */}
            {activeSection === "company" && settings && (
              <div className="space-y-6">
                <div className="flex border-b border-border-custom gap-1 bg-elevated p-1 rounded-lg w-max">
                  {([["details", "Company Details"], ["branches", "Branches"], ["business", "Business Profile"]] as const).map(([id, label]) => (
                    <button key={id} onClick={() => setCompanyTab(id)}
                      className={`px-5 py-2.5 rounded-md text-xs font-bold transition-all duration-200 ${
                        companyTab === id ? "bg-primary text-white" : "text-muted hover:text-foreground hover:bg-elevated"
                      }`}>
                      {label}
                    </button>
                  ))}
                </div>

                {/* Company Details */}
                {companyTab === "details" && (
                  <div className="bg-card border border-border-custom rounded-lg p-6 space-y-6">
                    <h2 className="text-sm font-bold text-foreground uppercase tracking-wider text-muted border-b border-border-custom pb-3">Company Details</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <Field label="Company Name">
                        <input type="text" value={cDraft.name} onChange={(e) => setCDraft({ ...cDraft, name: e.target.value })}
                          className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-4 py-2.5 text-xs text-foreground outline-none" />
                      </Field>
                      <Field label="Phone Number">
                        <input type="text" value={cDraft.phone} onChange={(e) => setCDraft({ ...cDraft, phone: e.target.value })}
                          className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-4 py-2.5 text-xs text-foreground outline-none" placeholder="Company phone number" />
                      </Field>
                      <Field label="Legal Business Name">
                        <input type="text" value={cDraft.legal_business_name} onChange={(e) => setCDraft({ ...cDraft, legal_business_name: e.target.value })}
                          className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-4 py-2.5 text-xs text-foreground outline-none" placeholder="Enter Legal Entity Name" />
                      </Field>
                      <Field label="GSTIN">
                        <input type="text" value={cDraft.gstin} onChange={(e) => { const v = e.target.value.toUpperCase(); setCDraft({ ...cDraft, gstin: v }); setGstinError(v ? !validateGSTIN(v) : false); }}
                          className={`w-full bg-elevated border rounded-md px-4 py-2.5 text-xs text-foreground outline-none ${gstinError ? "border-danger" : "border-border-custom focus:border-primary"}`} placeholder="Enter 15-digit GSTIN" />
                        {gstinError && <p className="text-[10px] text-danger mt-1">Invalid GSTIN format.</p>}
                      </Field>
                    </div>
                    <Field label="Company Primary Address">
                      <textarea value={cDraft.billing_address} onChange={(e) => setCDraft({ ...cDraft, billing_address: e.target.value })}
                        rows={3} className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-4 py-2.5 text-xs text-foreground outline-none resize-none" placeholder="Registered business address" />
                    </Field>

                    {/* Branding upload slots */}
                    <div>
                      <h3 className="text-[10px] uppercase tracking-wider text-muted font-bold mb-3">Branding Assets</h3>
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                        {ASSET_LABELS.map(({ type, label }) => {
                          const url = settings[`${type}_url` as keyof CompanySettings] as string | null | undefined;
                          return (
                            <div key={type} className="border border-dashed border-border-custom rounded-lg p-3 flex flex-col items-center gap-2">
                              <div className="h-20 w-full flex items-center justify-center rounded-md bg-elevated overflow-hidden">
                                {url ? (
                                  <AuthImage
                                    src={url.startsWith("/settings/") ? `/apis/v3${url}` : url}
                                    alt={label}
                                    className="max-h-20 max-w-full object-contain"
                                    fallback={<span className="text-[10px] text-muted">{label}</span>}
                                  />
                                ) : <span className="text-[10px] text-muted">{label}</span>}
                              </div>
                              <div className="text-[10px] text-muted font-bold">{label}</div>
                              <input type="file" accept="image/*" id={`up-${type}`} className="hidden"
                                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAsset(type, f); }} />
                              <label htmlFor={`up-${type}`} className="text-[10px] bg-primary/10 text-primary border border-primary/20 px-3 py-1 rounded-md cursor-pointer hover:bg-primary/20">
                                {uploading === type ? "Uploading…" : url ? "Replace" : "Upload"}
                              </label>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="flex justify-end">
                      <button onClick={saveDetails} disabled={gstinError} className="bg-primary text-white text-xs font-bold px-6 py-2.5 rounded-md disabled:opacity-50">
                        Save
                      </button>
                    </div>
                  </div>
                )}

                {/* Branches */}
                {companyTab === "branches" && (
                  <div className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <StatCard label="Total Branches" value={String(branches.length)} />
                      <StatCard label="Primary Branch" value={primaryBranch ? `${primaryBranch.branch_name}${primaryBranch.city ? ` · ${primaryBranch.city}` : ""}` : "—"} />
                      <StatCard label="Other Branches" value={String(otherCount)} />
                    </div>

                    <div className="flex items-center justify-between">
                      <h2 className="text-sm font-bold text-foreground uppercase tracking-wider text-muted">Company Branches</h2>
                      <button onClick={() => setShowAddBranch(true)} className="bg-primary text-white text-xs font-bold px-4 py-2.5 rounded-md">+ New Branch</button>
                    </div>

                    {showAddBranch && (
                      <form onSubmit={addBranch} className="bg-card border border-border-custom rounded-lg p-6 space-y-4">
                        <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">New Branch Details</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <input type="text" placeholder="Branch Name" value={nb.branch_name} onChange={(e) => setNb({ ...nb, branch_name: e.target.value })} required className="bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                          <input type="text" placeholder="Branch GSTIN" value={nb.gstin} onChange={(e) => setNb({ ...nb, gstin: e.target.value })} required className="bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                        </div>
                        <textarea placeholder="Project Geo Location (Google Address)" value={nb.geo_location} onChange={(e) => setNb({ ...nb, geo_location: e.target.value })} rows={2} className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none resize-none" />
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <input type="text" placeholder="Address Line 1" value={nb.address_line1} onChange={(e) => setNb({ ...nb, address_line1: e.target.value })} className="bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                          <input type="text" placeholder="City" value={nb.city} onChange={(e) => setNb({ ...nb, city: e.target.value })} className="bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                          <input type="text" placeholder="State / Province" value={nb.state} onChange={(e) => setNb({ ...nb, state: e.target.value })} className="bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                          <input type="text" placeholder="Zip" value={nb.zip} onChange={(e) => setNb({ ...nb, zip: e.target.value })} className="bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                          <select value={nb.country} onChange={(e) => setNb({ ...nb, country: e.target.value })} className="bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none">
                            {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                        <div className="flex gap-2 justify-end">
                          <button type="button" onClick={() => setShowAddBranch(false)} className="text-muted hover:text-foreground text-xs font-bold px-4 py-2">Cancel</button>
                          <button type="submit" className="bg-primary text-white text-xs font-bold px-4 py-2 rounded-md">Save Branch</button>
                        </div>
                      </form>
                    )}

                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                      {branches.length === 0 ? (
                        <div className="col-span-full">
                          <EmptyState
                            title="No branches configured"
                            description="Add branch offices or regional operational hubs."
                          />
                        </div>
                      ) : branches.map((b) => (
                        <div key={b.id} className="bg-card border border-border-custom rounded-lg p-5 rounded-lg space-y-3">
                          <div className="flex justify-between items-center">
                            <div className="flex items-center gap-3">
                              <div className="h-9 w-9 rounded-full bg-primary/15 text-primary font-bold flex items-center justify-center text-sm">{b.branch_name.charAt(0).toUpperCase()}</div>
                              <div className="font-bold text-foreground text-sm">{b.branch_name}</div>
                            </div>
                            {b.is_primary && <Badge tone="success" className="font-bold">Primary</Badge>}
                          </div>
                          <div className="text-xs space-y-1">
                            <div className="text-muted">GSTIN: <span className="font-sans text-muted">{b.gstin}</span></div>
                            <div className="text-muted line-clamp-2">Address: <span className="text-muted">{b.billing_address}</span></div>
                            {b.is_primary && <Badge tone="neutral" className="mt-1">Primary Address</Badge>}
                          </div>
                          <div className="flex justify-end">
                            <button onClick={() => setPrimary(b.id)} disabled={b.is_primary} className="text-[10px] text-muted hover:text-primary disabled:opacity-40 disabled:cursor-default font-bold">
                              {b.is_primary ? "Primary" : "Set as Primary"}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Business Profile */}
                {companyTab === "business" && (
                  <div className="space-y-6">
                  <h2 className="text-sm font-bold text-foreground uppercase tracking-wider text-muted border-b border-border-custom pb-3">Business Profile</h2>

                  <SelectorCard title="Avg. Business / Year" options={BUSINESS_SEGMENTS} selected={bSeg} onSelect={setBSeg} />
                  <SelectorCard title="Company Size" options={COMPANY_SIZES} selected={bSize} onSelect={setBSize} />

                  <div className="bg-card border border-border-custom rounded-lg p-6 space-y-3">
                    <h3 className="text-[10px] uppercase tracking-wider text-muted font-bold">Construction Type</h3>
                    <div className="flex flex-wrap gap-2">
                      {bTypes.map((t) => (
                          <Badge key={t} tone="primary" className="text-xs py-1 px-2.5 flex items-center gap-1.5">{t} <button onClick={() => toggleCType(t)} className="text-primary/70 hover:text-primary cursor-pointer"><Icon name="close" className="w-3.5 h-3.5" /></button></Badge>
                      ))}
                      {bTypes.length === 0 && <span className="text-xs text-muted">None selected</span>}
                    </div>
                    <div className="flex gap-2">
                      <select value={ctypeInput} onChange={(e) => setCtypeInput(e.target.value)} className="bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none flex-1">
                        <option value="">Add or pick a type…</option>
                        {CONSTRUCTION_TYPES.filter((t) => !bTypes.includes(t)).map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <button onClick={addCType} className="bg-primary text-white text-xs font-bold px-4 py-2 rounded-md">Add</button>
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <button onClick={saveBusiness} className="bg-primary text-white text-xs font-bold px-6 py-2.5 rounded-md">Save</button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ════════════════════════════ ROLES & ACCESS ════════════════════════════ */}
          {activeSection === "roles" && (
            <div className="space-y-6">
              {roleMsg && (
                <div className={`p-4 text-xs rounded-lg border ${
                  roleMsg.type === "ok"
                    ? "bg-success/10 border-success/20 text-success"
                    : "bg-danger/10 border-danger/20 text-danger"
                }`}>{roleMsg.text}</div>
              )}

              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-bold text-foreground uppercase tracking-wider text-muted">Company Roles</h2>
                  <p className="mt-1 text-xs text-muted">A role decides which pages someone sees and what they can change. Give people a role in the Team tab. {roles.length} role{roles.length === 1 ? "" : "s"} set up.</p>
                </div>
                <div className="flex gap-2">
                  {can("settings:manage") && DEFAULT_ROLES.some((d) => !roles.some((r) => r.role_name.toLowerCase() === d.toLowerCase())) && (
                    <button onClick={seedRoles} disabled={roleBusy} className="bg-elevated text-foreground text-xs font-bold px-4 py-2.5 rounded-md border border-border-custom hover:border-primary/50 disabled:opacity-50">
                      Add standard roles
                    </button>
                  )}
                  {can("settings:manage") && (
                    <button onClick={() => setShowAddRole(true)} className="bg-primary text-white text-xs font-bold px-4 py-2.5 rounded-md">+ Add Role</button>
                  )}
                </div>
              </div>

              {showAddRole && (
                <form onSubmit={addRole} className="bg-card border border-border-custom rounded-lg p-6 space-y-4 max-w-xl">
                  <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">New Role</h3>
                  <input type="text" placeholder="Role name (e.g. Safety Officer)" value={roleName}
                    onChange={(e) => setRoleName(e.target.value)} required
                    className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                  <div className="flex gap-2 justify-end">
                    <button type="button" onClick={() => setShowAddRole(false)} className="text-muted hover:text-foreground text-xs font-bold px-4 py-2">Cancel</button>
                    <button type="submit" disabled={roleBusy} className="bg-primary text-white text-xs font-bold px-4 py-2 rounded-md disabled:opacity-50">Add Role</button>
                  </div>
                </form>
              )}

              {roles.length === 0 ? (
                <div className="col-span-full text-center p-8 border border-dashed border-border-custom rounded-md text-muted text-xs">
                  No roles yet. Press <span className="text-primary font-bold">Add standard roles</span> to add the usual set, or add your own.
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {roles.map((r) => (
                    <div key={r.id} className="bg-card border border-border-custom rounded-lg p-5 flex items-center gap-3">
                      <div className="h-9 w-9 shrink-0 rounded-full bg-primary/15 text-primary font-bold flex items-center justify-center text-sm">
                        {r.role_name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-bold text-foreground text-sm">{r.role_name}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {DEFAULT_ROLES.includes(r.role_name) && (
                            <Badge tone="neutral">Default</Badge>
                          )}
                          {LOCKED_ROLES.has(r.role_name) && (
                            <Badge tone="success" className="font-bold">Full access</Badge>
                          )}
                        </div>
                        {ROLE_SUMMARIES[r.role_name] && (
                          <p className="mt-1.5 text-[11px] text-muted leading-snug">{ROLE_SUMMARIES[r.role_name]}</p>
                        )}
                      </div>
                      {can("settings:manage") && !DEFAULT_ROLES.includes(r.role_name) && !LOCKED_ROLES.has(r.role_name) && (
                        <button
                          onClick={() => deleteRole(r)}
                          disabled={roleBusy}
                          className="shrink-0 text-[10px] text-danger border border-danger/20 bg-danger/10 px-3 py-1.5 rounded-md hover:bg-danger/20 disabled:opacity-50"
                        >
                          Delete
                        </button>
                      )}
                      {can("settings:manage") && (
                        <button
                          onClick={() => setPermRole({ id: r.id, role_name: r.role_name, permissions: r.permissions })}
                          className="shrink-0 text-[10px] bg-primary/10 text-primary border border-primary/20 px-3 py-1.5 rounded-md hover:bg-primary/20 whitespace-nowrap"
                        >
                          Edit Permissions
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {permRole && (
            <RolePermissionsModal
              role={permRole}
              onClose={() => setPermRole(null)}
              onSaved={(updated) =>
                setRoles((prev) =>
                  prev.map((r) => (r.id === updated.id ? { ...r, permissions: updated.permissions } : r))
                )
              }
            />
          )}

          {/* ════════════════════════════ TEAM ════════════════════════════ */}
          {activeSection === "team" && can("team:manage") && (
            <div className="space-y-6">
              <TeamSection companyId={String(company_id)} />
            </div>
          )}

          {/* ════════════════════════════ PAYROLL ════════════════════════════ */}
          {activeSection === "payroll" && (
            <div className="space-y-6">
              <div className="flex border-b border-border-custom gap-1 bg-elevated p-1 rounded-lg w-max">
                {([["leave", "Leave Policy"], ["holiday", "Holiday Calendar"], ["salary", "Salary Template"], ["statutory", "Statutory (PF/ESI/TDS)"]] as const).map(([id, label]) => (
                  <button key={id} onClick={() => setPayrollTab(id)}
                    className={`px-5 py-2.5 rounded-md text-xs font-bold transition-all duration-200 ${
                      payrollTab === id ? "bg-primary text-white" : "text-muted hover:text-foreground hover:bg-elevated"
                    }`}>
                    {label}
                  </button>
                ))}
              </div>

              {/* ── Leave Policy ── */}
              {payrollTab === "leave" && (
                <div className="space-y-6">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-bold text-foreground uppercase tracking-wider text-muted">Leave Policy Templates</h2>
                    <button onClick={() => setShowAddLeave(true)} className="bg-primary text-white text-xs font-bold px-4 py-2.5 rounded-md">+ Create New</button>
                  </div>

                  {showAddLeave && (
                    <form onSubmit={createLeaveTemplate} className="bg-card border border-border-custom rounded-lg p-6 space-y-4 max-w-xl">
                      <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">New Leave Policy</h3>
                      <Field label="Template Name">
                        <input type="text" placeholder="e.g. Standard Leave Policy" value={ltName}
                          onChange={(e) => setLtName(e.target.value)} required
                          className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                      </Field>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] uppercase tracking-wider text-muted font-bold">Leave Type Quotas</span>
                          <button type="button" onClick={addLtType} className="text-[10px] bg-primary/10 text-primary border border-primary/20 px-3 py-1 rounded-md hover:bg-primary/20">+ Add New Type</button>
                        </div>
                        {ltTypes.map((t, i) => (
                          <div key={i} className="flex gap-2">
                            <input type="text" placeholder="Type (e.g. Casual)" value={t.type}
                              onChange={(e) => editLtType(i, "type", e.target.value)}
                              className="flex-1 bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                            <input type="number" placeholder="Days" value={t.days}
                              onChange={(e) => editLtType(i, "days", Number(e.target.value) || 0)}
                              className="w-24 bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                            <button type="button" onClick={() => removeLtType(i)} className="text-muted hover:text-danger px-2 cursor-pointer"><Icon name="close" className="w-4 h-4" /></button>
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-2 justify-end">
                        <button type="button" onClick={() => setShowAddLeave(false)} className="text-muted hover:text-foreground text-xs font-bold px-4 py-2">Cancel</button>
                        <button type="submit" disabled={ltBusy} className="bg-primary text-white text-xs font-bold px-4 py-2 rounded-md disabled:opacity-50">Create</button>
                      </div>
                    </form>
                  )}

                  {leaveTemplates.length === 0 ? (
                    <div className="col-span-full">
                      <EmptyState
                        title="No leave policy templates found"
                        description="Define annual leave quotas and accrual policies for your staff."
                        action={{ label: "Add Leave Policy", onClick: () => setShowAddLeave(true) }}
                      />
                    </div>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                      {leaveTemplates.map((t) => {
                        const quotas = (t.leave_types && t.leave_types.length)
                          ? t.leave_types
                          : [{ type: "Casual", days: t.casual_leave_days }, { type: "Sick", days: t.sick_leave_days }, { type: "Earned", days: t.earned_leave_days }];
                        return (
                          <div key={t.id} className="bg-card border border-border-custom rounded-lg p-5 space-y-3">
                            <div className="flex items-center justify-between">
                              <div className="font-bold text-foreground text-sm">{t.name}</div>
                              <button onClick={() => deleteLeaveTemplate(t.id)} className="text-[10px] text-muted hover:text-danger">Delete</button>
                            </div>
                            <div className="text-xs text-muted space-y-1">
                              {quotas.map((q) => (
                                <div key={q.type}>{q.type}: <span className="text-muted">{q.days} days</span></div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* ── Holiday Calendar ── */}
              {payrollTab === "holiday" && (
                <div className="space-y-6">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-bold text-foreground uppercase tracking-wider text-muted">Holiday Calendar</h2>
                    <button onClick={() => setShowAddHoliday(true)} className="bg-primary text-white text-xs font-bold px-4 py-2.5 rounded-md">+ Add Holiday</button>
                  </div>

                  {showAddHoliday && (
                    <form onSubmit={createHoliday} className="bg-card border border-border-custom rounded-lg p-6 space-y-4 max-w-xl">
                      <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">New Holiday</h3>
                      <Field label="Holiday Name">
                        <input type="text" placeholder="e.g. Independence Day" value={hName}
                          onChange={(e) => setHName(e.target.value)} required
                          className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                      </Field>
                      <Field label="Date">
                        <input type="date" value={hDate}
                          onChange={(e) => setHDate(e.target.value)}
                          className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                      </Field>
                      <div className="flex gap-2 justify-end">
                        <button type="button" onClick={() => setShowAddHoliday(false)} className="text-muted hover:text-foreground text-xs font-bold px-4 py-2">Cancel</button>
                        <button type="submit" className="bg-primary text-white text-xs font-bold px-4 py-2 rounded-md">Add</button>
                      </div>
                    </form>
                  )}

                  {holidays.length === 0 ? (
                    <div className="col-span-full">
                      <EmptyState
                        title="No holidays configured"
                        description="Configure company holidays and calendar observances."
                      />
                    </div>
                  ) : (
                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                      {holidays.map((h) => (
                        <div key={h.id} className="bg-card border border-border-custom rounded-lg p-5 flex items-center justify-between">
                          <div>
                            <div className="font-bold text-foreground text-sm">{h.name}</div>
                            <div className="text-xs text-muted">{formatDate(h.date)}</div>
                          </div>
                          <button onClick={() => deleteHoliday(h.id)} className="text-[10px] text-muted hover:text-danger">Delete</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── Salary Template ── */}
              {payrollTab === "salary" && (
                <div className="space-y-6">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-bold text-foreground uppercase tracking-wider text-muted">Salary Templates</h2>
                    <button onClick={() => setShowAddSalary(true)} className="bg-primary text-white text-xs font-bold px-4 py-2.5 rounded-md">+ Create New</button>
                  </div>

                  {showAddSalary && (
                    <form onSubmit={createSalaryTemplate} className="bg-card border border-border-custom rounded-lg p-6 space-y-6 max-w-2xl">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <Field label="Template Name">
                          <input type="text" placeholder="e.g. Grade A Engineer" value={stName}
                            onChange={(e) => setStName(e.target.value)} required
                            className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                        </Field>
                        <Field label="Description">
                          <input type="text" placeholder="Optional" value={stDesc}
                            onChange={(e) => setStDesc(e.target.value)}
                            className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                        </Field>
                        <Field label="Monthly CTC">
                          <div className="flex gap-2">
                            <input type="number" value={stCtc}
                              onChange={(e) => setStCtc(parseFloat(e.target.value) || 0)}
                              className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                            <select disabled className="bg-elevated border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none"><option>Monthly</option></select>
                          </div>
                        </Field>
                        <Field label="Day Off">
                          <select value={stDayOff} onChange={(e) => setStDayOff(e.target.value)}
                            className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none">
                            {WEEKDAYS.map((d) => <option key={d}>{d}</option>)}
                          </select>
                        </Field>
                      </div>

                      <div className="rounded-md border border-border-custom p-3 space-y-3">
                        <div className="text-sm font-semibold text-foreground">Salary Components</div>
                        <Field label="Basic">
                          <div className="flex items-center gap-2">
                            <input type="number" value={stBasicPct}
                              onChange={(e) => setStBasicPct(parseFloat(e.target.value) || 0)}
                              className="w-32 bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                            <select disabled className="bg-elevated border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none"><option>% of CTC</option></select>
                            <div className="whitespace-nowrap text-sm text-muted">= ₹{stBasic.toLocaleString("en-IN")}</div>
                          </div>
                        </Field>

                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-foreground">Allowances</span>
                          <button type="button" onClick={() => setStAllowances([...stAllowances, { name: "", amount: 0 }])}
                            className="text-[10px] bg-primary/10 text-primary border border-primary/20 px-3 py-1 rounded-md hover:bg-primary/20">+ New Allowance</button>
                        </div>
                        {stAllowances.map((a, i) => (
                          <div key={i} className="flex gap-2">
                            <input placeholder="Allowance name" value={a.name}
                              onChange={(e) => editLine(stAllowances, setStAllowances, i, "name", e.target.value)}
                              className="flex-1 bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                            <input type="number" placeholder="Amount" value={a.amount}
                              onChange={(e) => editLine(stAllowances, setStAllowances, i, "amount", parseFloat(e.target.value) || 0)}
                              className="w-32 bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                            <button type="button" onClick={() => setStAllowances(stAllowances.filter((_, j) => j !== i))} className="text-muted hover:text-danger px-2 cursor-pointer inline-flex items-center">
                              <Icon name="close" className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                        <div className="text-right text-sm text-muted">Fixed Allowance: ₹{stFixedAllowance.toLocaleString("en-IN")}</div>
                        <div className="border-t border-border-custom pt-3 text-sm font-semibold text-foreground">Gross Salary: ₹{stGross.toLocaleString("en-IN")}</div>
                      </div>

                      <div className="rounded-md border border-border-custom p-3 space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-foreground">Deductions</span>
                          <button type="button" onClick={() => setStDeductions([...stDeductions, { name: "", amount: 0 }])}
                            className="text-[10px] bg-primary/10 text-primary border border-primary/20 px-3 py-1 rounded-md hover:bg-primary/20">+ New Deduction</button>
                        </div>
                        {stDeductions.map((d, i) => (
                          <div key={i} className="flex gap-2">
                            <input placeholder="Deduction name" value={d.name}
                              onChange={(e) => editLine(stDeductions, setStDeductions, i, "name", e.target.value)}
                              className="flex-1 bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                            <input type="number" placeholder="Amount" value={d.amount}
                              onChange={(e) => editLine(stDeductions, setStDeductions, i, "amount", parseFloat(e.target.value) || 0)}
                              className="w-32 bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                            <button type="button" onClick={() => setStDeductions(stDeductions.filter((_, j) => j !== i))} className="text-muted hover:text-danger px-2 cursor-pointer inline-flex items-center">
                              <Icon name="close" className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                        <div className="border-t border-border-custom pt-3 text-sm font-semibold text-foreground">Net Amount (Per Month): ₹{stNet.toLocaleString("en-IN")}</div>
                      </div>

                      <div className="flex gap-2 justify-end">
                        <button type="button" onClick={() => { resetSt(); setShowAddSalary(false); }} className="text-muted hover:text-foreground text-xs font-bold px-4 py-2">Cancel</button>
                        <button type="submit" className="bg-primary text-white text-xs font-bold px-4 py-2 rounded-md">Save Template</button>
                      </div>
                    </form>
                  )}

                  {salaryTemplates.length === 0 ? (
                    <div className="col-span-full">
                      <EmptyState
                        title="No salary templates found"
                        description="Configure salary structures, allowances, and deduction policies."
                        action={{ label: "Add Salary Template", onClick: () => setShowAddSalary(true) }}
                      />
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="grid grid-cols-[2fr_3fr_1fr_auto] gap-4 px-4 text-[10px] uppercase tracking-wider text-muted font-bold">
                        <div>Template Name</div><div>Description</div><div>Status</div><div></div>
                      </div>
                      {salaryTemplates.map((t) => (
                        <div key={t.id} className="bg-card border border-border-custom rounded-lg p-5 grid grid-cols-[2fr_3fr_1fr_auto] gap-4 items-center">
                          <div className="font-bold text-foreground text-sm">{t.name}</div>
                          <div className="text-xs text-muted truncate">{t.description || "—"}</div>
                          <div><Badge tone="success" className="font-bold">{formatLabel(t.status)}</Badge></div>
                          <button onClick={() => deleteSalaryTemplate(t.id)} className="text-[10px] text-muted hover:text-danger justify-self-end">Delete</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── Statutory (PF/ESI/TDS) — bonus section ── */}
              {payrollTab === "statutory" && (
                <div className="space-y-6">
                  <h2 className="text-sm font-bold text-foreground uppercase tracking-wider text-muted border-b border-border-custom pb-3">Statutory Payroll Defaults</h2>
                  <p className="text-xs text-muted -mt-2">Company-wide default PF / ESI / TDS rates. These are inherited by new employees; per-employee overrides are set on the employee record in HR.</p>

                  <div className="bg-card border border-border-custom rounded-lg p-6 space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <Field label="PF Employee %">
                        <input type="number" step="0.01" value={pDraft.pf_employee_pct}
                          onChange={(e) => setPDraft({ ...pDraft, pf_employee_pct: Number(e.target.value) })}
                          className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-4 py-2.5 text-xs text-foreground outline-none" />
                      </Field>
                      <Field label="PF Employer %">
                        <input type="number" step="0.01" value={pDraft.pf_employer_pct}
                          onChange={(e) => setPDraft({ ...pDraft, pf_employer_pct: Number(e.target.value) })}
                          className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-4 py-2.5 text-xs text-foreground outline-none" />
                      </Field>
                      <Field label="ESI Employee %">
                        <input type="number" step="0.01" value={pDraft.esi_employee_pct}
                          onChange={(e) => setPDraft({ ...pDraft, esi_employee_pct: Number(e.target.value) })}
                          className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-4 py-2.5 text-xs text-foreground outline-none" />
                      </Field>
                      <Field label="ESI Employer %">
                        <input type="number" step="0.01" value={pDraft.esi_employer_pct}
                          onChange={(e) => setPDraft({ ...pDraft, esi_employer_pct: Number(e.target.value) })}
                          className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-4 py-2.5 text-xs text-foreground outline-none" />
                      </Field>
                      <Field label="TDS (Monthly ₹)">
                        <input type="number" step="0.01" value={pDraft.tds_monthly}
                          onChange={(e) => setPDraft({ ...pDraft, tds_monthly: Number(e.target.value) })}
                          className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-4 py-2.5 text-xs text-foreground outline-none" />
                      </Field>
                      <Field label="PF Wage Ceiling (₹)">
                        <input type="number" step="1" value={pDraft.pf_wage_ceiling}
                          onChange={(e) => setPDraft({ ...pDraft, pf_wage_ceiling: Number(e.target.value) || 0 })}
                          className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-4 py-2.5 text-xs text-foreground outline-none" />
                        <p className="text-[11px] text-muted mt-1">EPF statutory wage ceiling (defaults to ₹15,000). PF wage base is capped at this amount.</p>
                      </Field>
                      <div className="space-y-1.5">
                        <label className="text-[10px] uppercase tracking-wider text-muted font-bold">ESI Applicable</label>
                        <label className="flex items-center gap-2 cursor-pointer mt-2">
                          <input type="checkbox" checked={pDraft.is_esi_applicable}
                            onChange={(e) => setPDraft({ ...pDraft, is_esi_applicable: e.target.checked })}
                            className="h-4 w-4 accent-primary" />
                          <span className="text-xs text-foreground">{pDraft.is_esi_applicable ? "Yes" : "No"}</span>
                        </label>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[10px] uppercase tracking-wider text-muted font-bold">Assume Full Month on Zero Attendance</label>
                        <label className="flex items-center gap-2 cursor-pointer mt-2">
                          <input type="checkbox" checked={pDraft.assume_full_month_when_no_attendance}
                            onChange={(e) => setPDraft({ ...pDraft, assume_full_month_when_no_attendance: e.target.checked })}
                            className="h-4 w-4 accent-primary" />
                          <span className="text-xs text-foreground">{pDraft.assume_full_month_when_no_attendance ? "Enabled (pay full month)" : "Disabled (no punch = zero pay)"}</span>
                        </label>
                        <p className="text-[11px] text-muted mt-1">When turned on, staff with no attendance recorded in the month will be paid a full month instead of zero pay.</p>
                      </div>
                    </div>
                    <div className="flex justify-end">
                      <button onClick={handleSavePayrollClick} disabled={payrollStatus === "saving"}
                        className="bg-primary text-white text-xs font-bold px-6 py-2.5 rounded-md disabled:opacity-50 cursor-pointer">
                        {payrollStatus === "saving" ? "Saving…" : "Save"}
                      </button>
                    </div>
                    {payrollStatus === "saved" && (
                      <div className="p-4 bg-success/10 border border-success/20 text-success text-xs rounded-lg">Payroll settings saved successfully</div>
                    )}
                    {payrollStatus === "error" && (
                      <div className="p-4 bg-danger/10 border border-danger/20 text-danger text-xs rounded-lg">
                        {payrollError || "Failed to save payroll settings"}
                      </div>
                    )}
                  </div>

                  {showPayrollConfirm && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
                      <div className="bg-card border border-border-custom rounded-xl p-6 max-w-lg w-full space-y-4">
                        <div className="flex items-center justify-between">
                          <h3 className="text-base font-bold text-foreground">Confirm Statutory Payroll Changes</h3>
                          <button onClick={() => setShowPayrollConfirm(false)} className="text-muted hover:text-foreground">
                            <Icon name="close" className="w-4 h-4" />
                          </button>
                        </div>
                        <p className="text-xs text-muted">
                          You are updating company statutory payroll defaults. These rates affect statutory deductions across payroll runs:
                        </p>
                        <div className="bg-elevated border border-border-custom rounded-lg p-3 space-y-1.5 max-h-48 overflow-y-auto">
                          {getPayrollDiff().map((diff, idx) => (
                            <div key={idx} className="text-xs font-medium text-foreground flex items-center gap-2">
                              <span className="w-1.5 h-1.5 rounded-full bg-primary" />
                              <span>{diff}</span>
                            </div>
                          ))}
                        </div>
                        <div className="flex gap-2 justify-end pt-2">
                          <button
                            type="button"
                            onClick={() => setShowPayrollConfirm(false)}
                            className="text-muted hover:text-foreground text-xs font-bold px-4 py-2"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => savePayroll(true)}
                            disabled={payrollStatus === "saving"}
                            className="bg-primary text-white text-xs font-bold px-5 py-2 rounded-md disabled:opacity-50 cursor-pointer"
                          >
                            {payrollStatus === "saving" ? "Saving…" : "Confirm & Save"}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="bg-card border border-border-custom rounded-lg p-6 space-y-3">
                    <h3 className="text-[10px] uppercase tracking-wider text-muted font-bold">Salary Components (Payslip Structure)</h3>
                    <p className="text-[11px] text-muted">Fixed payslip component layout used by the payroll engine. Earnings and deductions are computed per run; this is a reference view, not an editable definition.</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-success font-bold mb-2">Earnings</div>
                        <ul className="text-xs text-muted space-y-1">
                          <li>• Basic</li><li>• HRA</li><li>• Other Allowances</li>
                        </ul>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-danger font-bold mb-2">Deductions</div>
                        <ul className="text-xs text-muted space-y-1">
                          <li>• PF (Employee) — Basic × PF Employee %</li>
                          <li>• PF (Employer) — Basic × PF Employer %</li>
                          <li>• ESI (Employee) — Gross × ESI Employee %</li>
                          <li>• ESI (Employer) — Gross × ESI Employer %</li>
                          <li>• TDS — Monthly fixed</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ════════════════════════════ HOLIDAY & WEEKOFF ════════════════════════════ */}
          {activeSection === "holiday" && (
            <div className="space-y-6">
              {/* Holidays — reuses HR's /hr/holidays (single source of truth) */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-bold text-foreground uppercase tracking-wider text-muted">Holiday Calendar</h2>
                  <button onClick={() => setShowAddHoliday(true)} className="bg-primary text-white text-xs font-bold px-4 py-2.5 rounded-md">+ Add Holiday</button>
                </div>

                {showAddHoliday && (
                  <form onSubmit={createHoliday} className="bg-card border border-border-custom rounded-lg p-6 space-y-4 max-w-xl">
                    <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">New Holiday</h3>
                    <Field label="Holiday Name">
                      <input type="text" placeholder="e.g. Independence Day" value={hName}
                        onChange={(e) => setHName(e.target.value)} required
                        className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                    </Field>
                    <Field label="Date">
                      <input type="date" value={hDate}
                        onChange={(e) => setHDate(e.target.value)}
                        className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                    </Field>
                    <div className="flex gap-2 justify-end">
                      <button type="button" onClick={() => setShowAddHoliday(false)} className="text-muted hover:text-foreground text-xs font-bold px-4 py-2">Cancel</button>
                      <button type="submit" className="bg-primary text-white text-xs font-bold px-4 py-2 rounded-md">Add</button>
                    </div>
                  </form>
                )}

                {holidays.length === 0 ? (
                  <div className="col-span-full">
                    <EmptyState
                      title="No holidays configured"
                      description="Configure company holidays and calendar observances."
                    />
                  </div>
                ) : (
                  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {holidays.map((h) => (
                      <div key={h.id} className="bg-card border border-border-custom rounded-lg p-5 flex items-center justify-between">
                        <div>
                          <div className="font-bold text-foreground text-sm">{h.name}</div>
                          <div className="text-xs text-muted">{formatDate(h.date)}</div>
                        </div>
                        <button onClick={() => deleteHoliday(h.id)} className="text-[10px] text-muted hover:text-danger">Delete</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Weekly Off — company default (bonus; not part of /hr/holidays) */}
              <div className="bg-card border border-border-custom rounded-lg p-6 space-y-4">
                <h2 className="text-sm font-bold text-foreground uppercase tracking-wider text-muted border-b border-border-custom pb-3">Weekly Off</h2>
                <p className="text-[11px] text-muted -mt-2">Default weekly off day for this company.</p>
                <Field label="Weekly Off Days">
                  <div className="flex gap-2">
                    {WEEKDAYS.map((d) => {
                      const isOff = weeklyOffDays.includes(d);
                      return (
                        <button
                          key={d}
                          type="button"
                          onClick={() => toggleWeeklyOffDay(d)}
                          className={`h-12 w-12 rounded-full text-[10px] font-bold flex flex-col items-center justify-center transition-colors ${
                            isOff
                              ? "bg-danger/10 text-danger border border-danger/20"
                              : "bg-success/10 text-success border border-success/20"
                          }`}
                          title={d}
                        >
                          <span>{d.slice(0, 2)}</span>
                          <span className="text-[8px] mt-0.5">{isOff ? "Off" : "Work"}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[10px] text-muted mt-2">Green = Working, Red = Week Off. Click each day to toggle it independently (e.g. both Sat & Sun off).</p>
                </Field>
                <div className="flex justify-end">
                  <button onClick={saveWeeklyOff} disabled={weeklyOffStatus === "saving"}
                    className="bg-primary text-white text-xs font-bold px-6 py-2.5 rounded-md disabled:opacity-50">
                    {weeklyOffStatus === "saving" ? "Saving…" : "Save"}
                  </button>
                </div>
                {weeklyOffStatus === "saved" && (
                  <div className="p-4 bg-success/10 border border-success/20 text-success text-xs rounded-lg">Weekly off saved</div>
                )}
                {weeklyOffStatus === "error" && (
                  <div className="p-4 bg-danger/10 border border-danger/20 text-danger text-xs rounded-lg">Failed to save weekly off</div>
                )}
              </div>
            </div>
          )}

          {/* ════════════════════════════ WORKFLOW CONTROLS ════════════════════════════ */}
          {activeSection === "workflow" && (
            <div className="space-y-6">
              <div className="flex border-b border-border-custom gap-1 bg-elevated p-1 rounded-lg w-max">
                {([["entry", "Entry Controls"], ["progress", "Progress Controls"], ["finance", "Finance Controls"], ["material", "Material Controls"]] as const).map(([id, label]) => (
                  <button key={id} onClick={() => setWfTab(id)}
                    className={`px-5 py-2.5 rounded-md text-xs font-bold transition-all duration-200 ${
                      wfTab === id ? "bg-primary text-white" : "text-muted hover:text-foreground hover:bg-elevated"
                    }`}>{label}</button>
                ))}
              </div>

              {/* Entry Controls */}
              {wfTab === "entry" && (
                <div className="space-y-3">
                  <WfEntryRow
                    label="Restrict creating entries older than (N) days"
                    desc="Block creating entries dated more than N days in the past"
                    enabled={wf.restrict_entry_creation_enabled}
                    days={wf.restrict_entry_creation_days}
                    onToggle={(v) => setWf({ ...wf, restrict_entry_creation_enabled: v })}
                    onDays={(v) => setWf({ ...wf, restrict_entry_creation_days: v })}
                  />
                  <WfEntryRow
                    label="Restrict editing entries older than (N) days"
                    desc="Block editing entries dated more than N days in the past"
                    enabled={wf.restrict_entry_editing_enabled}
                    days={wf.restrict_entry_editing_days}
                    onToggle={(v) => setWf({ ...wf, restrict_entry_editing_enabled: v })}
                    onDays={(v) => setWf({ ...wf, restrict_entry_editing_days: v })}
                  />
                  <WfSaveFooter status={wfStatus} onSave={saveWorkflow} savedText="Workflow controls saved" errorText="Failed to save workflow controls" />
                </div>
              )}

              {/* Progress Controls */}
              {wfTab === "progress" && (
                <div className="space-y-3">
                  <WfToggleRow
                    label="Restrict progress more than estimation"
                    desc="Block task progress entries beyond 100% / the linked estimate (ties into the Task tab)"
                    value={wf.restrict_progress_over_estimate}
                    onChange={(v) => setWf({ ...wf, restrict_progress_over_estimate: v })}
                  />
                  <WfSaveFooter status={wfStatus} onSave={saveWorkflow} savedText="Workflow controls saved" errorText="Failed to save workflow controls" />
                </div>
              )}

              {/* Finance Controls */}
              {wfTab === "finance" && (
                <div className="space-y-3">
                  <WfToggleRow
                    label="Pre-Tax Deduction/Retention"
                    desc="Apply Deduction/Retention before tax (instead of after) in Transaction & Quotation calcs"
                    value={wf.pretax_deduction_retention}
                    onChange={(v) => setWf({ ...wf, pretax_deduction_retention: v })}
                  />
                  <WfSaveFooter status={wfStatus} onSave={saveWorkflow} savedText="Workflow controls saved" errorText="Failed to save workflow controls" />
                </div>
              )}

              {/* Material Controls */}
              {wfTab === "material" && (
                <div className="space-y-3">
                  <WfToggleRow label="Restrict Material Usage" desc="Block material usage that would drive stock negative" value={wf.negative_stock_lock} onChange={(v) => setWf({ ...wf, negative_stock_lock: v })} />
                  <WfToggleRow label="Restrict Subcontractor Material Issue" desc="Block issuing material to subcontractors" value={wf.restrict_subcon_material_issue} onChange={(v) => setWf({ ...wf, restrict_subcon_material_issue: v })} />
                  <WfToggleRow label="Restrict Material Transfer" desc="Block inter-location / project material transfers" value={wf.restrict_material_transfer} onChange={(v) => setWf({ ...wf, restrict_material_transfer: v })} />
                  <WfToggleRow label="Restrict Production Material" desc="Block material consumption in production" value={wf.restrict_production_material} onChange={(v) => setWf({ ...wf, restrict_production_material: v })} />
                  <WfToggleRow label="Material Purchase Order Restriction" desc="Restrict Purchase Order creation" value={wf.po_restriction} onChange={(v) => setWf({ ...wf, po_restriction: v })} />
                  <div className="flex items-center justify-between bg-elevated border border-border-custom rounded-lg px-4 py-3">
                    <div>
                      <div className="text-xs font-bold text-foreground">GRN Numbering</div>
                      <div className="text-[10px] text-muted">Scope for GRN numbering</div>
                    </div>
                    <div className="flex gap-2">
                      {["Project Level", "Company Level"].map((opt) => (
                        <button key={opt} onClick={() => setWf({ ...wf, grn_numbering: opt })}
                          className={`px-4 py-2 rounded-md text-xs font-bold border transition-all ${
                            wf.grn_numbering === opt ? "bg-primary text-white border-primary" : "bg-elevated text-muted border-border-custom hover:border-primary/50"
                          }`}>{opt}</button>
                      ))}
                    </div>
                  </div>
                  <WfSaveFooter status={wfStatus} onSave={saveWorkflow} savedText="Workflow controls saved" errorText="Failed to save workflow controls" />
                </div>
              )}
            </div>
          )}

          {/* ════════════════════════════ DOCUMENT & FIELDS ════════════════════════════ */}
          {activeSection === "docfields" && settings && (
            <div className="space-y-6">
              <div className="flex border-b border-border-custom gap-1 bg-elevated p-1 rounded-lg w-max">
                {([["pdf", "PDF Template"], ["terms", "Terms & Conditions"], ["number", "Number Format"], ["custom", "Custom Fields"]] as const).map(([id, label]) => (
                  <button key={id} onClick={() => setDocTab(id)}
                    className={`px-5 py-2.5 rounded-md text-xs font-bold transition-all duration-200 ${docTab === id ? "bg-primary text-white" : "text-muted hover:text-foreground hover:bg-elevated"}`}>
                    {label}
                  </button>
                ))}
              </div>

              {/* ── PDF Template ── */}
              {docTab === "pdf" && (
                <div className="space-y-6">
                  <h2 className="text-sm font-bold text-foreground uppercase tracking-wider text-muted border-b border-border-custom pb-3">PDF Template</h2>

                  <div className="bg-card border border-border-custom rounded-lg p-6 space-y-3">
                    <h3 className="text-[10px] uppercase tracking-wider text-muted font-bold">Choose your Own PDF Template</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {([
                        { v: "Default", t: "Default", d: "Use the standard SiteFlow PDF template for all company documents." },
                        { v: "Custom", t: "Custom", d: "Use your own uploaded / configured custom PDF template." },
                      ] as const).map((o) => {
                        const active = settings.custom_pdf_template_enabled ? o.v === "Custom" : o.v === "Default";
                        return (
                          <button key={o.v} type="button" onClick={() => savePdfSettings({ custom_pdf_template_enabled: o.v === "Custom" })}
                            className={`text-left rounded-lg border p-4 space-y-1.5 transition-all cursor-pointer ${active ? "border-border-custom bg-elevated text-foreground font-semibold" : "border-border-custom bg-card text-muted hover:bg-elevated/40"}`}>
                            <div className="text-xs font-bold text-foreground">{o.t}</div>
                            <div className="text-[10px] text-muted">{o.d}</div>
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-muted">When enabled, client portal reports, bills, purchase orders, and BOQ documents render with your configured PDF template, shown as a banner in place of the standard layout. Until a template is configured, these documents use the default layout.</p>
                  </div>

                  <div className="bg-card border border-border-custom rounded-lg p-6 space-y-3">
                    <h3 className="text-[10px] uppercase tracking-wider text-muted font-bold">Document Company Name Display</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {([
                        { v: "company", t: "Company Name", d: "Print the parent company name on documents." },
                        { v: "branch", t: "Branch Name", d: "Print the issuing branch name on documents." },
                      ] as const).map((o) => {
                        const active = (settings.document_company_name_display ?? "company") === o.v;
                        return (
                          <button key={o.v} type="button" onClick={() => savePdfSettings({ document_company_name_display: o.v })}
                            className={`text-left rounded-lg border p-4 space-y-1.5 transition-all cursor-pointer ${active ? "border-border-custom bg-elevated text-foreground font-semibold" : "border-border-custom bg-card text-muted hover:bg-elevated/40"}`}>
                            <div className="text-xs font-bold text-foreground">{o.t}</div>
                            <div className="text-[10px] text-muted">{o.d}</div>
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-muted">Chooses the name printed in the masthead of your PDF documents. With Branch Name selected, a document for a project that belongs to a branch prints that branch's name, and projects without a branch print the company name. With Company Name selected, every document prints the parent company name. Applies to client portal reports, bills, purchase orders, and BOQ documents.</p>
                  </div>

                  {pdfStatus === "saved" && (<div className="p-4 bg-success/10 border border-success/20 text-success text-xs rounded-lg">PDF template settings saved</div>)}
                  {pdfStatus === "error" && (<div className="p-4 bg-danger/10 border border-danger/20 text-danger text-xs rounded-lg">Failed to save PDF template settings</div>)}

                  <div className="bg-card border border-border-custom rounded-lg p-6 space-y-3">
                    <h3 className="text-[10px] uppercase tracking-wider text-muted font-bold">ZATCA E-Invoicing (Saudi)</h3>
                    <p className="text-[10px] text-muted">When enabled, sale invoices show a ZATCA Phase 1 QR (TLV base64) and a downloadable UBL 2.1 XML. The VAT registration number is printed in the QR.</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {([{ v: true, t: "Enabled", d: "Generate ZATCA QR + XML on sale invoices." }, { v: false, t: "Disabled", d: "No ZATCA e-invoice data." }] as const).map((o) => {
                        const active = Boolean(settings.is_zatca_enable) === o.v;
                        return (
                          <button key={o.t} type="button" onClick={() => saveZatca({ is_zatca_enable: o.v })}
                            className={`text-left rounded-lg border p-4 space-y-1.5 transition-all cursor-pointer ${active ? "border-border-custom bg-elevated text-foreground font-semibold" : "border-border-custom bg-card text-muted hover:bg-elevated/40"}`}>
                            <div className="text-xs font-bold text-foreground">{o.t}</div>
                            <div className="text-[10px] text-muted">{o.d}</div>
                          </button>
                        );
                      })}
                    </div>
                    <div className="space-y-1">
                      <div className="text-[10px] uppercase tracking-wider text-muted font-bold">VAT Registration Number</div>
                      <input value={vatNumber} onChange={(e) => setVatNumber(e.target.value)} onBlur={() => saveZatca({ vat_number: vatNumber })}
                        placeholder="e.g. 300000000000003" className="w-full rounded-md border border-border-custom bg-elevated px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary" />
                    </div>
                    {zatcaStatus === "saved" && (<div className="p-4 bg-success/10 border border-success/20 text-success text-xs rounded-lg">ZATCA settings saved</div>)}
                    {zatcaStatus === "error" && (<div className="p-4 bg-danger/10 border border-danger/20 text-danger text-xs rounded-lg">Failed to save ZATCA settings</div>)}
                  </div>
                </div>
              )}

              {/* ── Terms & Conditions ── */}
              {docTab === "terms" && (
                <div className="space-y-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-sm font-bold text-foreground uppercase tracking-wider text-muted">Terms & Conditions</h2>
                      <p className="mt-1 text-xs text-muted">Central default text for each document type. Prefills downstream forms that have a terms field (Subcon Work Order, CRM Quotation).</p>
                    </div>
                    <button onClick={saveTerms} disabled={termsStatus === "saving"} className="bg-primary text-white text-xs font-bold px-6 py-2.5 rounded-md disabled:opacity-50">{termsStatus === "saving" ? "Saving…" : "Save"}</button>
                  </div>

                  {!termsLoaded ? (
                    <CardSkeleton />
                  ) : (
                    <div className="space-y-5">
                      {TERMS_FIELDS.map((f) => (
                        <div key={f.key} className="bg-card border border-border-custom rounded-lg p-5 space-y-2">
                          <label className="text-[10px] uppercase tracking-wider text-muted font-bold">{f.label}</label>
                          <textarea value={terms[f.key]} onChange={(e) => setTerms((t) => ({ ...t, [f.key]: e.target.value }))} rows={5}
                            className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-4 py-2.5 text-xs text-foreground outline-none resize-y font-sans" />
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="p-4 bg-success/10 border border-success/20 text-success text-xs rounded-lg">
                    Fully wired: creating a Subcon Work Order, CRM Quotation, Sales / Purchase / Subcon Invoice, BOQ, or Purchase Order without supplying <code>terms</code> now pre-fills it server-side from the matching document terms above. Each of those documents also exposes a Download PDF action that renders the saved terms in its footer.
                  </div>

                  {termsStatus === "saved" && (<div className="p-4 bg-success/10 border border-success/20 text-success text-xs rounded-lg">Terms & Conditions saved</div>)}
                  {termsStatus === "error" && (<div className="p-4 bg-danger/10 border border-danger/20 text-danger text-xs rounded-lg">Failed to save Terms & Conditions</div>)}
                </div>
              )}

              {/* ── Number Format ── */}
              {docTab === "number" && (
                <div className="space-y-6">
                  <h2 className="text-sm font-bold text-foreground uppercase tracking-wider text-muted border-b border-border-custom pb-3">Number Format</h2>
                  <div className="bg-card border border-border-custom rounded-lg p-6 space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <Field label="Currency Decimal Places">
                        <input type="number" min={0} max={6} value={numFmt.currency_decimal_places}
                          onChange={(e) => setNumFmt({ ...numFmt, currency_decimal_places: parseInt(e.target.value || "0", 10) || 0 })}
                          className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-4 py-2.5 text-xs text-foreground outline-none" />
                      </Field>
                      <Field label="Quantity Decimal Places">
                        <input type="number" min={0} max={6} value={numFmt.quantity_decimal_places}
                          onChange={(e) => setNumFmt({ ...numFmt, quantity_decimal_places: parseInt(e.target.value || "0", 10) || 0 })}
                          className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-4 py-2.5 text-xs text-foreground outline-none" />
                      </Field>
                    </div>
                    <div className="flex justify-end">
                      <button onClick={saveNumFmt} disabled={numStatus === "saving"} className="bg-primary text-white text-xs font-bold px-6 py-2.5 rounded-md disabled:opacity-50">{numStatus === "saving" ? "Saving…" : "Save"}</button>
                    </div>
                    {numStatus === "saved" && (<div className="p-4 bg-success/10 border border-success/20 text-success text-xs rounded-lg">Number format saved</div>)}
                    {numStatus === "error" && (<div className="p-4 bg-danger/10 border border-danger/20 text-danger text-xs rounded-lg">Failed to save number format</div>)}
                  </div>
                  <div className="p-4 bg-muted/10 border border-border-custom text-muted text-xs rounded-lg">
                    Configure standard currency formatting precision across financial reports and document views.
                  </div>
                </div>
              )}

              {/* ── Custom Fields ── */}
              {docTab === "custom" && (
                <div className="space-y-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-sm font-bold text-foreground uppercase tracking-wider text-muted">Custom Fields</h2>
                      <p className="mt-1 text-xs text-muted">Define custom fields to capture specialized tracking data across documents and records.</p>
                    </div>
                    <button onClick={() => setShowAddCf(true)} className="bg-primary text-white text-xs font-bold px-4 py-2.5 rounded-md">+ New Custom Field</button>
                  </div>

                  <div className="flex items-center gap-3 max-w-sm">
                    <label className="text-[10px] uppercase tracking-wider text-muted font-bold">Document / Entity Type</label>
                    <select value={cfEntity} onChange={(e) => setCfEntity(e.target.value)}
                      className="flex-1 bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none">
                      {DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>

                  {cfMsg && (<div className={`p-4 text-xs rounded-lg border ${cfMsg.type === "ok" ? "bg-success/10 border-success/20 text-success" : "bg-danger/10 border-danger/20 text-danger"}`}>{cfMsg.text}</div>)}

                  {showAddCf && (
                    <form onSubmit={addCf} className="bg-card border border-border-custom rounded-lg p-6 space-y-4 max-w-xl">
                      <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">New Custom Field — {cfEntity}</h3>
                      <Field label="Field Name">
                        <input type="text" placeholder="e.g. Client PO Reference" value={cfDraft.field_name}
                          onChange={(e) => setCfDraft({ ...cfDraft, field_name: e.target.value })} required
                          className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                      </Field>
                      <Field label="Data Type">
                        <select value={cfDraft.field_type} onChange={(e) => setCfDraft({ ...cfDraft, field_type: e.target.value })}
                          className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none">
                          {CF_DATA_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </Field>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={cfDraft.set_default} onChange={(e) => setCfDraft({ ...cfDraft, set_default: e.target.checked })} className="h-4 w-4 accent-primary" />
                        <span className="text-xs text-foreground">Set Default</span>
                      </label>
                      {cfDraft.set_default && (
                        <Field label="Default Value">
                          <input type="text" placeholder="Default value" value={cfDraft.default_value}
                            onChange={(e) => setCfDraft({ ...cfDraft, default_value: e.target.value })}
                            className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                        </Field>
                      )}
                      <div className="flex gap-2 justify-end">
                        <button type="button" onClick={() => setShowAddCf(false)} className="text-muted hover:text-foreground text-xs font-bold px-4 py-2">Cancel</button>
                        <button type="submit" disabled={cfBusy} className="bg-primary text-white text-xs font-bold px-4 py-2 rounded-md disabled:opacity-50">Add Field</button>
                      </div>
                    </form>
                  )}

                  <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
                    <div className="grid grid-cols-[2fr_1.5fr_1fr_2fr] gap-4 px-5 py-3 text-[10px] uppercase tracking-wider text-muted font-bold border-b border-border-custom">
                      <div>Field Name</div><div>Data Type</div><div>Set Default</div><div>Default Value</div>
                    </div>
                    {cfList.length === 0 ? (
                      <div className="p-8 text-center text-xs text-muted">No custom fields for {cfEntity}.</div>
                    ) : (
                      cfList.map((f) => (
                        <div key={f.id} className="grid grid-cols-[2fr_1.5fr_1fr_2fr] gap-4 px-5 py-3 items-center border-b border-border-custom last:border-0">
                          <div className="font-bold text-foreground text-sm">{f.field_name}</div>
                          <div className="text-xs text-muted">{formatLabel(f.field_type)}</div>
                          <div>{f.set_default ? <Badge tone="success" className="font-bold">Yes</Badge> : <span className="text-[10px] text-muted">—</span>}</div>
                          <div className="text-xs text-muted truncate">{f.default_value || "—"}</div>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="p-4 bg-warning/10 border border-warning/20 text-warning text-xs rounded-lg">
                    Note: custom fields you define here are saved per record type and listed above. They do not yet appear on Project, Task, Invoice, or other record forms, so values cannot be filled in on individual records yet.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ════════════════════════════ MULTI LEVEL APPROVAL ════════════════════════════ */}
          {activeSection === "approval" && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-bold text-foreground uppercase tracking-wider text-muted">Multi Level Approval</h2>
                  <p className="mt-1 text-xs text-muted">Define approver chains per document/transaction category. One block with no upper limit = a flat chain; multiple Min/Max blocks = amount-range routing (each published independently).</p>
                </div>
                <select value={approvalCat} onChange={(e) => setApprovalCat(e.target.value)}
                  className="bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none">
                  {APPROVAL_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              <div className="p-4 bg-warning/10 border border-warning/20 text-warning text-xs rounded-lg">
                Approval chains are enforced today across {APPROVAL_CATEGORIES.join(", ")}: when a matching rule covers the amount, the document is held until every level approves it.
              </div>

              {ruleMsg && (
                <div className={`p-4 text-xs rounded-lg border ${ruleMsg.type === "ok" ? "bg-success/10 border-success/20 text-success" : "bg-danger/10 border-danger/20 text-danger"}`}>{ruleMsg.text}</div>
              )}

              {/* New rule block */}
              <div className="bg-card border border-border-custom rounded-lg p-5 space-y-4">
                <div className="text-[10px] uppercase tracking-wider text-muted font-bold">Add Approval Rule Block — {approvalCat}</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                  <Field label="Min Amount (₹)">
                    <input type="number" min={0} value={newRule.min_amount}
                      onChange={(e) => setNewRule({ ...newRule, min_amount: parseInt(e.target.value || "0", 10) || 0 })}
                      className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                  </Field>
                  <Field label="Max Amount (₹, blank = no limit)">
                    <input type="number" min={0} value={newRule.max_amount}
                      onChange={(e) => setNewRule({ ...newRule, max_amount: e.target.value })}
                      placeholder="No upper limit"
                      className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                  </Field>
                  <Field label="Levels">
                    <input type="number" min={1} value={newRule.levels}
                      onChange={(e) => setNewRule({ ...newRule, levels: parseInt(e.target.value || "1", 10) || 1 })}
                      className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                  </Field>
                  <Field label="Approvers (comma-separated)">
                    <input type="text" value={newRule.approvers}
                      onChange={(e) => setNewRule({ ...newRule, approvers: e.target.value })}
                      placeholder="e.g. manager@co.in, finance@co.in"
                      className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                  </Field>
                </div>
                <div className="flex justify-end">
                  <button onClick={publishNewRule} disabled={ruleBusy} className="bg-primary text-white text-xs font-bold px-5 py-2.5 rounded-md disabled:opacity-50">Publish Rule Block</button>
                </div>
              </div>

              {/* Existing rule blocks for this category */}
              <div className="space-y-3">
                {approvalRulesForCat(approvalCat).length === 0 ? (
                  <EmptyState
                    title={`No approval rules configured for ${approvalCat}`}
                    description="Create threshold-based multi-level approval hierarchies for transactions."
                  />
                ) : (
                  approvalRulesForCat(approvalCat).map((r) => {
                    const e = ruleEdits[r.id] ?? { min_amount: r.min_amount, max_amount: r.max_amount ?? "", levels: r.levels, approvers: r.approvers };
                    return (
                      <div key={r.id} className="bg-card border border-border-custom rounded-lg p-5 space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                          <Field label="Min Amount (₹)">
                            <input type="number" min={0} value={e.min_amount}
                              onChange={(ev) => approveEdit(r.id, { min_amount: parseInt(ev.target.value || "0", 10) || 0 })}
                              className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                          </Field>
                          <Field label="Max Amount (₹, blank = no limit)">
                            <input type="number" min={0} value={e.max_amount}
                              onChange={(ev) => approveEdit(r.id, { max_amount: ev.target.value })}
                              placeholder="No upper limit"
                              className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                          </Field>
                          <Field label="Levels">
                            <input type="number" min={1} value={e.levels}
                              onChange={(ev) => approveEdit(r.id, { levels: parseInt(ev.target.value || "1", 10) || 1 })}
                              className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                          </Field>
                          <Field label="Approvers (comma-separated)">
                            <input type="text" value={e.approvers}
                              onChange={(ev) => approveEdit(r.id, { approvers: ev.target.value })}
                              placeholder="e.g. manager@co.in, finance@co.in"
                              className="w-full bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                          </Field>
                        </div>
                        <div className="flex justify-end gap-2">
                          <button onClick={() => deleteRule(r.id)} className="text-[10px] text-muted hover:text-danger font-bold">Delete</button>
                          <button onClick={() => publishEditRule(r)} disabled={ruleBusy} className="bg-primary text-white text-xs font-bold px-5 py-2 rounded-md disabled:opacity-50">Publish</button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* ════════════════════════════ INTEGRATIONS ════════════════════════════ */}
          {activeSection === "integrations" && settings && (
            <div className="space-y-6">
              <h2 className="text-sm font-bold text-foreground uppercase tracking-wider text-muted border-b border-border-custom pb-3">Integrations</h2>

              <div className="bg-card border border-border-custom rounded-lg p-6 space-y-5">
                <div>
                  <div className="text-sm font-bold text-foreground">Google Sheets</div>
                  <div className="text-[10px] text-muted">Authorize specific team member mobile numbers to connect and sync Google Sheets.</div>
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] uppercase tracking-wider text-muted font-bold">Authorized Phones (whitelist)</label>
                  <div className="flex gap-2">
                    <input type="text" placeholder="e.g. +919812345678" value={gsPhoneInput}
                      onChange={(e) => setGsPhoneInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addGsPhone(); } }}
                      className="flex-1 bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                    <button onClick={addGsPhone} className="bg-primary text-white text-xs font-bold px-4 py-2 rounded-md">Add</button>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {gsPhones.length === 0 ? (
                      <span className="text-[10px] text-muted">No authorized phones added.</span>
                    ) : gsPhones.map((p) => (
                      <Badge key={p} tone="primary" className="text-xs py-1 px-2.5 flex items-center gap-1.5">{p} <button onClick={() => removeGsPhone(p)} className="text-primary/70 hover:text-primary cursor-pointer"><Icon name="close" className="w-3.5 h-3.5" /></button></Badge>
                    ))}
                  </div>
                </div>

                <div className="rounded-lg border border-border-custom p-4 space-y-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted font-bold">Connection Status</div>
                  {gsConnection.connected ? (
                    <div className="flex items-center gap-2 text-xs text-success">
                      <span className="h-2 w-2 rounded-full bg-success" />
                      <span>
                        Connected
                        {gsConnection.connected_by_phone
                          ? ` by ${gsConnection.connected_by_name || "user"} (${gsConnection.connected_by_phone})`
                          : ""}
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-muted">
                      <span className="h-2 w-2 rounded-full bg-elevated" />
                      <span>Not connected. Connect from the Payroll Runs tab (HR) to authorize a Google account.</span>
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-border-custom p-4 space-y-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted font-bold">Activity Log</div>
                  <EmptyState
                    title="No activity recorded yet"
                    description="Auth and sync events for the Google Sheets integration will appear here once the connection is live."
                  />
                </div>

                <div className="p-4 bg-warning/10 border border-warning/20 text-warning text-xs rounded-lg">
                  Live export is wired for payroll runs (HR -&gt; Payroll Runs -&gt; Export to Google Sheets). The enable flag and authorized-phone whitelist below gate who may connect a Google account. Other report types are not exported yet.
                </div>

                {gsStatus === "saved" && (<div className="p-4 bg-success/10 border border-success/20 text-success text-xs rounded-lg">Integration settings saved</div>)}
                {gsStatus === "error" && (<div className="p-4 bg-danger/10 border border-danger/20 text-danger text-xs rounded-lg">Failed to save integration settings</div>)}
              </div>

              {/* Google Drive */}
              <div className="bg-card border border-border-custom rounded-lg p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-bold text-foreground">Google Drive</div>
                    <div className="text-[10px] text-muted">Backup project and company files to your connected Google Drive.</div>
                  </div>
                  {gdConnected ? (
                    <button onClick={disconnectDrive} disabled={gdBusy} className="bg-danger/10 text-danger border border-danger/20 text-xs font-bold px-4 py-2 rounded-md disabled:opacity-50">Disconnect</button>
                  ) : (
                    <button onClick={connectDrive} disabled={gdBusy} className="bg-primary text-white text-xs font-bold px-4 py-2 rounded-md disabled:opacity-50">Connect</button>
                  )}
                </div>
                <div className="rounded-lg border border-border-custom p-4 space-y-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted font-bold">Connection Status</div>
                  {gdConnected ? (
                    <div className="flex items-center gap-2 text-xs text-success"><span className="h-2 w-2 rounded-full bg-success" /><span>Connected</span></div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-muted"><span className="h-2 w-2 rounded-full bg-elevated" /><span>Not connected.</span></div>
                  )}
                </div>
                {gdMsg && (
                  <div className={`p-4 text-xs rounded-lg ${gdMsg.type === "ok" ? "bg-success/10 border border-success/20 text-success" : "bg-danger/10 border border-danger/20 text-danger"}`}>{gdMsg.text}</div>
                )}
              </div>

              {/* Zoho Books */}
              <div className="bg-card border border-border-custom rounded-lg p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-bold text-foreground">Zoho Books</div>
                    <div className="text-[10px] text-muted">Push vendor bills from SiteFlow into Zoho Books for accounting and GST reconciliation.</div>
                  </div>
                  {zbConnected ? (
                    <button onClick={disconnectZoho} disabled={zbBusy} className="bg-danger/10 text-danger border border-danger/20 text-xs font-bold px-4 py-2 rounded-md disabled:opacity-50">Disconnect</button>
                  ) : (
                    <button onClick={connectZoho} disabled={zbBusy} className="bg-primary text-white text-xs font-bold px-4 py-2 rounded-md disabled:opacity-50">Connect</button>
                  )}
                </div>
                <div className="rounded-lg border border-border-custom p-4 space-y-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted font-bold">Connection Status</div>
                  {zbConnected ? (
                    <div className="flex items-center gap-2 text-xs text-success"><span className="h-2 w-2 rounded-full bg-success" /><span>Connected</span></div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-muted"><span className="h-2 w-2 rounded-full bg-elevated" /><span>Not connected.</span></div>
                  )}
                </div>
                {zbMsg && (
                  <div className={`p-4 text-xs rounded-lg ${zbMsg.type === "ok" ? "bg-success/10 border border-success/20 text-success" : "bg-danger/10 border border-danger/20 text-danger"}`}>{zbMsg.text}</div>
                )}
              </div>

              {/* BI Data Export */}
              <div className="bg-card border border-border-custom rounded-lg p-6 space-y-4">
                <div>
                  <div className="text-sm font-bold text-foreground">BI Data Export (PowerBI / Tableau)</div>
                  <div className="text-[10px] text-muted">Create API keys to pull projects, budget variance, and labour productivity feeds as CSV or JSON.</div>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] uppercase tracking-wider text-muted font-bold">New key label</label>
                  <div className="flex gap-2">
                    <input type="text" placeholder="e.g. PowerBI Prod" value={biLabel} onChange={(e) => setBiLabel(e.target.value)} className="flex-1 bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
                    <button onClick={createBiKey} disabled={biBusy} className="bg-primary text-white text-xs font-bold px-4 py-2 rounded-md disabled:opacity-50">Create</button>
                  </div>
                  {biNewKey && (
                    <div className="rounded-lg border border-success/20 bg-success/10 p-3 space-y-1">
                      <div className="text-[10px] uppercase tracking-wider text-success font-bold">Copy this key now (shown once)</div>
                      <code className="block text-[11px] text-success break-all select-all">{biNewKey}</code>
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted font-bold">Keys</div>
                  {biKeys.length === 0 ? (
                    <EmptyState
                      title="No API keys created"
                      description="Create API keys to pull project feeds into PowerBI or Tableau."
                    />
                  ) : (
                    <div className="space-y-1.5">
                      {biKeys.map((k) => (
                        <div key={k.id} className="flex items-center justify-between text-xs bg-elevated border border-border-custom rounded-md px-3 py-2">
                          <div className="flex flex-col">
                            <span className="text-foreground">{k.label}</span>
                            <span className="text-[10px] text-muted">{k.masked_key}{k.revoked ? " (revoked)" : ""}</span>
                          </div>
                          {!k.revoked && (
                            <button onClick={() => revokeBiKey(k.id)} className="text-danger hover:text-danger text-[11px] font-bold">Revoke</button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="rounded-lg border border-border-custom p-4 space-y-1">
                  <div className="text-[10px] uppercase tracking-wider text-muted font-bold">Connect your BI tool</div>
                  <p className="text-[11px] text-muted">Point PowerBI or Tableau at your feed URL with the API key as a header (<code>X-API-Key</code>):</p>
                  <code className="block text-[11px] text-muted break-all">{apiHost}/apis/v3/integrations/bi/feed/{company_id}/projects?format=csv</code>
                </div>
                {biMsg && (
                  <div className={`p-4 text-xs rounded-lg ${biMsg.type === "ok" ? "bg-success/10 border border-success/20 text-success" : "bg-danger/10 border border-danger/20 text-danger"}`}>{biMsg.text}</div>
                )}
              </div>

              {/* Tally */}
              <div className="bg-card border border-border-custom rounded-lg p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-bold text-foreground">Tally</div>
                    <div className="text-[10px] text-muted">Sync ledgers and vouchers to your Tally accounting software.</div>
                  </div>
                  <a href={`/c/${company_id}/d/finance?tab=tally`} className="text-primary text-xs font-bold hover:underline">
                    Manage in Finance &rarr; Tally Sync
                  </a>
                </div>
                <div className="rounded-lg border border-border-custom p-4 space-y-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted font-bold">Connection Status</div>
                  {tallyConn?.connected ? (
                    <div className="flex items-center gap-2 text-xs text-success"><span className="h-2 w-2 rounded-full bg-success" /><span>Connected{tallyConn.tally_company_name ? ` (${tallyConn.tally_company_name})` : ""}</span></div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-muted"><span className="h-2 w-2 rounded-full bg-elevated" /><span>Not connected.</span></div>
                  )}
                </div>
              </div>

            </div>
          )}

          {/* ════════════════════════════ SUBSCRIPTION ════════════════════════════ */}
          {activeSection === "subscription" && settings && (
            <div className="space-y-6">
              <h2 className="text-sm font-bold text-foreground uppercase tracking-wider text-muted border-b border-border-custom pb-3">Subscription</h2>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard label="Current Plan" value={settings.subscription_plan || "—"} />
                <StatCard label="Start Date" value={fmtDate(settings.subscription_start)} />
                <StatCard label="End Date" value={fmtDate(settings.subscription_end)} />
                <StatCard label="Renewal Date" value={fmtDate(settings.subscription_renewal)} />
              </div>

              <div className="bg-card border border-border-custom rounded-lg p-6 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-primary/15 text-primary font-bold flex items-center justify-center"><Icon name="star" className="w-5 h-5" /></div>
                  <div>
                    <div className="text-sm font-bold text-foreground">Need to change your plan?</div>
                    <div className="text-[10px] text-muted">Plan, billing cycle and renewal are managed by the billing team.</div>
                  </div>
                </div>
                <p className="text-xs text-muted">
                  This view is <strong>display-only</strong> — there is no in-app billing or payment UI. Contact support to upgrade, downgrade, or adjust your renewal.
                </p>
                <div className="flex justify-start">
                  <a href="mailto:support@siteflow.app" className="bg-primary text-white text-xs font-bold px-6 py-2.5 rounded-md">Contact Support</a>
                </div>
              </div>
            </div>
          )}

          {/* ════════════════ Placeholder for not-yet-built sections ════════════════ */}
          {activeSection !== "company" && activeSection !== "roles" && activeSection !== "team" && activeSection !== "profile" && activeSection !== "payroll" && activeSection !== "holiday" && activeSection !== "workflow" && activeSection !== "docfields" && activeSection !== "approval" && activeSection !== "integrations" && activeSection !== "subscription" && (
            <Placeholder section={SECTIONS.find((s) => s.id === activeSection)?.label ?? ""} />
          )}
        </div>
        </PageShell>
      </main>
    </div>
  );
}

// ─── Small presentational helpers ─────────────────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[10px] uppercase tracking-wider text-muted font-bold">{label}</label>
      {children}
    </div>
  );
}

function WfSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-primary" : "bg-elevated"}`}
      aria-pressed={checked}>
      <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${checked ? "translate-x-5" : ""}`} />
    </button>
  );
}

function WfEntryRow({ label, desc, enabled, days, onToggle, onDays }: {
  label: string; desc: string; enabled: boolean; days: number; onToggle: (v: boolean) => void; onDays: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 bg-elevated border border-border-custom rounded-lg px-4 py-3">
      <div className="min-w-0">
        <div className="text-xs font-bold text-foreground">{label}</div>
        <div className="text-[10px] text-muted">{desc}</div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <input type="number" min={0} value={days}
          onChange={(e) => onDays(parseInt(e.target.value || "0", 10) || 0)}
          className="w-20 bg-elevated border border-border-custom focus:border-primary rounded-md px-3 py-2 text-xs text-foreground outline-none" />
        <WfSwitch checked={enabled} onChange={onToggle} />
      </div>
    </div>
  );
}

function WfToggleRow({ label, desc, value, onChange }: {
  label: string; desc: string; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 bg-elevated border border-border-custom rounded-lg px-4 py-3">
      <div className="min-w-0">
        <div className="text-xs font-bold text-foreground">{label}</div>
        <div className="text-[10px] text-muted">{desc}</div>
      </div>
      <WfSwitch checked={value} onChange={onChange} />
    </div>
  );
}

function WfSaveFooter({ status, onSave, savedText, errorText }: {
  status: "idle" | "saving" | "saved" | "error"; onSave: () => void; savedText: string; errorText: string;
}) {
  return (
    <>
      <div className="flex justify-end">
        <button onClick={onSave} disabled={status === "saving"}
          className="bg-primary text-white text-xs font-bold px-6 py-2.5 rounded-md disabled:opacity-50">
          {status === "saving" ? "Saving…" : "Save"}
        </button>
      </div>
      {status === "saved" && (
        <div className="p-4 bg-success/10 border border-success/20 text-success text-xs rounded-lg">{savedText}</div>
      )}
      {status === "error" && (
        <div className="p-4 bg-danger/10 border border-danger/20 text-danger text-xs rounded-lg">{errorText}</div>
      )}
    </>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card border border-border-custom rounded-lg p-5 rounded-lg">
      <div className="text-[10px] uppercase tracking-wider text-muted font-bold">{label}</div>
      <div className="mt-2 text-lg font-bold text-foreground truncate">{value}</div>
    </div>
  );
}

function SelectorCard({ title, options, selected, onSelect }: { title: string; options: string[]; selected: string | null; onSelect: (v: string) => void }) {
  return (
    <div className="bg-card border border-border-custom rounded-lg p-6 space-y-3">
      <h3 className="text-[10px] uppercase tracking-wider text-muted font-bold">{title}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        {options.map((o) => (
          <button key={o} onClick={() => onSelect(o)} className={`px-4 py-3 rounded-md text-xs font-bold border transition-all ${
            selected === o ? "bg-primary text-white border-primary" : "bg-elevated text-muted border-border-custom hover:border-primary/50"
          }`}>
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

function Placeholder({ section }: { section: string }) {
  return (
    <div className="bg-card border border-dashed border-border-custom rounded-lg p-10 text-center space-y-2">
      <div className="text-sm font-bold text-foreground">{section}</div>
      <p className="text-xs text-muted max-w-md mx-auto">
        This section is not available yet.
      </p>
    </div>
  );
}