"use client";

import React, { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { useProject } from "@/context/ProjectContext";
import { getApiHost, readErrorDetail } from "@/lib/api";
import { authHeaders, formatLabel } from "@/lib/siteflow";
import { isMissingOrDemoTenant, redirectToLogin } from "@/lib/company-guard";
import Icon from "@/components/marketing/Icon";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import SegmentedTabs from "@/components/ui/Tabs";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableSkeleton } from "@/components/ui/Skeleton";

interface TallyAgent {
  id: string;
  company_id: string;
  machine_label: string;
  auth_key: string;
  status: string;
  created_at: string;
}

interface BankMapping {
  id: string;
  company_id: string;
  onsite_bank_account_details: string;
  tally_ledger_name: string;
}

interface SyncLog {
  id: string;
  company_id: string;
  exported_at?: string | null;
  marked_synced_at?: string | null;
  voucher_count: number;
  created_at: string;
}

interface PendingVoucher {
  id: string;
  type: string;
  number: string;
  date: string;
  party: string;
  amount: number;
}

export default function TallyIntegrationPage() {
  const params = useParams();
  const companyId = params?.company_id as string;
  const { activeProjectId } = useProject();

  useEffect(() => {
    if (isMissingOrDemoTenant(companyId)) {
      redirectToLogin();
    }
  }, [companyId]);

  const [tab, setTab] = useState<"agents" | "bank_mappings" | "ledger_mappings" | "sync_history">("agents");

  // Ledger mappings state
  const [purchaseLedger, setPurchaseLedger] = useState("Purchase A/c");
  const [salesLedger, setSalesLedger] = useState("Sales A/c");
  const [freightLedger, setFreightLedger] = useState("");
  const [surchargeLedger, setSurchargeLedger] = useState("");
  const [roundOffLedger, setRoundOffLedger] = useState("");
  const [ledgerSaving, setLedgerSaving] = useState(false);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerMapId, setLedgerMapId] = useState<string | null>(null);
  const [connId, setConnId] = useState<string | null>(null);

  // Agents state
  const [agents, setAgents] = useState<TallyAgent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [agentForm, setAgentForm] = useState({
    machine_label: "",
    auth_key: "",
  });

  // Bank mappings state
  const [bankMappings, setBankMappings] = useState<BankMapping[]>([]);
  const [bankLoading, setBankLoading] = useState(false);
  const [showBankModal, setShowBankModal] = useState(false);
  const [bankForm, setBankForm] = useState({
    onsite_bank_account_details: "",
    tally_ledger_name: "",
  });

  // Sync state
  const [syncLogs, setSyncLogs] = useState<SyncLog[]>([]);
  const [pendingVouchers, setPendingVouchers] = useState<PendingVoucher[]>([]);
  const [pendingBillIds, setPendingBillIds] = useState<string[]>([]);
  const [pendingPaymentIds, setPendingPaymentIds] = useState<string[]>([]);
  const [syncLoading, setSyncLoading] = useState(false);
  const [unmarking, setUnmarking] = useState(false);
  const [unmarkInput, setUnmarkInput] = useState({
    entity_type: "bill" as "bill" | "payment",
    entity_id: "",
  });

  const [toastMessage, setToastMessage] = useState("");

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(""), 3500);
  };

  const fetchAgents = async () => {
    if (!companyId) return;
    setAgentsLoading(true);
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/tally/agents?company_id=${companyId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setAgents(Array.isArray(data) ? data : []);
      } else {
        setAgents([]);
      }
    } catch (e) {
      console.error("Failed to load Tally agents", e);
      setAgents([]);
    } finally {
      setAgentsLoading(false);
    }
  };

  const fetchBankMappings = async () => {
    if (!companyId) return;
    setBankLoading(true);
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/tally/mappings/bank?company_id=${companyId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setBankMappings(Array.isArray(data) ? data : []);
      } else {
        setBankMappings([]);
      }
    } catch (e) {
      console.error("Failed to load bank mappings", e);
      setBankMappings([]);
    } finally {
      setBankLoading(false);
    }
  };

  const fetchSyncData = async () => {
    if (!companyId) return;
    setSyncLoading(true);
    try {
      const [logRes, pendingRes] = await Promise.all([
        fetch(`${getApiHost()}/apis/v3/tally/sync-logs?company_id=${companyId}`, { headers: authHeaders() }),
        fetch(`${getApiHost()}/apis/v3/tally/pending?company_id=${companyId}`, { headers: authHeaders() }),
      ]);
      if (logRes.ok) {
        const data = await logRes.json();
        setSyncLogs(Array.isArray(data) ? data : []);
      }
      if (pendingRes.ok) {
        const data = await pendingRes.json();
        setPendingVouchers(Array.isArray(data.vouchers) ? data.vouchers : []);
        setPendingBillIds(Array.isArray(data.bill_ids) ? data.bill_ids : []);
        setPendingPaymentIds(Array.isArray(data.payment_ids) ? data.payment_ids : []);
      }
    } catch (e) {
      console.error("Failed to load sync data", e);
    } finally {
      setSyncLoading(false);
    }
  };

  const fetchGeneralLedgers = async () => {
    if (!companyId) return;
    setLedgerLoading(true);
    try {
      const [connRes, lmRes] = await Promise.all([
        fetch(`${getApiHost()}/apis/v3/tally/connections?company_id=${companyId}`, { headers: authHeaders() }),
        fetch(`${getApiHost()}/apis/v3/tally/mappings/ledger?company_id=${companyId}`, { headers: authHeaders() }),
      ]);
      if (connRes.ok) {
        const c = await connRes.json();
        if (c && c.id) {
          setConnId(c.id);
          setRoundOffLedger(c.round_off_ledger || "");
        }
      }
      if (lmRes.ok) {
        const lms = await lmRes.json();
        const purchase = lms.find((m: any) => m.onsite_transaction_type === "Material Purchase");
        if (purchase) {
          setLedgerMapId(purchase.id);
          setPurchaseLedger(purchase.tally_ledger_name || "Purchase A/c");
          setFreightLedger(purchase.freight_ledger || "");
          setSurchargeLedger(purchase.surcharge_ledger || "");
        }
        const sales = lms.find((m: any) => m.onsite_transaction_type === "Sales Invoice");
        if (sales) {
          setSalesLedger(sales.tally_ledger_name || "Sales A/c");
        }
      }
    } catch (e) {
      console.error("Failed to load general ledgers", e);
    } finally {
      setLedgerLoading(false);
    }
  };

  const handleSaveGeneralLedgers = async (e: React.FormEvent) => {
    e.preventDefault();
    setLedgerSaving(true);
    try {
      if (ledgerMapId) {
        const res = await fetch(`${getApiHost()}/apis/v3/tally/mappings/ledger/${ledgerMapId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
          body: JSON.stringify({
            tally_ledger_name: purchaseLedger.trim() || "Purchase A/c",
            freight_ledger: freightLedger.trim() || null,
            surcharge_ledger: surchargeLedger.trim() || null,
          }),
        });
        if (!res.ok) {
          const err = await readErrorDetail(res);
          alert(err || "Failed to update ledger mappings");
          return;
        }
      } else {
        const res = await fetch(`${getApiHost()}/apis/v3/tally/mappings/ledger`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
          body: JSON.stringify({
            company_id: companyId,
            onsite_transaction_type: "Material Purchase",
            posting_mode: "lumpsum",
            tally_voucher_type: "Purchase",
            tally_ledger_name: purchaseLedger.trim() || "Purchase A/c",
            freight_ledger: freightLedger.trim() || null,
            surcharge_ledger: surchargeLedger.trim() || null,
          }),
        });
        if (!res.ok) {
          const err = await readErrorDetail(res);
          alert(err || "Failed to create ledger mappings");
          return;
        }
      }

      if (connId) {
        await fetch(`${getApiHost()}/apis/v3/tally/connections/${connId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
          body: JSON.stringify({
            round_off_ledger: roundOffLedger.trim() || null,
          }),
        });
      }

      showToast("Tally general ledger & expense mappings saved successfully.");
      fetchGeneralLedgers();
    } catch (e: any) {
      alert("Failed to save ledger mappings: " + (e?.message || ""));
    } finally {
      setLedgerSaving(false);
    }
  };

  useEffect(() => {
    if (tab === "agents") fetchAgents();
    else if (tab === "bank_mappings") fetchBankMappings();
    else if (tab === "ledger_mappings") fetchGeneralLedgers();
    else if (tab === "sync_history") fetchSyncData();
  }, [companyId, tab]);

  const handleRegisterAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentForm.machine_label.trim() || !agentForm.auth_key.trim()) {
      alert("Please provide machine label and authentication key");
      return;
    }
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/tally/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id: companyId,
          machine_label: agentForm.machine_label.trim(),
          auth_key: agentForm.auth_key.trim(),
        }),
      });
      if (res.ok) {
        setShowAgentModal(false);
        setAgentForm({ machine_label: "", auth_key: "" });
        showToast("Tally Desktop Agent registered successfully");
        fetchAgents();
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to register agent");
      }
    } catch (e) {
      console.error(e);
      alert("Failed to register agent");
    }
  };

  const handleDeleteAgent = async (agentId: string) => {
    if (!confirm("Remove this Tally desktop agent?")) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/tally/agents/${agentId}`, {
        method: "DELETE",
        headers: authHeaders() || {},
      });
      if (res.ok) {
        setAgents(prev => prev.filter(a => a.id !== agentId));
        showToast("Tally agent removed successfully");
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to remove agent");
      }
    } catch (e) {
      console.error(e);
      alert("Error removing agent");
    }
  };

  const handleDeleteBankMapping = async (mapId: string) => {
    if (!confirm("Delete this bank mapping?")) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/tally/mappings/bank/${mapId}`, {
        method: "DELETE",
        headers: authHeaders() || {},
      });
      if (res.ok) {
        setBankMappings(prev => prev.filter(m => m.id !== mapId));
        showToast("Bank mapping deleted successfully");
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to delete bank mapping");
      }
    } catch (e) {
      console.error(e);
      alert("Error deleting bank mapping");
    }
  };

  const handleSaveBankMapping = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bankForm.onsite_bank_account_details.trim() || !bankForm.tally_ledger_name.trim()) {
      alert("Please provide bank account details and Tally ledger name");
      return;
    }
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/tally/mappings/bank`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id: companyId,
          onsite_bank_account_details: bankForm.onsite_bank_account_details.trim(),
          tally_ledger_name: bankForm.tally_ledger_name.trim(),
        }),
      });
      if (res.ok) {
        setShowBankModal(false);
        setBankForm({ onsite_bank_account_details: "", tally_ledger_name: "" });
        showToast("Bank mapping saved successfully");
        fetchBankMappings();
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to save bank mapping");
      }
    } catch (e) {
      console.error(e);
      alert("Failed to save bank mapping");
    }
  };

  const handleUnmarkSynced = async (entityType?: "bill" | "payment", entityId?: string) => {
    const type = entityType || unmarkInput.entity_type;
    const id = entityId || unmarkInput.entity_id;

    if (!id.trim()) {
      alert("Please specify a voucher/record UUID to unmark");
      return;
    }

    setUnmarking(true);
    try {
      const payload = {
        bill_ids: type === "bill" ? [id.trim()] : [],
        payment_ids: type === "payment" ? [id.trim()] : [],
      };
      const res = await fetch(`${getApiHost()}/apis/v3/tally/unmark-synced`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const data = await res.json();
        showToast(`Unmarked ${data.unmarked_bills || 0} bill(s) and ${data.unmarked_payments || 0} payment(s). Re-queued for export.`);
        setUnmarkInput({ entity_type: "bill", entity_id: "" });
        fetchSyncData();
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to unmark synced record");
      }
    } catch (e) {
      console.error(e);
      alert("Failed to unmark synced voucher");
    } finally {
      setUnmarking(false);
    }
  };

  const generateAuthKey = () => {
    const randomKey = "SF_TALLY_" + Math.random().toString(36).substring(2, 10).toUpperCase() + "_" + Date.now().toString().slice(-4);
    setAgentForm(prev => ({ ...prev, auth_key: randomKey }));
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden font-sans">
      <PageHeader
        title="Tally Prime ERP Integration"
        subtitle="Desktop agent connectors, bank ledger mappings, and voucher export queue management"
      >
        <div className="flex items-center gap-2">
          {tab === "agents" && (
            <button
              onClick={() => {
                generateAuthKey();
                setShowAgentModal(true);
              }}
              className="flex items-center gap-1.5 px-3.5 py-1.5 bg-primary text-white text-xs font-bold rounded-lg hover:bg-primary/95 transition-all cursor-pointer"
            >
              + Register Desktop Agent
            </button>
          )}
          {tab === "bank_mappings" && (
            <button
              onClick={() => setShowBankModal(true)}
              className="flex items-center gap-1.5 px-3.5 py-1.5 bg-primary text-white text-xs font-bold rounded-lg hover:bg-primary/95 transition-all cursor-pointer"
            >
              + Add Bank Mapping
            </button>
          )}
          {tab === "sync_history" && (
            <button
              onClick={fetchSyncData}
              className="flex items-center gap-1.5 px-3.5 py-1.5 bg-elevated border border-border-custom text-foreground text-xs font-bold rounded-lg hover:bg-card transition-all cursor-pointer"
            >
              <Icon name="refresh" className="w-3.5 h-3.5" /> Refresh Queue
            </button>
          )}
        </div>
      </PageHeader>

      <div className="px-6 py-2 border-b border-border-custom bg-card shrink-0 overflow-x-auto">
        <SegmentedTabs
          tabs={[
            { id: "agents", label: "Desktop Agents", icon: <Icon name="computer" className="w-3.5 h-3.5" /> },
            { id: "bank_mappings", label: "Bank Mappings", icon: <Icon name="bank" className="w-3.5 h-3.5" /> },
            { id: "ledger_mappings", label: "Ledger & Expense Mappings", icon: <Icon name="settings" className="w-3.5 h-3.5" /> },
            { id: "sync_history", label: "Export Queue & Sync History", icon: <Icon name="receipt" className="w-3.5 h-3.5" /> },
          ]}
          activeTab={tab}
          onChange={(t) => setTab(t as any)}
        />
      </div>

      <main className="flex-1 overflow-y-auto p-6 bg-elevated/10">
        {toastMessage && (
          <div className="mb-4 p-3 bg-success/10 border border-success/20 text-success text-xs rounded-lg font-semibold flex items-center justify-between">
            <span>{toastMessage}</span>
            <button onClick={() => setToastMessage("")}><Icon name="close" className="w-4 h-4" /></button>
          </div>
        )}

        {/* ── AGENTS TAB ── */}
        {tab === "agents" && (
          <div className="space-y-6">
            <div className="bg-card border border-border-custom rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">On-Premise Desktop Agents</h3>
                  <p className="text-[10px] text-muted">Local background sync services communicating with Tally Prime on port 9000</p>
                </div>
                <button
                  type="button"
                  onClick={fetchAgents}
                  className="px-3 py-1.5 bg-elevated hover:bg-card border border-border-custom text-foreground rounded text-xs font-semibold cursor-pointer inline-flex items-center gap-1"
                >
                  <Icon name="refresh" className="w-3.5 h-3.5" /> Refresh
                </button>
              </div>

              {agentsLoading ? (
                <TableSkeleton rows={4} cols={5} />
              ) : agents.length === 0 ? (
                <EmptyState
                  title="No Tally Desktop Agents registered"
                  description="Register an on-premise agent instance installed on your accounting workstation or server."
                  action={{
                    label: "+ Register Desktop Agent",
                    onClick: () => {
                      generateAuthKey();
                      setShowAgentModal(true);
                    },
                  }}
                />
              ) : (
                <div className="border border-border-custom rounded-lg overflow-hidden">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-elevated border-b border-border-custom text-muted text-[10px] uppercase font-bold tracking-wider">
                      <tr>
                        <th className="px-4 py-3">Machine Label</th>
                        <th className="px-4 py-3">Auth Key</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">Registered At</th>
                        <th className="px-4 py-3 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-custom/40">
                      {agents.map((ag) => (
                        <tr key={ag.id} className="hover:bg-elevated/40 transition-colors">
                          <td className="px-4 py-3 font-semibold text-foreground">{ag.machine_label}</td>
                          <td className="px-4 py-3 font-mono text-muted text-[11px]">{ag.auth_key}</td>
                          <td className="px-4 py-3">
                            <Badge tone={ag.status === "active" ? "success" : "neutral"} className="font-bold">
                              {formatLabel(ag.status)}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-muted">
                            {ag.created_at ? new Date(ag.created_at).toLocaleString("en-IN") : "—"}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <button
                              type="button"
                              onClick={() => handleDeleteAgent(ag.id)}
                              className="px-2.5 py-1 rounded bg-elevated hover:bg-danger/10 hover:text-danger hover:border-danger/20 border border-border-custom text-muted text-xs font-medium transition-all cursor-pointer inline-flex items-center gap-1"
                              title="Remove agent"
                            >
                              <Icon name="trash" className="w-3 h-3" /> Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="bg-card border border-border-custom rounded-xl p-5 space-y-2">
              <h4 className="text-xs font-bold text-foreground">Desktop Agent Setup Guide</h4>
              <ol className="text-xs text-muted space-y-1.5 list-decimal pl-4">
                <li>Install the SiteFlow Tally Agent utility on the Windows PC hosting Tally Prime.</li>
                <li>Ensure Tally Prime is running with ODBC/XML Server enabled on default port 9000.</li>
                <li>Copy the generated Auth Key from the registered agent and paste it into the agent config.</li>
                <li>The agent will automatically pull approved vouchers and push ledger balances.</li>
              </ol>
            </div>
          </div>
        )}

        {/* ── BANK MAPPINGS TAB ── */}
        {tab === "bank_mappings" && (
          <div className="space-y-6">
            <div className="bg-card border border-border-custom rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">Company Bank Account Mappings</h3>
                  <p className="text-[10px] text-muted">Map SiteFlow bank accounts to corresponding Tally Prime Bank Ledgers</p>
                </div>
                <button
                  type="button"
                  onClick={fetchBankMappings}
                  className="px-3 py-1.5 bg-elevated hover:bg-card border border-border-custom text-foreground rounded text-xs font-semibold cursor-pointer inline-flex items-center gap-1"
                >
                  <Icon name="refresh" className="w-3.5 h-3.5" /> Refresh
                </button>
              </div>

              {bankLoading ? (
                <TableSkeleton rows={4} cols={3} />
              ) : bankMappings.length === 0 ? (
                <EmptyState
                  title="No bank ledger mappings configured"
                  description="Add mappings to ensure payment vouchers post to the correct Tally bank account ledger."
                  action={{
                    label: "+ Add Bank Mapping",
                    onClick: () => setShowBankModal(true),
                  }}
                />
              ) : (
                <div className="border border-border-custom rounded-lg overflow-hidden">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-elevated border-b border-border-custom text-muted text-[10px] uppercase font-bold tracking-wider">
                      <tr>
                        <th className="px-4 py-3">SiteFlow Bank Account Details</th>
                        <th className="px-4 py-3">Tally Ledger Name</th>
                        <th className="px-4 py-3 text-right">Status</th>
                        <th className="px-4 py-3 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-custom/40">
                      {bankMappings.map((bm) => (
                        <tr key={bm.id} className="hover:bg-elevated/40 transition-colors">
                          <td className="px-4 py-3 font-semibold text-foreground">{bm.onsite_bank_account_details}</td>
                          <td className="px-4 py-3 font-mono text-primary font-bold">{bm.tally_ledger_name}</td>
                          <td className="px-4 py-3 text-right">
                            <span className="text-[10px] bg-success/10 text-success border border-success/20 px-2 py-0.5 rounded font-bold">
                              Mapped
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <button
                              type="button"
                              onClick={() => handleDeleteBankMapping(bm.id)}
                              className="px-2.5 py-1 rounded bg-elevated hover:bg-danger/10 hover:text-danger hover:border-danger/20 border border-border-custom text-muted text-xs font-medium transition-all cursor-pointer inline-flex items-center gap-1"
                              title="Delete bank mapping"
                            >
                              <Icon name="trash" className="w-3 h-3" /> Delete
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── LEDGER & EXPENSE MAPPINGS TAB ── */}
        {tab === "ledger_mappings" && (
          <div className="space-y-6">
            <div className="bg-card border border-border-custom rounded-xl p-5 space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">Tally Ledger & Expense Mappings</h3>
                  <p className="text-[10px] text-muted">Configure default nominal ledgers for purchases, sales, freight charges, surcharges, and fractional round-offs in Tally Prime.</p>
                </div>
                <button
                  type="button"
                  onClick={fetchGeneralLedgers}
                  className="px-3 py-1.5 bg-elevated hover:bg-card border border-border-custom text-foreground rounded text-xs font-semibold cursor-pointer inline-flex items-center gap-1"
                >
                  <Icon name="refresh" className="w-3.5 h-3.5" /> Refresh
                </button>
              </div>

              {ledgerLoading ? (
                <TableSkeleton rows={4} cols={2} />
              ) : (
                <form onSubmit={handleSaveGeneralLedgers} className="space-y-5">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="text-[10px] uppercase font-bold text-muted block mb-1">Purchase Ledger Name</label>
                      <input
                        type="text"
                        value={purchaseLedger}
                        onChange={(e) => setPurchaseLedger(e.target.value)}
                        placeholder="Purchase A/c"
                        className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary font-mono"
                      />
                      <p className="text-[10px] text-muted mt-1">Default ledger for vendor material bills & procurement vouchers.</p>
                    </div>

                    <div>
                      <label className="text-[10px] uppercase font-bold text-muted block mb-1">Sales Ledger Name</label>
                      <input
                        type="text"
                        value={salesLedger}
                        onChange={(e) => setSalesLedger(e.target.value)}
                        placeholder="Sales A/c"
                        className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary font-mono"
                      />
                      <p className="text-[10px] text-muted mt-1">Default ledger for client sales invoices & billing entries.</p>
                    </div>

                    <div>
                      <label className="text-[10px] uppercase font-bold text-muted block mb-1">Freight Ledger (Optional)</label>
                      <input
                        type="text"
                        value={freightLedger}
                        onChange={(e) => setFreightLedger(e.target.value)}
                        placeholder="Freight & Carriage Charges"
                        className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary font-mono"
                      />
                      <p className="text-[10px] text-muted mt-1">Ledger allocated for transport & delivery costs in purchase vouchers.</p>
                    </div>

                    <div>
                      <label className="text-[10px] uppercase font-bold text-muted block mb-1">Surcharge Ledger (Optional)</label>
                      <input
                        type="text"
                        value={surchargeLedger}
                        onChange={(e) => setSurchargeLedger(e.target.value)}
                        placeholder="Surcharge / Extra Duties"
                        className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary font-mono"
                      />
                      <p className="text-[10px] text-muted mt-1">Ledger allocated for custom duties, packing or incidental surcharges.</p>
                    </div>

                    <div className="md:col-span-2">
                      <label className="text-[10px] uppercase font-bold text-muted block mb-1">Round-off Ledger (Optional)</label>
                      <input
                        type="text"
                        value={roundOffLedger}
                        onChange={(e) => setRoundOffLedger(e.target.value)}
                        placeholder="Round Off A/c"
                        className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary font-mono"
                      />
                      <p className="text-[10px] text-muted mt-1">Ledger used to absorb fractional rounding discrepancies in invoice totals.</p>
                    </div>
                  </div>

                  <div className="pt-2 flex justify-end">
                    <button
                      type="submit"
                      disabled={ledgerSaving}
                      className="px-5 py-2.5 bg-primary text-white text-xs font-bold rounded-lg hover:bg-primary/95 transition-all cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
                    >
                      <Icon name="check" className="w-4 h-4" />
                      {ledgerSaving ? "Saving Ledger Mappings..." : "Save Ledger Mappings"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        )}

        {/* ── SYNC HISTORY & RE-SYNC TAB ── */}
        {tab === "sync_history" && (
          <div className="space-y-6">
            {/* Unmark / Re-sync Box */}
            <div className="bg-card border border-border-custom rounded-xl p-5 space-y-4">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">Re-Queue Synced Voucher (Unmark Synced)</h3>
                <p className="text-[10px] text-muted">If an export was marked as synced but failed during Tally import, unmark it here to restore it to the pending queue.</p>
              </div>

              <div className="flex flex-col sm:flex-row items-end gap-3">
                <div className="w-full sm:w-48">
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Entity Type</label>
                  <select
                    value={unmarkInput.entity_type}
                    onChange={(e) => setUnmarkInput({ ...unmarkInput, entity_type: e.target.value as any })}
                    className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary"
                  >
                    <option value="bill">Vendor Bill / PO</option>
                    <option value="payment">Payment Voucher</option>
                  </select>
                </div>
                <div className="flex-1 w-full">
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Record UUID / ID</label>
                  <input
                    type="text"
                    value={unmarkInput.entity_id}
                    onChange={(e) => setUnmarkInput({ ...unmarkInput, entity_id: e.target.value })}
                    placeholder="Enter Bill or Payment UUID..."
                    className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary font-mono"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => handleUnmarkSynced()}
                  disabled={unmarking || !unmarkInput.entity_id.trim()}
                  className="px-4 py-2 bg-primary text-white text-xs font-bold rounded-lg hover:bg-primary/95 transition-all cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5 shrink-0"
                >
                  <Icon name="refresh" className="w-3.5 h-3.5" />
                  {unmarking ? "Unmarking..." : "Unmark & Re-Queue"}
                </button>
              </div>
            </div>

            {/* Pending Vouchers Queue */}
            <div className="bg-card border border-border-custom rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">Pending Export Queue</h3>
                  <p className="text-[10px] text-muted">{pendingVouchers.length} voucher(s) waiting for Tally Prime sync</p>
                </div>
              </div>

              {pendingVouchers.length === 0 ? (
                <div className="text-xs text-muted text-center py-6 bg-elevated/30 rounded-lg">
                  All vouchers are up-to-date and synced with Tally.
                </div>
              ) : (
                <div className="border border-border-custom rounded-lg overflow-hidden max-h-64 overflow-y-auto">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-elevated border-b border-border-custom text-muted text-[10px] uppercase font-bold tracking-wider">
                      <tr>
                        <th className="px-4 py-2.5">Type</th>
                        <th className="px-4 py-2.5">Number</th>
                        <th className="px-4 py-2.5">Party</th>
                        <th className="px-4 py-2.5 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-custom/40">
                      {pendingVouchers.map((v, i) => (
                        <tr key={i} className="hover:bg-elevated/40">
                          <td className="px-4 py-2 font-bold text-foreground">{v.type}</td>
                          <td className="px-4 py-2 font-mono text-muted">{v.number}</td>
                          <td className="px-4 py-2 text-foreground">{v.party}</td>
                          <td className="px-4 py-2 text-right font-sans font-bold text-foreground">
                            ₹{(v.amount || 0).toLocaleString("en-IN")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Sync Logs */}
            <div className="bg-card border border-border-custom rounded-xl p-5 space-y-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">Recent Sync Logs</h3>
              {syncLogs.length === 0 ? (
                <div className="text-xs text-muted text-center py-4">No sync history logs recorded yet.</div>
              ) : (
                <div className="border border-border-custom rounded-lg overflow-hidden">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-elevated border-b border-border-custom text-muted text-[10px] uppercase font-bold tracking-wider">
                      <tr>
                        <th className="px-4 py-2.5">Sync Event</th>
                        <th className="px-4 py-2.5 text-right">Voucher Count</th>
                        <th className="px-4 py-2.5">Marked Synced At</th>
                        <th className="px-4 py-2.5">Logged At</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-custom/40">
                      {syncLogs.map((log) => (
                        <tr key={log.id} className="hover:bg-elevated/40">
                          <td className="px-4 py-2 font-semibold text-foreground">Batch Voucher Sync</td>
                          <td className="px-4 py-2 text-right font-sans font-bold text-primary">{log.voucher_count}</td>
                          <td className="px-4 py-2 text-muted">{log.marked_synced_at ? new Date(log.marked_synced_at).toLocaleString("en-IN") : "—"}</td>
                          <td className="px-4 py-2 text-muted">{log.created_at ? new Date(log.created_at).toLocaleString("en-IN") : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Register Agent Modal ── */}
        {showAgentModal && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setShowAgentModal(false)}>
            <div className="bg-card border border-border-custom rounded-xl w-full max-w-md p-6 relative overflow-hidden" onClick={e => e.stopPropagation()}>
              <div className="flex justify-between items-start pb-3 border-b border-border-custom">
                <div>
                  <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">Register Tally Desktop Agent</h3>
                  <p className="text-[10px] text-muted mt-0.5">Connect an on-premise sync agent</p>
                </div>
                <button onClick={() => setShowAgentModal(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
              </div>

              <form onSubmit={handleRegisterAgent} className="space-y-3 my-4 text-xs">
                <div>
                  <label className="text-[10px] text-muted uppercase font-bold block mb-1">Machine Label / Computer Name*</label>
                  <input
                    type="text"
                    required
                    value={agentForm.machine_label}
                    onChange={(e) => setAgentForm({ ...agentForm, machine_label: e.target.value })}
                    placeholder="e.g. ACCOUNTS-DESKTOP-01"
                    className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[10px] text-muted uppercase font-bold">Authentication Key*</label>
                    <button
                      type="button"
                      onClick={generateAuthKey}
                      className="text-[10px] text-primary hover:underline font-bold"
                    >
                      Generate New Key
                    </button>
                  </div>
                  <input
                    type="text"
                    required
                    value={agentForm.auth_key}
                    onChange={(e) => setAgentForm({ ...agentForm, auth_key: e.target.value })}
                    className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs font-mono"
                  />
                </div>

                <div className="pt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowAgentModal(false)}
                    className="px-4 py-2 rounded-lg border border-border-custom text-muted hover:text-foreground text-xs font-semibold"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 bg-primary text-white font-bold rounded-lg text-xs hover:bg-primary/95 transition-all"
                  >
                    Register Agent
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* ── Add Bank Mapping Modal ── */}
        {showBankModal && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setShowBankModal(false)}>
            <div className="bg-card border border-border-custom rounded-xl w-full max-w-md p-6 relative overflow-hidden" onClick={e => e.stopPropagation()}>
              <div className="flex justify-between items-start pb-3 border-b border-border-custom">
                <div>
                  <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">Add Bank Ledger Mapping</h3>
                  <p className="text-[10px] text-muted mt-0.5">Map SiteFlow bank account to Tally ledger</p>
                </div>
                <button onClick={() => setShowBankModal(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
              </div>

              <form onSubmit={handleSaveBankMapping} className="space-y-3 my-4 text-xs">
                <div>
                  <label className="text-[10px] text-muted uppercase font-bold block mb-1">SiteFlow Bank Account Details*</label>
                  <input
                    type="text"
                    required
                    value={bankForm.onsite_bank_account_details}
                    onChange={(e) => setBankForm({ ...bankForm, onsite_bank_account_details: e.target.value })}
                    placeholder="e.g. HDFC Bank - A/c 50200012345678"
                    className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs"
                  />
                </div>

                <div>
                  <label className="text-[10px] text-muted uppercase font-bold block mb-1">Tally Ledger Name*</label>
                  <input
                    type="text"
                    required
                    value={bankForm.tally_ledger_name}
                    onChange={(e) => setBankForm({ ...bankForm, tally_ledger_name: e.target.value })}
                    placeholder="e.g. HDFC Bank A/c"
                    className="w-full bg-background border border-border-custom rounded-lg px-3 py-2 text-foreground focus:outline-none focus:border-primary text-xs"
                  />
                </div>

                <div className="pt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowBankModal(false)}
                    className="px-4 py-2 rounded-lg border border-border-custom text-muted hover:text-foreground text-xs font-semibold"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 bg-primary text-white font-bold rounded-lg text-xs hover:bg-primary/95 transition-all"
                  >
                    Save Mapping
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
