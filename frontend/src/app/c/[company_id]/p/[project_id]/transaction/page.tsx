"use client";
import Badge, { type BadgeTone } from "@/components/ui/Badge";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { getApi, authHeaders, fmtINR, formatLabel, todayLocalISO, formatDate } from "@/lib/siteflow";
import { readErrorDetail } from "@/lib/api";
import { useCompanySettings } from "@/context/CompanySettingsContext";
import ZatcaInvoicePanel from "@/components/ZatcaInvoicePanel";
import { CustomFieldsSection, useCustomFields } from "@/components/CustomFieldsSection";
import { UNITS } from "@/lib/units";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import Icon from "@/components/marketing/Icon";
import FieldHint from "@/components/ui/FieldHint";

// ── Transaction taxonomy (exact list from build spec) ────────────────────────
type Endpoint = "bill" | "debit" | "credit" | "request";
type TxnType = {
  key: string;
  label: string;
  endpoint: Endpoint;
  direction: "in" | "out";
  paymentMode?: boolean; // Payment In / Payment Out → Cash/Bank/Cheque conditional fields
};

const INVOICE_TYPES_IN = ["payment_in", "sales_invoice", "material_sales", "i_received", "sale", "material_sale"];

const REVENUE_TYPES = ["sale", "material_sale"];
const EXPENSE_TYPES = ["purchase", "subcon", "expense", "equipment"];
const SETTLEMENT_TYPES = ["payment_in", "payment_out", "i_paid", "i_received"];

const TAXONOMY: TxnType[] = [
  { key: "payment_in", label: "Payment In", endpoint: "bill", direction: "in", paymentMode: true },
  { key: "payment_out", label: "Payment Out", endpoint: "bill", direction: "out", paymentMode: true },
  { key: "debit_note", label: "Debit Note", endpoint: "debit", direction: "out" },
  { key: "credit_note", label: "Credit Note", endpoint: "credit", direction: "in" },
  { key: "party_to_party_payment", label: "Party-to-Party Payment", endpoint: "request", direction: "out" },
  { key: "sales_invoice", label: "Sales Invoice", endpoint: "bill", direction: "in" },
  { key: "material_sales", label: "Material Sales", endpoint: "bill", direction: "in" },
  { key: "material_purchase", label: "Material Purchase", endpoint: "bill", direction: "out" },
  { key: "material_return", label: "Material Return", endpoint: "credit", direction: "in" },
  { key: "material_transfer", label: "Material Transfer", endpoint: "bill", direction: "out" },
  { key: "other_expense", label: "Other Expense", endpoint: "bill", direction: "out" },
  { key: "equipment_expense", label: "Equipment Expense", endpoint: "bill", direction: "out" },
  { key: "i_paid", label: "I Paid", endpoint: "bill", direction: "out" },
  { key: "i_received", label: "I Received", endpoint: "bill", direction: "in" },
  { key: "payment_request", label: "Payment Request", endpoint: "request", direction: "out" },
];

const isInType = (t: string) => INVOICE_TYPES_IN.includes(t);

// Taxonomy key -> the invoice_type the backend stores. The filter tabs are
// taxonomy keys, so comparing them to stored types directly matched nothing for
// Sales Invoice, Material Sales, Material Purchase, Other Expense and Equipment.
const CANONICAL_TYPE: Record<string, string> = {
  sales_invoice: "sale",
  material_sales: "material_sale",
  material_purchase: "purchase",
  other_expense: "expense",
  equipment_expense: "equipment",
};
const canonicalType = (key: string) => CANONICAL_TYPE[key] || key;

// Stored type -> what the Type column shows.
const TYPE_LABEL: Record<string, string> = {
  ...Object.fromEntries(TAXONOMY.map((t) => [canonicalType(t.key), t.label])),
  subcon: "Subcontractor Bill",
};
const typeLabel = (t: string) => TYPE_LABEL[t] || t.replace(/_/g, " ");

// ── Backend shapes ───────────────────────────────────────────────────────────
type Bill = {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  invoice_type: string;
  status: string;
  party_company_user_id: string;
  subtotal: number;
  gst_amount: number;
  total_payable: number;
  paid_amount: number;
  approval_flag: string;
  deductions: { deduction_type: string; amount: number }[];
};
type Note = {
  id: string;
  party_company_user_id: string;
  notes: string | null;
  total_amount: number;
  reference_number: string | null;
  created_at: string;
};
type PRequest = {
  id: string;
  project_id?: string | null;
  party_company_user_id: string;
  party_name?: string | null;
  amount: number;
  details: string | null;
  status: string;
  due_date: string | null;
  approval_status: string;
  request_type: string;
  created_at: string;
};
type Member = { company_team_id: string; user_id: string | null; name: string; role: string | null };
type CostCode = { id: string; code: string; name: string };
type FinanceTxnRow = {
  id: string;
  date: string;
  type: string;
  party: string;
  status: string;
  ref: string;
  amount: number;
  project_id: string | null;
};

type LedgerRow = {
  id: string;
  date: string;
  type: string;
  party: string;
  amount: number;
  direction: "in" | "out";
  kind: string;
  ref: string;
  status: string;
};

function Card({ label, value, tone }: { label: string; value: string; tone?: "emerald" | "rose" | "violet" }) {
  const color = tone === "emerald" ? "text-success" : tone === "rose" ? "text-danger" : tone === "violet" ? "text-chart-4" : "text-foreground";
  return (
    <div className="rounded-lg border border-border-custom bg-card p-4">
      <div className="text-xs uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-2 text-2xl font-bold ${color}`}>{value}</div>
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 overflow-y-auto">
      <div className="my-8 w-full max-w-2xl rounded-lg border border-border-custom bg-card p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-foreground">{title}</h3>
          <button onClick={onClose} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Lbl({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 text-xs font-medium text-muted">{children}</div>;
}

export default function TransactionPage() {
  const { currencyDecimalPlaces } = useCompanySettings();
  const params = useParams();
  const companyId = params.company_id as string;
  const projectId = params.project_id as string;

  const [bills, setBills] = useState<Bill[]>([]);
  const [debits, setDebits] = useState<Note[]>([]);
  const [credits, setCredits] = useState<Note[]>([]);
  const [requests, setRequests] = useState<PRequest[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [costCodes, setCostCodes] = useState<CostCode[]>([]);
  const [paymentTotals, setPaymentTotals] = useState<{ received: number; paid: number } | null>(null);
  const [feedRows, setFeedRows] = useState<FinanceTxnRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [zatcaBillId, setZatcaBillId] = useState<string | null>(null);
  const [zatcaEnabled, setZatcaEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cid = companyId;
      const [bRes, dRes, cRes, rRes, mRes, ccRes, sRes, tRes] = await Promise.all([
        fetch(getApi(`/billing/bills?project_id=${projectId}`), { headers: authHeaders() }),
        fetch(getApi(`/billing/debit-notes?project_id=${projectId}`), { headers: authHeaders() }),
        fetch(getApi(`/billing/credit-notes?project_id=${projectId}`), { headers: authHeaders() }),
        fetch(getApi(`/finance/payment-requests/${cid}`), { headers: authHeaders() }),
        fetch(getApi(`/projects/${projectId}/members`), { headers: authHeaders() }),
        fetch(getApi(`/library/cost-codes/${cid}`), { headers: authHeaders() }),
        fetch(getApi(`/settings/company/${cid}`), { headers: authHeaders() }),
        fetch(getApi(`/finance/transactions/${cid}`), { headers: authHeaders() }),
      ]);
      if (bRes.ok) setBills(await bRes.json());
      if (dRes.ok) setDebits(await dRes.json());
      if (cRes.ok) setCredits(await cRes.json());
      // The payment-request feed is company-wide; keep this project's only.
      if (rRes.ok) setRequests(((await rRes.json()) as PRequest[]).filter((r) => r.project_id === projectId));
      if (mRes.ok) setMembers(await mRes.json());
      if (ccRes.ok) setCostCodes(await ccRes.json());
      if (sRes.ok) setZatcaEnabled(Boolean((await sRes.json()).is_zatca_enable));
      // R2-173: money actually moved lives in the Payment table, which
      // /billing/bills never returns, so a project with large receipts and no
      // settlement-type bill showed a structural ₹0 Total In. Pull the company
      // transaction feed and keep only this project's recorded payments so the
      // cash tiles match what the server reports elsewhere. The feed's rows
      // carry project_id; its aggregates are company-wide so they are not used.
      if (tRes.ok) {
        const body = await tRes.json();
        const rows: FinanceTxnRow[] = Array.isArray(body?.transactions) ? body.transactions : [];
        let received = 0;
        let paid = 0;
        const mine = rows.filter((r) => r.project_id === projectId);
        setFeedRows(mine);
        for (const r of mine) {
          const amt = Number(r.amount) || 0;
          if (r.type === "Payment In") received += amt;
          else if (r.type === "Payment Out") paid += amt;
        }
        setPaymentTotals({ received, paid });
      } else {
        setPaymentTotals(null);
      }
    } catch (e) {
      setError("Failed to load transactions.");
      setPaymentTotals(null);
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [companyId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const memberName = useCallback(
    (id: string | undefined) => members.find((m) => m.company_team_id === id || m.user_id === id)?.name || "—",
    [members]
  );
  // A subcontractor billed through a work order is not a project member, so
  // fall back to the party name the finance feed resolved for that bill.
  const feedPartyById = useMemo(() => new Map(feedRows.map((r) => [r.id, r.party])), [feedRows]);
  const billParty = useCallback(
    (b: Bill) => {
      const n = memberName(b.party_company_user_id);
      return n !== "—" ? n : feedPartyById.get(b.id) || "—";
    },
    [memberName, feedPartyById]
  );

  // ── Summary cards: cash heads = settlement vouchers + recorded payments ────
  // R2-490: one classification for every canonical invoice_type, mirroring
  // backend/app/constants.py, with a single declared basis per head. In/Out are
  // cash movements (settlement vouchers plus the Payment records folded in
  // below); D1 R2-021: margin legs are ex-GST subtotals per founder decision,
  // so they reflect true revenue vs cost without pass-through GST. material_transfer
  // / material_return move stock, not money, so they belong to no money head by design.
  const { totalIn, totalOut, sales, expense, balance, margin } = useMemo(() => {
    let totalIn = 0, totalOut = 0, sales = 0, expense = 0;
    for (const b of bills) {
      const t = b.invoice_type;

      if (SETTLEMENT_TYPES.includes(t)) {
        const amt = Number(b.total_payable) || 0;
        if (t === "payment_in" || t === "i_received") {
          totalIn += amt;
        } else {
          totalOut += amt;
        }
        continue;
      }
      // D1: margin on ex-GST subtotals, not GST-inclusive total_payable
      const exGst = Number(b.subtotal) || 0;
      if (REVENUE_TYPES.includes(t)) {
        sales += exGst;
      } else if (EXPENSE_TYPES.includes(t)) {
        expense += exGst;
      }
    }
    // R2-173: fold in the recorded payments fetched above. null means the
    // finance feed failed; the tiles then stay voucher-only and a warning is
    // shown instead of presenting an understated total as complete.
    if (paymentTotals) {
      totalIn += paymentTotals.received;
      totalOut += paymentTotals.paid;
    }
    return {
      totalIn,
      totalOut,
      sales,
      expense,
      balance: totalIn - totalOut,
      margin: sales - expense,
    };
  }, [bills, paymentTotals]);

  // ── Unified ledger ─────────────────────────────────────────────────────────
  const ledger: LedgerRow[] = useMemo(() => {
    const rows: LedgerRow[] = [];
    for (const b of bills)
      rows.push({
        id: b.id,
        date: b.invoice_date,
        type: b.invoice_type,
        party: billParty(b),
        amount: Number(b.total_payable) || 0,
        direction: isInType(b.invoice_type) ? "in" : "out",
        kind: "Bill",
        ref: b.invoice_number,
        status: b.status,
      });
    for (const n of debits)
      rows.push({ id: n.id, date: n.created_at, type: "debit_note", party: memberName(n.party_company_user_id), amount: Number(n.total_amount) || 0, direction: "out", kind: "Debit Note", ref: n.reference_number || "—", status: "—" });
    for (const n of credits)
      rows.push({ id: n.id, date: n.created_at, type: "credit_note", party: memberName(n.party_company_user_id), amount: Number(n.total_amount) || 0, direction: "in", kind: "Credit Note", ref: n.reference_number || "—", status: "—" });
    for (const r of requests)
      rows.push({ id: r.id, date: r.created_at, type: TAXONOMY.some((t) => t.key === r.request_type) ? r.request_type : "payment_request", party: r.party_name || memberName(r.party_company_user_id), amount: Number(r.amount) || 0, direction: "out", kind: "Payment Request", ref: "—", status: r.approval_status });
    // Recorded payments: they fed the cash tiles but were never listed.
    for (const r of feedRows) {
      if (r.type !== "Payment In" && r.type !== "Payment Out") continue;
      const inbound = r.type === "Payment In";
      rows.push({ id: r.id, date: r.date, type: inbound ? "payment_in" : "payment_out", party: r.party || "—", amount: Number(r.amount) || 0, direction: inbound ? "in" : "out", kind: "Payment", ref: r.ref || "—", status: r.status });
    }
    return rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [bills, debits, credits, requests, memberName, billParty, feedRows]);

  const filtered = ledger.filter((r) => {
    if (typeFilter !== "All" && r.type !== canonicalType(typeFilter)) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!r.party.toLowerCase().includes(q) && !r.ref.toLowerCase().includes(q) && !r.type.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const handleCancelTransaction = async (r: { kind: string; id: string; type: string }) => {
    if (!confirm(`Are you sure you want to cancel this ${r.kind}?`)) return;
    try {
      let url = "";
      if (r.kind === "Debit Note") {
        url = getApi(`/billing/debit-notes/${r.id}/cancel`);
      } else if (r.kind === "Credit Note") {
        url = getApi(`/billing/credit-notes/${r.id}/cancel`);
      } else if (r.kind === "Bill") {
        url = getApi(`/billing/bills/${r.id}/cancel`);
      } else {
        return;
      }
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      });
      if (res.ok) {
        load();
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Action failed");
      }
    } catch (e) {
      console.error(e);
      alert("Action failed");
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title="Project Transactions"
        subtitle="Balance, margin & the full transaction taxonomy for this project."
      >
        <button
          onClick={() => setAddOpen(true)}
          className="rounded-md bg-primary px-3.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 cursor-pointer"
        >
          + Add Transaction
        </button>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">

      {/* Summary cards */}
      {/* R2-490: the In/Out tiles are labelled as cash deliberately - they count
          settlement vouchers and recorded payments, not every accrual row the
          ledger below shows, and the label must not claim otherwise. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card label="Total In (Cash Received)" value={fmtINR(totalIn, currencyDecimalPlaces)} tone="emerald" />
        <Card label="Total Out (Cash Paid)" value={fmtINR(totalOut, currencyDecimalPlaces)} tone="rose" />
        <Card label="Project Balance (In − Out)" value={fmtINR(balance, currencyDecimalPlaces)} tone={balance >= 0 ? "emerald" : "rose"} />
        <Card label="Margin (Sales − Expense, ex-GST)" value={fmtINR(margin, currencyDecimalPlaces)} tone="violet" />
      </div>

      {/* R2-173: never present voucher-only cash tiles as if they were complete */}
      {!loading && !paymentTotals && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
          Recorded payments could not be loaded, so Total In / Total Out cover settlement vouchers only and may understate actual cash moved.
        </div>
      )}

      {error && <div className="rounded-md border border-danger/40 bg-danger/10 px-4 py-2 text-sm text-danger">{error}</div>}

      {/* Taxonomy filter + search */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setTypeFilter("All")}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold border transition-all cursor-pointer ${typeFilter === "All" ? "bg-elevated text-foreground border-border-custom" : "border-border-custom bg-card text-muted hover:bg-elevated/40 hover:text-foreground"}`}
        >
          All
        </button>
        {TAXONOMY.map((t) => (
          <button
            key={t.key}
            onClick={() => setTypeFilter(t.key)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold border transition-all cursor-pointer ${typeFilter === t.key ? "bg-elevated text-foreground border-border-custom" : "border-border-custom bg-card text-muted hover:bg-elevated/40 hover:text-foreground"}`}
          >
            {t.label}
          </button>
        ))}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search party / ref / type"
          className="ml-auto min-w-[200px] flex-1 rounded-md border border-border-custom bg-card px-3 py-2 text-sm text-foreground"
        />
      </div>

      {/* Ledger table */}
      <div className="rounded-lg border border-border-custom overflow-hidden bg-card">
        <table className="w-full text-sm">
          <thead className="bg-elevated text-muted">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Date</th>
              <th className="text-left px-4 py-3 font-medium">Type</th>
              <th className="text-left px-4 py-3 font-medium">Party</th>
              <th className="text-left px-4 py-3 font-medium">Ref</th>
              <th className="text-right px-4 py-3 font-medium">Amount</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              {zatcaEnabled && <th className="text-left px-4 py-3 font-medium">ZATCA</th>}
              <th className="text-center px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={zatcaEnabled ? 8 : 7} className="p-4">
                  <TableSkeleton rows={5} cols={7} />
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={zatcaEnabled ? 8 : 7} className="p-8">
                  <EmptyState
                    title="No transactions found"
                    description="No transactions match this filter. Add a transaction to track project ledger activity."
                    action={{ label: "+ Add Transaction", onClick: () => setAddOpen(true) }}
                  />
                </td>
              </tr>
            )}
            {!loading && filtered.map((r) => (
              <tr key={`${r.kind}-${r.id}`} className="border-t border-border-custom hover:bg-elevated/50">
                <td className="px-4 py-3 text-muted whitespace-nowrap">{r.date ? formatDate(r.date) : "—"}</td>
                <td className="px-4 py-3">
                  <Badge tone="primary">{typeLabel(r.type)}</Badge>
                </td>
                <td className="px-4 py-3 text-foreground">{r.party}</td>
                <td className="px-4 py-3 text-muted">{r.ref}</td>
                <td className={`px-4 py-3 text-right font-medium ${r.direction === "in" ? "text-success" : "text-danger"}`}>
                  {r.direction === "in" ? "+" : "−"}
                  {fmtINR(r.amount, currencyDecimalPlaces)}
                </td>
                <td className="px-4 py-3 text-muted">{formatLabel(r.status)}</td>
                {zatcaEnabled && (
                  <td className="px-4 py-3">
                    {r.kind === "Bill" && r.type === "sale" ? (
                      <button
                        type="button"
                        onClick={() => setZatcaBillId(r.id)}
                        className="rounded-md border border-border-custom px-2 py-1 text-xs text-muted hover:border-primary hover:text-foreground"
                      >
                        ZATCA
                      </button>
                    ) : null}
                  </td>
                )}
                <td className="px-4 py-3 text-center">
                  {r.status !== "Cancelled" && r.status !== "cancelled" && ["Debit Note", "Credit Note", "Bill"].includes(r.kind) && (
                    <button
                      type="button"
                      onClick={() => handleCancelTransaction(r)}
                      className="rounded border border-danger/30 bg-danger/10 px-2 py-0.5 text-xs font-bold text-danger hover:bg-danger/20 cursor-pointer"
                      title={`Cancel ${r.kind}`}
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {addOpen && (
        <NewTransactionModal
          companyId={companyId}
          projectId={projectId}
          members={members}
          costCodes={costCodes}
          bills={bills}
          onClose={() => setAddOpen(false)}
          onCreated={() => { setAddOpen(false); load(); }}
        />
      )}

      {zatcaBillId && (
        <Modal title="ZATCA E-Invoice" onClose={() => setZatcaBillId(null)}>
          <ZatcaInvoicePanel
            billId={zatcaBillId}
            companyId={companyId}
            onClose={() => setZatcaBillId(null)}
          />
        </Modal>
      )}
      </PageShell>
      </div>
    </div>
  );
}

// ── New Transaction modal (full taxonomy + shared sub-entities) ──────────────
function NewTransactionModal({
  companyId, projectId, members, costCodes, bills = [], onClose, onCreated,
}: {
  companyId: string;
  projectId: string;
  members: Member[];
  costCodes: CostCode[];
  bills?: Bill[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { currencyDecimalPlaces } = useCompanySettings();
  const [typeKey, setTypeKey] = useState<string>(TAXONOMY[0].key);
  const cfg = TAXONOMY.find((t) => t.key === typeKey)!;
  const isSalesInvoice = cfg.key === "sales_invoice";
  // R2-211: settlement types are cash movements, not taxable supplies — the
  // GST field is hidden and gst_pct forced to 0 for them.
  const isSettlement = cfg.endpoint === "bill" && SETTLEMENT_TYPES.includes(cfg.key);

  // R2-763: dynamically label the auxiliary text input so a payment request's
  // purpose is labelled Details and debit/credit notes are labelled Notes,
  // instead of misleadingly labelling all branches as Ship To addressing.
  const addressingLabel =
    cfg.endpoint === "bill"
      ? "Ship To (addressing)"
      : cfg.endpoint === "debit"
      ? "Notes (Debit Note remarks)"
      : cfg.endpoint === "credit"
      ? "Notes (Credit Note remarks)"
      : "Details / Purpose";

  const addressingPlaceholder =
    cfg.endpoint === "bill"
      ? "Optional ship-to address"
      : cfg.endpoint === "debit"
      ? "Optional notes / reason for debit note"
      : cfg.endpoint === "credit"
      ? "Optional notes / reason for credit note"
      : "Purpose of payment request / details";

  // Custom Fields (Settings → Custom Fields, entity_type="invoice") — only surfaced
  // for the Sales Invoice transaction type, which is the entity this framework is wired to.
  const customFields = useCustomFields(companyId, "invoice");

  const [partyId, setPartyId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [date, setDate] = useState(todayLocalISO());
  const [dueDate, setDueDate] = useState("");
  const [gstPct, setGstPct] = useState("18");
  const [preTax, setPreTax] = useState(false);
  const [shipTo, setShipTo] = useState("");

  // Debit / Credit note fields
  const [billId, setBillId] = useState("");
  const [debitWorkAmount, setDebitWorkAmount] = useState("");
  const [debitGstAmount, setDebitGstAmount] = useState("");
  const [creditAmount, setCreditAmount] = useState("");

  // Add Item rows (subtotal calculator; cost code from library)
  // R2-747: HSN/SAC is mandatory per line on a tax invoice (Rule 46, CGST
  // Rules) and the backend now rejects a revenue invoice without it, so the
  // editor has to be able to supply it rather than leaving the user blocked.
  const [items, setItems] = useState<{ desc: string; hsn: string; costCodeId: string; unit: string; qty: string; rate: string }[]>([]);
  // Deduction rows
  const [deductions, setDeductions] = useState<{ type: string; mode: "amount" | "percent"; value: string; notes: string }[]>([]);
  const [retentionPct, setRetentionPct] = useState("");

  // Payment mode (Cash / Bank / Cheque) for Payment In / Out
  const [payMode, setPayMode] = useState<"Cash" | "Bank" | "Cheque">("Cash");
  const [bankName, setBankName] = useState("");
  const [txnRef, setTxnRef] = useState("");
  const [chequeNo, setChequeNo] = useState("");

  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // BOQ linkage (for Billed Value on the BOQ tab)
  const [boqDocId, setBoqDocId] = useState("");
  const [boqDocs, setBoqDocs] = useState<{ id: string; title: string; client_name: string | null }[]>([]);
  useEffect(() => {
    let alive = true;
    fetch(getApi(`/budgeting/boq-documents?project_id=${projectId}`), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => { if (alive) setBoqDocs(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, [projectId]);

  const subtotal = useMemo(
    () => items.reduce((s, it) => s + (parseFloat(it.qty) || 0) * (parseFloat(it.rate) || 0), 0),
    [items]
  );

  const addItem = () => setItems((s) => [...s, { desc: "", hsn: "", costCodeId: "", unit: "", qty: "", rate: "" }]);
  const addDeduction = () => setDeductions((s) => [...s, { type: "TDS", mode: "percent", value: "", notes: "" }]);

  const selectedMember = members.find((m) => m.company_team_id === partyId || m.user_id === partyId);

  const submit = async () => {
    setErr(null);
    if (!partyId) { setErr("Select a party."); return; }
    if (!invoiceNumber && cfg.endpoint === "bill") { setErr("Invoice / reference number is required."); return; }
    if (subtotal <= 0 && cfg.endpoint === "bill") { setErr("Add at least one line item with qty × rate > 0."); return; }
    if (isSalesInvoice) {
      const cfError = customFields.validate();
      if (cfError) { setErr(cfError); return; }
    }

    setSaving(true);
    try {
      const cid = companyId;
      const member = members.find((m) => m.company_team_id === partyId || m.user_id === partyId);
      if (!member) throw new Error("Party not found");
      const dt = `${date}T00:00:00`;
      const due = dueDate ? `${dueDate}T00:00:00` : null;

      const itemsJson = JSON.stringify(
        items.map((it) => {
          const cc = costCodes.find((c) => c.id === it.costCodeId);
          return {
            desc: it.desc,
            // R2-747: carried into the invoice so the HSN/SAC column is not
            // structurally blank.
            hsn_sac: it.hsn || "",
            cost_code_id: it.costCodeId || null,
            cost_code_name: cc ? `${cc.code} · ${cc.name}` : null,
            unit: it.unit || null,
            qty: parseFloat(it.qty) || 0,
            rate: parseFloat(it.rate) || 0,
            amount: (parseFloat(it.qty) || 0) * (parseFloat(it.rate) || 0),
          };
        })
      );

      const dedPayload = deductions
        .filter((d) => d.value)
        .map((d) => ({
          deduction_type: d.type,
          amount: d.mode === "amount" ? parseFloat(d.value) : 0,
          percentage: d.mode === "percent" ? parseFloat(d.value) : null,
          notes: d.notes || null,
        }));
      if (retentionPct) {
        const rp = parseFloat(retentionPct);
        if (!isNaN(rp) && rp > 0) dedPayload.push({ deduction_type: "Retention", amount: 0, percentage: rp, notes: "Auto retention" });
      }

      let res: Response;
      if (cfg.endpoint === "bill") {
        const canonicalType = {
          sales_invoice: "sale",
          material_sales: "material_sale",
          material_purchase: "purchase",
          other_expense: "expense",
          equipment_expense: "equipment",
          payment_in: "payment_in",
          payment_out: "payment_out",
          i_paid: "i_paid",
          i_received: "i_received",
          material_transfer: "material_transfer",
          material_return: "material_return",
        }[cfg.key] || cfg.key;

        res = await fetch(getApi(`/billing/bills`), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
          body: JSON.stringify({
            company_id: cid,
            project_id: projectId,
            party_company_user_id: member.company_team_id,
            invoice_number: invoiceNumber,
            invoice_date: dt,
            due_date: due,
            invoice_type: canonicalType,
            subtotal: subtotal,
            gst_pct: isSettlement ? 0 : parseFloat(gstPct) || 0,
            deductions: dedPayload,
            pre_tax_deductions: preTax,
            items_json: itemsJson,
            payment_mode: cfg.paymentMode ? payMode : null,
            payment_bank_name: cfg.paymentMode && payMode !== "Cash" ? bankName || null : null,
            payment_ref: cfg.paymentMode
              ? payMode === "Cheque"
                ? chequeNo || null
                : payMode === "Bank"
                ? txnRef || null
                : null
              : null,
            ship_to: shipTo || null,
            boq_document_id: boqDocId || null,
            custom_fields: isSalesInvoice ? customFields.toPayload() : [],
          }),
        });
      } else if (cfg.endpoint === "debit") {
        const wAmt = parseFloat(debitWorkAmount) || 0;
        const gAmt = parseFloat(debitGstAmount) || 0;
        const tAmt = wAmt + gAmt;
        if (tAmt <= 0) { setErr("Please specify a valid work amount or GST amount for debit note."); setSaving(false); return; }
        res = await fetch(getApi(`/billing/debit-notes`), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
          body: JSON.stringify({
            project_id: projectId,
            company_id: cid,
            party_company_user_id: member.company_team_id,
            notes: shipTo || null,
            work_amount: wAmt,
            gst_amount: gAmt,
            total_amount: tAmt,
            bill_id: billId || null,
            reference_number: invoiceNumber || null,
          }),
        });
      } else if (cfg.endpoint === "credit") {
        const tAmt = parseFloat(creditAmount) || subtotal || 0;
        if (tAmt <= 0) { setErr("Please specify a valid credit note amount."); setSaving(false); return; }
        res = await fetch(getApi(`/billing/credit-notes`), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
          body: JSON.stringify({
            project_id: projectId,
            company_id: cid,
            party_company_user_id: member.company_team_id,
            notes: shipTo || null,
            total_amount: tAmt,
            bill_id: billId || null,
            reference_number: invoiceNumber || null,
          }),
        });
      } else {
        res = await fetch(getApi(`/finance/payment-requests/${cid}`), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
          body: JSON.stringify({
            project_id: projectId,
            party_company_user_id: member.user_id,
            amount: subtotal,
            details: shipTo || null,
            due_date: due,
            request_type: cfg.key,
            approval_status: "Pending",
          }),
        });
      }

      if (res.ok) onCreated();
      else {
        const body = await res.text();
        setErr(`Save failed (${res.status}): ${body.slice(0, 200)}`);
      }
    } catch (e: any) {
      setErr(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`Add ${cfg.label}`} onClose={onClose}>
      {/* Type selector */}
      <Lbl>Transaction Type</Lbl>
      <select
        value={typeKey}
        onChange={(e) => setTypeKey(e.target.value)}
        className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground mb-3"
      >
        {TAXONOMY.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
      </select>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="col-span-2">
          <Lbl>Party (Bill To)</Lbl>
          <select value={partyId} onChange={(e) => setPartyId(e.target.value)} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground">
            <option value="">Select party</option>
            {members.map((m) => (
              <option key={m.company_team_id} value={m.company_team_id}>{m.name}{m.role ? ` (${m.role})` : ""}</option>
            ))}
          </select>
          {members.length === 0 && (
            <FieldHint text="No parties available. Invite members in Settings." href={`/c/${companyId}/settings`} linkLabel="Go to Settings" />
          )}
        </div>

        {(cfg.endpoint === "debit" || cfg.endpoint === "credit") && (
          <div className="col-span-2">
            <Lbl>Link to Invoice / Bill (Optional)</Lbl>
            <select
              value={billId}
              onChange={(e) => setBillId(e.target.value)}
              className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="">No invoice link (Standalone Note)</option>
              {bills
                .filter((b) => b.party_company_user_id === selectedMember?.company_team_id && b.status !== "Cancelled" && b.status !== "cancelled")
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.invoice_number || b.id} · ₹{b.total_payable ?? b.subtotal ?? 0} ({b.invoice_type || "Invoice"})
                  </option>
                ))}
            </select>
          </div>
        )}

        {cfg.endpoint === "bill" && (
          <div className="col-span-2">
            <Lbl>Link to BOQ (Billed Value)</Lbl>
            <select
              value={boqDocId}
              onChange={(e) => setBoqDocId(e.target.value)}
              className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="">No BOQ link</option>
              {boqDocs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                  {d.client_name ? ` · ${d.client_name}` : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <Lbl>{cfg.endpoint === "bill" ? "Invoice / Reference #" : "Reference #"}</Lbl>
          <input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
        </div>
        <div>
          <Lbl>Date</Lbl>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
        </div>

        {cfg.endpoint === "bill" && (
          <div>
            <Lbl>Due Date</Lbl>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
          </div>
        )}
        {cfg.endpoint === "bill" && !isSettlement && (
          <div>
            <Lbl>GST %</Lbl>
            <input value={gstPct} onChange={(e) => setGstPct(e.target.value)} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
          </div>
        )}

        {/* Payment mode conditional fields (Payment In / Out) */}
        {cfg.paymentMode && (
          <div className="col-span-2 rounded-md border border-border-custom p-3">
            <Lbl>Payment Mode</Lbl>
            <div className="flex gap-2 mb-2">
              {(["Cash", "Bank", "Cheque"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setPayMode(m)}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold border transition-all cursor-pointer ${payMode === m ? "bg-elevated text-foreground border-border-custom" : "border-border-custom bg-card text-muted hover:bg-elevated/40"}`}
                >
                  {m}
                </button>
              ))}
            </div>
            {payMode !== "Cash" && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <Lbl>Bank Name</Lbl>
                  <input value={bankName} onChange={(e) => setBankName(e.target.value)} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
                </div>
                {payMode === "Cheque" ? (
                  <div>
                    <Lbl>Cheque No.</Lbl>
                    <input value={chequeNo} onChange={(e) => setChequeNo(e.target.value)} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
                  </div>
                ) : (
                  <div>
                    <Lbl>Transaction Ref</Lbl>
                    <input value={txnRef} onChange={(e) => setTxnRef(e.target.value)} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Add Item sub-entity */}
        {cfg.endpoint === "bill" && (
          <div className="col-span-2 rounded-md border border-border-custom p-3">
            <div className="flex items-center justify-between mb-2">
              <Lbl>Add Item</Lbl>
              <button type="button" onClick={addItem} className="text-xs rounded-md border border-border-custom px-2 py-1 text-muted hover:text-foreground">+ Add line</button>
            </div>
            {items.map((it, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 mb-2">
                <input placeholder="Description" value={it.desc} onChange={(e) => setItems((s) => s.map((x, j) => j === i ? { ...x, desc: e.target.value } : x))} className={(cfg.key === "sales_invoice" || cfg.key === "material_sales" ? "col-span-2" : "col-span-3") + " rounded-md border border-border-custom bg-background px-2 py-1.5 text-sm text-foreground"} />
                {/* R2-747: HSN/SAC is required per line on a tax invoice, so the
                    field is shown exactly where the backend demands it. Showing
                    it only for revenue types keeps every other form unchanged. */}
                {(cfg.key === "sales_invoice" || cfg.key === "material_sales") && (
                  <input
                    placeholder="HSN/SAC"
                    title="HSN/SAC code: mandatory on a tax invoice (Rule 46, CGST Rules)"
                    value={it.hsn}
                    onChange={(e) => setItems((s) => s.map((x, j) => j === i ? { ...x, hsn: e.target.value } : x))}
                    className="col-span-1 rounded-md border border-border-custom bg-background px-2 py-1.5 text-sm text-foreground"
                  />
                )}
                <select value={it.costCodeId} onChange={(e) => setItems((s) => s.map((x, j) => j === i ? { ...x, costCodeId: e.target.value } : x))} className="col-span-2 rounded-md border border-border-custom bg-background px-2 py-1.5 text-sm text-foreground">
                  <option value="">Cost Code</option>
                  {costCodes.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
                </select>
                <select value={it.unit} onChange={(e) => setItems((s) => s.map((x, j) => j === i ? { ...x, unit: e.target.value } : x))} className="col-span-2 rounded-md border border-border-custom bg-background px-2 py-1.5 text-sm text-foreground">
                  <option value="">Unit</option>
                  {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
                <input type="number" placeholder="Qty" value={it.qty} onChange={(e) => setItems((s) => s.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} className="col-span-2 rounded-md border border-border-custom bg-background px-2 py-1.5 text-sm text-foreground" />
                <input type="number" placeholder="Rate" value={it.rate} onChange={(e) => setItems((s) => s.map((x, j) => j === i ? { ...x, rate: e.target.value } : x))} className="col-span-2 rounded-md border border-border-custom bg-background px-2 py-1.5 text-sm text-foreground" />
                <div className="col-span-1 flex items-center justify-end text-sm text-muted">
                  {fmtINR((parseFloat(it.qty) || 0) * (parseFloat(it.rate) || 0), currencyDecimalPlaces)}
                </div>
              </div>
            ))}
            <div className="text-right text-sm font-medium text-foreground">Subtotal: {fmtINR(subtotal, currencyDecimalPlaces)}</div>
          </div>
        )}

        {/* Deduction + Retention sub-entities */}
        {cfg.endpoint === "bill" && (
          <div className="col-span-2 rounded-md border border-border-custom p-3">
            <div className="flex items-center justify-between mb-2">
              <Lbl>Deductions</Lbl>
              <button type="button" onClick={addDeduction} className="text-xs rounded-md border border-border-custom px-2 py-1 text-muted hover:text-foreground">+ Add deduction</button>
            </div>
            {deductions.map((d, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 mb-2">
                <select value={d.type} onChange={(e) => setDeductions((s) => s.map((x, j) => j === i ? { ...x, type: e.target.value } : x))} className="col-span-4 rounded-md border border-border-custom bg-background px-2 py-1.5 text-sm text-foreground">
                  <option value="TDS">TDS</option>
                  <option value="Retention">Retention</option>
                  <option value="Security Deposit">Security Deposit</option>
                  <option value="Advance Recovery">Advance Recovery</option>
                  <option value="Material Recovery">Material Recovery</option>
                </select>
                <select value={d.mode} onChange={(e) => setDeductions((s) => s.map((x, j) => j === i ? { ...x, mode: e.target.value as any } : x))} className="col-span-2 rounded-md border border-border-custom bg-background px-2 py-1.5 text-sm text-foreground">
                  <option value="amount">₹ Amt</option>
                  <option value="percent">% </option>
                </select>
                <input type="number" placeholder="Value" value={d.value} onChange={(e) => setDeductions((s) => s.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} className="col-span-2 rounded-md border border-border-custom bg-background px-2 py-1.5 text-sm text-foreground" />
                <input placeholder="Notes" value={d.notes} onChange={(e) => setDeductions((s) => s.map((x, j) => j === i ? { ...x, notes: e.target.value } : x))} className="col-span-4 rounded-md border border-border-custom bg-background px-2 py-1.5 text-sm text-foreground" />
              </div>
            ))}
            <div className="flex items-center gap-2 mt-1">
              <Lbl>Retention %</Lbl>
              <input type="number" value={retentionPct} onChange={(e) => setRetentionPct(e.target.value)} placeholder="e.g. 5" className="w-24 rounded-md border border-border-custom bg-background px-2 py-1.5 text-sm text-foreground" />
              <label className="flex items-center gap-2 text-sm text-muted ml-3">
                <input type="checkbox" checked={preTax} onChange={(e) => setPreTax(e.target.checked)} /> Pre-tax deductions
              </label>
            </div>
          </div>
        )}

        {/* Custom Fields (Settings → Custom Fields, entity_type="invoice") */}
        {isSalesInvoice && (
          <CustomFieldsSection
            fields={customFields.fields}
            values={customFields.values}
            setValue={customFields.setValue}
          />
        )}

        {/* Debit Note Breakdown & Live Arithmetic */}
        {cfg.endpoint === "debit" && (
          <div className="col-span-2 rounded-md border border-border-custom p-3 space-y-3">
            <div className="text-xs font-bold uppercase tracking-wider text-muted">Debit Note Breakdown & Arithmetic</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Lbl>Taxable Work Amount (₹)</Lbl>
                <input
                  type="number"
                  step="0.01"
                  value={debitWorkAmount}
                  onChange={(e) => setDebitWorkAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground"
                />
              </div>
              <div>
                <Lbl>GST Amount (₹)</Lbl>
                <input
                  type="number"
                  step="0.01"
                  value={debitGstAmount}
                  onChange={(e) => setDebitGstAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground"
                />
              </div>
            </div>
            <div className="rounded-md bg-elevated/50 p-2.5 text-xs text-foreground font-mono flex items-center justify-between border border-border-custom">
              <span>Work Amount (₹{(parseFloat(debitWorkAmount) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}) + GST (₹{(parseFloat(debitGstAmount) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })})</span>
              <span className="font-bold text-danger">
                Total: ₹{((parseFloat(debitWorkAmount) || 0) + (parseFloat(debitGstAmount) || 0)).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
              </span>
            </div>
          </div>
        )}

        {/* Credit Note Amount */}
        {cfg.endpoint === "credit" && (
          <div className="col-span-2 rounded-md border border-border-custom p-3 space-y-3">
            <div className="text-xs font-bold uppercase tracking-wider text-muted">Credit Note Amount</div>
            <div>
              <Lbl>Total Credit Amount (₹)</Lbl>
              <input
                type="number"
                step="0.01"
                value={creditAmount}
                onChange={(e) => setCreditAmount(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground"
              />
            </div>
          </div>
        )}

        {/* Bill / Ship addressing / Notes / Details depending on branch (R2-763) */}
        <div className="col-span-2">
          <Lbl>{addressingLabel}</Lbl>
          <input
            value={shipTo}
            onChange={(e) => setShipTo(e.target.value)}
            placeholder={addressingPlaceholder}
            className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground"
          />
        </div>
      </div>

      {err && <div className="mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{err}</div>}

      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="rounded-md border border-border-custom px-4 py-2 text-sm text-foreground hover:border-primary">Cancel</button>
        <button onClick={submit} disabled={saving} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
          {saving ? "Saving…" : "Save Transaction"}
        </button>
      </div>
    </Modal>
  );
}
