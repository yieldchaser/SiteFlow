"use client";
import Badge, { type BadgeTone } from "@/components/ui/Badge";
import {  getApiHost , readErrorDetail, detailToMessage} from "@/lib/api";
import { authHeaders, formatDate, formatLabel, todayLocalISO } from "@/lib/siteflow";

import React, { useState, useEffect, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useProject } from "@/context/ProjectContext";
import Icon, { type IconName } from "@/components/marketing/Icon";
// R2-755: shared CSV guard. Quote-doubling protects the delimiter, not the
// formula — a leading = + - @ executes when the export opens in Excel/Sheets.
import { buildCsv } from "@/lib/csv";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import SegmentedTabs from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import FieldHint from "@/components/ui/FieldHint";

interface Transaction {
  id: string;
  date: string;
  type: "Expense" | "Receipt" | "Debit Note" | "Credit Note" | "Party to Party" | "Internal Transfer";
  category: string;
  description: string;
  amount: number;
  party: string;
  ref: string;
  ref_invoice?: string;
  ledger: string;
  status: "Pending" | "Approved" | "Rejected";
  cost_code?: string;
  photo_url?: string;
  settled_amount: number;
  balance_due: number;
  project_id?: string;
  project_name?: string;
  due_date?: string;
}

interface LedgerEntry {
  id: string;
  date: string;
  type: string;
  category: string;
  description: string;
  amount: number;
  party: string;
  ref: string;
  ledger: string;
  debit: number;
  credit: number;
  balance: number;
}

interface PLItem {
  head: string;
  budget: number;
  actual: number;
  variance: number;
}

interface TallyConnection {
  id?: string;
  connected?: boolean;
  tally_company_name?: string;
  registered_mobile?: string;
  sync_window_start_date?: string;
  voucher_number_template?: string;
  default_cash_ledger?: string;
  round_off_ledger?: string;
  auto_create_missing_ledgers?: boolean;
}

interface TallyPartyMapping {
  id: string;
  company_id: string;
  onsite_party_id: string;
  tally_ledger_name: string;
}

interface TallyLedgerMapping {
  id: string;
  company_id: string;
  onsite_transaction_type: string;
  posting_mode: string;
  tally_voucher_type: string;
  tally_ledger_name: string;
  freight_ledger?: string;
  surcharge_ledger?: string;
}

interface TallyCostCentreMapping {
  id: string;
  company_id: string;
  project_id: string;
  tally_cost_centre_name: string;
}

interface TallyPendingVoucher {
  type: string;
  number: string;
  party: string;
  amount: number;
  date: string;
}

interface TallySyncLog {
  id: string;
  company_id: string;
  exported_at: string | null;
  marked_synced_at: string | null;
  voucher_count: number;
  created_at: string;
}

function formatDmy(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d.getDate()).padStart(2, "0")} ${m[d.getMonth()]} ${d.getFullYear()}`;
}

function fyStartIso(): string {
  const d = new Date();
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-04-01`;
}

export default function FinancePage() {
  const router = useRouter();
  const params = useParams();
  const companyId = params?.company_id as string;
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;

  const [tab, setTab] = useState<"ledger" | "general_ledger" | "party" | "cashbook" | "pl" | "tally" | "costvar" | "payment_requests" | "accounts">("ledger");
  
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [projectLedger, setProjectLedger] = useState<LedgerEntry[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerDateFilter, setLedgerDateFilter] = useState("");
  const [ledgerSearchQuery, setLedgerSearchQuery] = useState("");
  const [plData, setPlData] = useState<PLItem[]>([]);
  const [tallyConn, setTallyConn] = useState<TallyConnection | null>(null);

  // Zoho Books push-to-ledger state
  const [zohoConnected, setZohoConnected] = useState(false);
  const [zohoPushingId, setZohoPushingId] = useState<string | null>(null);
  const [zohoMsg, setZohoMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const pushToZoho = async (billId: string) => {
    setZohoPushingId(billId);
    setZohoMsg(null);
    try {
      const res = await fetch(
        `${getApiHost()}/apis/v3/integrations/zoho-books/companies/${companyId}/push-bill/${billId}`,
        { method: "POST", headers: authHeaders() }
      );
      const body = await res.json().catch(() => ({} as any));
      if (res.ok) {
        setZohoMsg({ type: "ok", text: `Pushed to Zoho Books (bill ${body.zoho_bill_id || "created"}).` });
      } else {
        setZohoMsg({ type: "err", text: detailToMessage(body.detail, "Zoho Books push failed.") });
      }
    } catch (e: any) {
      setZohoMsg({ type: "err", text: e?.message || "Zoho Books push failed." });
    } finally {
      setZohoPushingId(null);
    }
  };

  // Details drawer voucher state
  const [selectedVoucher, setSelectedVoucher] = useState<Transaction | null>(null);

  // Record Payment Modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [selectedTxnType, setSelectedTxnType] = useState<any>("Expense");
  const [amount, setAmount] = useState("");
  const [partyName, setPartyName] = useState("");
  const [refNum, setRefNum] = useState("");
  const [refInvoice, setRefInvoice] = useState("");
  const [desc, setDesc] = useState("");
  const [txnDate, setTxnDate] = useState(() => todayLocalISO());
  const [costCode, setCostCode] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("Cash");
  const [submitting, setSubmitting] = useState(false);
  const [photoUrl, setPhotoUrl] = useState<string>("");

  // Dynamic Transaction Options matching competitor UI
  const [showBillShipModal, setShowBillShipModal] = useState(false);
  const [billShip, setBillShip] = useState({ billFrom: "", billTo: "", shipFrom: "", shipTo: "" });
  const [sameAsBillFrom, setSameAsBillFrom] = useState(false);
  const [sameAsBillTo, setSameAsBillTo] = useState(false);
  const [csvPreview, setCsvPreview] = useState<any[] | null>(null);
  const [csvFile, setCsvFile] = useState<File | null>(null);

  // Interactive Tag Sales, Reference No, Notes toggles
  const [taggedSalesInvoice, setTaggedSalesInvoice] = useState("");

  // Additional 12-button interactive state toggles

  // Transfer & Sub-form state variables
  const [paymentFromParty, setPaymentFromParty] = useState("");
  const [paymentToParty, setPaymentToParty] = useState("");

  // Equipment & Material Transfer fields

  // Bank Accounts & Payment Requests states
  const [bankAccounts, setBankAccounts] = useState<any[]>([]);
  const [cashAccount, setCashAccount] = useState<any>(null);
  const [cashRunning, setCashRunning] = useState(0);
  const [paymentRequests, setPaymentRequests] = useState<any[]>([]);
  const [showAddBankModal, setShowAddBankModal] = useState(false);
  const [newBank, setNewBank] = useState({ name: "", holder: "", number: "", ifsc: "", upi: "", balance: "" });
  const [showAddCashModal, setShowAddCashModal] = useState(false);
  const [newCash, setNewCash] = useState({ name: "Cash Account", opening: "" });
  const [showAddRequestModal, setShowAddRequestModal] = useState(false);
  const [newRequest, setNewRequest] = useState({ partyId: "", amount: "", details: "", dueDate: "", requestType: "", extra: "" });
  const [prStep, setPrStep] = useState<"type" | "form">("type");
  const [prType, setPrType] = useState<any>(null);
  const [selectedPR, setSelectedPR] = useState<any>(null);
  const [showRecordPaymentModal, setShowRecordPaymentModal] = useState(false);
  const [prPayment, setPrPayment] = useState({ date: "", mode: "Cash", paidAmount: "", deduction: "0", tds: "0", remarks: "", referenceNo: "", attachmentName: "" });
  const [usersList, setUsersList] = useState<any[]>([]);
  // Real references for the "Advance against ..." request types, so the ref is a
  // link to a document rather than a typed string nobody can resolve later.
  const [refWorkOrders, setRefWorkOrders] = useState<Array<{ id: string; wo_number: string; subcontractor_name?: string }>>([]);
  const [refPOs, setRefPOs] = useState<Array<{ id: string; po_number: string; vendor_name?: string }>>([]);

  const PR_TYPES: { key: string; icon: IconName; label: string; extraLabel: string; extraPlaceholder: string }[] = [
    { key: "Advance against PO", icon: "description", label: "Advance against PO", extraLabel: "PO Reference", extraPlaceholder: "PO-204" },
    { key: "Advance against Subcon Work Order", icon: "ledger", label: "Advance against Subcon Work Order", extraLabel: "Work Order Ref", extraPlaceholder: "WO-1001" },
    { key: "Advance against BOQ", icon: "ruler", label: "Advance against BOQ", extraLabel: "BOQ Document Ref", extraPlaceholder: "BOQ-..." },
    { key: "Advance against Material Purchase", icon: "package", label: "Advance against Material Purchase", extraLabel: "Material Purchase Ref", extraPlaceholder: "MP-..." },
    { key: "Advance against Subcon Expense", icon: "brick", label: "Advance against Subcon Expense", extraLabel: "Subcon Expense Ref", extraPlaceholder: "SE-..." },
    { key: "Advance against Other Expense", icon: "receipt", label: "Advance against Other Expense", extraLabel: "Other Expense Ref", extraPlaceholder: "OE-..." },
    { key: "Advance for Labour", icon: "worker", label: "Advance for Labour", extraLabel: "Labour Ref", extraPlaceholder: "Labour / Workforce" },
    { key: "Petty Cash", icon: "banknote", label: "Petty Cash", extraLabel: "", extraPlaceholder: "" },
    { key: "Other", icon: "memo", label: "Other", extraLabel: "", extraPlaceholder: "" },
  ];

  // Company-level Party sub-tab states
  const [companyParties, setCompanyParties] = useState<any[]>([]);
  const [showAddPartyModal, setShowAddPartyModal] = useState(false);
  const [partyTabStatus, setPartyTabStatus] = useState("All");
  const [newParty, setNewParty] = useState({
    name: "", phone: "", email: "", party_type: "Supplier", address: "",
    party_id_custom: "", date_of_joining: "", aadhaar_number: "", pan_number: "",
    contractor_role: "", bank_account_id: "", opening_balance: "", opening_balance_type: "pay",
    create_wo: false, wo_title: "", wo_terms: "",
  });
  const [serviceTags, setServiceTags] = useState<string[]>([]);
  const [serviceTagInput, setServiceTagInput] = useState("");

  // Company-level Transaction sub-tab states
  const [txnSummary, setTxnSummary] = useState<any>({
    total_invoice: 0, unpaid_invoice: 0, total_expense: 0, unpaid_expense: 0,
    company_balance: 0, cash_balance: 0, in_total: 0, out_total: 0, transactions: [],
  });
  // Distinguishes "not loaded yet" / "load failed" from a genuine all-zero ledger,
  // so a cold-start or failed fetch can no longer render as rupee-zero totals.
  const [txnLoad, setTxnLoad] = useState<"loading" | "ready" | "error">("loading");
  const [txnDateFilter, setTxnDateFilter] = useState("");
  const [showUnbilledOnly, setShowUnbilledOnly] = useState(false);
  const [showPendingOnly, setShowPendingOnly] = useState(false);

  // Tally Sync States
  const [tallyPending, setTallyPending] = useState<{ count: number; bill_ids: string[]; payment_ids: string[]; vouchers: TallyPendingVoucher[] }>({ count: 0, bill_ids: [], payment_ids: [], vouchers: [] });
  const [tallyExporting, setTallyExporting] = useState(false);
  const [tallyMarking, setTallyMarking] = useState(false);
  const [tallyLastExport, setTallyLastExport] = useState<string | null>(null);
  const [tallyLastMarked, setTallyLastMarked] = useState<string | null>(null);
  const [tallyMsg, setTallyMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // Tally Setup Modal
  const [showTallySetup, setShowTallySetup] = useState(false);
  const [tallyCompany, setTallyCompany] = useState("");
  const [tallyMobile, setTallyMobile] = useState("");
  const [tallyVoucherTemplate, setTallyVoucherTemplate] = useState("SF-{year}-{number}");
  const [tallyDefaultCash, setTallyDefaultCash] = useState("");
  const [tallyRoundOff, setTallyRoundOff] = useState("");
  const [tallyAutoCreate, setTallyAutoCreate] = useState(false);
  const [tallySyncFrom, setTallySyncFrom] = useState(fyStartIso());
  const [tallySaving, setTallySaving] = useState(false);

  // Tally Mappings
  const [tallyPartyMappings, setTallyPartyMappings] = useState<TallyPartyMapping[]>([]);
  const [tallyLedgerMappings, setTallyLedgerMappings] = useState<TallyLedgerMapping[]>([]);
  const [tallyCostCentreMappings, setTallyCostCentreMappings] = useState<TallyCostCentreMapping[]>([]);
  const [partyLedgerInputs, setPartyLedgerInputs] = useState<Record<string, string>>({});
  const [purchaseLedgerInput, setPurchaseLedgerInput] = useState("Purchase A/c");
  const [salesLedgerInput, setSalesLedgerInput] = useState("Sales A/c");
  const [freightLedgerInput, setFreightLedgerInput] = useState("");
  const [surchargeLedgerInput, setSurchargeLedgerInput] = useState("");
  const [costCentreInput, setCostCentreInput] = useState("");
  const [tallySyncLogs, setTallySyncLogs] = useState<TallySyncLog[]>([]);

  // Search & Filters
  const [searchQuery, setSearchQuery] = useState("");

  // Party sub-tab states
  const [partySearchQuery, setPartySearchQuery] = useState("");

  const fetchData = async () => {
    try {
      // Fetch Company-level Transactions & Summary (Finance tab: Transaction sub-tab)
      try {
        const txnRes = await fetch(`${getApiHost()}/apis/v3/finance/transactions/${companyId}`, { headers: authHeaders() });
        if (txnRes.ok) {
          setTxnSummary(await txnRes.json());
          setTxnLoad("ready");
        } else {
          setTxnLoad("error");
        }
      } catch {
        setTxnLoad("error");
      }

      // Project-scoped P&L only when a real project is active.
      if (projectId) {
        try {
          const plRes = await fetch(`${getApiHost()}/apis/v3/finance/pl?project_id=${projectId}`, { headers: authHeaders() });
          if (plRes.ok) {
            setPlData(await plRes.json());
          }
        } catch {}
      }

      try {
        const tallyRes = await fetch(`${getApiHost()}/apis/v3/tally/connections?company_id=${companyId}`, { headers: authHeaders() });
        if (tallyRes.ok) {
          const data = await tallyRes.json();
          if (data && data.connected === false) {
            setTallyConn(null);
          } else {
            setTallyConn(data);
            setTallyCompany(data.tally_company_name || "");
            setTallyMobile(data.registered_mobile || "");
            setTallyVoucherTemplate(data.voucher_number_template || "");
            setTallyDefaultCash(data.default_cash_ledger || "");
            setTallyAutoCreate(Boolean(data.auto_create_missing_ledgers));
          }
        }
      } catch {}

      // Fetch Bank Accounts
      try {
        const bankRes = await fetch(`${getApiHost()}/apis/v3/finance/accounts/${companyId}`, { headers: authHeaders() });
        if (bankRes.ok) {
          setBankAccounts(await bankRes.json());
        }
      } catch {}

      // Fetch Cash Account (running balance)
      try {
        const cashRes = await fetch(`${getApiHost()}/apis/v3/finance/cash-account/${companyId}`, { headers: authHeaders() });
        if (cashRes.ok) {
          const ca = await cashRes.json();
          setCashAccount(ca);
          setCashRunning(ca ? ca.running_balance : 0);
        }
      } catch {}

      // Fetch Payment Requests
      try {
        const reqRes = await fetch(`${getApiHost()}/apis/v3/finance/payment-requests/${companyId}`, { headers: authHeaders() });
        if (reqRes.ok) {
          setPaymentRequests(await reqRes.json());
        }
      } catch {}

      // Fetch Company-level Parties (Finance tab: Party sub-tab)
      try {
        const partyRes = await fetch(`${getApiHost()}/apis/v3/finance/parties/${companyId}`, { headers: authHeaders() });
        if (partyRes.ok) {
          setCompanyParties(await partyRes.json());
        }
      } catch {}

      // Zoho Books connection status (gates the per-bill push button)
      try {
        const zohoRes = await fetch(`${getApiHost()}/apis/v3/integrations/zoho-books/status/${companyId}`, { headers: authHeaders() });
        if (zohoRes.ok) {
          const zs = await zohoRes.json();
          setZohoConnected(Boolean(zs.connected));
        }
      } catch {}

      // Parties for the payment dropdowns. This used to read
      // /hr/employees/{projectId}, the employee directory, so a payment request
      // could only ever name an employee of the active project. On a project
      // with no employees the drawer said "No parties registered yet" while the
      // company had a full party master, and there was no way to raise a
      // payment to the subcontractor you actually owed.
      try {
        const partyRes = await fetch(`${getApiHost()}/apis/v3/finance/parties/${companyId}`, { headers: authHeaders() });
        if (partyRes.ok) {
          const parties = await partyRes.json();
          setUsersList(
            (parties || []).map((pt: any) => ({
              id: pt.id,
              name: pt.name,
              role: pt.party_type || pt.contractor_role || null,
            }))
          );
        }
      } catch {}
      if (projectId) {
        try {
          const [woRes, poRes] = await Promise.all([
            fetch(`${getApiHost()}/apis/v3/billing/work-orders?project_id=${projectId}`, { headers: authHeaders() }),
            fetch(`${getApiHost()}/apis/v3/procurement/pos?project_id=${projectId}`, { headers: authHeaders() }),
          ]);
          if (woRes.ok) setRefWorkOrders(await woRes.json());
          if (poRes.ok) setRefPOs(await poRes.json());
        } catch {}
        try {
          await fetchGeneralLedger();
        } catch {}
      }
    } catch (e) {
      console.error("Failed to load finance data", e);
      setTxnLoad("error");
    }
  };

  const fetchGeneralLedger = async () => {
    if (!projectId) return;
    try {
      setLedgerLoading(true);
      const res = await fetch(`${getApiHost()}/apis/v3/finance/ledger?project_id=${projectId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setProjectLedger(Array.isArray(data) ? data : []);
      } else {
        setProjectLedger([]);
      }
    } catch (e) {
      console.error("Failed to load project general ledger", e);
      setProjectLedger([]);
    } finally {
      setLedgerLoading(false);
    }
  };

  const handleDeletePayment = async (paymentId: string) => {
    if (!confirm("Are you sure you want to delete this payment voucher? This will reverse any linked bill settlements and bank postings.")) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/finance/payments/${paymentId}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (res.ok) {
        alert("Payment deleted successfully");
        setSelectedVoucher(null);
        fetchData();
        fetchGeneralLedger();
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to delete payment");
      }
    } catch (err) {
      console.error("Delete payment error:", err);
      alert("Failed to delete payment. Check your connection.");
    }
  };

  useEffect(() => {
    if (typeof window !== "undefined") {
      const queryParams = new URLSearchParams(window.location.search);
      const queryTab = queryParams.get("tab");
      if (queryTab && ["ledger", "general_ledger", "party", "cashbook", "pl", "tally", "costvar", "payment_requests", "accounts"].includes(queryTab)) {
        setTab(queryTab as any);
      }
    }
  }, []);

  useEffect(() => {
    if (companyId) {
      fetchData();
    }
  }, [companyId, projectId]);

  const handleUploadCSV = async (file: File) => {
    setSubmitting(true);
    const formData = new FormData();
    formData.append("company_id", companyId);
    formData.append("file", file);
    
    try {
      const apiHost = getApiHost();
      const res = await fetch(`${apiHost}/apis/v3/cashbook/upload`, {
        method: "POST",
        headers: authHeaders(),
        body: formData
      });
      if (res.ok) {
        const data = await res.json();
        // R2-533 clause 4: the importer now reports what it did. A batch that
        // dropped rows must never again claim a clean success.
        const created: number = data.created ?? 0;
        const duplicates: number = data.duplicates ?? 0;
        const skipped: Array<{ line: number; reason: string }> = data.skipped ?? [];
        const warnings: string[] = data.warnings ?? [];
        const summary: string[] = [
          `Created ${created} transaction${created === 1 ? "" : "s"}.`,
        ];
        for (const w of warnings) summary.push(w);
        if (duplicates > 0) {
          summary.push(
            `Skipped ${duplicates} duplicate row${duplicates === 1 ? "" : "s"} already on file.`
          );
        }
        if (skipped.length > 0) {
          summary.push(
            `Skipped ${skipped.length} row${skipped.length === 1 ? "" : "s"} that could not be read:`
          );
          for (const s of skipped.slice(0, 10)) {
            summary.push(`Line ${s.line}: ${s.reason}`);
          }
          if (skipped.length > 10) {
            summary.push(`...and ${skipped.length - 10} more.`);
          }
        }
        alert(summary.join("\n"));
        setShowAddModal(false);
        setCsvPreview(null);
        setCsvFile(null);
        if (typeof window !== "undefined") {
          window.location.reload();
        }
      } else {
        const err = await res.json();
        alert(`Failed to import: ${detailToMessage(err.detail, "Unknown error")}`);
      }
    } catch (err) {
      console.error(err);
      alert("Error importing CSV file");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCsvSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvFile(file);
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length);
      if (lines.length < 2) { setCsvPreview([]); return; }
      const headers = lines[0].split(",").map(h => h.replace(/^"|"$/g, "").trim());
      const rows = lines.slice(1).map(line => {
        const cells = line.split(",").map(c => c.replace(/^"|"$/g, "").trim());
        const obj: any = {};
        headers.forEach((h, i) => { obj[h] = cells[i] || ""; });
        return obj;
      });
      setCsvPreview(rows);
    } catch (err) {
      alert("Could not parse CSV file");
    }
  };

  // Bills, notes and expenses are recorded on the project's Transactions tab,
  // which saves real bills with line items and the right direction. This menu
  // used to book every one of them as a plain cash payment out.
  const PROJECT_TXN_TYPE: Record<string, string> = {
    "Payment In": "payment_in",
    "Payment Out": "payment_out",
    "Debit Note": "debit_note",
    "Credit Note": "credit_note",
    "Sales Invoice": "sales_invoice",
    "Material Sales": "material_sales",
    "Material Purchase": "material_purchase",
    "Material Return": "material_return",
    "Material Transfer": "material_transfer",
    "Other Expense": "other_expense",
    "Equipment Expense": "equipment_expense",
  };
  const openNewVoucher = (type: string) => {
    setIsDropdownOpen(false);
    if (type === "Sub Con Bill") {
      router.push(`/c/${companyId}/d/subcon`);
      return;
    }
    const key = PROJECT_TXN_TYPE[type];
    if (key) {
      if (!activeProjectId) {
        alert("Pick a project in the menu first. Bills and expenses are recorded against a project.");
        return;
      }
      router.push(`/c/${companyId}/p/${activeProjectId}/transaction?new=${key}`);
      return;
    }
    setSelectedTxnType(type as any);
    setPartyName("");
    setShowAddModal(true);
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    const amtVal = parseFloat(amount);
    
    if (selectedTxnType === "Party to Party") {
      if (!amount || amtVal <= 0 || !paymentFromParty || !paymentToParty) {
        alert("Please select both parties and enter a valid amount");
        return;
      }
      setSubmitting(true);
      try {
        const apiHost = getApiHost();
        const res = await fetch(`${apiHost}/apis/v3/cashbook/p2p`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
          body: JSON.stringify({
            company_id: companyId,
            sender_company_user_id: paymentFromParty,
            receiver_company_user_id: paymentToParty,
            amount: amtVal,
            payment_date: txnDate ? (txnDate.includes("T") ? txnDate : `${txnDate}T00:00:00Z`) : new Date().toISOString(),
            description: desc || ""
          }),
        });
        
        if (res.ok) {
          const data = await res.json();
          const fromName = usersList.find((u: any) => u.id === paymentFromParty)?.name || "—";
          const toName = usersList.find((u: any) => u.id === paymentToParty)?.name || "—";
          
          const newTxn1: Transaction = {
            id: data.sender_payment_id || `TXN-${Date.now()}-1`,
            date: txnDate,
            type: "Party to Party",
            category: "P2P Debit",
            description: desc || `Transfer to ${toName}`,
            amount: amtVal,
            party: fromName,
            ref: refNum || "",
            ledger: "Cashbook",
            status: "Approved",
            cost_code: costCode,
            settled_amount: amtVal,
            balance_due: 0
          };
          
          const newTxn2: Transaction = {
            id: data.receiver_payment_id || `TXN-${Date.now()}-2`,
            date: txnDate,
            type: "Party to Party",
            category: "P2P Credit",
            description: desc || `Transfer from ${fromName}`,
            amount: amtVal,
            party: toName,
            ref: refNum || "",
            ledger: "Cashbook",
            status: "Approved",
            cost_code: costCode,
            settled_amount: amtVal,
            balance_due: 0
          };
          
          setTransactions([newTxn1, newTxn2, ...transactions]);
          alert("Party to Party transfer recorded successfully!");
        } else {
          const err = await res.json();
          alert(`Failed: ${detailToMessage(err.detail, "Server error")}`);
        }
        setShowAddModal(false);
        setAmount("");
        setPaymentFromParty("");
        setPaymentToParty("");
        setRefNum("");
        setDesc("");
      } catch (err) {
        console.error("Failed to record P2P transfer", err);
        alert("Error sending request to server");
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (!amount || amtVal <= 0 || !partyName.trim()) return;

    setSubmitting(true);
    const paymentType = ["Receipt", "Payment In"].includes(selectedTxnType) ? "in" : "out";
    const reference = refNum || `SF-V-${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    try {
      const apiHost = getApiHost();
      const res = await fetch(`${apiHost}/apis/v3/finance/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id: companyId,
          project_id: projectId,
          payment_type: paymentType,
          amount: amtVal,
          payment_method: paymentMethod,
          reference_number: reference,
          description: desc || `Recorded ${selectedTxnType} voucher${partyName ? ` - ${partyName}` : ""}`,
          cost_code: costCode || undefined,
          category: selectedTxnType,
          payment_date: txnDate ? (txnDate.includes("T") ? txnDate : `${txnDate}T00:00:00Z`) : new Date().toISOString()
        }),
      });

      if (!res.ok) {
        // Never show a voucher the server did not keep.
        alert(`Not saved: ${await readErrorDetail(res)}`);
        return;
      }
      const saved = await res.json();
      const newTxn: Transaction = {
        id: saved.id,
        date: txnDate,
        type: selectedTxnType,
        category: selectedTxnType,
        description: desc || `Recorded ${selectedTxnType} voucher`,
        amount: amtVal,
        party: partyName,
        ref: reference,
        ref_invoice: ["Debit Note", "Credit Note"].includes(selectedTxnType) ? (taggedSalesInvoice || refInvoice) : undefined,
        ledger: selectedTxnType,
        status: "Pending",
        cost_code: costCode,
        photo_url: photoUrl || undefined,
        settled_amount: 0,
        balance_due: amtVal
      };

      setTransactions([newTxn, ...transactions]);
      setShowAddModal(false);
      setAmount("");
      setPartyName("");
      setRefNum("");
      setRefInvoice("");
      setDesc("");
      setPhotoUrl("");
      setTaggedSalesInvoice("");
    } catch (err) {
      console.error("Failed to record payment", err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleApproveVoucher = async (id: string) => {
    try {
      const apiHost = getApiHost();
      const res = await fetch(`${apiHost}/apis/v3/finance/approve/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) }
      });
      if (res.ok) {
        const data = await res.json();
        setTransactions(prev => prev.map(t => {
          if (t.id === id) {
            return { ...t, status: "Approved" as const, settled_amount: t.amount, balance_due: 0 };
          }
          return t;
        }));
        if (selectedVoucher?.id === id) {
          setSelectedVoucher({ ...selectedVoucher, status: "Approved" as const, settled_amount: selectedVoucher.amount, balance_due: 0 });
        }
      } else {
        console.error("Approval failed:", res.status);
      }
    } catch (err) {
      console.error("Approval error:", err);
    }
  };

  const handleAddBankAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/finance/accounts/${companyId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          account_holder_name: newBank.holder,
          bank_name: newBank.name,
          account_number: newBank.number,
          ifsc_code: newBank.ifsc,
          upi_id: newBank.upi || null,
          balance: parseFloat(newBank.balance) || 0.0,
        }),
      });
      if (res.ok) {
        const added = await res.json();
        setBankAccounts([...bankAccounts, added]);
        setNewBank({ name: "", holder: "", number: "", ifsc: "", upi: "", balance: "" });
        setShowAddBankModal(false);
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteBankAccount = async (accId: string) => {
    if (!confirm("Are you sure you want to delete this bank account?")) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/finance/accounts/${accId}`, {
        method: "DELETE",
        headers: authHeaders() || {},
      });
      if (res.ok) {
        setBankAccounts(prev => prev.filter(b => b.id !== accId));
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to delete bank account");
      }
    } catch (e) {
      console.error(e);
      alert("Error deleting bank account");
    }
  };

  const handleCreateCashAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/finance/cash-account/${companyId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          name: newCash.name || "",
          opening_balance: parseFloat(newCash.opening) || 0.0,
        }),
      });
      if (res.ok) {
        const ca = await res.json();
        setCashAccount(ca);
        setCashRunning(ca.running_balance);
        setNewCash({ name: "Cash Account", opening: "" });
        setShowAddCashModal(false);
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleCreatePaymentRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/finance/payment-requests/${companyId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          party_company_user_id: newRequest.partyId,
          project_id: projectId || null,
          amount: parseFloat(newRequest.amount),
          details: newRequest.extra ? `${newRequest.extra} — ${newRequest.details}` : newRequest.details,
          due_date: newRequest.dueDate ? new Date(newRequest.dueDate).toISOString() : null,
          request_type: newRequest.requestType,
        }),
      });
      if (res.ok) {
        const added = await res.json();
        setPaymentRequests([...paymentRequests, added]);
        setNewRequest({ partyId: "", amount: "", details: "", dueDate: "", requestType: "", extra: "" });
        setPrStep("type");
        setPrType(null);
        setShowAddRequestModal(false);
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchTallyData = async () => {
    try {
      const pendingRes = await fetch(`${getApiHost()}/apis/v3/tally/pending?company_id=${companyId}`, { headers: authHeaders() });
      if (pendingRes.ok) setTallyPending(await pendingRes.json());

      const pmRes = await fetch(`${getApiHost()}/apis/v3/tally/mappings/party?company_id=${companyId}`, { headers: authHeaders() });
      if (pmRes.ok) {
        const pm: TallyPartyMapping[] = await pmRes.json();
        setTallyPartyMappings(pm);
        const init: Record<string, string> = {};
        pm.forEach(m => { init[m.onsite_party_id] = m.tally_ledger_name; });
        setPartyLedgerInputs(init);
      }

      const lmRes = await fetch(`${getApiHost()}/apis/v3/tally/mappings/ledger?company_id=${companyId}`, { headers: authHeaders() });
      if (lmRes.ok) {
        const lm: TallyLedgerMapping[] = await lmRes.json();
        setTallyLedgerMappings(lm);
        const purchase = lm.find(m => m.onsite_transaction_type === "Material Purchase");
        const sales = lm.find(m => m.onsite_transaction_type === "Sales Invoice");
        if (purchase) {
          setPurchaseLedgerInput(purchase.tally_ledger_name);
          setFreightLedgerInput(purchase.freight_ledger || "");
          setSurchargeLedgerInput(purchase.surcharge_ledger || "");
        }
        if (sales) setSalesLedgerInput(sales.tally_ledger_name);
      }

      const ccRes = await fetch(`${getApiHost()}/apis/v3/tally/mappings/cost-centre?company_id=${companyId}`, { headers: authHeaders() });
      if (ccRes.ok) {
        const cc: TallyCostCentreMapping[] = await ccRes.json();
        setTallyCostCentreMappings(cc);
        if (activeProjectId) {
          const found = cc.find(m => m.project_id === activeProjectId);
          if (found) setCostCentreInput(found.tally_cost_centre_name);
        }
      }

      const logRes = await fetch(`${getApiHost()}/apis/v3/tally/sync-logs?company_id=${companyId}`, { headers: authHeaders() });
      if (logRes.ok) {
        const logs = await logRes.json();
        setTallySyncLogs(logs);
        const exportedTimes = (logs as any[]).filter((l) => l.exported_at).map((l) => new Date(l.exported_at).getTime());
        if (exportedTimes.length > 0) setTallyLastExport(new Date(Math.max(...exportedTimes)).toLocaleString("en-IN"));
        const markedTimes = (logs as any[]).filter((l) => l.marked_synced_at).map((l) => new Date(l.marked_synced_at).getTime());
        if (markedTimes.length > 0) setTallyLastMarked(new Date(Math.max(...markedTimes)).toLocaleString("en-IN"));
      }
    } catch (e) {
      console.error("Failed to load Tally data", e);
    }
  };

  useEffect(() => {
    if (companyId) {
      fetchTallyData();
    }
  }, [companyId, activeProjectId]);

  const openTallySetup = () => {
    setTallyCompany(tallyConn?.tally_company_name || "");
    setTallyMobile(tallyConn?.registered_mobile || "");
    setTallyVoucherTemplate(tallyConn?.voucher_number_template || "");
    setTallyDefaultCash(tallyConn?.default_cash_ledger || "");
    setTallyRoundOff(tallyConn?.round_off_ledger || "");
    setTallyAutoCreate(Boolean(tallyConn?.auto_create_missing_ledgers));
    setTallySyncFrom(tallyConn?.sync_window_start_date ? String(tallyConn.sync_window_start_date).slice(0, 10) : fyStartIso());
    setShowTallySetup(true);
  };

  const deleteTallyConnection = async () => {
    if (!tallyConn?.id || !confirm("Disconnect and delete Tally integration settings?")) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/tally/connections/${tallyConn.id}`, {
        method: "DELETE",
        headers: authHeaders() || {},
      });
      if (res.ok) {
        setTallyConn(null);
        setTallyMsg({ type: "ok", text: "Tally connection removed." });
      } else {
        const err = await readErrorDetail(res);
        setTallyMsg({ type: "err", text: err || "Failed to remove Tally connection." });
      }
    } catch (e: any) {
      setTallyMsg({ type: "err", text: e?.message || "Failed to remove Tally connection." });
    }
  };

  const saveTallyConnection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tallyCompany.trim() || !tallyMobile.trim()) {
      setTallyMsg({ type: "err", text: "Tally company name and registered mobile are required." });
      return;
    }
    setTallySaving(true);
    setTallyMsg(null);
    try {
      const url = tallyConn?.id ? `${getApiHost()}/apis/v3/tally/connections/${tallyConn.id}` : `${getApiHost()}/apis/v3/tally/connections`;
      const res = await fetch(url, {
        method: tallyConn?.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id: companyId,
          tally_company_name: tallyCompany.trim(),
          registered_mobile: tallyMobile.trim(),
          sync_window_start_date: tallySyncFrom ? (tallySyncFrom.includes("T") ? tallySyncFrom : `${tallySyncFrom}T00:00:00Z`) : new Date().toISOString(),
          voucher_number_template: tallyVoucherTemplate.trim() || "",
          auto_create_missing_ledgers: tallyAutoCreate,
          default_cash_ledger: tallyDefaultCash.trim() || null,
          round_off_ledger: tallyRoundOff.trim() || null,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setTallyConn(data);
        setShowTallySetup(false);
        setTallyMsg({ type: "ok", text: "Tally connection saved." });
      } else {
        const err = await res.json().catch(() => ({}));
        setTallyMsg({ type: "err", text: detailToMessage(err.detail, "Failed to save Tally connection.") });
      }
    } catch (e: any) {
      setTallyMsg({ type: "err", text: e?.message || "Failed to save Tally connection." });
    } finally {
      setTallySaving(false);
    }
  };

  const handleDownloadXml = async () => {
    setTallyExporting(true);
    setTallyMsg(null);
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/tally/export?company_id=${companyId}`, { headers: authHeaders() });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setTallyMsg({ type: "err", text: err.detail || `Export failed (HTTP ${res.status}).` });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `siteflow-tally-${todayLocalISO()}.xml`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setTallyLastExport(new Date().toLocaleString("en-IN"));
      setTallyMsg({ type: "ok", text: "Tally XML downloaded. Import it in Tally Prime, then mark as imported below." });
    } catch (e: any) {
      setTallyMsg({ type: "err", text: e?.message || "Export failed." });
    } finally {
      setTallyExporting(false);
    }
  };

  const handleMarkSynced = async () => {
    if (tallyPending.bill_ids.length === 0 && tallyPending.payment_ids.length === 0) {
      setTallyMsg({ type: "err", text: "No pending vouchers to mark." });
      return;
    }
    setTallyMarking(true);
    setTallyMsg(null);
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/tally/mark-synced`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          bill_ids: tallyPending.bill_ids,
          payment_ids: tallyPending.payment_ids,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setTallyLastMarked(new Date(data.marked_synced_at || Date.now()).toLocaleString("en-IN"));
        setTallyMsg({ type: "ok", text: `Marked ${data.marked_bills} bill(s) and ${data.marked_payments} payment(s) as synced.` });
        await fetchTallyData();
      } else {
        const err = await res.json().catch(() => ({}));
        setTallyMsg({ type: "err", text: detailToMessage(err.detail, "Failed to mark as synced.") });
      }
    } catch (e: any) {
      setTallyMsg({ type: "err", text: e?.message || "Failed to mark as synced." });
    } finally {
      setTallyMarking(false);
    }
  };

  const savePartyMapping = async (partyId: string, ledgerName: string) => {
    if (!ledgerName.trim()) return;
    const existing = tallyPartyMappings.find(m => m.onsite_party_id === partyId);
    try {
      if (existing) {
        await fetch(`${getApiHost()}/apis/v3/tally/mappings/party/${existing.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
          body: JSON.stringify({ tally_ledger_name: ledgerName.trim() }),
        });
      } else {
        await fetch(`${getApiHost()}/apis/v3/tally/mappings/party`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
          body: JSON.stringify({ company_id: companyId, onsite_party_id: partyId, tally_ledger_name: ledgerName.trim() }),
        });
      }
      await fetchTallyData();
    } catch (e) {
      console.error("Failed to save party mapping", e);
    }
  };

  const deletePartyMapping = async (mapId: string) => {
    try {
      await fetch(`${getApiHost()}/apis/v3/tally/mappings/party/${mapId}`, {
        method: "DELETE",
        headers: authHeaders() || {},
      });
      await fetchTallyData();
    } catch (e) {
      console.error("Failed to delete party mapping", e);
    }
  };

  const saveLedgerMappings = async () => {
    try {
      const existingPurchase = tallyLedgerMappings.find(m => m.onsite_transaction_type === "Material Purchase");
      const existingSales = tallyLedgerMappings.find(m => m.onsite_transaction_type === "Sales Invoice");

      if (existingPurchase) {
        await fetch(`${getApiHost()}/apis/v3/tally/mappings/ledger/${existingPurchase.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
          body: JSON.stringify({
            tally_ledger_name: purchaseLedgerInput.trim() || "Purchase A/c",
            freight_ledger: freightLedgerInput.trim() || null,
            surcharge_ledger: surchargeLedgerInput.trim() || null,
          }),
        });
      } else {
        await fetch(`${getApiHost()}/apis/v3/tally/mappings/ledger`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
          body: JSON.stringify({
            company_id: companyId,
            onsite_transaction_type: "Material Purchase",
            posting_mode: "lumpsum",
            tally_voucher_type: "Purchase",
            tally_ledger_name: purchaseLedgerInput.trim() || "Purchase A/c",
            freight_ledger: freightLedgerInput.trim() || null,
            surcharge_ledger: surchargeLedgerInput.trim() || null,
          }),
        });
      }

      if (existingSales) {
        await fetch(`${getApiHost()}/apis/v3/tally/mappings/ledger/${existingSales.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
          body: JSON.stringify({ tally_ledger_name: salesLedgerInput.trim() || "Sales A/c" }),
        });
      } else {
        await fetch(`${getApiHost()}/apis/v3/tally/mappings/ledger`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
          body: JSON.stringify({ company_id: companyId, onsite_transaction_type: "Sales Invoice", posting_mode: "lumpsum", tally_voucher_type: "Sales", tally_ledger_name: salesLedgerInput.trim() || "Sales A/c" }),
        });
      }
      await fetchTallyData();
      setTallyMsg({ type: "ok", text: "Ledger mappings saved." });
    } catch (e) {
      console.error("Failed to save ledger mappings", e);
    }
  };

  const deleteLedgerMapping = async (mapId: string) => {
    try {
      await fetch(`${getApiHost()}/apis/v3/tally/mappings/ledger/${mapId}`, {
        method: "DELETE",
        headers: authHeaders() || {},
      });
      await fetchTallyData();
    } catch (e) {
      console.error("Failed to delete ledger mapping", e);
    }
  };

  const saveCostCentreMapping = async () => {
    if (!activeProjectId) {
      setTallyMsg({ type: "err", text: "Select a project first to map its cost centre." });
      return;
    }
    if (!costCentreInput.trim()) return;
    const existing = tallyCostCentreMappings.find(m => m.project_id === activeProjectId);
    try {
      if (existing) {
        await fetch(`${getApiHost()}/apis/v3/tally/mappings/cost-centre/${existing.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
          body: JSON.stringify({ tally_cost_centre_name: costCentreInput.trim() }),
        });
      } else {
        await fetch(`${getApiHost()}/apis/v3/tally/mappings/cost-centre`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
          body: JSON.stringify({ company_id: companyId, project_id: activeProjectId, tally_cost_centre_name: costCentreInput.trim() }),
        });
      }
      await fetchTallyData();
      setTallyMsg({ type: "ok", text: "Cost centre mapping saved." });
    } catch (e) {
      console.error("Failed to save cost centre mapping", e);
    }
  };

  const deleteCostCentreMapping = async (mapId: string) => {
    try {
      await fetch(`${getApiHost()}/apis/v3/tally/mappings/cost-centre/${mapId}`, {
        method: "DELETE",
        headers: authHeaders() || {},
      });
      await fetchTallyData();
    } catch (e) {
      console.error("Failed to delete cost centre mapping", e);
    }
  };

  // Math & Ledgers compilation
  const sortedTxns = useMemo(() => {
    return [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  }, [transactions]);

  // Header-chip counts (lifted from the inline IIFE so the header chips and the
  // toolbar buttons can share the same source of truth). Fix for R2-101.
  const txnsForHeader = txnSummary.transactions || [];
  const unbilledCount = useMemo(
    () => txnsForHeader.filter((t: any) => /material/i.test(t.type || "") && t.status && t.status !== "Paid").length,
    [txnsForHeader]
  );
  const pendingCount = useMemo(
    () => txnsForHeader.filter((t: any) => t.status && t.status !== "Paid" && t.status !== "Approved").length,
    [txnsForHeader]
  );

  // Main ledger with running balance
  const ledgerWithRunningBalance = useMemo(() => {
    let balance = 0;
    return sortedTxns.map(t => {
      const isCredit = t.type === "Receipt" || t.type === "Credit Note";
      if (isCredit) {
        balance += t.amount;
      } else {
        balance -= t.amount;
      }
      return { ...t, running_balance: balance };
    }).reverse();
  }, [sortedTxns]);

  const receiptsSum = useMemo(() => {
    return transactions
      .filter(t => t.type === "Receipt" || t.type === "Credit Note")
      .reduce((s, t) => s + Math.abs(t.amount), 0);
  }, [transactions]);

  const expensesSum = useMemo(() => {
    return transactions
      .filter(t => t.type === "Expense" || t.type === "Debit Note")
      .reduce((s, t) => s + Math.abs(t.amount), 0);
  }, [transactions]);

  const netCashFlow = receiptsSum - expensesSum;

  // Party ledgers compilation
  const partyLedgers = useMemo(() => {
    const map: Record<string, { party: string; total_debit: number; total_credit: number; net_due: number; txns: Transaction[] }> = {};
    transactions.forEach(t => {
      if (!map[t.party]) {
        map[t.party] = { party: t.party, total_debit: 0, total_credit: 0, net_due: 0, txns: [] };
      }
      const isCredit = t.type === "Receipt" || t.type === "Credit Note";
      if (isCredit) {
        map[t.party].total_credit += t.amount;
      } else {
        map[t.party].total_debit += t.amount;
      }
      map[t.party].net_due += t.balance_due;
      map[t.party].txns.push(t);
    });
    return Object.values(map);
  }, [transactions]);

  // Cash Book compilation
  const cashBookRows = useMemo(() => {
    let balance = 0;
    return sortedTxns.map(t => {
      const isCredit = t.type === "Receipt" || t.type === "Credit Note";
      if (isCredit) {
        balance += t.amount;
      } else {
        balance -= t.amount;
      }
      return {
        date: t.date,
        narration: t.description,
        party: t.party,
        ref: t.ref,
        debit: !isCredit ? t.amount : 0,
        credit: isCredit ? t.amount : 0,
        running_balance: balance
      };
    }).reverse();
  }, [sortedTxns]);

  const totalRevenue = plData.find(r => r.head === "Revenue (Billed)")?.actual || 0;
  const totalCost = plData.filter(r => r.head !== "Revenue (Billed)").reduce((s, r) => s + r.actual, 0);
  const grossProfit = totalRevenue - totalCost;
  const margin = totalRevenue > 0 ? ((grossProfit / totalRevenue) * 100).toFixed(1) : "—";

  const handleCreateParty = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newParty.name.trim()) {
      alert("Party name is required");
      return;
    }
    setSubmitting(true);
    try {
      const payload: any = {
        company_id: companyId,
        name: newParty.name,
        phone: newParty.phone || null,
        email: newParty.email || null,
        party_type: newParty.party_type || null,
        address: newParty.address || null,
        party_id_custom: newParty.party_id_custom || null,
        date_of_joining: newParty.date_of_joining || null,
        aadhaar_number: newParty.aadhaar_number || null,
        pan_number: newParty.pan_number || null,
        contractor_role: newParty.party_type === "Contractor" || newParty.party_type === "Subcontractor" ? newParty.contractor_role : null,
        service_rate_categories: serviceTags.length ? JSON.stringify(serviceTags) : null,
        bank_account_id: newParty.bank_account_id || null,
        opening_balance: parseFloat(newParty.opening_balance) || 0,
        opening_balance_type: newParty.opening_balance ? newParty.opening_balance_type : null,
      };
      const res = await fetch(`${getApiHost()}/apis/v3/library/parties`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(detailToMessage(err.detail, "Failed to create party"));
      }
      const created = await res.json();
      // Refresh party list
      const pr = await fetch(`${getApiHost()}/apis/v3/finance/parties/${companyId}`, { headers: authHeaders() });
      if (pr.ok) setCompanyParties(await pr.json());
      setShowAddPartyModal(false);
      const shouldCreateWO = newParty.create_wo;
      setNewParty({ name: "", phone: "", email: "", party_type: "Supplier", address: "", party_id_custom: "", date_of_joining: "", aadhaar_number: "", pan_number: "", contractor_role: "", bank_account_id: "", opening_balance: "", opening_balance_type: "pay", create_wo: false, wo_title: "", wo_terms: "" });
      setServiceTags([]);
      if (shouldCreateWO) {
        // Deliberate work order creation with line items in Subcontractor Management
        router.push(`/c/${companyId}/d/subcon?create_wo=true&party_id=${created.id}`);
      } else {
        alert("Party created successfully");
      }
    } catch (err: any) {
      alert(err?.message || "Error creating party");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ── Finance sub-navigation (top tabs) ── */}
      <div className="px-6 py-2 border-b border-border-custom bg-card shrink-0 overflow-x-auto">
        <SegmentedTabs
          tabs={[
            { id: "party", label: "Party", icon: <Icon name="group" className="w-3.5 h-3.5" /> },
            { id: "ledger", label: "Transaction", icon: <Icon name="ledger" className="w-3.5 h-3.5" /> },
            { id: "general_ledger", label: "General Ledger", icon: <Icon name="payments" className="w-3.5 h-3.5" /> },
            { id: "payment_requests", label: "Payment Requests", icon: <Icon name="envelope" className="w-3.5 h-3.5" /> },
            { id: "accounts", label: "Accounts", icon: <Icon name="bank" className="w-3.5 h-3.5" /> },
            { id: "tally", label: "Tally Sync", icon: <Icon name="refresh" className="w-3.5 h-3.5" /> },
          ]}
          activeTab={tab}
          onChange={(t) => {
            setTab(t as any);
            if (t === "general_ledger") fetchGeneralLedger();
          }}
        />
      </div>

      {/* ── Main content area ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <PageHeader
          title={tab === "ledger" ? "Dashboard" : tab === "general_ledger" ? "Project General Ledger" : tab === "party" ? "Party-wise Ledgers" : tab === "payment_requests" ? "Payment Requests Ledger" : tab === "accounts" ? "Company Cash & Bank Accounts" : tab === "cashbook" ? "Cash Book (Bank Ledger)" : tab === "pl" ? "Project P&L" : tab === "tally" ? "Tally Sync Gateway" : "Cost Variance Report"}
          subtitle="Real-time sequential approval tracking & running balance ledger"
        >
          <div className="flex items-center gap-4 relative">
            {/* Unbilled Materials Badge */}
            <div className="hidden sm:flex items-center gap-1.5 cursor-pointer hover:bg-elevated/40 px-2.5 py-1.5 rounded-lg border border-border-custom/50">
              <Icon name="trolley" className="w-3.5 h-3.5" />
              <span className="text-[10px] text-muted uppercase font-bold tracking-wider">Unbilled Materials</span>
              <span className="bg-primary/20 text-primary border border-primary/30 text-[9px] font-bold px-1.5 py-0.5 rounded-full">{unbilledCount}</span>
            </div>

            {/* Pending Entries Badge */}
            <div className="hidden sm:flex items-center gap-1.5 cursor-pointer hover:bg-elevated/40 px-2.5 py-1.5 rounded-lg border border-border-custom/50">
              <Icon name="schedule" className="w-3.5 h-3.5" />
              <span className="text-[10px] text-muted uppercase font-bold tracking-wider">Pending Entries</span>
              <span className="bg-warning/10 text-warning border border-warning/20 text-[9px] font-bold px-1.5 py-0.5 rounded-full">{pendingCount}</span>
            </div>

            <div className="relative">
              <button onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-bold text-white hover:opacity-90 transition-all cursor-pointer">
                Create Transaction +
              </button>
              {isDropdownOpen && (
                <div className="absolute right-0 mt-2 w-80 bg-card/95 backdrop-blur-md border border-border-custom rounded-lg shadow-2xl p-5 z-50 space-y-4 text-left max-h-[420px] overflow-y-auto">
                  <div>
                    <div className="text-[9px] font-bold text-success uppercase tracking-widest border-b border-border-custom pb-1 mb-2">Payment</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 text-[11px]">
                      {["Payment In", "Payment Out", "Debit Note", "Credit Note", "Party to Party", "Upload Payments"].map(type => (
                        <button key={type} onClick={() => openNewVoucher(type)}
                          className="py-1 px-2 text-left rounded-lg text-muted hover:text-success hover:bg-success/10 transition-all text-xs cursor-pointer font-semibold">
                          + {type}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="text-[9px] font-bold text-primary uppercase tracking-widest border-b border-border-custom pb-1 mb-2">Sales</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 text-[11px]">
                      {["Sales Invoice", "Material Sales"].map(type => (
                        <button key={type} onClick={() => openNewVoucher(type)}
                          className="py-1 px-2 text-left rounded-lg text-muted hover:text-primary hover:bg-primary/10 transition-all text-xs cursor-pointer font-semibold">
                          + {type}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="text-[9px] font-bold text-primary uppercase tracking-widest border-b border-border-custom pb-1 mb-2">Expense</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5 text-[11px]">
                      {["Material Purchase", "Material Return", "Material Transfer", "Sub Con Bill", "Other Expense", "Equipment Expense"].map(type => (
                        <button key={type} onClick={() => openNewVoucher(type)}
                          className="py-1 px-2 text-left rounded-lg text-muted hover:text-primary hover:bg-primary/10 transition-all text-xs cursor-pointer font-semibold">
                          + {type}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </PageHeader>

        <div className="flex-1 overflow-y-auto">
          <PageShell width="wide">
          {/* ── TRANSACTION LEDGER TAB ── */}
          {/* ── TRANSACTION SUB-TAB (COMPANY-WIDE) ── */}
          {tab === "ledger" && (() => {
            const txns = txnSummary.transactions || [];
            const filtered = txns.filter((t: any) => {
              const q = searchQuery.toLowerCase();
              const matchQ = !q || (t.party || "").toLowerCase().includes(q) || (t.details || "").toLowerCase().includes(q) || (t.ref || "").toLowerCase().includes(q);
              const matchD = !txnDateFilter || (t.date || "").startsWith(txnDateFilter);
              const matchM = !showUnbilledOnly || (/material/i.test(t.type || "") && t.status && t.status !== "Paid");
              const matchP = !showPendingOnly || (t.status && t.status !== "Paid" && t.status !== "Approved");
              return matchQ && matchD && matchM && matchP;
            });
            const statusClass = (s: string) => {
              if (s === "Paid" || s === "Approved") return "bg-success/10 text-success border border-success/20";
              if (s === "Partially Paid") return "bg-warning/10 text-warning border border-warning/20";
              return "bg-danger/10 text-danger border border-danger/20";
            };
            const sumCell = (v: number) =>
              txnLoad === "loading" ? (
                <Skeleton className="w-16 h-4 inline-block align-middle" />
              ) : (
                `₹${(v || 0).toLocaleString("en-IN")}`
              );
            return (
            <div className="space-y-4">
              {txnLoad === "error" && (
                <div className="p-3 text-xs rounded-lg bg-danger/10 border border-danger/20 text-danger flex items-center gap-2 flex-wrap">
                  <span>Company finance totals failed to load. Figures below may be incomplete.</span>
                  <button onClick={fetchData} className="underline font-bold cursor-pointer">Retry</button>
                </div>
              )}
              {/* Three Summary Cards */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-card border border-border-custom rounded-lg p-4">
                  <div className="text-[10px] font-bold text-muted uppercase tracking-wider">Total Invoice</div>
                  <div className="text-xl font-extrabold text-foreground mt-1">{sumCell(txnSummary.total_invoice)}</div>
                  <div className="text-[10px] text-danger mt-1">Unpaid Invoice: ₹{(txnSummary.unpaid_invoice || 0).toLocaleString("en-IN")}</div>
                </div>
                <div className="bg-card border border-border-custom rounded-lg p-4">
                  <div className="text-[10px] font-bold text-muted uppercase tracking-wider">Total Expense</div>
                  <div className="text-xl font-extrabold text-foreground mt-1">{sumCell(txnSummary.total_expense)}</div>
                  <div className="text-[10px] text-danger mt-1">Unpaid Expense: ₹{(txnSummary.unpaid_expense || 0).toLocaleString("en-IN")}</div>
                </div>
                <div className="bg-card border border-border-custom rounded-lg p-4">
                  <div className="text-[10px] font-bold text-muted uppercase tracking-wider flex items-center gap-1">
                    Company Balance <span title="Sum of Cash + all Bank Account balances" className="cursor-help">ⓘ</span>
                  </div>
                  <div className="text-xl font-extrabold text-foreground mt-1">{sumCell(txnSummary.company_balance)}</div>
                  <div className="text-[10px] text-muted mt-1">In: {sumCell(txnSummary.in_total)} | Out: {sumCell(txnSummary.out_total)}</div>
                </div>
              </div>

              {/* Toolbar */}
              <div className="flex flex-wrap items-center gap-2">
                <input type="date" value={txnDateFilter} onChange={(e) => setTxnDateFilter(e.target.value)} className="py-1 px-2 border border-border-custom bg-card hover:bg-elevated rounded text-[11px] text-foreground focus:outline-none" />
                <button onClick={() => setShowUnbilledOnly(!showUnbilledOnly)} className={`py-1 px-3 border border-border-custom hover:bg-elevated rounded text-[11px] font-medium transition-all flex items-center gap-1 cursor-pointer ${showUnbilledOnly ? "text-primary border-primary/60" : "text-foreground"}`}>
                  <Icon name="trolley" className="w-3.5 h-3.5" /> Unbilled Materials <span className="bg-primary/20 text-primary text-[9px] font-bold px-1.5 py-0.5 rounded-full">New {unbilledCount}</span>
                </button>
                <button onClick={() => setShowPendingOnly(!showPendingOnly)} className={`py-1 px-3 border border-border-custom hover:bg-elevated rounded text-[11px] font-medium transition-all flex items-center gap-1 cursor-pointer ${showPendingOnly ? "text-warning border-warning/60" : "text-foreground"}`}>
                  <Icon name="schedule" className="w-3.5 h-3.5" /> Pending Entries <span className="bg-warning/10 text-warning text-[9px] font-bold px-1.5 py-0.5 rounded-full">{pendingCount}</span>
                </button>
                <div className="flex-1" />
                <input type="text" placeholder="Search party, voucher#..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="bg-input border border-border-custom rounded-md px-3 py-1.5 text-xs text-foreground placeholder-muted focus:outline-none focus:border-primary" />
              </div>

              {zohoMsg && (
                <div className={`mb-3 p-3 text-xs rounded-lg ${zohoMsg.type === "ok" ? "bg-success/10 border border-success/20 text-success" : "bg-danger/10 border border-danger/20 text-danger"}`}>
                  {zohoMsg.text}
                </div>
              )}

              {/* Table: Party | Details | Status */}
              <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
                <table className="w-full text-xs text-left">
                  <thead className="bg-input/60 text-muted uppercase text-[10px] tracking-wider">
                    <tr>
                      <th className="p-3 font-semibold">Party</th>
                      <th className="p-3 font-semibold">Details</th>
                      <th className="p-3 font-semibold text-right">Amount (₹)</th>
                      <th className="p-3 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-custom/40">
                    {filtered.length === 0 && (
                      <tr><td colSpan={4} className="p-6 text-center text-muted">
                        {txnLoad === "loading" ? "Loading transactions..." : txnLoad === "error" ? "Could not load transactions." : "No Data Transaction"}
                      </td></tr>
                    )}
                    {filtered.map((t: any, i: number) => (
                      <tr key={i} className="hover:bg-elevated/40 transition-all cursor-pointer" onClick={() => setSelectedVoucher(t)}>
                        <td className="p-3">
                          <div className="font-bold text-foreground">{t.party}</div>
                          {/* Some rows carry the raw enum ("expense", "payment_in")
                              and others a human label, so the same column mixed
                              both. formatLabel leaves an already-spaced label alone. */}
                          <div className="text-[10px] text-muted">{formatLabel(t.type)}</div>
                        </td>
                        <td className="p-3 text-foreground">
                          {t.details}
                          {t.project_id ? <span className="text-[10px] text-muted block">Project: {t.project_name || String(t.project_id).slice(0, 8)}</span> : null}
                          {t.due_date ? <span className="text-[10px] text-warning block font-medium">Due: {formatDate(t.due_date)}</span> : null}
                        </td>
                        <td className="p-3 text-right font-bold text-foreground">₹{(t.amount || 0).toLocaleString("en-IN")}</td>
                        <td className="p-3">
                          <div className="flex items-center gap-2">
                            <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider ${statusClass(t.status)}`}>{formatLabel(t.status)}</span>
                            {zohoConnected && (t.type === "Material Purchase" || t.type === "Subcon Bill") && (
                              <button
                                onClick={(e) => { e.stopPropagation(); pushToZoho(t.id); }}
                                disabled={zohoPushingId === t.id}
                                title="Push this vendor bill to Zoho Books"
                                className="text-[9px] font-bold px-2 py-0.5 rounded bg-primary/15 text-primary border border-primary/20 hover:bg-primary/25 transition-all disabled:opacity-50 cursor-pointer"
                              >
                                {zohoPushingId === t.id ? "Pushing…" : "→ Zoho"}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            );
          })()}

          {/* ── PROJECT GENERAL LEDGER TAB ── */}
          {tab === "general_ledger" && (() => {
            const filteredLedger = projectLedger.filter((entry) => {
              const q = ledgerSearchQuery.toLowerCase();
              const matchQ = !q || (entry.party || "").toLowerCase().includes(q) || (entry.description || "").toLowerCase().includes(q) || (entry.ref || "").toLowerCase().includes(q) || (entry.category || "").toLowerCase().includes(q);
              const matchD = !ledgerDateFilter || (entry.date || "").startsWith(ledgerDateFilter);
              return matchQ && matchD;
            });
            const totalDebit = filteredLedger.reduce((sum, e) => sum + (e.debit || 0), 0);
            const totalCredit = filteredLedger.reduce((sum, e) => sum + (e.credit || 0), 0);
            const latestBalance = filteredLedger.length > 0 ? filteredLedger[filteredLedger.length - 1].balance : 0;

            const handleExportCsv = () => {
              const csv = buildCsv(
                ["Date", "Description", "Ref / Voucher", "Party", "Category", "Debit", "Credit", "Balance"],
                filteredLedger.map(e => [
                  e.date || "",
                  e.description || "",
                  e.ref || "",
                  e.party || "",
                  e.category || "",
                  String(e.debit || 0),
                  String(e.credit || 0),
                  String(e.balance || 0),
                ])
              );
              const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
              const url = URL.createObjectURL(blob);
              const link = document.createElement("a");
              link.href = url;
              link.setAttribute("download", `General_Ledger_${todayLocalISO()}.csv`);
              document.body.appendChild(link);
              link.click();
              document.body.removeChild(link);
            };

            return (
              <div className="space-y-4">
                {/* Summary Cards */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-card border border-border-custom rounded-lg p-4">
                    <div className="text-[10px] font-bold text-muted uppercase tracking-wider">Total Debits (Receipts)</div>
                    <div className="text-xl font-extrabold text-foreground mt-1 font-sans">₹{totalDebit.toLocaleString("en-IN")}</div>
                    <div className="text-[10px] text-muted mt-1">{filteredLedger.filter(e => e.debit > 0).length} debit entries</div>
                  </div>
                  <div className="bg-card border border-border-custom rounded-lg p-4">
                    <div className="text-[10px] font-bold text-muted uppercase tracking-wider">Total Credits (Payments/Bills)</div>
                    <div className="text-xl font-extrabold text-foreground mt-1 font-sans">₹{totalCredit.toLocaleString("en-IN")}</div>
                    <div className="text-[10px] text-muted mt-1">{filteredLedger.filter(e => e.credit > 0).length} credit entries</div>
                  </div>
                  <div className="bg-card border border-border-custom rounded-lg p-4">
                    <div className="text-[10px] font-bold text-muted uppercase tracking-wider">Net Running Balance</div>
                    <div className={`text-xl font-extrabold mt-1 font-sans ${latestBalance >= 0 ? "text-success" : "text-danger"}`}>
                      ₹{latestBalance.toLocaleString("en-IN")}
                    </div>
                    <div className="text-[10px] text-muted mt-1">Double-entry project balance</div>
                  </div>
                </div>

                {/* Toolbar */}
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="date"
                    value={ledgerDateFilter}
                    onChange={(e) => setLedgerDateFilter(e.target.value)}
                    className="py-1 px-2 border border-border-custom bg-card hover:bg-elevated rounded text-[11px] text-foreground focus:outline-none"
                  />
                  <button
                    onClick={handleExportCsv}
                    className="py-1 px-3 border border-border-custom bg-elevated hover:bg-card rounded text-[11px] font-semibold text-foreground flex items-center gap-1 cursor-pointer"
                  >
                    <Icon name="cloud_drive" className="w-3.5 h-3.5" /> Export CSV
                  </button>
                  <button
                    onClick={fetchGeneralLedger}
                    className="py-1 px-3 border border-border-custom bg-elevated hover:bg-card rounded text-[11px] font-semibold text-muted hover:text-foreground flex items-center gap-1 cursor-pointer"
                  >
                    <Icon name="refresh" className="w-3.5 h-3.5" /> Refresh
                  </button>
                  <div className="flex-1" />
                  <input
                    type="text"
                    placeholder="Search ledger entries..."
                    value={ledgerSearchQuery}
                    onChange={(e) => setLedgerSearchQuery(e.target.value)}
                    className="bg-input border border-border-custom rounded-md px-3 py-1.5 text-xs text-foreground placeholder-muted focus:outline-none focus:border-primary"
                  />
                </div>

                {/* General Ledger Table */}
                <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-input/60 text-muted uppercase text-[10px] tracking-wider">
                      <tr>
                        <th className="p-3 font-semibold">Date</th>
                        <th className="p-3 font-semibold">Description</th>
                        <th className="p-3 font-semibold">Ref / Voucher</th>
                        <th className="p-3 font-semibold">Party</th>
                        <th className="p-3 font-semibold">Category</th>
                        <th className="p-3 font-semibold text-right">Debit (₹)</th>
                        <th className="p-3 font-semibold text-right">Credit (₹)</th>
                        <th className="p-3 font-semibold text-right">Balance (₹)</th>
                        <th className="p-3 font-semibold text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-custom/40">
                      {ledgerLoading ? (
                        <tr>
                          <td colSpan={9} className="p-6 text-center text-muted">
                            Loading project general ledger...
                          </td>
                        </tr>
                      ) : filteredLedger.length === 0 ? (
                        <tr>
                          <td colSpan={9} className="p-6 text-center text-muted">
                            No ledger entries found for this project.
                          </td>
                        </tr>
                      ) : (
                        filteredLedger.map((entry, idx) => (
                          <tr key={entry.id || idx} className="hover:bg-elevated/40 transition-all">
                            <td className="p-3 text-muted whitespace-nowrap">{formatDmy(entry.date)}</td>
                            <td className="p-3 text-foreground font-medium">{entry.description}</td>
                            <td className="p-3 text-muted font-sans font-semibold">{entry.ref || "—"}</td>
                            <td className="p-3 text-foreground font-semibold">{entry.party || "—"}</td>
                            <td className="p-3 text-muted">
                              <span className="bg-elevated px-2 py-0.5 rounded text-[10px] font-semibold">{entry.category || entry.type}</span>
                            </td>
                            <td className="p-3 text-right font-sans font-bold text-success">
                              {entry.debit > 0 ? `₹${entry.debit.toLocaleString("en-IN")}` : "—"}
                            </td>
                            <td className="p-3 text-right font-sans font-bold text-danger">
                              {entry.credit > 0 ? `₹${entry.credit.toLocaleString("en-IN")}` : "—"}
                            </td>
                            <td className="p-3 text-right font-sans font-bold text-foreground">
                              ₹{entry.balance.toLocaleString("en-IN")}
                            </td>
                            <td className="p-3 text-center whitespace-nowrap">
                              {entry.id && (
                                <button
                                  type="button"
                                  onClick={() => handleDeletePayment(entry.id)}
                                  className="px-2 py-1 bg-elevated hover:bg-danger/10 border border-border-custom text-muted hover:text-danger rounded text-[10px] font-semibold cursor-pointer"
                                  title="Delete payment voucher"
                                >
                                  Delete
                                </button>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}

          {/* ── PARTY SUB-TAB (COMPANY-WIDE) ── */}
          {tab === "party" && (() => {
            const partySums = companyParties.reduce(
              (acc, p) => {
                acc.advance_paid += p.advance_paid || 0;
                acc.to_pay += p.to_pay || 0;
                acc.to_receive += p.to_receive || 0;
                acc.advance_received += p.advance_received || 0;
                return acc;
              },
              { advance_paid: 0, to_pay: 0, to_receive: 0, advance_received: 0 }
            );
            const statusChip = (status: string) => {
              if (status === "Advance Paid" || status === "Advance Received")
                return "bg-success/10 text-success border border-success/20";
              if (status === "To Pay" || status === "To Receive")
                return "bg-danger/10 text-danger border border-danger/20";
              return "bg-elevated text-muted border border-border-custom";
            };
            const filteredParties = companyParties.filter(p => {
              const q = partySearchQuery.toLowerCase();
              const matchQ = !q || p.name.toLowerCase().includes(q) || (p.party_id_custom || "").toLowerCase().includes(q);
              const matchS = partyTabStatus === "All" || (partyTabStatus === "Active" ? p.status !== "Settled" : p.status === "Settled");
              return matchQ && matchS;
            });
            const exportCsv = () => {
              const rows = [["Party ID", "Name", "Type", "Balance", "Status"]];
              filteredParties.forEach(p => rows.push([p.party_id_custom || "", p.name, p.party_type || "", String(p.balance), p.status]));
              // R2-755: party names and IDs are user-controlled free text; the
              // old builder only quote-doubled, which does not stop a formula.
              const csv = buildCsv(rows[0], rows.slice(1));
              const blob = new Blob([csv], { type: "text/csv" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "parties.csv";
              a.click();
              URL.revokeObjectURL(url);
            };
            return (
            <div className="space-y-6 relative h-full flex flex-col">
              {/* Four Cards Metrics Summary Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-card border border-border-custom rounded-lg p-4 flex items-center justify-between relative overflow-hidden">
                  <div className="space-y-1 z-10">
                    <span className="text-[10px] font-bold text-success/80 uppercase tracking-wider block">Advance Paid</span>
                    <strong className="text-xl font-extrabold text-foreground tracking-tight block">₹{partySums.advance_paid.toLocaleString("en-IN")}</strong>
                  </div>
                  <div className="h-9 w-9 rounded-full bg-success/10 flex items-center justify-center text-success z-10">
                    <Icon name="arrow_up" className="w-4 h-4" />
                  </div>
                </div>
                <div className="bg-card border border-border-custom rounded-lg p-4 flex items-center justify-between relative overflow-hidden">
                  <div className="space-y-1 z-10">
                    <span className="text-[10px] font-bold text-danger/80 uppercase tracking-wider block">To Pay</span>
                    <strong className="text-xl font-extrabold text-foreground tracking-tight block">₹{partySums.to_pay.toLocaleString("en-IN")}</strong>
                  </div>
                  <div className="h-9 w-9 rounded-full bg-danger/10 flex items-center justify-center text-danger z-10">
                    <Icon name="arrow_up" className="w-4 h-4" />
                  </div>
                </div>
                <div className="bg-card border border-border-custom rounded-lg p-4 flex items-center justify-between relative overflow-hidden">
                  <div className="space-y-1 z-10">
                    <span className="text-[10px] font-bold text-danger/80 uppercase tracking-wider block">To Receive</span>
                    <strong className="text-xl font-extrabold text-foreground tracking-tight block">₹{partySums.to_receive.toLocaleString("en-IN")}</strong>
                  </div>
                  <div className="h-9 w-9 rounded-full bg-danger/10 flex items-center justify-center text-danger z-10">
                    <Icon name="arrow_down" className="w-4 h-4" />
                  </div>
                </div>
                <div className="bg-card border border-border-custom rounded-lg p-4 flex items-center justify-between relative overflow-hidden">
                  <div className="space-y-1 z-10">
                    <span className="text-[10px] font-bold text-success/80 uppercase tracking-wider block">Advance Received</span>
                    <strong className="text-xl font-extrabold text-foreground tracking-tight block">₹{partySums.advance_received.toLocaleString("en-IN")}</strong>
                  </div>
                  <div className="h-9 w-9 rounded-full bg-success/10 flex items-center justify-center text-success z-10">
                    <Icon name="arrow_down" className="w-4 h-4" />
                  </div>
                </div>
              </div>

              {/* Toolbar */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[200px]">
                  <input
                    type="text"
                    placeholder="Search parties..."
                    value={partySearchQuery}
                    onChange={(e) => setPartySearchQuery(e.target.value)}
                    className="w-full bg-input border border-border-custom rounded-md py-1.5 pl-8 pr-3 text-xs text-foreground placeholder-muted focus:outline-none focus:border-primary transition-all"
                  />
                  <Icon name="search" className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted" />
                </div>
                <select
                  value={partyTabStatus}
                  onChange={(e) => setPartyTabStatus(e.target.value)}
                  className="py-1 px-2 border border-border-custom bg-card hover:bg-elevated rounded text-[11px] font-medium text-foreground focus:outline-none cursor-pointer"
                >
                  <option>Active</option>
                  <option>All</option>
                  <option>Inactive</option>
                </select>
                <button onClick={exportCsv} className="py-1 px-3 border border-border-custom hover:bg-elevated rounded text-[11px] font-medium text-foreground transition-all inline-flex items-center gap-1">
                  <Icon name="arrow_down" className="w-3.5 h-3.5" /> Export
                </button>
                <button
                  onClick={() => { setShowAddPartyModal(true); }}
                  className="py-1.5 px-3 rounded bg-primary hover:bg-primary/90 text-white text-[11px] font-semibold transition-all"
                >
                  + New Party
                </button>
              </div>

              {/* Table */}
              <div className="flex-1 bg-card border border-border-custom rounded-lg overflow-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-input/60 text-muted uppercase text-[10px] tracking-wider">
                    <tr>
                      <th className="p-3 font-semibold">Party Details</th>
                      <th className="p-3 font-semibold">Type</th>
                      <th className="p-3 font-semibold text-right">Balance (₹)</th>
                      <th className="p-3 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-custom/40">
                    {filteredParties.length === 0 && (
                      <tr>
                        <td colSpan={4} className="p-8">
                          <EmptyState
                            title="No parties found"
                            description="No vendors, subcontractors, or clients match your search query."
                            action={{ label: "Add New Party", onClick: () => setShowAddPartyModal(true) }}
                          />
                        </td>
                      </tr>
                    )}
                    {filteredParties.map(p => (
                      <tr key={String(p.id)} className="hover:bg-elevated/40 transition-all">
                        <td className="p-3">
                          <div className="flex items-center gap-3">
                            <div className="h-8 w-8 rounded-full bg-primary/10 text-primary font-bold flex items-center justify-center text-xs">
                              {p.name.slice(0, 2).toUpperCase()}
                            </div>
                            <div>
                              <h4 className="text-xs font-bold text-foreground">{p.name}</h4>
                              <span className="text-[10px] text-muted">{p.party_id_custom || ""}</span>
                            </div>
                          </div>
                        </td>
                        <td className="p-3 text-foreground">{p.party_type || "—"}</td>
                        <td className="p-3 text-right font-bold text-foreground">
                          ₹{Math.abs(p.balance || 0).toLocaleString("en-IN")}
                          {/* R2-418: the net balance alone summed to a number that matched
                              no tile above; surfacing each row's two directions makes the
                              column reconcile with the To Pay / To Receive cards. */}
                          <div className="text-[10px] font-normal text-muted mt-0.5">
                            Pay ₹{(p.to_pay || 0).toLocaleString("en-IN")} · Receive ₹{(p.to_receive || 0).toLocaleString("en-IN")}
                          </div>
                        </td>
                        <td className="p-3">
                          <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider ${statusChip(p.status)}`}>
                            {formatLabel(p.status)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            );
          })()}

          {/* ── ADD PARTY MODAL ── */}
          {showAddPartyModal && (
            <>
              <div onClick={() => setShowAddPartyModal(false)} className="fixed inset-0 bg-black/60 z-40" />
              <div className="fixed right-0 top-0 h-full w-[480px] max-w-full bg-card border-l border-border-custom shadow-2xl z-50 p-6 overflow-y-auto flex flex-col gap-5">
                <div className="flex justify-between items-center border-b border-border-custom pb-4">
                  <div className="flex items-center gap-2">
                    <button onClick={() => setShowAddPartyModal(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
                    <h3 className="text-sm font-bold uppercase tracking-wider text-foreground">New Party</h3>
                  </div>
                  <button onClick={handleCreateParty} disabled={submitting} className="px-4 py-1.5 bg-primary hover:bg-primary/90 text-white text-xs font-semibold rounded disabled:opacity-50">
                    {submitting ? "Saving..." : "Save Party"}
                  </button>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="text-[10px] font-bold text-muted uppercase tracking-wider">Name *</label>
                    <input value={newParty.name} onChange={(e) => setNewParty({ ...newParty, name: e.target.value })} className="w-full bg-input border border-border-custom rounded-md p-2 text-xs text-foreground focus:outline-none focus:border-primary" />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-bold text-muted uppercase tracking-wider">Phone (w/ country code)</label>
                      <input value={newParty.phone} onChange={(e) => setNewParty({ ...newParty, phone: e.target.value })} placeholder="+91" className="w-full bg-input border border-border-custom rounded-md p-2 text-xs text-foreground focus:outline-none focus:border-primary" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-muted uppercase tracking-wider">Email</label>
                      <input value={newParty.email} onChange={(e) => setNewParty({ ...newParty, email: e.target.value })} className="w-full bg-input border border-border-custom rounded-md p-2 text-xs text-foreground focus:outline-none focus:border-primary" />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-bold text-muted uppercase tracking-wider">Party Type</label>
                      <select value={newParty.party_type} onChange={(e) => setNewParty({ ...newParty, party_type: e.target.value })} className="w-full bg-input border border-border-custom rounded-md p-2 text-xs text-foreground focus:outline-none focus:border-primary">
                        <option>Supplier</option>
                        <option>Subcontractor</option>
                        <option>Contractor</option>
                        <option>Client</option>
                        <option>Labour</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-muted uppercase tracking-wider">Party ID (auto)</label>
                      <input value={newParty.party_id_custom} onChange={(e) => setNewParty({ ...newParty, party_id_custom: e.target.value })} placeholder="PID-1" className="w-full bg-input border border-border-custom rounded-md p-2 text-xs text-foreground focus:outline-none focus:border-primary" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-muted uppercase tracking-wider">Address</label>
                    <textarea value={newParty.address} onChange={(e) => setNewParty({ ...newParty, address: e.target.value })} rows={2} className="w-full bg-input border border-border-custom rounded-md p-2 text-xs text-foreground focus:outline-none focus:border-primary" />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] font-bold text-muted uppercase tracking-wider">Date of Joining</label>
                      <input type="date" value={newParty.date_of_joining} onChange={(e) => setNewParty({ ...newParty, date_of_joining: e.target.value })} className="w-full bg-input border border-border-custom rounded-md p-2 text-xs text-foreground focus:outline-none focus:border-primary" />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-muted uppercase tracking-wider">PAN</label>
                      <input value={newParty.pan_number} onChange={(e) => setNewParty({ ...newParty, pan_number: e.target.value })} className="w-full bg-input border border-border-custom rounded-md p-2 text-xs text-foreground focus:outline-none focus:border-primary" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[10px] font-bold text-muted uppercase tracking-wider">Aadhaar Number</label>
                    <div className="flex gap-2">
                      <input value={newParty.aadhaar_number} onChange={(e) => setNewParty({ ...newParty, aadhaar_number: e.target.value })} className="flex-1 bg-input border border-border-custom rounded-md p-2 text-xs text-foreground focus:outline-none focus:border-primary" />
                    </div>
                  </div>

                  {/* Contractor / Subcontractor extra fields */}
                  {(newParty.party_type === "Contractor" || newParty.party_type === "Subcontractor") && (
                    <div className="space-y-3 border border-border-custom rounded-lg p-3 bg-input/40">
                      <div>
                        <label className="text-[10px] font-bold text-muted uppercase tracking-wider">Contractor Role</label>
                        <select value={newParty.contractor_role} onChange={(e) => setNewParty({ ...newParty, contractor_role: e.target.value })} className="w-full bg-input border border-border-custom rounded-md p-2 text-xs text-foreground focus:outline-none focus:border-primary">
                          <option value="">Select</option>
                          <option>Site Execution</option>
                          <option>Finishing</option>
                          <option>MEP</option>
                          <option>Survey</option>
                          <option>Other</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-[10px] font-bold text-muted uppercase tracking-wider">Service Rate Categories</label>
                        <div className="flex flex-wrap gap-2 mb-2">
                          {serviceTags.map((t, i) => (
                            <span key={i} className="text-[10px] px-2 py-1 rounded bg-primary/10 text-primary flex items-center gap-1">
                              {t}
                              <button type="button" onClick={() => setServiceTags(serviceTags.filter((_, j) => j !== i))} className="text-primary/70 hover:text-primary cursor-pointer"><Icon name="close" className="w-3 h-3" /></button>
                            </span>
                          ))}
                        </div>
                        <div className="flex gap-2">
                          <input
                            value={serviceTagInput}
                            onChange={(e) => setServiceTagInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && serviceTagInput.trim()) {
                                e.preventDefault();
                                setServiceTags([...serviceTags, serviceTagInput.trim()]);
                                setServiceTagInput("");
                              }
                            }}
                            placeholder="Add tag + Enter"
                            className="flex-1 bg-input border border-border-custom rounded-md p-2 text-xs text-foreground focus:outline-none focus:border-primary"
                          />
                          <button type="button" onClick={() => { if (serviceTagInput.trim()) { setServiceTags([...serviceTags, serviceTagInput.trim()]); setServiceTagInput(""); } }} className="px-3 py-2 border border-border-custom rounded-md text-[10px] text-muted hover:bg-elevated">+ Tag</button>
                        </div>
                      </div>
                      <div>
                        <label className="text-[10px] font-bold text-muted uppercase tracking-wider">Opening Balance (₹)</label>
                        <input type="number" value={newParty.opening_balance} onChange={(e) => setNewParty({ ...newParty, opening_balance: e.target.value })} className="w-full bg-input border border-border-custom rounded-md p-2 text-xs text-foreground focus:outline-none focus:border-primary" />
                        {newParty.opening_balance && (
                          <div className="flex gap-3 mt-2">
                            <button type="button" onClick={() => setNewParty({ ...newParty, opening_balance_type: "pay" })} className={`flex-1 py-2 rounded-md border text-[10px] font-semibold transition-all ${newParty.opening_balance_type === "pay" ? "border-border-custom bg-elevated text-foreground font-semibold" : "border-border-custom bg-card text-muted hover:bg-elevated/40"}`}>Party will pay (To Pay)</button>
                            <button type="button" onClick={() => setNewParty({ ...newParty, opening_balance_type: "receive" })} className={`flex-1 py-2 rounded-md border text-[10px] font-semibold transition-all ${newParty.opening_balance_type === "receive" ? "border-border-custom bg-elevated text-foreground font-semibold" : "border-border-custom bg-card text-muted hover:bg-elevated/40"}`}>Party will receive (Advance Received)</button>
                          </div>
                        )}
                      </div>
                      <div>
                        <label className="text-[10px] font-bold text-muted uppercase tracking-wider">Link Bank Account</label>
                        <select value={newParty.bank_account_id} onChange={(e) => setNewParty({ ...newParty, bank_account_id: e.target.value })} className="w-full bg-input border border-border-custom rounded-md p-2 text-xs text-foreground focus:outline-none focus:border-primary">
                          <option value="">Not applicable</option>
                          {bankAccounts.map((b: any) => (
                            <option key={String(b.id)} value={String(b.id)}>{b.bank_name} — {b.account_number}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}

                  {/* Spin into Sub-Con Work Order */}
                  <div className="border border-border-custom rounded-lg p-3 bg-input/40 space-y-3">
                    <label className="flex items-center gap-2 text-[11px] font-semibold text-foreground cursor-pointer">
                      <input type="checkbox" checked={newParty.create_wo} onChange={(e) => setNewParty({ ...newParty, create_wo: e.target.checked })} />
                      Create Sub-Con Work Order for this party
                    </label>
                    {newParty.create_wo && (
                      <>
                        <div>
                          <label className="text-[10px] font-bold text-muted uppercase tracking-wider">WO Title</label>
                          <input value={newParty.wo_title} onChange={(e) => setNewParty({ ...newParty, wo_title: e.target.value })} className="w-full bg-input border border-border-custom rounded-md p-2 text-xs text-foreground focus:outline-none focus:border-primary" />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-muted uppercase tracking-wider">Terms &amp; Conditions</label>
                          <div className="flex gap-1 mb-1">
                            <button type="button" onClick={() => document.execCommand("bold")} className="px-2 py-1 border border-border-custom rounded text-[10px] font-bold">B</button>
                            <button type="button" onClick={() => document.execCommand("italic")} className="px-2 py-1 border border-border-custom rounded text-[10px] italic">I</button>
                            <button type="button" onClick={() => document.execCommand("underline")} className="px-2 py-1 border border-border-custom rounded text-[10px] underline">U</button>
                            <button type="button" onClick={() => document.execCommand("insertUnorderedList")} className="px-2 py-1 border border-border-custom rounded text-[10px]">• List</button>
                          </div>
                          <div
                            contentEditable
                            suppressContentEditableWarning
                            onBlur={(e) => setNewParty({ ...newParty, wo_terms: e.currentTarget.innerText })}
                            className="w-full min-h-[80px] bg-input border border-border-custom rounded-md p-2 text-xs text-foreground focus:outline-none focus:border-primary"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-bold text-muted uppercase tracking-wider">Attach Media</label>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ── BILL / SHIP ADDRESS MODAL (4 blocks) ── */}
          {showBillShipModal && (
            <>
              <div onClick={() => setShowBillShipModal(false)} className="fixed inset-0 bg-black/60 z-40" />
              <div className="fixed right-0 top-0 h-full w-[520px] max-w-full bg-card border-l border-border-custom shadow-2xl z-50 p-6 overflow-y-auto flex flex-col gap-4">
                <div className="flex justify-between items-center border-b border-border-custom pb-4">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-foreground">Bill To / Ship To</h3>
                  <button onClick={() => setShowBillShipModal(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
                </div>

                {(["billFrom", "billTo", "shipFrom", "shipTo"] as const).map((key) => {
                  const label = { billFrom: "Bill From", billTo: "Bill To", shipFrom: "Ship From", shipTo: "Ship To" }[key];
                  return (
                    <div key={key} className="border border-border-custom rounded-lg p-3 bg-input/40 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-bold text-foreground">{label}</span>
                        <select
                          value={billShip[key] === "" ? "" : "custom"}
                          onChange={(e) => {
                            if (e.target.value !== "custom") setBillShip({ ...billShip, [key]: e.target.value });
                          }}
                          className="text-[10px] bg-input border border-border-custom rounded px-2 py-1 text-foreground"
                        >
                          <option value="custom">Type / select address</option>
                          <option value="Company">Company</option>
                        </select>
                      </div>
                      <textarea
                        value={billShip[key]}
                        onChange={(e) => setBillShip({ ...billShip, [key]: e.target.value })}
                        rows={2}
                        placeholder={`${label} address`}
                        className="w-full bg-input border border-border-custom rounded-md p-2 text-xs text-foreground focus:outline-none focus:border-primary"
                      />
                      {key === "shipFrom" && (
                        <label className="flex items-center gap-2 text-[10px] text-muted cursor-pointer">
                          <input type="checkbox" checked={sameAsBillFrom} onChange={(e) => { setSameAsBillFrom(e.target.checked); if (e.target.checked) setBillShip({ ...billShip, shipFrom: billShip.billFrom }); }} />
                          Same as Bill From Address
                        </label>
                      )}
                      {key === "shipTo" && (
                        <label className="flex items-center gap-2 text-[10px] text-muted cursor-pointer">
                          <input type="checkbox" checked={sameAsBillTo} onChange={(e) => { setSameAsBillTo(e.target.checked); if (e.target.checked) setBillShip({ ...billShip, shipTo: billShip.billTo }); }} />
                          Same as Bill To Address
                        </label>
                      )}
                    </div>
                  );
                })}

                <button
                  onClick={() => setShowBillShipModal(false)}
                  className="mt-2 py-2 rounded bg-primary hover:bg-primary/90 text-white text-xs font-semibold"
                >
                  Save Addresses
                </button>
              </div>
            </>
          )}

          {/* ── CASH BOOK TAB ── */}
          {tab === "cashbook" && (
            <div className="space-y-4">
              <div className="text-xs text-muted">Double-entry book for all site bank accounts & cash boxes.</div>
              <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
                <table className="w-full text-xs text-left">
                  <thead>
                    <tr className="border-b border-border-custom text-muted font-bold uppercase tracking-wider text-[9px]">
                      <th className="px-5 py-3">Date</th>
                      <th className="px-5 py-3">Reference</th>
                      <th className="px-5 py-3">Narration (Particulars)</th>
                      <th className="px-5 py-3">Party</th>
                      <th className="px-5 py-3 text-right">Debit (Outflow)</th>
                      <th className="px-5 py-3 text-right">Credit (Inflow)</th>
                      <th className="px-5 py-3 text-right">Cash Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-custom font-sans">
                    {cashBookRows.map((row, idx) => (
                      <tr key={idx} className="hover:bg-elevated">
                        <td className="px-5 py-3 text-muted">{row.date}</td>
                        <td className="px-5 py-3 text-foreground font-bold">{row.ref}</td>
                        <td className="px-5 py-3 text-muted font-sans">{row.narration}</td>
                        <td className="px-5 py-3 text-muted font-sans">{row.party}</td>
                        <td className="px-5 py-3 text-right text-danger">{row.debit > 0 ? `₹${row.debit.toLocaleString("en-IN")}` : "—"}</td>
                        <td className="px-5 py-3 text-right text-success">{row.credit > 0 ? `₹${row.credit.toLocaleString("en-IN")}` : "—"}</td>
                        <td className="px-5 py-3 text-right text-foreground font-extrabold">₹{row.running_balance.toLocaleString("en-IN")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── PAYMENT REQUESTS TAB ── */}
          {tab === "payment_requests" && (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <div className="text-xs text-muted">Record and track internal payment requests, milestone requests, and supplier payments.</div>
                <button
                  onClick={() => { setPrStep("type"); setPrType(null); setNewRequest({ partyId: "", amount: "", details: "", dueDate: "", requestType: "", extra: "" }); setShowAddRequestModal(true); }}
                  className="bg-primary text-white text-xs font-bold px-4 py-2.5 rounded-md cursor-pointer"
                >
                  + Create Payment Request
                </button>
              </div>

              <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
                <table className="w-full text-xs text-left">
                  <thead>
                      <tr className="border-b border-border-custom text-muted font-bold uppercase tracking-wider text-[9px]">
                        <th className="px-5 py-3">Request No.</th>
                        <th className="px-5 py-3">Created At</th>
                        <th className="px-5 py-3">Party Name</th>
                        <th className="px-5 py-3">Type</th>
                        <th className="px-5 py-3">Requested Amount</th>
                        <th className="px-5 py-3">Particulars / Details</th>
                        <th className="px-5 py-3">Status</th>
                        <th className="px-5 py-3">Due Date</th>
                      </tr>
                  </thead>
                  <tbody>
                    {paymentRequests.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="p-8">
                          <EmptyState
                            title="No active payment requests found"
                            description="Payment requests submitted for approval will appear here."
                          />
                        </td>
                      </tr>
                    ) : (
                      paymentRequests.map((req) => (
                        <tr key={req.id} onClick={() => setSelectedPR(req)} className="border-t border-border-custom hover:bg-elevated cursor-pointer transition-colors">
                          <td className="px-5 py-3 text-foreground font-sans font-bold">{req.request_no || "—"}</td>
                          <td className="px-5 py-3 text-muted font-sans">
                            {formatDate(req.created_at)}
                          </td>
                          <td className="px-5 py-3 font-semibold text-foreground">{req.party_name}</td>
                          <td className="px-5 py-3 text-muted">{req.request_type || "—"}</td>
                          <td className="px-5 py-3 text-foreground font-bold font-sans">₹{req.amount.toLocaleString("en-IN")}</td>
                          <td className="px-5 py-3 text-muted">{req.details}</td>
                          <td className="px-5 py-3">
                            <span className={`px-2 py-0.5 rounded text-[8px] font-bold border ${
                              req.status === "Approved" || req.status === "Paid"
                                ? "bg-success/10 border-success/20 text-success"
                                : req.status === "Rejected"
                                ? "bg-danger/10 border-danger/20 text-danger"
                                : "bg-warning/10 border-warning/20 text-warning"
                            }`}>
                              {req.status.toUpperCase()}
                            </span>
                          </td>
                          <td className="px-5 py-3 text-muted font-sans">
                            {req.due_date ? formatDate(req.due_date) : "Immediate"}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── CASH & BANK ACCOUNTS TAB ── */}
          {tab === "accounts" && (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <div className="text-xs text-muted">List and manage central business bank accounts, UPI configurations, and cash balances.</div>
                <button
                  onClick={() => setShowAddBankModal(true)}
                  className="bg-primary hover:bg-primary/95 text-white text-xs font-bold px-4 py-2.5 rounded-lg transition-all"
                >
                  + New Bank Account
                </button>
              </div>

              {/* Cash Account Section */}
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <p className="text-[10px] text-muted font-bold uppercase tracking-wider">Cash Account</p>
                  {!cashAccount && (
                    <button onClick={() => setShowAddCashModal(true)} className="bg-primary hover:bg-primary/95 text-white text-[10px] font-bold px-3 py-1.5 rounded-lg transition-all">+ New Cash Account</button>
                  )}
                </div>
                {cashAccount ? (
                  <div className="bg-card border border-border-custom rounded-xl p-4 flex items-center justify-between transition-all">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-lg bg-success/10 flex items-center justify-center text-success text-lg border border-success/20">
                        <Icon name="banknote" className="w-5 h-5" />
                      </div>
                      <div>
                        <h4 className="text-xs font-bold text-foreground">{cashAccount.name}</h4>
                        <p className="text-[10px] text-muted mt-0.5">Opening: ₹{(cashAccount.opening_balance || 0).toLocaleString("en-IN")}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <p className="text-[8px] text-muted uppercase tracking-wider">Running Balance</p>
                        <span className="text-base font-bold text-foreground">₹{cashRunning.toLocaleString("en-IN")}</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="bg-card border border-dashed border-border-custom rounded-xl p-8 text-center text-muted text-xs">
                    No cash account configured. Click "+ New Cash Account" to set an opening balance.
                  </div>
                )}
              </div>

              {/* Bank Accounts Section */}
              <div className="space-y-3">
                <p className="text-[10px] text-muted font-bold uppercase tracking-wider">Bank Accounts</p>
                <div className="grid gap-4 md:grid-cols-2">
                  {bankAccounts.length === 0 ? (
                    <div className="bg-card border border-border-custom rounded-xl p-8 text-center text-muted col-span-2 text-xs">
                      No bank accounts added yet. Click "+ New Bank Account" to configure one.
                    </div>
                  ) : (
                    bankAccounts.map((acc) => (
                      <div key={acc.id} className="bg-card border border-border-custom rounded-xl p-5 space-y-4 transition-all relative">
                        <div className="flex justify-between items-start">
                          <div className="flex items-center gap-2">
                            <div className="h-8 w-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary text-sm font-bold">
                              <Icon name="bank" className="w-4 h-4" />
                            </div>
                            <div>
                              <div className="text-xs font-bold text-foreground flex items-center gap-1.5">
                                {acc.bank_name}
                                <Badge tone="primary" className="font-bold">PRIMARY</Badge>
                              </div>
                              <div className="text-[10px] text-muted mt-0.5">A/C: {acc.account_number}</div>
                            </div>
                          </div>
                          
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleDeleteBankAccount(acc.id)}
                              className="p-1.5 rounded-lg bg-danger/10 hover:bg-danger/20 border border-danger/20 text-danger text-xs transition-all cursor-pointer"
                              title="Delete bank account"
                            >
                              <Icon name="trash" className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        {/* Account Details Sub Grid */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-3 border-t border-border-custom/50 text-[10px]">
                          <div>
                            <span className="text-muted block uppercase font-medium text-[8px] tracking-wider">AC Holder</span>
                            <span className="text-foreground font-semibold mt-0.5 block">{acc.account_holder_name || "—"}</span>
                          </div>
                          <div>
                            <span className="text-muted block uppercase font-medium text-[8px] tracking-wider">IFSC Code</span>
                            <span className="text-foreground font-semibold mt-0.5 block font-sans">{acc.ifsc_code || "—"}</span>
                          </div>
                          <div>
                            <span className="text-muted block uppercase font-medium text-[8px] tracking-wider">UPI</span>
                            <span className="text-foreground font-semibold mt-0.5 block">{acc.upi_id || "—"}</span>
                          </div>
                          <div>
                            <span className="text-muted block uppercase font-medium text-[8px] tracking-wider">IBAN No</span>
                            <span className="text-foreground font-semibold mt-0.5 block font-sans">Not provided</span>
                          </div>
                          <div className="col-span-2">
                            <span className="text-muted block uppercase font-medium text-[8px] tracking-wider">Running Balance</span>
                            <span className="text-foreground font-bold mt-0.5 block text-xs">₹{acc.balance.toLocaleString("en-IN")}</span>
                          </div>
                          <div className="col-span-2">
                            <span className="text-muted block uppercase font-medium text-[8px] tracking-wider">Opening Balance</span>
                            <span className="text-foreground font-semibold mt-0.5 block text-[10px]">₹{(acc.opening_balance ?? 0).toLocaleString("en-IN")}</span>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── PROJECT P&L TAB ── */}
          {tab === "pl" && (
            <div className="space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {[
                  { label: "Revenue (Billed)", value: `₹${totalRevenue.toLocaleString("en-IN")}`, color: "text-success" },
                  { label: "Total Cost", value: `₹${totalCost.toLocaleString("en-IN")}`, color: "text-danger" },
                  { label: `Gross Margin (${margin}%)`, value: `₹${grossProfit.toLocaleString("en-IN")}`, color: "text-primary" },
                ].map((s, i) => (
                  <div key={i} className="bg-card border border-border-custom rounded-lg rounded-md p-5 border border-border-custom text-center bg-input">
                    <div className="text-[10px] text-muted uppercase tracking-wider">{s.label}</div>
                    <div className="text-2xl font-black mt-2">{s.value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── TALLY SYNC TAB ── */}
          {tab === "tally" && (
            <div className="space-y-5">
              {tallyMsg && (
                <div className={`p-3 text-xs rounded-lg ${tallyMsg.type === "ok" ? "bg-success/10 border border-success/20 text-success" : "bg-danger/10 border border-danger/20 text-danger"}`}>
                  {tallyMsg.text}
                </div>
              )}

              {/* Connection */}
              <div className="bg-card border border-border-custom rounded-lg p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-bold text-foreground">Tally Prime Connection</h2>
                    <div className="text-xs text-muted">Configure the Tally company this SiteFlow data exports into.</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => router.push(`/c/${companyId}/d/integrations/tally`)}
                      className="text-xs font-bold px-3 py-1.5 rounded-md bg-elevated border border-border-custom hover:bg-card text-foreground cursor-pointer inline-flex items-center gap-1.5"
                    >
                      <Icon name="settings" className="w-3.5 h-3.5" /> Desktop Agents & Mappings
                    </button>
                    {tallyConn ? (
                      <button onClick={openTallySetup} className="text-xs font-bold px-3 py-1.5 rounded-md border border-border-custom hover:bg-elevated cursor-pointer">Edit Connection</button>
                    ) : (
                      <button onClick={openTallySetup} className="bg-primary text-white text-xs font-bold px-4 py-2 rounded-md hover:opacity-90 cursor-pointer">Connect Tally</button>
                    )}
                  </div>
                </div>
                {tallyConn ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-3 text-xs">
                    <div className="rounded-lg border border-border-custom p-3">
                      <div className="text-[10px] uppercase font-bold text-muted">Company</div>
                      <div className="text-foreground font-semibold">{tallyConn.tally_company_name}</div>
                    </div>
                    <div className="rounded-lg border border-border-custom p-3">
                      <div className="text-[10px] uppercase font-bold text-muted">Mobile</div>
                      <div className="text-foreground font-semibold">{tallyConn.registered_mobile}</div>
                    </div>
                    <div className="rounded-lg border border-border-custom p-3">
                      <div className="text-[10px] uppercase font-bold text-muted">Voucher No.</div>
                      <div className="text-foreground font-semibold">{tallyConn.voucher_number_template}</div>
                    </div>
                    <div className="rounded-lg border border-border-custom p-3">
                      <div className="text-[10px] uppercase font-bold text-muted">Round-off Ledger</div>
                      <div className="text-foreground font-semibold">{tallyConn.round_off_ledger || "Round Off (Default)"}</div>
                    </div>
                    <div className="rounded-lg border border-border-custom p-3">
                      <div className="text-[10px] uppercase font-bold text-muted">Auto-create ledgers</div>
                      <div className="text-foreground font-semibold">{tallyConn.auto_create_missing_ledgers ? "On" : "Off"}</div>
                    </div>
                  </div>
                ) : (
                  <EmptyState
                    title="No Tally connection yet"
                    description="Connect your Tally Prime company to export vouchers, map accounting ledgers, and sync financial transactions."
                    action={{
                      label: "Connect Tally",
                      onClick: openTallySetup,
                    }}
                  />
                )}
              </div>

              {/* Mappings */}
              {tallyConn && (
                <div className="bg-card border border-border-custom rounded-lg p-5 space-y-6">
                  <h2 className="text-sm font-bold text-foreground">Ledger Mappings</h2>

                  {/* Transaction-type ledger mappings */}
                  <div className="space-y-3">
                    <div className="text-[10px] uppercase font-bold text-muted">Transaction Type Ledgers</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                      <div>
                        <label className="text-xs text-muted">Purchase ledger</label>
                        <input value={purchaseLedgerInput} onChange={(e) => setPurchaseLedgerInput(e.target.value)} placeholder="Purchase A/c" className="w-full mt-1 bg-input border border-border-custom rounded-md px-3 py-1.5 text-xs text-foreground focus:outline-none focus:border-primary" />
                      </div>
                      <div>
                        <label className="text-xs text-muted">Sales ledger</label>
                        <input value={salesLedgerInput} onChange={(e) => setSalesLedgerInput(e.target.value)} placeholder="Sales A/c" className="w-full mt-1 bg-input border border-border-custom rounded-md px-3 py-1.5 text-xs text-foreground focus:outline-none focus:border-primary" />
                      </div>
                      <div>
                        <label className="text-xs text-muted">Freight ledger (optional)</label>
                        <input value={freightLedgerInput} onChange={(e) => setFreightLedgerInput(e.target.value)} placeholder="Freight Charges" className="w-full mt-1 bg-input border border-border-custom rounded-md px-3 py-1.5 text-xs text-foreground focus:outline-none focus:border-primary" />
                      </div>
                      <div>
                        <label className="text-xs text-muted">Surcharge ledger (optional)</label>
                        <input value={surchargeLedgerInput} onChange={(e) => setSurchargeLedgerInput(e.target.value)} placeholder="Surcharge / Extra Charges" className="w-full mt-1 bg-input border border-border-custom rounded-md px-3 py-1.5 text-xs text-foreground focus:outline-none focus:border-primary" />
                      </div>
                    </div>
                    <button onClick={saveLedgerMappings} className="text-xs font-bold px-3 py-1.5 rounded-md bg-primary/15 text-primary border border-primary/20 hover:bg-primary/25">Save Ledger Mappings</button>
                  </div>

                  {/* Party ledger mappings */}
                  <div className="space-y-3">
                    <div className="text-[10px] uppercase font-bold text-muted">Party Ledger Mappings</div>
                    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                      {companyParties.length === 0 && (
                        <EmptyState
                          title="No parties found"
                          description="Create company parties first to map them to Tally ledgers."
                          className="py-4"
                        />
                      )}
                      {companyParties.map((p: any) => (
                        <div key={p.id} className="flex items-center gap-2">
                          <div className="w-48 shrink-0 text-xs text-foreground truncate">{p.name}</div>
                          <input
                            value={partyLedgerInputs[p.id] ?? tallyPartyMappings.find((m) => m.onsite_party_id === p.id)?.tally_ledger_name ?? ""}
                            placeholder="Tally ledger name"
                            onChange={(e) => setPartyLedgerInputs((prev) => ({ ...prev, [p.id]: e.target.value }))}
                            onBlur={(e) => savePartyMapping(p.id, e.target.value)}
                            className="flex-1 bg-input border border-border-custom rounded-md px-3 py-1.5 text-xs text-foreground focus:outline-none focus:border-primary"
                          />
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Cost centre mapping (optional) */}
                  <div className="space-y-3">
                    <div className="text-[10px] uppercase font-bold text-muted">Project Cost Centre {activeProjectId ? "" : "(select a project)"}</div>
                    <div className="flex items-center gap-2">
                      <input
                        value={costCentreInput}
                        placeholder="Tally cost centre name"
                        onChange={(e) => setCostCentreInput(e.target.value)}
                        className="flex-1 bg-input border border-border-custom rounded-md px-3 py-1.5 text-xs text-foreground focus:outline-none focus:border-primary"
                      />
                      <button onClick={saveCostCentreMapping} className="text-xs font-bold px-3 py-1.5 rounded-md bg-primary/15 text-primary border border-primary/20 hover:bg-primary/25">Save</button>
                    </div>
                  </div>
                </div>
              )}

              {/* Export flow */}
              {tallyConn && (
                <div className="bg-card border border-border-custom rounded-lg p-5 space-y-4">
                  <h2 className="text-sm font-bold text-foreground">Export to Tally</h2>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
                    <div className="rounded-lg border border-border-custom p-3">
                      <div className="text-[10px] uppercase font-bold text-muted">Pending vouchers</div>
                      <div className="text-foreground font-semibold">{tallyPending.count}</div>
                    </div>
                    <div className="rounded-lg border border-border-custom p-3">
                      <div className="text-[10px] uppercase font-bold text-muted">Last export</div>
                      <div className="text-foreground font-semibold">{tallyLastExport || "—"}</div>
                    </div>
                    <div className="rounded-lg border border-border-custom p-3">
                      <div className="text-[10px] uppercase font-bold text-muted">Last marked synced</div>
                      <div className="text-foreground font-semibold">{tallyLastMarked || "—"}</div>
                    </div>
                  </div>

                  {tallyPending.count > 0 && (
                    <div className="rounded-lg border border-border-custom p-3 space-y-1 max-h-48 overflow-y-auto">
                      {tallyPending.vouchers.map((v, i) => (
                        <div key={i} className="flex items-center justify-between text-xs text-muted">
                          <span className="font-semibold text-foreground">{v.type}</span>
                          <span>{v.number}</span>
                          <span>{v.party}</span>
                          <span>₹{(v.amount || 0).toLocaleString("en-IN")}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button onClick={handleDownloadXml} disabled={tallyExporting || tallyPending.count === 0} className="px-4 py-2 bg-primary text-white text-xs font-bold rounded-md hover:opacity-90 disabled:opacity-50">
                      {tallyExporting ? "Generating…" : "Download Tally XML"}
                    </button>
                    <button onClick={handleMarkSynced} disabled={tallyMarking || tallyPending.count === 0} className="px-4 py-2 border border-border-custom text-foreground text-xs font-bold rounded-md hover:bg-elevated disabled:opacity-50">
                      {tallyMarking ? "Marking…" : "Mark as imported into Tally"}
                    </button>
                  </div>

                  <div className="rounded-lg border border-border-custom bg-input p-4 text-xs text-muted space-y-1">
                    <div className="font-bold text-foreground">How to import</div>
                    <div>1. Click "Download Tally XML" to get the voucher file.</div>
                    <div>2. Open Tally Prime, go to Gateway of Tally, then Import Data, then Vouchers, and select the downloaded file.</div>
                    <div>3. After the import succeeds in Tally, click "Mark as imported into Tally" so these vouchers are not exported again.</div>
                    <div>4. Ensure the referenced ledgers exist in Tally, or enable auto-create missing ledgers in the connection.</div>
                  </div>
                </div>
              )}

              {/* Sync history */}
              {tallyConn && tallySyncLogs.length > 0 && (
                <div className="bg-card border border-border-custom rounded-lg p-5 space-y-2">
                  <h2 className="text-sm font-bold text-foreground">Sync History</h2>
                  <div className="space-y-1">
                    {tallySyncLogs.map((log) => (
                      <div key={log.id} className="flex items-center justify-between text-xs text-muted">
                        <span>Marked {log.voucher_count} voucher(s) synced</span>
                        <span>{log.marked_synced_at ? new Date(log.marked_synced_at).toLocaleString("en-IN") : "—"}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── COST VARIANCE TAB ── */}
          {tab === "costvar" && (() => {
            const BUDGET_LINES: { code: string; head: string; budget: number }[] = [];

            const actuals: Record<string, number> = {};
            transactions.filter(t => t.status !== "Rejected").forEach(t => {
              const key = t.cost_code ? t.cost_code.split(" ")[0] : "5.0";
              actuals[key] = (actuals[key] || 0) + t.amount;
            });

            const rows = BUDGET_LINES.map(b => {
              const actual = actuals[b.code] || 0;
              const variance = b.budget - actual;
              const variancePct = b.budget > 0 ? ((variance / b.budget) * 100) : 0;
              const pctComplete = 0.60;
              const eac = actual > 0 ? (actual / pctComplete) : b.budget;
              return { ...b, actual, variance, variancePct, eac };
            });

            const totalBudget = rows.reduce((s, r) => s + r.budget, 0);
            const totalActual = rows.reduce((s, r) => s + r.actual, 0);
            const totalVariance = totalBudget - totalActual;
            const totalEAC = rows.reduce((s, r) => s + r.eac, 0);

            return (
              <div className="space-y-5">
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="text-xs font-bold text-muted uppercase tracking-wider">Budget vs Actual: Cost Variance Report</h2>
                    <p className="text-[10px] text-muted mt-1">EAC = Estimate At Completion (projects final cost at current burn rate assuming 60% completion).</p>
                  </div>
                  <Badge tone={totalVariance >= 0 ? "success" : "danger"} className="font-bold">
                    {totalVariance >= 0 ? (
                      <span className="inline-flex items-center gap-1">
                        <Icon name="arrow_down" className="w-3.5 h-3.5" /> Underspent
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Icon name="arrow_up" className="w-3.5 h-3.5" /> Overspent
                      </span>
                    )} by ₹{Math.abs(totalVariance).toLocaleString("en-IN")}
                  </Badge>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {[
                    { label: "Total Budget", value: `₹${totalBudget.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`, color: "text-foreground" },
                    { label: "Actual Spend", value: `₹${totalActual.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`, color: "text-primary" },
                    { label: "Variance", value: `₹${totalVariance.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`, color: totalVariance >= 0 ? "text-success" : "text-danger" },
                    { label: "EAC (at 60%)", value: `₹${Math.round(totalEAC).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`, color: totalEAC > totalBudget ? "text-danger" : "text-success" },
                  ].map(kpi => (
                    <div key={kpi.label} className="bg-input border border-border-custom rounded-md p-4">
                      <span className="text-[9px] uppercase text-muted tracking-wider block">{kpi.label}</span>
                      <strong className={`text-lg font-extrabold mt-1 block font-sans ${kpi.color}`}>{kpi.value}</strong>
                    </div>
                  ))}
                </div>

                <div className="bg-background border border-border-custom rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border-custom text-muted">
                        <th className="px-5 py-3 text-left font-semibold">Cost Code</th>
                        <th className="px-5 py-3 text-left font-semibold">Head</th>
                        <th className="px-5 py-3 text-right font-semibold">Budget</th>
                        <th className="px-5 py-3 text-right font-semibold">Actual</th>
                        <th className="px-5 py-3 text-right font-semibold">Variance</th>
                        <th className="px-5 py-3 text-right font-semibold">Var %</th>
                        <th className="px-5 py-3 text-right font-semibold">EAC</th>
                        <th className="px-5 py-3 text-center font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(row => {
                        const isOver = row.variance < 0;
                        const isWarn = row.variancePct < 10 && row.variancePct >= 0;
                        const statusLabel = isOver ? "OVERSPENT" : isWarn ? "AT RISK" : "ON TRACK";
                        const statusTone: BadgeTone = isOver ? "danger" : isWarn ? "warning" : "success";
                        return (
                          <tr key={row.code} className={`border-b border-white/[0.03] hover:bg-elevated transition-all ${isOver ? "bg-danger/[0.02]" : ""}`}>
                            <td className="px-5 py-3 font-sans text-muted">{row.code}</td>
                            <td className="px-5 py-3 font-semibold text-foreground">{row.head}</td>
                            <td className="px-5 py-3 text-right font-sans text-muted">₹{row.budget.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                            <td className="px-5 py-3 text-right font-sans font-bold text-foreground">₹{row.actual.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                            <td className={`px-5 py-3 text-right font-sans font-bold ${isOver ? "text-danger" : "text-success"}`}>
                              {row.variance >= 0 ? "+" : ""}₹{row.variance.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                            </td>
                            <td className={`px-5 py-3 text-right font-sans ${isOver ? "text-danger" : isWarn ? "text-warning" : "text-success"}`}>
                              {row.variancePct.toFixed(1)}%
                            </td>
                            <td className={`px-5 py-3 text-right font-sans ${row.eac > row.budget ? "text-danger" : "text-muted"}`}>
                              ₹{Math.round(row.eac).toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                            </td>
                            <td className="px-5 py-3 text-center">
                              <Badge tone={statusTone} className="font-bold">{statusLabel}</Badge>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
          </PageShell>
        </div>
      </div>

      {/* ── Voucher Detail Drawer ── */}
      {selectedVoucher && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-end">
          <div className="bg-background border-l border-border-custom w-full max-w-md h-full shadow-2xl flex flex-col overflow-hidden text-xs">
            {selectedVoucher.status === "Pending" ? (
              <div className="bg-warning px-6 py-2.5 text-center font-bold text-black uppercase tracking-wider text-[10px] inline-flex items-center justify-center gap-1.5 w-full">
                <Icon name="warning" className="w-3.5 h-3.5" /> Pending Voucher Approval (Accrued Expense)
              </div>
            ) : (
              <div className="bg-success px-6 py-2.5 text-center font-bold text-black uppercase tracking-wider text-[10px] inline-flex items-center justify-center gap-1.5 w-full">
                <Icon name="check" className="w-3.5 h-3.5" /> Approved & Settled Ledger Voucher
              </div>
            )}

            <div className="px-6 py-4 border-b border-border-custom flex items-center justify-between bg-background">
              <div>
                <span className="text-[9px] uppercase tracking-wider font-extrabold text-primary">Voucher Details</span>
                <h2 className="text-base font-extrabold text-foreground mt-1">{selectedVoucher.ref}</h2>
              </div>
              <button onClick={() => setSelectedVoucher(null)} className="text-muted hover:text-foreground cursor-pointer inline-flex items-center gap-1"><Icon name="close" className="w-4 h-4" /> Close</button>
            </div>

            <div className="flex-1 p-6 overflow-y-auto space-y-6">
              <div className="space-y-1 border-b border-border-custom pb-4">
                <span className="text-muted uppercase text-[9px] tracking-wider block">Ledger Classification</span>
                <strong className="text-foreground block mt-0.5 text-sm">{selectedVoucher.ledger}</strong>
                {selectedVoucher.cost_code && (
                  <Badge tone="primary" className="inline-flex mt-1.5 font-bold">Cost Code: {selectedVoucher.cost_code}</Badge>
                )}
                {selectedVoucher.ref_invoice && (
                  <Badge tone="warning" className="inline-flex mt-1.5 font-bold mr-1.5">Ref Invoice: {selectedVoucher.ref_invoice}</Badge>
                )}
                {selectedVoucher.project_name && (
                  <Badge tone="primary" className="inline-flex mt-1.5 font-bold mr-1.5">Project: {selectedVoucher.project_name}</Badge>
                )}
                {selectedVoucher.due_date && (
                  <Badge tone="warning" className="inline-flex mt-1.5 font-bold">Due Date: {selectedVoucher.due_date}</Badge>
                )}
              </div>

              {/* Approval steps */}
              <div className="space-y-3 border-b border-border-custom pb-4">
                <span className="text-muted uppercase text-[9px] tracking-wider block">Sequential Approvals</span>
                <div className="space-y-3 mt-2">
                  <div className="flex items-center gap-3">
                    <div className="h-5 w-5 rounded-full bg-success/10 border border-success/20 text-success flex items-center justify-center font-bold text-[10px]"><Icon name="check" className="w-3 h-3" /></div>
                    <div>
                      <div className="text-[11px] font-bold text-foreground">1. Site Supervisor</div>
                      <div className="text-[9px] text-muted">Verified upon entry & photo upload</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className={`h-5 w-5 rounded-full flex items-center justify-center font-bold text-[10px] ${selectedVoucher.status === "Approved" ? "bg-success/10 border-success/20 text-success" : "bg-warning/10 border-warning/20 text-warning"}`}>
                      {selectedVoucher.status === "Approved" ? <Icon name="check" className="w-3 h-3" /> : <Icon name="schedule" className="w-3 h-3" />}
                    </div>
                    <div>
                      <div className="text-[11px] font-bold text-foreground">2. Project Manager</div>
                      <div className="text-[9px] text-muted">Required for values &gt; ₹50k</div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-input p-4 rounded-md border border-border-custom text-xs font-sans">
                <div>
                  <span className="text-muted block uppercase text-[9px] tracking-wider font-sans">Settled Amount</span>
                  <strong className="text-success mt-1 block text-sm">₹{(selectedVoucher.settled_amount ?? 0).toLocaleString("en-IN")}</strong>
                </div>
                <div>
                  <span className="text-muted block uppercase text-[9px] tracking-wider font-sans">Balance Due</span>
                  <strong className="text-danger mt-1 block text-sm">₹{(selectedVoucher.balance_due ?? 0).toLocaleString("en-IN")}</strong>
                </div>
              </div>

              {/* Photo preview */}
              {selectedVoucher.photo_url && (
                <div className="space-y-2">
                  <span className="text-muted block uppercase text-[9px] tracking-wider">Voucher Photo Receipt</span>
                  <div className="border border-border-custom rounded-md overflow-hidden aspect-[4/3] bg-elevated relative">
                    <img src={selectedVoucher.photo_url} alt="Voucher Receipt" className="object-cover h-full w-full opacity-80" />
                  </div>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-border-custom bg-background flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => handleDeletePayment(selectedVoucher.id)}
                className="px-3.5 py-2 bg-danger/10 hover:bg-danger/20 border border-danger/20 text-danger rounded-md text-xs font-bold cursor-pointer inline-flex items-center gap-1.5"
              >
                <Icon name="trash" className="w-3.5 h-3.5" /> Delete Payment
              </button>
              <div className="flex items-center gap-2">
                <button onClick={() => setSelectedVoucher(null)} className="px-4 py-2 text-xs font-bold text-muted hover:text-foreground cursor-pointer">Close</button>
                {selectedVoucher.status === "Pending" && (
                  <button onClick={() => handleApproveVoucher(selectedVoucher.id)} className="px-5 py-2.5 bg-success text-black font-extrabold rounded-md hover:opacity-90 inline-flex items-center gap-1.5 cursor-pointer">
                    Approve Voucher <Icon name="thumbs_up" className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Voucher Drawer ── */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-end animate-fade-in" onClick={() => setShowAddModal(false)}>
          <div className="bg-card w-full max-w-lg h-full border-l border-border-custom shadow-2xl p-6 flex flex-col justify-between overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div>
              {/* Dynamic Header */}
              <div className="flex justify-between items-center border-b border-border-custom pb-4 mb-5">
                <div>
                  <h3 className="text-sm font-bold text-foreground uppercase tracking-wider">
                    {selectedTxnType === "Upload Payments" ? "ADD PAYMENT" : selectedTxnType}
                  </h3>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="date"
                    value={txnDate}
                    onChange={e => setTxnDate(e.target.value)}
                    title="Transaction date"
                    className="bg-background border border-border-custom rounded-lg px-2 py-1.5 text-foreground text-xs font-sans focus:outline-none focus:border-primary"
                  />
                  <button onClick={() => setShowAddModal(false)} className="text-xs text-muted hover:text-foreground transition-colors cursor-pointer">Cancel</button>
                  <button onClick={handleRecordPayment} className="bg-primary hover:bg-primary/90 text-white font-bold text-xs px-4 py-1.5 rounded-lg transition-all cursor-pointer">Save</button>
                </div>
              </div>

              {/* Dynamic Form Content */}
              {selectedTxnType === "Upload Payments" ? (
                /* UPLOAD PAYMENTS SCREEN (Screenshot 2) */
                <div className="space-y-6 text-xs">
                  <div className="bg-elevated/45 border border-border-custom p-4 rounded-xl space-y-3">
                    <div className="flex items-start gap-2.5">
                      <Icon name="note" className="w-4 h-4 text-muted" />
                      <div className="space-y-1">
                        <strong className="text-foreground block">How to import Excel/CSV in SiteFlow:</strong>
                        <ol className="list-decimal pl-4 space-y-1 text-muted leading-relaxed">
                          <li>Remove any unnecessary header rows from the Excel file.</li>
                          <li>
                            Ensure the column structure aligns with the{" "}
                            <span onClick={() => {
                              const tpl = "Payment Type,Party Name,Amount,Project Name,Payment Date,Mode of Payment,Category,Payment Request ID,Remark";
                              const blob = new Blob([tpl], { type: "text/csv" });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement("a");
                              a.href = url; a.download = "siteflow_payment_template.csv"; a.click();
                              URL.revokeObjectURL(url);
                            }} className="text-primary hover:underline font-bold cursor-pointer inline-flex items-center gap-1">
                              SiteFlow Payment Request template <Icon name="inbox" className="w-3.5 h-3.5" />
                            </span>{" "}
                            (column names and order of columns need to match exactly with the sample file).
                          </li>
                          <li>Upload that file here.</li>
                        </ol>
                      </div>
                    </div>
                  </div>

                  <div 
                    onClick={() => document.getElementById("payments-csv-file-input")?.click()}
                    className="border-2 border-dashed border-border-custom hover:border-primary/50 transition-all rounded-xl p-8 flex flex-col items-center justify-center bg-background cursor-pointer text-center space-y-2"
                  >
                    <input 
                      type="file" 
                      id="payments-csv-file-input" 
                      accept=".csv" 
                      className="hidden" 
                      onChange={handleCsvSelect}
                    />
                    <Icon name="outbox" className="w-8 h-8 text-primary" />
                    <strong className="text-foreground font-bold text-xs">Upload Csv</strong>
                    <span className="text-[9px] text-muted">Supports .csv formats up to 10MB</span>
                  </div>

                  {csvPreview && (
                    <div className="border border-border-custom rounded-xl p-3 bg-input/40 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-bold text-foreground">Preview ({csvPreview.length} rows)</span>
                        <button type="button" onClick={() => { setCsvPreview(null); setCsvFile(null); }} className="text-[10px] text-muted hover:text-foreground">Clear</button>
                      </div>
                      <div className="max-h-48 overflow-auto">
                        <table className="w-full text-[9px] text-left">
                          <thead className="text-muted uppercase">
                            <tr>
                              {csvPreview[0] && Object.keys(csvPreview[0]).map(h => <th key={h} className="p-1">{h}</th>)}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border-custom/40">
                            {csvPreview.slice(0, 50).map((r, i) => (
                              <tr key={i}>
                                {Object.values(r).map((v: any, j) => <td key={j} className="p-1 text-foreground">{v}</td>)}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <button
                        type="button"
                        disabled={!csvFile || submitting}
                        onClick={() => csvFile && handleUploadCSV(csvFile)}
                        className="w-full py-2 rounded bg-primary hover:bg-primary/90 text-white text-xs font-semibold disabled:opacity-50"
                      >
                        {submitting ? "Importing..." : "Save Import"}
                      </button>
                    </div>
                  )}
                </div>
              ) : selectedTxnType === "Party to Party" ? (
                /* PARTY TO PARTY PAYMENT (Screenshot 4) */
                <div className="space-y-4 text-xs">
                  <div className="flex justify-between items-center bg-background/50 border border-border-custom rounded-lg p-2.5">
                    <span className="text-muted text-[10px] font-bold uppercase">Date</span>
                    <span className="text-foreground font-semibold font-sans">{formatDmy(txnDate)}</span>
                  </div>

                  <div>
                    <label className="text-[10px] text-muted uppercase font-bold block mb-1">Payment From (Debit)*</label>
                    <select
                      value={paymentFromParty}
                      onChange={e => setPaymentFromParty(e.target.value)}
                      required
                      className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs"
                    >
                      <option value="">Select party to debit...</option>
                      {usersList.map((u: any) => (
                        <option key={u.id} value={u.id}>{u.name} ({u.role || "—"})</option>
                      ))}
                    </select>
                    {usersList.length === 0 && (
                      <FieldHint text="No parties registered yet." onAction={() => setShowAddPartyModal(true)} actionLabel="Add a party" />
                    )}
                  </div>

                  <div>
                    <label className="text-[10px] text-muted uppercase font-bold block mb-1">Payment To (Credit)*</label>
                    <select
                      value={paymentToParty}
                      onChange={e => setPaymentToParty(e.target.value)}
                      required
                      className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs"
                    >
                      <option value="">Select party to credit...</option>
                      {usersList.map((u: any) => (
                        <option key={u.id} value={u.id}>{u.name} ({u.role || "—"})</option>
                      ))}
                    </select>
                    {usersList.length === 0 && (
                      <FieldHint text="No parties registered yet." onAction={() => setShowAddPartyModal(true)} actionLabel="Add a party" />
                    )}
                  </div>

                  <div>
                    <label className="text-[10px] text-muted uppercase font-bold block mb-1">Amount</label>
                    <input
                      type="number"
                      value={amount}
                      onChange={e => setAmount(e.target.value)}
                      placeholder="0"
                      className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground text-xs font-sans font-bold"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] text-muted uppercase font-bold block mb-1">Description</label>
                    <textarea
                      value={desc}
                      onChange={e => setDesc(e.target.value)}
                      rows={3}
                      placeholder="Describe transfer reason..."
                      className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground text-xs resize-none"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] text-muted uppercase font-bold block mb-1">Add Cost Code</label>
                    <select
                      value={costCode}
                      onChange={e => setCostCode(e.target.value)}
                      className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs"
                    >
                      <option value="">Select Cost Code</option>
                      {/* cost codes loaded from library_cost_codes */}
                      <option value="" disabled>— No cost codes configured</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-[10px] text-muted uppercase font-bold block mb-1">Reference No.</label>
                    <input
                      type="text"
                      value={refNum}
                      onChange={e => setRefNum(e.target.value)}
                      placeholder="e.g. Reference transaction ID"
                      className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground text-xs"
                    />
                  </div>

                </div>
              ) : null}
            </div>

          </div>
        </div>
      )}
      {/* ── Add Bank Account Modal ── */}
      {showAddBankModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-end animate-fade-in" onClick={() => setShowAddBankModal(false)}>
          <div className="bg-card w-full max-w-md h-full border-l border-border-custom shadow-2xl p-6 flex flex-col justify-between overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div>
              <div className="flex justify-between items-center border-b border-border-custom pb-4 mb-5">
                <h3 className="text-sm font-bold text-foreground uppercase tracking-wider">Add New Account</h3>
                <button onClick={() => setShowAddBankModal(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
              </div>

              <form onSubmit={handleAddBankAccount} className="space-y-4 text-xs font-sans">
                <div>
                  <label className="text-[10px] text-muted uppercase font-bold block mb-1">Account Holder Name*</label>
                  <input
                    type="text"
                    value={newBank.holder}
                    onChange={e => setNewBank({ ...newBank, holder: e.target.value })}
                    required
                    placeholder="e.g. YASH DESAI"
                    className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs"
                  />
                </div>

                <div>
                  <label className="text-[10px] text-muted uppercase font-bold block mb-1">Account Number*</label>
                  <input
                    type="text"
                    value={newBank.number}
                    onChange={e => setNewBank({ ...newBank, number: e.target.value })}
                    required
                    placeholder="e.g. ICIC000239181289"
                    className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs"
                  />
                </div>

                <div>
                  <label className="text-[10px] text-muted uppercase font-bold block mb-1">IFSC Code*</label>
                  <input
                    type="text"
                    value={newBank.ifsc}
                    onChange={e => setNewBank({ ...newBank, ifsc: e.target.value })}
                    required
                    placeholder="e.g. ICIC000"
                    className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs font-sans"
                  />
                </div>

                <div>
                  <label className="text-[10px] text-muted uppercase font-bold block mb-1">Bank Name*</label>
                  <input
                    type="text"
                    value={newBank.name}
                    onChange={e => setNewBank({ ...newBank, name: e.target.value })}
                    required
                    placeholder="e.g. ICICI BANK"
                    className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs"
                  />
                </div>

                <div>
                  <label className="text-[10px] text-muted uppercase font-bold block mb-1">Bank Address</label>
                  <input
                    type="text"
                    value={newBank.upi} // Map temporary local fields safely
                    onChange={e => setNewBank({ ...newBank, upi: e.target.value })}
                    placeholder="Bank Branch Address"
                    className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs"
                  />
                </div>

                <div>
                  <label className="text-[10px] text-muted uppercase font-bold block mb-1">IBAN Number</label>
                  <input
                    type="text"
                    placeholder="Not provided"
                    className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs"
                  />
                </div>

                <div>
                  <label className="text-[10px] text-muted uppercase font-bold block mb-1">UPI Number (Optional)</label>
                  <input
                    type="text"
                    placeholder="e.g. pay@upi"
                    className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs"
                  />
                </div>

                <div className="pt-2">
                  <p className="text-[10px] text-muted uppercase font-bold mb-1">Opening Balance:</p>
                  <div>
                    <label className="text-[10px] text-muted block mb-1">Amount</label>
                    <input
                      type="number"
                      value={newBank.balance}
                      onChange={e => setNewBank({ ...newBank, balance: e.target.value })}
                      placeholder="Opening balance"
                      className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs"
                    />
                  </div>
                </div>
              </form>
            </div>

            <div className="flex gap-3 mt-8 pt-4 border-t border-border-custom">
              <button
                onClick={handleAddBankAccount}
                className="flex-1 py-2.5 bg-primary text-white font-bold rounded-lg hover:bg-primary/95 text-xs transition-all"
              >
                Save
              </button>
              <button onClick={() => setShowAddBankModal(false)} className="px-4 py-2.5 rounded-lg border border-border-custom text-muted hover:text-foreground hover:border-border-custom text-xs">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Cash Account Modal ── */}
      {showAddCashModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center animate-fade-in p-4" onClick={() => setShowAddCashModal(false)}>
          <div className="bg-card w-full max-w-md border border-border-custom shadow-2xl rounded-xl p-6" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center border-b border-border-custom pb-4 mb-5">
              <div>
                <h3 className="text-sm font-bold text-foreground uppercase tracking-wider">New Cash Account</h3>
                <p className="text-[10px] text-muted mt-0.5">Set the opening cash balance for the company</p>
              </div>
              <button onClick={() => setShowAddCashModal(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>

            <form onSubmit={handleCreateCashAccount} className="space-y-4 text-xs font-sans">
              <div>
                <label className="text-[10px] text-muted uppercase font-bold block mb-1">Account Name</label>
                <input
                  type="text"
                  value={newCash.name}
                  onChange={e => setNewCash({ ...newCash, name: e.target.value })}
                  placeholder="Cash Account"
                  className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs"
                />
              </div>
              <div>
                <label className="text-[10px] text-muted uppercase font-bold block mb-1">Opening Balance (₹)*</label>
                <input
                  type="number"
                  value={newCash.opening}
                  onChange={e => setNewCash({ ...newCash, opening: e.target.value })}
                  required
                  placeholder="e.g. 50000"
                  className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs font-sans"
                />
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  type="submit"
                  className="flex-1 py-2.5 bg-primary text-white font-bold rounded-lg hover:bg-primary/95 text-xs transition-all"
                >
                  Create Cash Account
                </button>
                <button onClick={() => setShowAddCashModal(false)} className="px-4 py-2.5 rounded-lg border border-border-custom text-muted hover:text-foreground hover:border-border-custom text-xs">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Create Payment Request Drawer ── */}
      {showAddRequestModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-end animate-fade-in" onClick={() => setShowAddRequestModal(false)}>
          <div className="bg-card w-full max-w-md h-full border-l border-border-custom shadow-2xl p-6 flex flex-col justify-between overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div>
              <div className="flex justify-between items-center border-b border-border-custom pb-4 mb-5">
                <div>
                  <h3 className="text-sm font-bold text-foreground uppercase tracking-wider">New Payment Request</h3>
                  <p className="text-[10px] text-muted font-sans mt-0.5">Voucher: PR-{paymentRequests.length + 1}</p>
                </div>
                <button onClick={() => setShowAddRequestModal(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
              </div>

              {prStep === "type" ? (
                <div className="space-y-3">
                  <p className="text-[10px] text-muted uppercase font-bold tracking-wider">Select Request Type</p>
                  <div className="grid grid-cols-1 gap-2">
                    {PR_TYPES.map((t) => (
                      <button
                        key={t.key}
                        type="button"
                        onClick={() => { setPrType(t); setNewRequest({ ...newRequest, requestType: t.key }); setPrStep("form"); }}
                        className="flex items-center gap-3 w-full text-left bg-background border border-border-custom hover:border-primary/60 hover:bg-primary/5 rounded-lg px-4 py-3 transition-all"
                      >
                        <Icon name={t.icon} className="w-5 h-5 text-foreground" />
                        <span className="text-xs font-semibold text-foreground">{t.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <form onSubmit={handleCreatePaymentRequest} className="space-y-4 text-xs font-sans">
                  <button type="button" onClick={() => { setPrStep("type"); setPrType(null); }} className="text-[10px] text-primary hover:underline font-bold cursor-pointer inline-flex items-center gap-1"><Icon name="arrow_left" className="w-3 h-3" /> Change type</button>
                  <Badge tone="primary" className="font-bold">{prType?.icon && <Icon name={prType.icon} className="w-3.5 h-3.5 shrink-0" />}{prType?.label}</Badge>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="text-[10px] text-muted uppercase font-bold block mb-1">Request No.*</label>
                      <input
                        type="text"
                        value={`PR-${paymentRequests.length + 1}`}
                        disabled
                        className="w-full bg-background/50 border border-border-custom rounded-lg px-3 py-2 text-muted focus:outline-none text-xs font-sans"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted uppercase font-bold block mb-1">Date*</label>
                      <input
                        type="date"
                        value={todayLocalISO()}
                        disabled
                        className="w-full bg-background/50 border border-border-custom rounded-lg px-3 py-2 text-muted focus:outline-none text-xs"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-[10px] text-muted uppercase font-bold block mb-1">Party Name*</label>
                    <select
                      value={newRequest.partyId}
                      onChange={e => setNewRequest({ ...newRequest, partyId: e.target.value })}
                      required
                      className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs"
                    >
                      <option value="">Search or select party...</option>
                      {usersList.map((u: any) => (
                        <option key={u.id} value={u.id}>{u.name} ({u.role || "—"})</option>
                      ))}
                      {usersList.length === 0 && (
                        <option value="" disabled>No parties registered yet</option>
                      )}
                    </select>
                    {usersList.length === 0 && (
                      <FieldHint text="No parties registered yet." onAction={() => setShowAddPartyModal(true)} actionLabel="Add a party" />
                    )}
                  </div>

                  {prType?.extraLabel && (
                    <div>
                      <label className="text-[10px] text-muted uppercase font-bold block mb-1">{prType.extraLabel}</label>
                      {prType.key === "Advance against Subcon Work Order" ? (
                        <select
                          value={newRequest.extra}
                          onChange={e => setNewRequest({ ...newRequest, extra: e.target.value })}
                          className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs"
                        >
                          <option value="">Select work order...</option>
                          {refWorkOrders.map((w) => (
                            <option key={w.id} value={w.wo_number}>
                              {w.wo_number}{w.subcontractor_name ? ` - ${w.subcontractor_name}` : ""}
                            </option>
                          ))}
                        </select>
                      ) : prType.key === "Advance against PO" ? (
                        <select
                          value={newRequest.extra}
                          onChange={e => setNewRequest({ ...newRequest, extra: e.target.value })}
                          className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs"
                        >
                          <option value="">Select purchase order...</option>
                          {refPOs.map((o) => (
                            <option key={o.id} value={o.po_number}>
                              {o.po_number}{o.vendor_name ? ` - ${o.vendor_name}` : ""}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={newRequest.extra}
                          onChange={e => setNewRequest({ ...newRequest, extra: e.target.value })}
                          placeholder={prType.extraPlaceholder}
                          className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs"
                        />
                      )}
                      {prType.key === "Advance against Subcon Work Order" && refWorkOrders.length === 0 && (
                        <p className="mt-1 text-[10px] text-muted">No work orders on this project yet.</p>
                      )}
                    </div>
                  )}

                  <div>
                    <label className="text-[10px] text-muted uppercase font-bold block mb-1">Requested Amount (₹)*</label>
                    <input
                      type="number"
                      value={newRequest.amount}
                      onChange={e => setNewRequest({ ...newRequest, amount: e.target.value })}
                      required
                      placeholder="e.g. 15000"
                      className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs font-sans"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] text-muted uppercase font-bold block mb-1">Due Date</label>
                    <input
                      type="date"
                      value={newRequest.dueDate}
                      onChange={e => setNewRequest({ ...newRequest, dueDate: e.target.value })}
                      className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] text-muted uppercase font-bold block mb-1">Request Details / Particulars</label>
                    <textarea
                      value={newRequest.details}
                      onChange={e => setNewRequest({ ...newRequest, details: e.target.value })}
                      placeholder="Provide details for this payment request..."
                      rows={3}
                      className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs resize-none"
                    />
                  </div>

                    <div>
                      <label className="text-[10px] text-muted uppercase font-bold block mb-1">Attachments</label>
                    </div>
                </form>
              )}
            </div>

            <div className="flex gap-3 mt-8 pt-4 border-t border-border-custom">
              {prStep === "form" && (
                <button
                  onClick={handleCreatePaymentRequest}
                  className="flex-1 py-2.5 bg-primary text-white font-bold rounded-lg hover:bg-primary/95 text-xs transition-all"
                >
                  Save Request
                </button>
              )}
              <button onClick={() => setShowAddRequestModal(false)} className="px-4 py-2.5 rounded-lg border border-border-custom text-muted hover:text-foreground hover:border-border-custom text-xs">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Payment Request Detail Drawer ── */}
      {selectedPR && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-end animate-fade-in" onClick={() => setSelectedPR(null)}>
          <div className="bg-card w-full max-w-md h-full border-l border-border-custom shadow-2xl p-6 flex flex-col overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-start border-b border-border-custom pb-4 mb-5">
              <div>
                <p className="text-[10px] text-muted font-sans">Voucher: {selectedPR.request_no || "—"}</p>
                <h3 className="text-sm font-bold text-foreground uppercase tracking-wider mt-0.5">{selectedPR.request_type || "—"}</h3>
                <p className="text-xs text-foreground mt-1">{selectedPR.party_name}</p>
              </div>
              <button onClick={() => setSelectedPR(null)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>

            <div className="space-y-4 text-xs font-sans">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="bg-background border border-border-custom rounded-lg p-3">
                  <p className="text-[9px] text-muted uppercase font-bold">Requested Amount</p>
                  <p className="text-foreground font-bold font-sans mt-1">₹{(selectedPR.amount || 0).toLocaleString("en-IN")}</p>
                </div>
                <div className="bg-background border border-border-custom rounded-lg p-3">
                  <p className="text-[9px] text-muted uppercase font-bold">Status</p>
                  <p className="mt-1">
                    <span className={`px-2 py-0.5 rounded text-[8px] font-bold border ${
                      selectedPR.status === "Paid" || selectedPR.status === "Approved"
                        ? "bg-success/10 border-success/20 text-success"
                        : selectedPR.status === "Rejected"
                        ? "bg-danger/10 border-danger/20 text-danger"
                        : "bg-warning/10 border-warning/20 text-warning"
                    }`}>{selectedPR.status.toUpperCase()}</span>
                    <span className="ml-2 text-[8px] text-muted uppercase">Appr: {formatLabel(selectedPR.approval_status)}</span>
                  </p>
                </div>
              </div>

              <div className="bg-background border border-border-custom rounded-lg p-3">
                <p className="text-[9px] text-muted uppercase font-bold mb-1">Particulars</p>
                <p className="text-muted">{selectedPR.details || "—"}</p>
                <p className="text-[9px] text-muted mt-2">Due: {selectedPR.due_date ? formatDate(selectedPR.due_date) : "Immediate"}</p>
              </div>

              {selectedPR.payment && (
                <div className="bg-primary/5 border border-primary/20 rounded-lg p-3">
                  <p className="text-[9px] text-primary uppercase font-bold mb-1">Payment Recorded</p>
                  <p className="text-foreground font-sans">₹{selectedPR.payment.paid_amount.toLocaleString("en-IN")} via {selectedPR.payment.payment_mode} on {formatDate(selectedPR.payment.payment_date)}</p>
                  <p className="text-[9px] text-muted mt-1">Deduction ₹{selectedPR.payment.deduction} · TDS ₹{selectedPR.payment.tds} · Balance Due ₹{selectedPR.payment.balance_due}</p>
                  {selectedPR.payment.reference_no && <p className="text-[9px] text-muted mt-1">Ref: {selectedPR.payment.reference_no}</p>}
                  {selectedPR.payment.remarks && <p className="text-[9px] text-muted mt-1">Remarks: {selectedPR.payment.remarks}</p>}
                </div>
              )}
            </div>

            <div className="mt-auto pt-5 space-y-2">
              <div className="flex gap-2">
                <button
                  onClick={async () => {
                    try {
                      const res = await fetch(`${getApiHost()}/apis/v3/finance/payment-requests/approve/${selectedPR.id}`, {
                        method: "PUT", headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
                        body: JSON.stringify({ status: "Approved" }),
                      });
                      if (res.ok) {
                        const u = await res.json();
                        setSelectedPR(u);
                        setPaymentRequests(paymentRequests.map(p => p.id === u.id ? u : p));
                      } else {
                        const err = await res.json().catch(() => ({}));
                        alert(detailToMessage(err.detail, "Failed to update approval status"));
                      }
                    } catch (e: any) {
                      alert(e?.message || "Network error updating approval status");
                    }
                  }}
                  disabled={selectedPR.status === "Paid"}
                  className="flex-1 py-2.5 bg-primary text-white font-bold rounded-lg hover:bg-primary/95 text-xs transition-all disabled:opacity-40"
                >Request Approval</button>
                <button
                  onClick={async () => {
                    try {
                      const res = await fetch(`${getApiHost()}/apis/v3/finance/payment-requests/approve/${selectedPR.id}`, {
                        method: "PUT", headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
                        body: JSON.stringify({ status: "Paid" }),
                      });
                      if (res.ok) {
                        const u = await res.json();
                        setSelectedPR(u);
                        setPaymentRequests(paymentRequests.map(p => p.id === u.id ? u : p));
                      } else {
                        const err = await res.json().catch(() => ({}));
                        alert(detailToMessage(err.detail, "Failed to mark payment request as paid"));
                      }
                    } catch (e: any) {
                      alert(e?.message || "Network error marking payment request as paid");
                    }
                  }}
                  disabled={selectedPR.status === "Paid"}
                  className="flex-1 py-2.5 bg-success text-white font-bold rounded-lg hover:bg-success text-xs transition-all disabled:opacity-40"
                >Mark as Paid</button>
              </div>
              <button
                onClick={() => { setPrPayment({ date: todayLocalISO(), mode: "Cash", paidAmount: String(selectedPR.amount || ""), deduction: "0", tds: "0", remarks: "", referenceNo: "", attachmentName: "" }); setShowRecordPaymentModal(true); }}
                disabled={selectedPR.status === "Paid"}
                className="w-full py-2.5 bg-elevated text-foreground font-bold rounded-lg hover:bg-elevated text-xs transition-all disabled:opacity-40"
              >Record Payment</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Record Payment Modal ── */}
      {showRecordPaymentModal && selectedPR && (
        <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center animate-fade-in p-4" onClick={() => setShowRecordPaymentModal(false)}>
          <div className="bg-card w-full max-w-md border border-border-custom shadow-2xl rounded-xl p-6 overflow-y-auto max-h-[90vh]" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center border-b border-border-custom pb-4 mb-5">
              <div>
                <h3 className="text-sm font-bold text-foreground uppercase tracking-wider">Record Payment</h3>
                <p className="text-[10px] text-muted font-sans mt-0.5">{selectedPR.request_no} · {selectedPR.party_name}</p>
              </div>
              <button onClick={() => setShowRecordPaymentModal(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>

            <div className="space-y-4 text-xs font-sans">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-muted uppercase font-bold block mb-1">Payment Date*</label>
                  <input type="date" value={prPayment.date}
                    onChange={e => setPrPayment({ ...prPayment, date: e.target.value })}
                    className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs" />
                </div>
                <div>
                  <label className="text-[10px] text-muted uppercase font-bold block mb-1">Payment Mode*</label>
                  <select value={prPayment.mode}
                    onChange={e => setPrPayment({ ...prPayment, mode: e.target.value })}
                    className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs">
                    <option value="Cash">Cash</option>
                    <option value="Bank">Bank</option>
                    <option value="UPI">UPI</option>
                    <option value="Cheque">Cheque</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-muted uppercase font-bold block mb-1">Paid Amount (₹)*</label>
                  <input type="number" value={prPayment.paidAmount}
                    onChange={e => setPrPayment({ ...prPayment, paidAmount: e.target.value })}
                    className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs font-sans" />
                </div>
                <div>
                  <label className="text-[10px] text-muted uppercase font-bold block mb-1">Deduction (₹)</label>
                  <input type="number" value={prPayment.deduction}
                    onChange={e => setPrPayment({ ...prPayment, deduction: e.target.value })}
                    className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs font-sans" />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-muted uppercase font-bold block mb-1">TDS (₹)</label>
                  <input type="number" value={prPayment.tds}
                    onChange={e => setPrPayment({ ...prPayment, tds: e.target.value })}
                    className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs font-sans" />
                </div>
                <div>
                  <label className="text-[10px] text-muted uppercase font-bold block mb-1">Balance Due (₹)</label>
                  <input type="text" readOnly
                    value={Math.max(0, (selectedPR.amount || 0) - (parseFloat(prPayment.paidAmount) || 0) - (parseFloat(prPayment.deduction) || 0) - (parseFloat(prPayment.tds) || 0)).toLocaleString("en-IN")}
                    className="w-full bg-background/50 border border-border-custom rounded-lg px-3 py-2 text-muted focus:outline-none text-xs font-sans" />
                </div>
              </div>

              <div>
                <label className="text-[10px] text-muted uppercase font-bold block mb-1">Reference No.</label>
                <input type="text" value={prPayment.referenceNo}
                  onChange={e => setPrPayment({ ...prPayment, referenceNo: e.target.value })}
                  placeholder="e.g. TXN-1234 / Cheque no."
                  className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs" />
              </div>

              <div>
                <label className="text-[10px] text-muted uppercase font-bold block mb-1">Remarks</label>
                <textarea value={prPayment.remarks}
                  onChange={e => setPrPayment({ ...prPayment, remarks: e.target.value })}
                  rows={2} placeholder="Optional remarks..."
                  className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs resize-none" />
              </div>

              <div>
                <label className="text-[10px] text-muted uppercase font-bold block mb-1">Reference / document name</label>
                <input type="text" value={prPayment.attachmentName} onChange={e => setPrPayment({ ...prPayment, attachmentName: e.target.value })} placeholder="e.g. Receipt-2026-04"
                  className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs" />
                <p className="text-[9px] text-muted mt-1">File attachment is not available yet. Object storage is required and has not been configured.</p>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  onClick={async () => {
                    try {
                      const res = await fetch(`${getApiHost()}/apis/v3/finance/payment-requests/pay/${selectedPR.id}`, {
                        method: "POST", headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
                        body: JSON.stringify({
                          payment_date: prPayment.date ? new Date(prPayment.date).toISOString() : new Date().toISOString(),
                          payment_mode: prPayment.mode,
                          paid_amount: parseFloat(prPayment.paidAmount) || 0,
                          deduction: parseFloat(prPayment.deduction) || 0,
                          tds: parseFloat(prPayment.tds) || 0,
                          remarks: prPayment.remarks,
                          reference_no: prPayment.referenceNo,
                          attachment_name: prPayment.attachmentName,
                        }),
                      });
                      if (res.ok) {
                        const u = await res.json();
                        setSelectedPR(u);
                        setPaymentRequests(paymentRequests.map(p => p.id === u.id ? u : p));
                        setShowRecordPaymentModal(false);
                      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
                    } catch (err) { console.error(err); }
                  }}
                  className="flex-1 py-2.5 bg-primary text-white font-bold rounded-lg hover:bg-primary/95 text-xs transition-all"
                >Save Payment</button>
                <button onClick={() => setShowRecordPaymentModal(false)} className="px-4 py-2.5 rounded-lg border border-border-custom text-muted hover:text-foreground hover:border-border-custom text-xs">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Tally Setup Modal ── */}
      {showTallySetup && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setShowTallySetup(false)}>
          <div className="w-full max-w-md bg-card border border-border-custom rounded-xl p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-foreground">Tally Prime Connection</h3>
            <form onSubmit={saveTallyConnection} className="space-y-3">
              <div>
                <label className="text-[10px] text-muted uppercase font-bold block mb-1">Tally company name*</label>
                <input value={tallyCompany} onChange={(e) => setTallyCompany(e.target.value)} required className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs" />
              </div>
              <div>
                <label className="text-[10px] text-muted uppercase font-bold block mb-1">Registered mobile*</label>
                <input value={tallyMobile} onChange={(e) => setTallyMobile(e.target.value)} required className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs" />
              </div>
              <div>
                <label className="text-[10px] text-muted uppercase font-bold block mb-1">Voucher number template</label>
                <input value={tallyVoucherTemplate} onChange={(e) => setTallyVoucherTemplate(e.target.value)} className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs" />
              </div>
              <div>
                <label className="text-[10px] text-muted uppercase font-bold block mb-1">Default cash ledger</label>
                <input value={tallyDefaultCash} onChange={(e) => setTallyDefaultCash(e.target.value)} placeholder="e.g. Cash Account" className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs" />
              </div>
              <div>
                <label className="text-[10px] text-muted uppercase font-bold block mb-1">Round-off ledger (optional)</label>
                <input value={tallyRoundOff} onChange={(e) => setTallyRoundOff(e.target.value)} placeholder="e.g. Round Off / Fractional Diff" className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs" />
              </div>
              <div>
                <label className="text-[10px] text-muted uppercase font-bold block mb-1">Sync from date</label>
                <input type="date" value={tallySyncFrom} onChange={(e) => setTallySyncFrom(e.target.value)} className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs font-sans" />
                <p className="text-[10px] text-muted mt-1">Bills and payments on or after this date are included in the Tally export. Defaults to the start of the current financial year.</p>
              </div>
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input type="checkbox" checked={tallyAutoCreate} onChange={(e) => setTallyAutoCreate(e.target.checked)} />
                Auto-create missing ledgers on import
              </label>
              <div className="flex gap-3 pt-2">
                <button type="submit" disabled={tallySaving} className="flex-1 py-2.5 bg-primary text-white font-bold rounded-lg hover:bg-primary/95 text-xs transition-all disabled:opacity-50">
                  {tallySaving ? "Saving…" : "Save Connection"}
                </button>
                <button type="button" onClick={() => setShowTallySetup(false)} className="px-4 py-2.5 rounded-lg border border-border-custom text-muted hover:text-foreground text-xs">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}