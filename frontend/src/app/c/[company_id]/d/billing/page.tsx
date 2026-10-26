"use client";
import {  getApiHost , readErrorDetail, detailToMessage} from "@/lib/api";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useProject } from "@/context/ProjectContext";
import { useParams } from "next/navigation";
import { authHeaders, downloadWithAuth, formatLabel, formatDate, fmtINR as fmtAmount } from "@/lib/siteflow";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import SegmentedTabs from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import Icon from "@/components/marketing/Icon";
import Badge from "@/components/ui/Badge";
import FieldHint from "@/components/ui/FieldHint";
import { useCustomFields, CustomFieldsSection } from "@/components/CustomFieldsSection";

// Types
interface Deduction {
  id?: string;
  type: string;
  rate?: number | null; // percentage
  amount: number;
  notes?: string;
  released_amount?: number | null;
  released_at?: string | null;
  release_due_date?: string | null;
}

interface Bill {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  subcontractor: string;
  subtotal: number;
  gstAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  totalPayable: number;
  deductions: Deduction[];
  preTax: boolean;
  status: string;
  // R2-214: audit-approval lifecycle straight from the server's approval_flag,
  // independent of the payment status above.
  approvalFlag: string;
  invoiceType: string | null;
  // Theme B (soft flag): link to an approved ThreeWayMatch.
  matchId: string | null;
  matchStatus: string | null;
}

interface ThreeWayMatchOption {
  id: string;
  po_number: string | null;
  grn_number: string | null;
  match_status: string;
}

interface WorkOrder {
  id: string;
  woNumber: string;
  subcontractor: string;
  item: string;
  value: number;
  status: "Active" | "Completed" | "Draft";
  date: string;
}

interface DebitCreditNote {
  id: string;
  type: "debit" | "credit";
  subcontractor: string;
  amount: number;
  notes: string;
  date: string;
  status: "approved" | "pending" | "cancelled";
}

export default function SubcontractorBillingPage() {
  const { company_id } = useParams();
  const companyId = company_id || "demo-company";
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;

  const [tab, setTab] = useState<"wo" | "ra-bills" | "notes">("ra-bills");

  useEffect(() => {
    if (typeof window !== "undefined") {
      const queryParams = new URLSearchParams(window.location.search);
      const queryTab = queryParams.get("tab");
      if (queryTab && ["wo", "ra-bills", "notes"].includes(queryTab)) {
        setTab(queryTab as "wo" | "ra-bills" | "notes");
      }
    }
  }, []);

  // State managers
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [notes, setNotes] = useState<DebitCreditNote[]>([]);

  // Theme B (soft flag): per-row match linker state.
  const [matchOptions, setMatchOptions] = useState<ThreeWayMatchOption[]>([]);
  const [linkingBillId, setLinkingBillId] = useState<string | null>(null);

  // Bill Detail Drawer & Retention Release state
  const [selectedBillForDetail, setSelectedBillForDetail] = useState<Bill | null>(null);
  const [retentionModal, setRetentionModal] = useState<{
    bill: Bill;
    deduction: Deduction;
    mode: "full" | "partial";
    partialAmount: number;
  } | null>(null);

  // Real subcontractors (no hardcoded demo vendors)
  const [subcontractors, setSubcontractors] = useState<Array<{ company_team_id: string; name: string }>>([]);
  const subconNameMap = React.useMemo(() => {
    const m: Record<string, string> = {};
    subcontractors.forEach((s) => (m[s.company_team_id] = s.name));
    return m;
  }, [subcontractors]);

  const fetchWorkOrders = async (nameMap: Record<string, string> = {}) => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/billing/work-orders?project_id=${projectId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        const mapped = data.map((wo: any) => ({
          id: wo.id,
          woNumber: wo.wo_number,
          subcontractor: wo.subcontractor_name || nameMap[wo.subcontractor_id] || "Unassigned",
          item: wo.items && wo.items.length > 0 ? wo.items[0].description || wo.terms : wo.terms || "—",
          value: wo.estimated_work_amount,
          status: wo.status === "active" ? "Active" : wo.status,
          date: wo.wo_date || "",
        }));
        setWorkOrders(mapped);
      } else {
        console.error("Failed to fetch work orders", res.status);
      }
    } catch (e) {
      console.error("Failed to fetch work orders", e);
    }
  };

  const fetchTowers = async () => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/towers/${projectId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setTowers(data.map((t: any) => ({ id: t.id, tower_name: t.tower_name, tower_code: t.tower_code })));
      }
    } catch (e) { console.error(e); }
  };

  const fetchPNL = async () => {
    if (!projectId) return;
    try {
      const url = selectedTower === "all"
        ? `${getApiHost()}/apis/v3/towers/${projectId}/consolidated-pnl`
        : `${getApiHost()}/apis/v3/towers/${projectId}/consolidated-pnl?tower_id=${selectedTower}`;
      const res = await fetch(url, { headers: authHeaders() });
      if (res.ok) setPnlData(await res.json());
    } catch (e) { console.error(e); }
  };

  const fetchBills = async (nameMap: Record<string, string> = {}) => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/billing/bills?project_id=${projectId}&invoice_type=subcon`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        const mapped = data.map((bill: any) => {
          const gstTotal = parseFloat(bill.gst_amount || 0);
          const halfGst = gstTotal / 2;
          return {
            id: bill.id,
            invoiceNumber: bill.invoice_number,
            invoiceDate: bill.invoice_date || "",
            subcontractor: nameMap[bill.party_company_user_id] || "Unassigned",
            subtotal: parseFloat(bill.subtotal || 0),
            gstAmount: gstTotal,
            cgstAmount: halfGst,
            sgstAmount: halfGst,
            igstAmount: 0,
            totalPayable: parseFloat(bill.total_payable || 0),
            preTax: Boolean(bill.pre_tax_deductions),
            status: bill.status || "Unpaid",
            approvalFlag: bill.approval_flag || "pending",
            invoiceType: bill.invoice_type || null,
            matchId: bill.match_id || null,
            matchStatus: bill.match_status || "unmatched",
            deductions: (bill.deductions || []).map((d: any) => ({
              id: d.id,
              type: d.deduction_type,
              amount: parseFloat(d.amount || 0),
              rate: d.percentage,
              notes: d.notes,
              released_amount: d.released_amount !== null && d.released_amount !== undefined ? parseFloat(d.released_amount) : 0,
              released_at: d.released_at || null,
              release_due_date: d.release_due_date || null,
            }))
          };
        });
        setBills(mapped);
        if (selectedBillForDetail) {
          const updatedSelected = mapped.find((b: Bill) => b.id === selectedBillForDetail.id);
          if (updatedSelected) setSelectedBillForDetail(updatedSelected);
        }
      } else {
        console.error("Failed to fetch bills", res.status);
      }
    } catch (e) {
      console.error("Failed to fetch bills", e);
    }
  };

  const fetchNotes = async (nameMap: Record<string, string> = {}) => {
    try {
      const dnRes = await fetch(`${getApiHost()}/apis/v3/billing/debit-notes?project_id=${projectId}`, { headers: authHeaders() });
      const cnRes = await fetch(`${getApiHost()}/apis/v3/billing/credit-notes?project_id=${projectId}`, { headers: authHeaders() });
      let allNotes: DebitCreditNote[] = [];
      if (dnRes.ok) {
        const dnData = await dnRes.json();
        allNotes = allNotes.concat(dnData.map((n: any) => ({
          id: n.id,
          type: "debit",
          subcontractor: nameMap[n.party_company_user_id] || "Unassigned",
          amount: n.total_amount,
          notes: n.notes || "",
          date: n.created_at ? n.created_at.split("T")[0] : "",
          status: n.approval_flag === "auto_approved" ? "approved" : "pending"
        })));
      }
      if (cnRes.ok) {
        const cnData = await cnRes.json();
        allNotes = allNotes.concat(cnData.map((n: any) => ({
          id: n.id,
          type: "credit",
          subcontractor: nameMap[n.party_company_user_id] || "Unassigned",
          amount: n.total_amount,
          notes: n.notes || "",
          date: n.created_at ? n.created_at.split("T")[0] : "",
          status: n.approval_flag === "approved" ? "approved" : "pending"
        })));
      }
      setNotes(allNotes);
    } catch (e) {
      console.error("Failed to fetch debit/credit notes", e);
    }
  };

  useEffect(() => {
    if (!projectId || !companyId) return;
    (async () => {
      let nameMap: Record<string, string> = {};
      try {
        const res = await fetch(`${getApiHost()}/apis/v3/billing/subcontractors?company_id=${companyId}`, { headers: authHeaders() });
        if (res.ok) {
          const subs = await res.json();
          setSubcontractors(subs);
          subs.forEach((s: any) => (nameMap[s.company_team_id] = s.name));
        } else {
          console.error("Failed to fetch subcontractors", res.status);
        }
      } catch (e) {
        console.error("Failed to fetch subcontractors", e);
      }
      await Promise.all([
        fetchWorkOrders(nameMap),
        fetchBills(nameMap),
        fetchNotes(nameMap),
        fetchTowers(),
      ]);
    })();
  }, [companyId, projectId]);

  const [towers, setTowers] = useState<Array<{ id: string; tower_name: string; tower_code: string }>>([]);
  const [selectedTower, setSelectedTower] = useState<string>("all");
  const [pnlData, setPnlData] = useState<any[]>([]);

  useEffect(() => {
    fetchPNL();
  }, [selectedTower]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${getApiHost()}/apis/v3/settings/company-terms/${companyId}`, { headers: authHeaders() });
        if (r.ok) {
          const d = await r.json();
          setInvoiceDefaultTerms(d.subcon_terms || d.invoice_terms || "");
        }
      } catch {
        /* ignore: terms are optional */
      }
      try {
        // Settings -> Workflow Controls -> Finance Controls -> Pre-Tax
        // Deduction/Retention. The backend applies deductions in this order and
        // the preview has to use the same flag, or it shows a number the system
        // will not store.
        const cs = await fetch(`${getApiHost()}/apis/v3/settings/company/${companyId}`, { headers: authHeaders() });
        if (cs.ok) {
          const d = await cs.json();
          setPretaxDeductionOrder(Boolean(d.pretax_deduction_retention));
        }
      } catch {
        /* ignore: default order applies */
      }
    })();
  }, [companyId]);

  // New Work Order Modal & Forms
  const [showWOModal, setShowWOModal] = useState(false);
  const [newWONum, setNewWONum] = useState("");
  const [newWOSub, setNewWOSub] = useState("");
  const [newWOItem, setNewWOItem] = useState("");
  const [newWOValue, setNewWOValue] = useState(150000);

  // New Bill Modal & Forms
  const [showBillModal, setShowBillModal] = useState(false);
  const [newBillNum, setNewBillNum] = useState("RA-BILL-003");
  const [newBillSub, setNewBillSub] = useState("");
  const [newBillSubtotal, setNewBillSubtotal] = useState(100000);
  const [newBillGstPct, setNewBillGstPct] = useState(18);
  const [newBillTdsPct, setNewBillTdsPct] = useState(2);
  const [newBillRetentionPct, setNewBillRetentionPct] = useState(5);
  const [newBillAdvanceRecovery, setNewBillAdvanceRecovery] = useState(0);
  const [newBillPreTax, setNewBillPreTax] = useState(false);
  const [newBillTerms, setNewBillTerms] = useState("");
  const [invoiceDefaultTerms, setInvoiceDefaultTerms] = useState("");
  // Company setting, not a per-bill choice: which deduction group is computed
  // first. The backend reads Company.pretax_deduction_retention; false (the
  // default) means retention is computed on the subtotal and TDS on what remains.
  const [pretaxDeductionOrder, setPretaxDeductionOrder] = useState(false);
  // enforce_required_custom_fields runs on "bill" in the backend, but this form
  // rendered no custom-field inputs at all, so a single required field on that
  // entity type made every RA bill impossible to submit.
  const billCustomFields = useCustomFields(String(companyId), "bill");

  const fetchNextInvoiceNumber = async (docType: string = "subcon") => {
    if (!companyId || companyId === "demo-company") return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/billing/next-number/${companyId}?invoice_type=${encodeURIComponent(docType)}`, {
        headers: authHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.invoice_number) {
          setNewBillNum(data.invoice_number);
        }
      }
    } catch {
      /* ignore: keep default/typed number on failure */
    }
  };

  useEffect(() => {
    if (showBillModal) {
      if (!newBillTerms) setNewBillTerms(invoiceDefaultTerms);
      fetchNextInvoiceNumber("subcon");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBillModal]);

  const handleCancelBill = async (bill: Bill) => {
    if (!confirm(`Are you sure you want to cancel Bill #${bill.invoiceNumber} (₹${bill.totalPayable.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })})? This will un-commit billed amounts from its PO/Work Order.`)) {
      return;
    }
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/billing/bills/${bill.id}/cancel`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const err = await readErrorDetail(res);
        alert(err || "Failed to cancel bill");
        return;
      }
      alert(`Bill #${bill.invoiceNumber} cancelled successfully.`);
      if (selectedBillForDetail?.id === bill.id) {
        setSelectedBillForDetail(null);
      }
      fetchBills(subconNameMap);
    } catch (err: any) {
      console.error("Cancel bill error:", err);
      alert(err?.message || "Failed to cancel bill");
    }
  };

  const handleReleaseRetention = async () => {
    if (!retentionModal) return;
    const { bill, deduction, mode, partialAmount } = retentionModal;
    const already = Number(deduction.released_amount || 0);
    const outstanding = Math.max(0, deduction.amount - already);
    const releaseAmount = mode === "full" ? outstanding : Number(partialAmount);

    if (releaseAmount <= 0) {
      alert("Release amount must be greater than 0.");
      return;
    }
    if (releaseAmount > outstanding) {
      alert(`Release amount cannot exceed the remaining outstanding retention of ₹${outstanding.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`);
      return;
    }

    try {
      const res = await fetch(`${getApiHost()}/apis/v3/billing/bills/${bill.id}/deductions/${deduction.id}/release`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          released_amount: releaseAmount,
        }),
      });
      if (!res.ok) {
        const err = await readErrorDetail(res);
        alert(err || "Failed to release retention");
        return;
      }
      alert(`Retention of ₹${releaseAmount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} released successfully.`);
      setRetentionModal(null);
      fetchBills(subconNameMap);
    } catch (err: any) {
      console.error("Release retention error:", err);
      alert(err?.message || "Failed to release retention");
    }
  };

  // Live Bill Calculation Preview.
  //
  // This MUST agree with _sequential_deduction_calc + create_bill in
  // backend/app/routers/billing.py. It did not, and the difference was silent
  // money: for 200,000 at 18% GST with 2% TDS and 5% retention the panel showed
  // a net payable of 2,20,200 while the backend stored 2,22,200.
  //
  // Two rules, both taken from the backend:
  //   1. Every deduction is computed on the GST-EXCLUSIVE subtotal. The old
  //      code took retention off the GST-inclusive gross. TDS under the Income
  //      Tax Act is on the value of work, not on the GST component, and
  //      retention follows the same base.
  //   2. Deductions cascade. One group is computed on the subtotal, the rest on
  //      what is left. Which group goes first is the company's
  //      pretax_deduction_retention setting, not the per-bill checkbox.
  //
  // The per-bill "Pre-Tax Deductions Order" checkbox only moves the GST base.
  const calculateBillPreview = (
    subtotal: number,
    gstPct: number,
    tdsPct: number,
    retentionPct: number,
    advRecovery: number,
    preTax: boolean,
    retentionFirst: boolean
  ) => {
    // Mirrors _sequential_deduction_calc(deductions, base=subtotal, pretax_order).
    const retentionOf = (base: number) => base * (retentionPct / 100);
    // "other" is everything that is not Retention: TDS, plus any advance
    // recovery entered as a flat amount.
    const otherOf = (base: number) => base * (tdsPct / 100) + advRecovery;

    let retentionAmt: number;
    let otherAmt: number;
    if (retentionFirst) {
      retentionAmt = retentionOf(subtotal);
      otherAmt = otherOf(Math.max(0, subtotal - retentionAmt));
    } else {
      otherAmt = otherOf(subtotal);
      retentionAmt = retentionOf(Math.max(0, subtotal - otherAmt));
    }
    const tdsAmt = Math.max(0, otherAmt - advRecovery);
    const dedTotal = retentionAmt + otherAmt;

    const gstAmt = preTax
      ? (subtotal - dedTotal) * (gstPct / 100)
      : subtotal * (gstPct / 100);
    const totalPayable = subtotal - dedTotal + gstAmt;

    return {
      gstAmt: Math.round(gstAmt),
      tdsAmt: Math.round(tdsAmt),
      retentionAmt: Math.round(retentionAmt),
      totalPayable: Math.round(totalPayable)
    };
  };

  const preview = calculateBillPreview(
    newBillSubtotal,
    newBillGstPct,
    newBillTdsPct,
    newBillRetentionPct,
    newBillAdvanceRecovery,
    newBillPreTax,
    !pretaxDeductionOrder
  );

  const handleCreateWO = async () => {
    if (!newWOSub) {
      alert("Select a subcontractor before submitting the work order.");
      return;
    }
    const subconId = newWOSub;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/billing/work-orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id: companyId,
          project_id: projectId,
          subcontractor_id: subconId,
          wo_number: newWONum,
          wo_date: new Date().toISOString(),
          items: [
            {
              boq_item_id: null,
              task_id: null,
              quantity: 1,
              rate: newWOValue
            }
          ],
          terms: newWOItem
        })
      });
      if (res.ok) {
        fetchWorkOrders(subconNameMap);
        setShowWOModal(false);
        setNewWOItem("");
        setNewWONum(`WO-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`);
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (e) {
      console.error("Failed to create work order", e);
    }
  };

  const handleCreateBill = async () => {
    if (!newBillSub) {
      alert("Select a subcontractor before submitting the RA bill.");
      return;
    }
    const subconId = newBillSub;
    const cfError = billCustomFields.validate();
    if (cfError) {
      alert(cfError);
      return;
    }
    const deductions: Array<{ deduction_type: string; amount: number; percentage: number | null; notes: string }> = [
      { deduction_type: "TDS", amount: preview.tdsAmt, percentage: newBillTdsPct, notes: `${newBillTdsPct}% TDS (Sec 194C)` },
      { deduction_type: "Retention", amount: preview.retentionAmt, percentage: newBillRetentionPct, notes: `${newBillRetentionPct}% retention on the GST-exclusive work value` }
    ];

    if (newBillAdvanceRecovery > 0) {
      deductions.push({ deduction_type: "Advance Recovery", amount: newBillAdvanceRecovery, percentage: null, notes: "Advance Return adjustment" });
    }

    try {
      const res = await fetch(`${getApiHost()}/apis/v3/billing/bills`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id: companyId,
          project_id: projectId,
          party_company_user_id: subconId,
          invoice_number: newBillNum,
          invoice_date: new Date().toISOString(),
          invoice_type: "subcon",
          subtotal: newBillSubtotal,
          gst_pct: newBillGstPct,
          deductions: deductions,
          pre_tax_deductions: newBillPreTax,
          terms: newBillTerms || null,
          custom_fields: billCustomFields.toPayload()
        })
      });
      if (res.ok) {
        fetchBills(subconNameMap);
        setShowBillModal(false);
        setNewBillNum(`RA-BILL-${Math.floor(1000 + Math.random() * 9000)}`);
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (e) {
      console.error("Failed to create bill", e);
    }
  };

  const handleApproveBill = async (id: string) => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/billing/bills/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      });
      if (res.ok) {
        const bill = await res.json();
        setBills(prev => prev.map(b => b.id === id
          ? { ...b, approvalFlag: bill.approval_flag || "—" }
          : b));
      } else {
        const err = await res.json().catch(() => ({}));
        alert(detailToMessage(err.detail, "Failed to approve bill"));
      }
    } catch (e) {
      console.error("Failed to approve bill", e);
    }
  };

  // Theme B (soft flag): open the match picker for a bill — list only APPROVED
  // ThreeWayMatches for this company/project.
  const openMatchPicker = async (billId: string) => {
    setLinkingBillId(billId);
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/three-way/${companyId}?project_id=${projectId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        const approved = (data || [])
          .filter((m: any) => m.match_status === "approved")
          .map((m: any) => ({
            id: m.id,
            po_number: m.po_number || null,
            grn_number: m.grn_number || null,
            match_status: m.match_status,
          }));
        setMatchOptions(approved);
      }
    } catch (e) {
      console.error("Failed to fetch matches", e);
    }
  };

  const linkBillMatch = async (billId: string, matchId: string | null) => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/billing/bills/${billId}/match`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ match_id: matchId }),
      });
      if (res.ok) {
        const bill = await res.json();
        setBills(prev => prev.map(b => b.id === billId
          ? { ...b, matchId: bill.match_id || null, matchStatus: bill.match_status || "unmatched" }
          : b));
      } else {
        const err = await res.json().catch(() => ({}));
        alert(detailToMessage(err.detail, "Failed to link match"));
      }
    } catch (e) {
      console.error("Failed to link match", e);
    } finally {
      setLinkingBillId(null);
      setMatchOptions([]);
    }
  };

  const handleCancelNote = async (noteId: string, type: "debit" | "credit") => {
    if (!confirm(`Are you sure you want to cancel this ${type} note?`)) return;
    try {
      const endpoint = type === "debit" ? "debit-notes" : "credit-notes";
      const res = await fetch(`${getApiHost()}/apis/v3/billing/${endpoint}/${noteId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      });
      if (res.ok) {
        setNotes(prev => prev.map(n => n.id === noteId ? { ...n, status: "cancelled" } : n));
      } else {
        const err = await readErrorDetail(res);
        alert(err || `Failed to cancel ${type} note`);
      }
    } catch (e) {
      console.error(`Failed to cancel ${type} note`, e);
    }
  };

  // Computed KPI cards from the real bills already fetched
  const fmtINR = (n: number): string => {
    if (!n || n <= 0) return "₹0";
    if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
    if (n >= 1e3) return `₹${(n / 1e3).toFixed(1)}K`;
    return `₹${Math.round(n)}`;
  };
  const now = new Date();
  const isThisMonth = (d: string) => {
    if (!d) return false;
    const dt = new Date(d);
    return dt.getFullYear() === now.getFullYear() && dt.getMonth() === now.getMonth();
  };
  const billedThisMonth = bills.filter((b) => isThisMonth(b.invoiceDate));
  const totalBilledMTD = billedThisMonth.reduce((s, b) => s + (b.totalPayable || 0), 0);
  // R2-214: audit approval lives in approval_flag ("approved"/"auto_approved"),
  // not in the payment status.
  const isAuditApproved = (b: { approvalFlag: string }) =>
    b.approvalFlag === "approved" || b.approvalFlag === "auto_approved";
  const pendingBills = bills.filter((b) => !isAuditApproved(b));
  const pendingAmt = pendingBills.reduce((s, b) => s + (b.totalPayable || 0), 0);
  const retentionHeld = bills.reduce(
    (s, b) => s + (b.deductions || []).filter((d) => d.type === "Retention").reduce((x, d) => x + (d.amount || 0), 0),
    0
  );
  const settledBills = bills.filter((b) => b.status === "approved");
  const settledAmt = settledBills.reduce((s, b) => s + (b.totalPayable || 0), 0);
  const kpiCards = [
    { label: "Total RA Billing MTD", value: fmtINR(totalBilledMTD), sub: `${billedThisMonth.length} bill${billedThisMonth.length === 1 ? "" : "s"} this month`, color: "text-foreground" },
    { label: "Pending Audit Approval", value: fmtINR(pendingAmt), sub: `${pendingBills.length} bill${pendingBills.length === 1 ? "" : "s"} pending`, color: "text-warning" },
    { label: "Total Retentions Held", value: fmtINR(retentionHeld), sub: "Retention deductions", color: "text-info" },
    { label: "Net Payable Settled", value: fmtINR(settledAmt), sub: `${settledBills.length} bill${settledBills.length === 1 ? "" : "s"} paid`, color: "text-primary" }
  ];

  return (
    <div className="flex-1 flex flex-col overflow-hidden font-sans">
      <PageHeader
        title="Subcontractor Billing & WOs"
        subtitle="RA Billing Engine · Post-tax & Pre-tax Retentions · TDS Auditor Logs"
      >
        <div className="flex items-center gap-2">
          <select value={selectedTower} onChange={(e) => setSelectedTower(e.target.value)} className="bg-card border border-border-custom rounded-md px-2.5 py-1.5 text-xs text-foreground outline-none">
            <option value="all">All Towers/Phases</option>
            {towers.map((t) => <option key={t.id} value={t.id}>{t.tower_name} ({t.tower_code})</option>)}
          </select>
          <button
            onClick={() => {
              if (tab === "wo") setShowWOModal(true);
              else setShowBillModal(true);
            }}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-1.5 text-xs font-bold text-white hover:opacity-90 transition-all cursor-pointer"
          >
            {tab === "wo" ? "+ Create Work Order" : "+ Submit RA Bill"}
          </button>
        </div>
      </PageHeader>

      <div className="px-6 py-2 border-b border-border-custom bg-card shrink-0 overflow-x-auto">
        <SegmentedTabs
          tabs={[
            { id: "ra-bills", label: "RA Bills (Subcon)" },
            { id: "wo", label: "Work Orders" },
            { id: "notes", label: "Debit/Credit Notes" },
          ]}
          activeTab={tab}
          onChange={(t) => setTab(t as any)}
        />
      </div>

      {/* Main Container */}
      <div className="flex-1 flex flex-col overflow-hidden relative font-sans">

        {/* Workspace Body */}
        <div className="flex-1 overflow-y-auto z-10">
          <PageShell width="wide">

          {/* TAB: RA Bills */}
          {tab === "ra-bills" && (
            <div className="space-y-6">
              
              {/* Quick stats row */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                {kpiCards.map((s, idx) => (
                  <div key={idx} className="bg-card border border-border-custom rounded-lg p-4">
                    <span className="text-[10px] font-bold text-muted uppercase tracking-wider block">{s.label}</span>
                    <span className={`text-2xl font-extrabold mt-1 block ${s.color}`}>{s.value}</span>
                    <span className="text-[10px] text-muted block mt-0.5">{s.sub}</span>
                  </div>
                ))}
              </div>

              {/* Bills List Table */}
              <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
                <div className="px-5 py-4 border-b border-border-custom">
                  <h2 className="text-xs font-bold uppercase tracking-wider text-muted">Subcontractor RA Bills</h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="border-b border-border-custom text-muted">
                        <th className="px-5 py-3 font-bold">Bill Number</th>
                        <th className="px-5 py-3 font-bold">Subcontractor</th>
                        <th className="px-5 py-3 font-bold">Billed Subtotal</th>
                        <th className="px-5 py-3 font-bold">GST (CGST+SGST/IGST)</th>
                        <th className="px-5 py-3 font-bold">Deductions (TDS/Retention)</th>
                        <th className="px-5 py-3 font-bold">Deduction Tax Mode</th>
                        <th className="px-5 py-3 font-bold">Net Payable</th>
                        <th className="px-5 py-3 font-bold">Status</th>
                        <th className="px-5 py-3 font-bold text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bills.map((bill) => (
                        <tr key={bill.id} className="border-b border-border-custom hover:bg-elevated transition-all">
                          <td className="px-5 py-3.5">
                            <button
                              type="button"
                              onClick={() => setSelectedBillForDetail(bill)}
                              className="font-sans text-primary hover:underline font-bold text-left cursor-pointer"
                              title="Click to view bill deductions and details"
                            >
                              {bill.invoiceNumber}
                            </button>
                          </td>
                          <td className="px-5 py-3.5 text-foreground font-semibold">{bill.subcontractor}</td>
                          <td className="px-5 py-3.5 font-bold text-muted">₹{bill.subtotal.toLocaleString("en-IN")}</td>
                          <td className="px-5 py-3.5 text-muted">
                            <div className="flex flex-col">
                              <span className="text-[10px] text-muted">Total: ₹{bill.gstAmount.toLocaleString("en-IN")}</span>
                              {bill.cgstAmount > 0 && <>
                                <span className="text-[10px] text-success">CGST {bill.cgstAmount.toLocaleString("en-IN")}</span>
                                <span className="text-[10px] text-success">SGST {bill.sgstAmount.toLocaleString("en-IN")}</span>
                              </>}
                              {bill.igstAmount > 0 && <span className="text-[10px] text-warning">IGST {bill.igstAmount.toLocaleString("en-IN")}</span>}
                            </div>
                          </td>
                          <td className="px-5 py-3.5 text-muted max-w-[220px]">
                            <button
                              type="button"
                              onClick={() => setSelectedBillForDetail(bill)}
                              className="flex flex-wrap gap-1 text-left cursor-pointer"
                              title="Click to view / release retentions"
                            >
                              {bill.deductions.map((d, idx) => {
                                const isRetention = d.type === "Retention";
                                const released = Number(d.released_amount || 0);
                                const outstanding = Math.max(0, Number(d.amount) - released);
                                return (
                                  <span
                                    key={idx}
                                    className={`border text-[9px] px-1.5 py-0.5 rounded font-sans ${
                                      isRetention
                                        ? outstanding > 0
                                          ? "bg-primary/10 border-primary/30 text-primary font-bold"
                                          : "bg-success/10 border-success/30 text-success font-bold"
                                        : "bg-elevated border-border-custom text-muted"
                                    }`}
                                  >
                                    {d.type}: ₹{d.amount.toLocaleString("en-IN")}
                                    {isRetention && released > 0 && ` (Rel: ₹${released.toLocaleString("en-IN")})`}
                                  </span>
                                );
                              })}
                            </button>
                          </td>
                          <td className="px-5 py-3.5">
                            <span className="text-muted font-bold uppercase text-[10px]">{bill.preTax ? "Pre-Tax" : "Post-Tax"}</span>
                          </td>
                          <td className="px-5 py-3.5 font-extrabold text-foreground">₹{bill.totalPayable.toLocaleString("en-IN")}</td>
                          <td className="px-5 py-3.5">
                            <div className="flex flex-col gap-1">
                              <Badge
                                tone={
                                  bill.status === "Cancelled"
                                    ? "danger"
                                    : bill.status === "Paid"
                                    ? "success"
                                    : isAuditApproved(bill)
                                    ? "success"
                                    : "warning"
                                }
                                className="uppercase font-bold"
                              >
                                {bill.status === "Cancelled" ? "Cancelled" : (isAuditApproved(bill) ? "approved" : bill.approvalFlag)}
                              </Badge>
                              {bill.invoiceType !== "sale" && bill.matchStatus !== "approved" && bill.status !== "Cancelled" && (
                                <Badge tone="danger" className="uppercase font-bold w-fit">
                                  Unmatched
                                </Badge>
                              )}
                            </div>
                          </td>
                          <td className="px-5 py-3.5 text-right">
                            <div className="flex items-center justify-end gap-1.5 flex-wrap">
                              <button
                                type="button"
                                onClick={() => setSelectedBillForDetail(bill)}
                                className="bg-primary/10 border border-primary/20 text-primary rounded-lg px-2.5 py-1 text-[10px] font-bold hover:bg-primary/20 transition-all cursor-pointer"
                              >
                                View
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await downloadWithAuth(`/billing/bills/${bill.id}/pdf`);
                                  } catch (e) {
                                    alert(`Download failed (${e instanceof Error ? e.message : "unknown error"}).`);
                                  }
                                }}
                                className="bg-elevated border border-border-custom text-muted rounded-lg px-2 py-1 text-[10px] font-bold hover:bg-elevated/70 transition-all cursor-pointer"
                              >
                                PDF
                              </button>
                              {!isAuditApproved(bill) && bill.status !== "Cancelled" && (
                                <button
                                  type="button"
                                  onClick={() => handleApproveBill(bill.id)}
                                  className="bg-success hover:bg-success text-white rounded-lg px-2 py-1 text-[10px] font-bold transition-all cursor-pointer inline-flex items-center gap-1"
                                >
                                  <Icon name="check" className="w-3 h-3" /> Approve
                                </button>
                              )}
                              {bill.status !== "Cancelled" && (
                                <button
                                  type="button"
                                  onClick={() => handleCancelBill(bill)}
                                  className="bg-danger/10 border border-danger/20 text-danger hover:bg-danger/20 rounded-lg px-2 py-1 text-[10px] font-bold transition-all cursor-pointer"
                                  title="Cancel Bill"
                                >
                                  Cancel
                                </button>
                              )}
                              {bill.status !== "Cancelled" && (
                                <button
                                  type="button"
                                  onClick={() => openMatchPicker(bill.id)}
                                  className="bg-secondary/10 border border-secondary/20 text-secondary rounded-lg px-2 py-1 text-[10px] font-bold hover:bg-secondary/20 transition-all cursor-pointer"
                                >
                                  {bill.matchStatus === "approved" ? "Match" : "Link"}
                                </button>
                              )}
                              {linkingBillId === bill.id && (
                                <div className="mt-2 flex flex-col gap-2 w-full text-left">
                                  <select
                                    value={bill.matchId || ""}
                                    onChange={(e) => linkBillMatch(bill.id, e.target.value || null)}
                                    className="bg-card border border-border-custom rounded-md px-2 py-1 text-[10px] text-foreground outline-none"
                                  >
                                    <option value="">Select approved match…</option>
                                    {matchOptions.map((m) => (
                                      <option key={m.id} value={m.id}>
                                        {m.po_number ? `PO ${m.po_number}` : "PO ?"} · {m.grn_number ? `GRN ${m.grn_number}` : "GRN ?"}
                                      </option>
                                    ))}
                                  </select>
                                  {matchOptions.length === 0 && (
                                    <FieldHint text="No approved matches yet. Create matches in Three-Way Matching." href={`/c/${companyId}/d/three-way`} linkLabel="Go to Three-Way Matching" />
                                  )}
                                  <button
                                    onClick={() => { setLinkingBillId(null); setMatchOptions([]); }}
                                    className="text-muted hover:text-foreground text-[10px] px-1.5 cursor-pointer"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                      {bills.length === 0 && (
                        <tr>
                          <td colSpan={9} className="p-8">
                            <EmptyState
                              title="No RA bills found"
                              description="Create contractor running account bills or supplier invoices to process progress payments."
                              action={{
                                label: "+ Submit RA Bill",
                                onClick: () => setShowBillModal(true),
                              }}
                            />
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Tower-wise P&L Summary */}
              {pnlData.length > 0 && (
                <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
                  <div className="px-5 py-4 border-b border-border-custom">
                    <h2 className="text-xs font-bold uppercase tracking-wider text-muted">Tower-wise P&L Breakdown</h2>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs text-left">
                      <thead>
                        <tr className="border-b border-border-custom text-muted">
                          <th className="px-5 py-3 font-bold">Tower/Phase</th>
                          <th className="px-5 py-3 font-bold text-right">Budget</th>
                          <th className="px-5 py-3 font-bold text-right">PO Value</th>
                          <th className="px-5 py-3 font-bold text-right">WO Value</th>
                          <th className="px-5 py-3 font-bold text-right">Billed</th>
                          <th className="px-5 py-3 font-bold text-right">Variance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pnlData.map((p) => (
                          <tr key={p.tower_id} className="border-b border-border-custom hover:bg-elevated transition-all">
                            <td className="px-5 py-3.5 text-foreground font-semibold">{p.tower_name}</td>
                            <td className="px-5 py-3.5 text-right font-sans text-muted">{fmtAmount(p.budget || 0)}</td>
                            <td className="px-5 py-3.5 text-right font-sans text-warning">{fmtAmount(p.total_po_value || 0)}</td>
                            <td className="px-5 py-3.5 text-right font-sans">{fmtAmount(p.total_wo_value || 0)}</td>
                            <td className="px-5 py-3.5 text-right font-sans text-primary">{fmtAmount(p.total_billed || 0)}</td>
                            <td className="px-5 py-3.5 text-right font-sans text-muted">{fmtAmount((p.budget || 0) - (p.total_billed || 0))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

            </div>
          )}

          {/* TAB: Work Orders */}
          {tab === "wo" && (
            <div className="space-y-6">
              <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
                <div className="px-5 py-4 border-b border-border-custom">
                  <h2 className="text-xs font-bold uppercase tracking-wider text-muted">Active Work Orders</h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="border-b border-border-custom text-muted">
                        <th className="px-5 py-3 font-bold">WO Number</th>
                        <th className="px-5 py-3 font-bold">Subcontractor</th>
                        <th className="px-5 py-3 font-bold">Work Scope / Details</th>
                        <th className="px-5 py-3 font-bold">Estimated WO Amount</th>
                        <th className="px-5 py-3 font-bold">Date Issued</th>
                        <th className="px-5 py-3 font-bold">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {workOrders.map((wo) => (
                        <tr key={wo.id} className="border-b border-border-custom hover:bg-elevated transition-all">
                          <td className="px-5 py-3.5 font-sans text-secondary font-bold">{wo.woNumber}</td>
                          <td className="px-5 py-3.5 text-foreground font-semibold">{wo.subcontractor}</td>
                          <td className="px-5 py-3.5 text-muted">{wo.item}</td>
                          <td className="px-5 py-3.5 font-bold text-foreground">{fmtAmount(wo.value)}</td>
                          <td className="px-5 py-3.5 text-muted">{formatDate(wo.date)}</td>
                          <td className="px-5 py-3.5">
                            <Badge tone={wo.status === "Completed" ? "success" : "info"} className="uppercase font-bold">
                              {formatLabel(wo.status)}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                      {workOrders.length === 0 && (
                        <tr>
                          <td colSpan={6} className="p-8">
                            <EmptyState
                              title="No work orders found"
                              description="Create contractor work orders to formalize scopes of work and manage progress billing."
                              action={{
                                label: "+ Create Work Order",
                                onClick: () => setShowWOModal(true),
                              }}
                            />
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB: Debit/Credit Notes */}
          {tab === "notes" && (
            <div className="space-y-6">
              <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
                <div className="px-5 py-4 border-b border-border-custom">
                  <h2 className="text-xs font-bold uppercase tracking-wider text-muted">Debit & Credit Notes Ledger</h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead>
                      <tr className="border-b border-border-custom text-muted">
                        <th className="px-5 py-3 font-bold">Note ID</th>
                        <th className="px-5 py-3 font-bold">Subcontractor</th>
                        <th className="px-5 py-3 font-bold">Amount Adjustment</th>
                        <th className="px-5 py-3 font-bold">Description Notes</th>
                        <th className="px-5 py-3 font-bold">Movement Type</th>
                        <th className="px-5 py-3 font-bold">Status</th>
                        <th className="px-5 py-3 font-bold">Date Logged</th>
                        <th className="px-5 py-3 font-bold text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {notes.map((note) => (
                        <tr key={note.id} className="border-b border-border-custom hover:bg-elevated transition-all">
                          <td className="px-5 py-3.5 font-sans text-muted">{note.id}</td>
                          <td className="px-5 py-3.5 text-foreground font-semibold">{note.subcontractor}</td>
                          <td className={`px-5 py-3.5 font-sans font-bold ${note.type === "credit" ? "text-success" : "text-danger"}`}>
                            {note.type === "credit" ? "+" : "-"}{fmtAmount(note.amount)}
                          </td>
                          <td className="px-5 py-3.5 text-muted">{note.notes}</td>
                          <td className="px-5 py-3.5">
                            <Badge tone={note.type === "credit" ? "success" : "danger"} className="uppercase font-bold">
                              {note.type.toUpperCase() + " NOTE"}
                            </Badge>
                          </td>
                          <td className="px-5 py-3.5 text-muted font-semibold">{note.status.toUpperCase()}</td>
                          <td className="px-5 py-3.5 text-muted">{note.date}</td>
                          <td className="px-5 py-3.5 text-center">
                            {note.status !== "cancelled" && (
                              <button
                                type="button"
                                onClick={() => handleCancelNote(note.id, note.type)}
                                className="px-2.5 py-1 rounded bg-danger/10 hover:bg-danger/20 border border-danger/20 text-danger text-xs font-bold transition-all cursor-pointer inline-flex items-center gap-1"
                                title="Cancel note"
                              >
                                <Icon name="close" className="w-3.5 h-3.5" /> Cancel
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                      {notes.length === 0 && (
                        <tr>
                          <td colSpan={8} className="p-8">
                            <EmptyState
                              title="No debit or credit notes recorded"
                              description="Debit and credit note adjustments linked to subcontractor billing will appear here."
                            />
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          </PageShell>
        </div>
      </div>

      {/* Modal: Create Work Order */}
      {showWOModal && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-card border border-border-custom rounded-lg w-full max-w-md border border-border-custom rounded-md p-6 space-y-4">
            <div>
              <h3 className="text-sm font-extrabold text-foreground">Create Work Order (WO)</h3>
              <p className="text-xs text-muted mt-1">Issue a formal contract scope for labor works.</p>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">WO Serial Code</label>
                  <input
                    type="text"
                    value={newWONum}
                    onChange={(e) => setNewWONum(e.target.value)}
                    className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary font-sans"
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Subcontractor</label>
                  <select
                    value={newWOSub}
                    onChange={(e) => setNewWOSub(e.target.value)}
                    className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary font-semibold"
                  >
                    <option value="">Select subcontractor</option>
                    {subcontractors.map((s) => (
                      <option key={s.company_team_id} value={s.company_team_id}>{s.name}</option>
                    ))}
                  </select>
                  {subcontractors.length === 0 && (
                    <FieldHint text="No subcontractors yet. Add one in Subcontractors." href={`/c/${companyId}/d/subcon`} linkLabel="Go to Subcontractors" />
                  )}
                </div>
              </div>

              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Work Description / Scope</label>
                <textarea
                  value={newWOItem}
                  onChange={(e) => setNewWOItem(e.target.value)}
                  placeholder="Bricklaying, plastering, or BBS detailing..."
                  rows={2}
                  className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary"
                />
              </div>

              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Total Estimated Value (₹)</label>
                <input
                  type="number"
                  value={newWOValue}
                  onChange={(e) => setNewWOValue(parseInt(e.target.value))}
                  className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none"
                />
              </div>
            </div>

            <div className="flex gap-3 justify-end pt-2">
              <button onClick={() => setShowWOModal(false)} className="px-4 py-2 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer">Cancel</button>
              <button onClick={handleCreateWO} className="bg-primary hover:opacity-90 text-white px-5 py-2 rounded-md text-xs font-bold cursor-pointer">Submit WO</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Create RA Bill (with interactive math engine preview) */}
      {showBillModal && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-card border border-border-custom rounded-lg w-full max-w-2xl border border-border-custom rounded-md p-6 grid grid-cols-12 gap-6 my-10">
            
            {/* Form Column */}
            <div className="col-span-12 md:col-span-7 space-y-4">
              <div>
                <h3 className="text-sm font-extrabold text-foreground font-sans">Submit Subcontractor RA Bill</h3>
                <p className="text-xs text-muted mt-1">Submit subcontractor bills with real-time deduction auditing.</p>
              </div>

              <div className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] uppercase font-bold text-muted block mb-1">Bill Serial ID</label>
                    <input
                      type="text"
                      value={newBillNum}
                      onChange={(e) => setNewBillNum(e.target.value)}
                      className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none font-sans"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-bold text-muted block mb-1">Subcontractor</label>
                    <select
                      value={newBillSub}
                      onChange={(e) => setNewBillSub(e.target.value)}
                      className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none font-semibold"
                    >
                      <option value="">Select subcontractor</option>
                      {subcontractors.map((s) => (
                        <option key={s.company_team_id} value={s.company_team_id}>{s.name}</option>
                      ))}
                    </select>
                    {subcontractors.length === 0 && (
                      <FieldHint text="No subcontractors yet. Add one in Subcontractors." href={`/c/${companyId}/d/subcon`} linkLabel="Go to Subcontractors" />
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] uppercase font-bold text-muted block mb-1">Billed Subtotal (₹)</label>
                    <input
                      type="number"
                      value={newBillSubtotal}
                      onChange={(e) => setNewBillSubtotal(parseInt(e.target.value))}
                      className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary font-sans font-bold"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-bold text-muted block mb-1">GST Percentage (%)</label>
                    <input
                      type="number"
                      value={newBillGstPct}
                      onChange={(e) => setNewBillGstPct(parseInt(e.target.value))}
                      className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] uppercase font-bold text-muted block mb-1">TDS Rate Preset</label>
                    <div className="flex gap-1 mb-1.5">
                      <button
                        type="button"
                        onClick={() => setNewBillTdsPct(1)}
                        className={`px-1.5 py-0.5 rounded text-[8px] font-bold border transition-all cursor-pointer ${
                          newBillTdsPct === 1
                            ? "bg-primary border-primary text-white"
                            : "bg-elevated border-border-custom text-muted hover:text-foreground"
                        }`}
                      >
                        1% (194C Indiv)
                      </button>
                      <button
                        type="button"
                        onClick={() => setNewBillTdsPct(2)}
                        className={`px-1.5 py-0.5 rounded text-[8px] font-bold border transition-all cursor-pointer ${
                          newBillTdsPct === 2
                            ? "bg-primary border-primary text-white"
                            : "bg-elevated border-border-custom text-muted hover:text-foreground"
                        }`}
                      >
                        2% (194C Corp)
                      </button>
                      <button
                        type="button"
                        onClick={() => setNewBillTdsPct(0.1)}
                        className={`px-1.5 py-0.5 rounded text-[8px] font-bold border transition-all cursor-pointer ${
                          newBillTdsPct === 0.1
                            ? "bg-primary border-primary text-white"
                            : "bg-elevated border-border-custom text-muted hover:text-foreground"
                        }`}
                      >
                        0.1% (194Q)
                      </button>
                    </div>
                    <div className="relative">
                      <input
                        type="number"
                        step="0.1"
                        value={newBillTdsPct}
                        onChange={(e) => setNewBillTdsPct(parseFloat(e.target.value) || 0)}
                        className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary font-sans"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted text-[10px]">%</span>
                    </div>
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-bold text-muted block mb-1">GST Rate Preset</label>
                    <div className="flex gap-1 mb-1.5">
                      <button
                        type="button"
                        onClick={() => setNewBillGstPct(18)}
                        className={`px-1.5 py-0.5 rounded text-[8px] font-bold border transition-all cursor-pointer ${
                          newBillGstPct === 18
                            ? "bg-secondary border-secondary text-foreground"
                            : "bg-elevated border-border-custom text-muted hover:text-foreground"
                        }`}
                      >
                        18% (Works Contract)
                      </button>
                      <button
                        type="button"
                        onClick={() => setNewBillGstPct(12)}
                        className={`px-1.5 py-0.5 rounded text-[8px] font-bold border transition-all cursor-pointer ${
                          newBillGstPct === 12
                            ? "bg-secondary border-secondary text-foreground"
                            : "bg-elevated border-border-custom text-muted hover:text-foreground"
                        }`}
                      >
                        12% (Infra)
                      </button>
                      <button
                        type="button"
                        onClick={() => setNewBillGstPct(5)}
                        className={`px-1.5 py-0.5 rounded text-[8px] font-bold border transition-all cursor-pointer ${
                          newBillGstPct === 5
                            ? "bg-secondary border-secondary text-foreground"
                            : "bg-elevated border-border-custom text-muted hover:text-foreground"
                        }`}
                      >
                        5% (Housing)
                      </button>
                    </div>
                    <div className="relative">
                      <input
                        type="number"
                        value={newBillGstPct}
                        onChange={(e) => setNewBillGstPct(parseInt(e.target.value) || 0)}
                        className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary font-sans"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted text-[10px]">%</span>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] uppercase font-bold text-muted block mb-1">Retention (%)</label>
                    <input
                      type="number"
                      value={newBillRetentionPct}
                      onChange={(e) => setNewBillRetentionPct(parseInt(e.target.value) || 0)}
                      className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none font-sans"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-bold text-muted block mb-1">Advance Return (₹)</label>
                    <input
                      type="number"
                      value={newBillAdvanceRecovery}
                      onChange={(e) => setNewBillAdvanceRecovery(parseInt(e.target.value) || 0)}
                      className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none font-sans"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Terms &amp; Conditions</label>
                  <textarea
                    value={newBillTerms}
                    onChange={(e) => setNewBillTerms(e.target.value)}
                    placeholder="Pre-filled from company Invoice / Subcon Terms; edit as needed"
                    rows={3}
                    className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary"
                  />
                </div>

                {billCustomFields.fields.length > 0 && (
                  <CustomFieldsSection
                    fields={billCustomFields.fields}
                    values={billCustomFields.values}
                    setValue={billCustomFields.setValue}
                  />
                )}

                {/* GST base toggle. This does NOT change which deduction is
                    computed first; that is a company setting. */}
                <div className="flex items-center justify-between p-3 rounded-md bg-elevated border border-border-custom">
                  <div>
                    <span className="text-xs font-bold text-foreground block">Charge GST after deductions</span>
                    <span className="text-[9px] text-muted">GST is charged on the work value net of retention and TDS.</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={newBillPreTax}
                    onChange={(e) => setNewBillPreTax(e.target.checked)}
                    className="h-4 w-4 accent-primary cursor-pointer"
                  />
                </div>
              </div>

              <div className="flex gap-3 justify-end pt-2">
                <button onClick={() => setShowBillModal(false)} className="px-4 py-2 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer">Cancel</button>
                <button onClick={handleCreateBill} className="bg-primary hover:opacity-90 text-white px-5 py-2 rounded-md text-xs font-bold cursor-pointer">Submit RA Bill</button>
              </div>
            </div>

            {/* Billing Engine Calculator Preview Column */}
            <div className="col-span-12 md:col-span-5 bg-elevated border border-border-custom rounded-lg p-5 space-y-4 flex flex-col justify-between">
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-secondary">Billing Engine Preview</h4>
                <p className="text-[9px] text-muted mt-1 leading-snug">Matches the deduction order configured for this company. TDS and retention are computed on the work value, before GST.</p>
              </div>

              <div className="space-y-2.5 text-xs">
                <div className="flex justify-between text-muted">
                  <span>Gross Subtotal:</span>
                  <span className="font-sans font-bold text-foreground">{fmtAmount(newBillSubtotal)}</span>
                </div>
                
                <div className="flex justify-between text-muted">
                  <span>TDS ({newBillTdsPct}%):</span>
                  <span className="font-sans text-danger">-{fmtAmount(preview.tdsAmt)}</span>
                </div>

                <div className="flex justify-between text-muted">
                  <span>Retention ({newBillRetentionPct}%):</span>
                  <span className="font-sans text-danger">-{fmtAmount(preview.retentionAmt)}</span>
                </div>

                {newBillAdvanceRecovery > 0 && (
                  <div className="flex justify-between text-muted">
                    <span>Advance Recovery:</span>
                    <span className="font-sans text-danger">-₹{newBillAdvanceRecovery.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                  </div>
                )}

                <div className="flex justify-between text-muted border-t border-border-custom pt-2">
                  <span>GST ({newBillGstPct}%):</span>
                  <span className="font-sans text-success">+{fmtAmount(preview.gstAmt)}</span>
                </div>

                <div className="flex justify-between items-center text-foreground border-t border-border-custom pt-3 mt-1 font-extrabold text-sm">
                  <span>Net Payable:</span>
                  <span className="font-sans text-primary bg-primary/10 border border-primary/20 px-2 py-1 rounded-lg">
                    {fmtAmount(preview.totalPayable)}
                  </span>
                </div>
              </div>

              {/* Information alert details */}
              <div className="p-3 bg-secondary/10 border border-secondary/20 rounded-md text-[9px] text-muted leading-normal">
                {newBillPreTax ? (
                  <span><strong>Pre-tax Mode ON:</strong> GST is charged on the work value after deductions. TDS and retention are still computed on the work value, never on the GST.</span>
                ) : (
                  <span><strong>Post-tax Mode ON (Default):</strong> GST is charged on the full work value. TDS and retention are computed on the work value, not on the GST, and apply in the order set in Settings.</span>
                )}
              </div>
            </div>

          </div>
        </div>
      )}

      {/* Bill Detail Drawer */}
      {selectedBillForDetail && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex justify-end" onClick={() => setSelectedBillForDetail(null)}>
          <div className="bg-card w-full max-w-xl h-full border-l border-border-custom shadow-2xl p-6 flex flex-col justify-between overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="space-y-6">
              <div className="flex items-center justify-between pb-4 border-b border-border-custom">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-base font-bold text-foreground uppercase tracking-wider font-sans">
                      Bill #{selectedBillForDetail.invoiceNumber}
                    </h2>
                    <Badge tone={selectedBillForDetail.status === "Cancelled" ? "danger" : selectedBillForDetail.status === "Paid" ? "success" : "warning"} className="font-bold uppercase text-[9px]">
                      {formatLabel(selectedBillForDetail.status)}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted mt-0.5 font-sans">
                    {selectedBillForDetail.subcontractor} · {formatDate(selectedBillForDetail.invoiceDate)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {selectedBillForDetail.status !== "Cancelled" && (
                    <button
                      type="button"
                      onClick={() => handleCancelBill(selectedBillForDetail)}
                      className="px-2.5 py-1 bg-danger/10 border border-danger/20 text-danger hover:bg-danger/20 text-xs font-bold rounded-lg transition-all cursor-pointer inline-flex items-center gap-1"
                    >
                      <Icon name="close" className="w-3.5 h-3.5" /> Cancel Bill
                    </button>
                  )}
                  <button onClick={() => setSelectedBillForDetail(null)} className="text-muted hover:text-foreground cursor-pointer p-1">
                    <Icon name="close" className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {/* Financial Metrics Summary */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-elevated/40 border border-border-custom p-3 rounded-lg">
                  <span className="text-[9px] uppercase font-bold text-muted block">Billed Subtotal</span>
                  <span className="text-xs font-bold text-foreground mt-0.5 block">₹{selectedBillForDetail.subtotal.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="bg-elevated/40 border border-border-custom p-3 rounded-lg">
                  <span className="text-[9px] uppercase font-bold text-muted block">GST Total</span>
                  <span className="text-xs font-bold text-foreground mt-0.5 block">₹{selectedBillForDetail.gstAmount.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="bg-elevated/40 border border-border-custom p-3 rounded-lg">
                  <span className="text-[9px] uppercase font-bold text-muted block">Deductions Mode</span>
                  <span className="text-xs font-bold text-muted mt-0.5 block">{selectedBillForDetail.preTax ? "Pre-Tax" : "Post-Tax"}</span>
                </div>
                <div className="bg-primary/10 border border-primary/20 p-3 rounded-lg">
                  <span className="text-[9px] uppercase font-bold text-primary block">Net Payable</span>
                  <span className="text-xs font-extrabold text-primary mt-0.5 block">₹{selectedBillForDetail.totalPayable.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                </div>
              </div>

              {/* Deductions Breakdown & Retention Release */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">Withheld Deductions & Retentions</h3>
                  <span className="text-[11px] text-muted">
                    Total: ₹{selectedBillForDetail.deductions.reduce((s, d) => s + Number(d.amount), 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                  </span>
                </div>

                {selectedBillForDetail.deductions.length === 0 ? (
                  <div className="bg-elevated/20 border border-border-custom rounded-lg p-4 text-center text-muted text-xs">
                    No deductions recorded against this bill.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {selectedBillForDetail.deductions.map((d, idx) => {
                      const isRetention = d.type === "Retention";
                      const released = Number(d.released_amount || 0);
                      const outstanding = Math.max(0, Number(d.amount) - released);
                      return (
                        <div key={d.id || idx} className="bg-card border border-border-custom rounded-lg p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Badge tone={isRetention ? "info" : "neutral"} className="font-bold text-[10px]">
                                {d.type}
                              </Badge>
                              {d.rate && <span className="text-[11px] text-muted font-sans font-semibold">({d.rate}%)</span>}
                            </div>
                            <span className="text-xs font-bold text-foreground font-sans">
                              ₹{Number(d.amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                            </span>
                          </div>

                          {d.notes && <p className="text-[11px] text-muted">{d.notes}</p>}

                          {isRetention && (
                            <div className="pt-2 border-t border-border-custom flex items-center justify-between flex-wrap gap-2 text-[11px]">
                              <div className="flex items-center gap-3 text-muted">
                                <span>Released: <strong className="text-foreground">₹{released.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</strong></span>
                                <span>Remaining: <strong className="text-foreground">₹{outstanding.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</strong></span>
                              </div>
                              {selectedBillForDetail.status !== "Cancelled" && (
                                outstanding > 0 ? (
                                  <button
                                    type="button"
                                    onClick={() => setRetentionModal({
                                      bill: selectedBillForDetail,
                                      deduction: d,
                                      mode: "full",
                                      partialAmount: outstanding,
                                    })}
                                    className="px-2.5 py-1 bg-primary hover:bg-primary/95 text-white font-bold rounded text-xs transition-all cursor-pointer"
                                  >
                                    Release Retention
                                  </button>
                                ) : (
                                  <Badge tone="success" className="font-bold text-[9px]">Fully Released</Badge>
                                )
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="pt-4 border-t border-border-custom flex justify-end">
              <button
                type="button"
                onClick={() => setSelectedBillForDetail(null)}
                className="px-4 py-2 bg-elevated hover:bg-card border border-border-custom text-foreground text-xs font-semibold rounded-lg transition-all cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Retention Release Dialog */}
      {retentionModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setRetentionModal(null)}>
          <div className="bg-card border border-border-custom rounded-xl w-full max-w-md p-6 relative shadow-2xl space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border-custom pb-3">
              <div>
                <h3 className="text-sm font-bold text-foreground uppercase tracking-wider font-sans">Release Retention</h3>
                <p className="text-[11px] text-muted mt-0.5">
                  {retentionModal.bill.subcontractor} · Bill #{retentionModal.bill.invoiceNumber}
                </p>
              </div>
              <button onClick={() => setRetentionModal(null)} className="text-muted hover:text-foreground cursor-pointer">
                <Icon name="close" className="w-5 h-5" />
              </button>
            </div>

            {/* Retention Status Card */}
            {(() => {
              const released = Number(retentionModal.deduction.released_amount || 0);
              const outstanding = Math.max(0, Number(retentionModal.deduction.amount) - released);
              return (
                <div className="space-y-4 text-xs">
                  <div className="grid grid-cols-3 gap-2 bg-elevated/40 border border-border-custom p-3 rounded-lg text-center">
                    <div>
                      <span className="text-[9px] uppercase font-bold text-muted block">Withheld</span>
                      <span className="text-xs font-bold text-foreground mt-0.5 block">₹{Number(retentionModal.deduction.amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                    </div>
                    <div>
                      <span className="text-[9px] uppercase font-bold text-muted block">Released</span>
                      <span className="text-xs font-bold text-muted mt-0.5 block">₹{released.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                    </div>
                    <div>
                      <span className="text-[9px] uppercase font-bold text-primary block">Remaining</span>
                      <span className="text-xs font-extrabold text-primary mt-0.5 block">₹{outstanding.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] uppercase font-bold text-muted block">Release Mode</label>
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 p-2.5 rounded-lg border border-border-custom hover:bg-elevated/40 cursor-pointer">
                        <input
                          type="radio"
                          name="releaseMode"
                          checked={retentionModal.mode === "full"}
                          onChange={() => setRetentionModal({ ...retentionModal, mode: "full" })}
                          className="text-primary"
                        />
                        <span className="text-xs font-semibold text-foreground">
                          Release full remaining (₹{outstanding.toLocaleString("en-IN", { minimumFractionDigits: 2 })})
                        </span>
                      </label>

                      <label className="flex items-center gap-2 p-2.5 rounded-lg border border-border-custom hover:bg-elevated/40 cursor-pointer">
                        <input
                          type="radio"
                          name="releaseMode"
                          checked={retentionModal.mode === "partial"}
                          onChange={() => setRetentionModal({ ...retentionModal, mode: "partial", partialAmount: Math.min(outstanding, outstanding / 2) })}
                          className="text-primary"
                        />
                        <span className="text-xs font-semibold text-foreground">
                          Release partial amount
                        </span>
                      </label>
                    </div>
                  </div>

                  {retentionModal.mode === "partial" && (
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase font-bold text-muted block">Partial Release Amount (₹)*</label>
                      <input
                        type="number"
                        min="0.01"
                        max={outstanding}
                        step="any"
                        value={retentionModal.partialAmount}
                        onChange={(e) => setRetentionModal({ ...retentionModal, partialAmount: parseFloat(e.target.value) || 0 })}
                        className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground text-xs focus:outline-none focus:border-primary font-sans font-bold"
                      />
                      <span className="text-[10px] text-muted">Maximum releasable: ₹{outstanding.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
                    </div>
                  )}

                  <div className="flex items-center justify-end gap-2 pt-3 border-t border-border-custom">
                    <button
                      type="button"
                      onClick={() => setRetentionModal(null)}
                      className="px-4 py-2 bg-elevated hover:bg-card border border-border-custom text-muted hover:text-foreground text-xs font-semibold rounded-lg transition-all cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleReleaseRetention}
                      className="px-5 py-2 bg-primary hover:bg-primary/95 text-white text-xs font-bold rounded-lg transition-all cursor-pointer"
                    >
                      Confirm Release
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

    </div>
  );
}