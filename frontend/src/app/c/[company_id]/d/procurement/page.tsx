"use client";
import Badge, { type BadgeTone } from "@/components/ui/Badge";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useProject } from "@/context/ProjectContext";
import { useCompanySettings } from "@/context/CompanySettingsContext";
import { getApiHost, readErrorDetail } from "@/lib/api";
import { authHeaders, downloadWithAuth, formatDate, formatLabel, todayLocalISO } from "@/lib/siteflow";
import Icon, { type IconName } from "@/components/marketing/Icon";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import SegmentedTabs from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import FieldHint from "@/components/ui/FieldHint";

// Types
interface IndentItem {
  name: string;
  qty: number;
  unit: string;
  specOverride?: string;
  photoUrl?: string;
}

interface Indent {
  id: string;
  indentNumber: string;
  items: IndentItem[];
  status: "pending" | "approved" | "ordered" | "rejected" | "cancelled";
  requestedBy: string;
  date: string;
}

interface POItem {
  id?: string;
  name: string;
  qty: number;
  unit: string;
  rate: number;
  tax_pct?: number;
}

interface PO {
  id: string;
  poNumber: string;
  vendor: string;
  items: POItem[];
  grossAmount: number;
  taxAmount: number;
  totalAmount: number;
  status: "draft" | "approved" | "sent" | "partial" | "received" | "closed" | "cancelled";
  approvalFlag: "pending" | "approved" | "rejected";
  date: string;
  expectedDeliveryDate?: string | null;
}

interface GRNItem {
  name: string;
  qty: number;
  unit: string;
  rate: number;
}

interface GRN {
  id: string;
  grnNumber: string;
  poNumber: string;
  vendor: string;
  receivedDate: string;
  receivedBy: string;
  items: GRNItem[];
  isBilled: boolean;
  isCancelled?: boolean;
  gatePhotoUrl?: string;
}

interface InventoryItem {
  name: string;
  onHand: number;
  reserved: number;
  unit: string;
  minAlertThreshold: number;
}

interface Transaction {
  id: string;
  materialName: string;
  qty: number;
  unit: string;
  type: "received" | "used" | "transferred" | "returned";
  sourceRef: string;
  date: string;
}

export default function ProcurementPage() {
  const { company_id } = useParams();
  const companyId = company_id || "demo-company";
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;
  const { quantityDecimalPlaces } = useCompanySettings();

  const fmtQty = (val: number | string | null | undefined) => {
    const num = Number(val) || 0;
    return new Intl.NumberFormat("en-IN", {
      minimumFractionDigits: 0,
      maximumFractionDigits: quantityDecimalPlaces,
    }).format(num);
  };

  const [tab, setTab] = useState<"po" | "indent" | "inventory" | "ledger" | "unbilled">("po");

  useEffect(() => {
    if (typeof window !== "undefined") {
      const queryParams = new URLSearchParams(window.location.search);
      const queryTab = queryParams.get("tab");
      if (queryTab && ["po", "indent", "inventory", "ledger", "unbilled"].includes(queryTab)) {
        setTab(queryTab as any);
      }
    }
  }, []);

  // State managers
  const [indents, setIndents] = useState<Indent[]>([]);
  const [indentScope, setIndentScope] = useState<"project" | "company">("project");
  const [pos, setPos] = useState<PO[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [grns, setGrns] = useState<GRN[]>([]);
  const [isOffline, setIsOffline] = useState(false);

  const fetchIndentsByScope = async (scope: "project" | "company" = indentScope) => {
    try {
      const apiHost = getApiHost();
      const url = scope === "company"
        ? `${apiHost}/apis/v3/procurement/indents/company/${companyId}`
        : `${apiHost}/apis/v3/procurement/indents?project_id=${projectId}`;
      const indentsRes = await fetch(url, { headers: authHeaders() });
      if (indentsRes.ok) {
        const data = await indentsRes.json();
        const mapped = (Array.isArray(data) ? data : []).map((ind: any) => ({
          id: ind.id,
          indentNumber: ind.indent_number,
          projectId: ind.project_id,
          projectName: ind.project_id === projectId ? "Active Project" : `Project ${String(ind.project_id).slice(0, 8)}`,
          items: (ind.items || []).map((item: any) => ({ name: item.material_name, qty: item.quantity, unit: item.unit })),
          status: ind.status,
          requestedBy: "Auto-synced",
          date: ind.created_at ? ind.created_at.split("T")[0] : "",
        }));
        setIndents(mapped);
      }
    } catch (e) {
      console.error("Failed to fetch indents by scope", e);
    }
  };

  const fetchProcurementData = async () => {
    if (!projectId) return;
    try {
      const apiHost = getApiHost();
      const [teamRes, indentsRes, posRes, grnsRes, invRes, vendorsRes, materialsRes, matchesRes, txnsRes] = await Promise.all([
        fetch(`${apiHost}/apis/v3/crm/team-members/${companyId}`, { headers: authHeaders() }),
        fetch(indentScope === "company" ? `${apiHost}/apis/v3/procurement/indents/company/${companyId}` : `${apiHost}/apis/v3/procurement/indents?project_id=${projectId}`, { headers: authHeaders() }),
        fetch(`${apiHost}/apis/v3/procurement/pos?project_id=${projectId}`, { headers: authHeaders() }),
        fetch(`${apiHost}/apis/v3/procurement/grns?project_id=${projectId}`, { headers: authHeaders() }),
        fetch(`${apiHost}/apis/v3/procurement/inventory?project_id=${projectId}`, { headers: authHeaders() }),
        fetch(`${apiHost}/apis/v3/library/parties/${companyId}`, { headers: authHeaders() }),
        fetch(`${apiHost}/apis/v3/library/materials/${companyId}`, { headers: authHeaders() }),
        fetch(`${apiHost}/apis/v3/three-way/${companyId}`, { headers: authHeaders() }),
        fetch(`${apiHost}/apis/v3/procurement/transactions?project_id=${projectId}`, { headers: authHeaders() }),
      ]);

      const cancelledGrnIds = new Set<string>();
      if (txnsRes.ok) {
        const txData = await txnsRes.json();
        const txArr = Array.isArray(txData) ? txData : [];
        txArr.forEach((t: any) => {
          if (t.type === "grn_cancellation" && t.source_ref_id) {
            cancelledGrnIds.add(String(t.source_ref_id));
          }
        });
        setTransactions(txArr.map((t: any) => ({
          id: t.id,
          materialName: t.material_name,
          qty: t.qty,
          unit: t.unit || "Unit",
          type: t.type,
          sourceRef: t.source_ref_id || "",
          date: t.created_at ? t.created_at.split("T")[0] : "",
        })));
      }

      const billedGrnIds = new Set<string>();
      if (matchesRes.ok) {
        const mdata = await matchesRes.json();
        (Array.isArray(mdata) ? mdata : []).forEach((m: any) => {
          if (m.grn_id) billedGrnIds.add(String(m.grn_id));
        });
      }

      const teamMembersArr: Array<{ id: string; name: string }> = [];
      if (teamRes.ok) {
        const tdata = await teamRes.json();
        (Array.isArray(tdata) ? tdata : []).forEach((t: any) => {
          teamMembersArr.push({ id: String(t.id), name: t.name || "Member" });
        });
        setTeamMembers(teamMembersArr);
      }
      const teamById: Record<string, string> = {};
      teamMembersArr.forEach((t) => (teamById[t.id] = t.name));

      if (materialsRes.ok) {
        const mdata = await materialsRes.json();
        setMaterials(mdata.map((m: any) => ({ id: m.id, name: m.name, unit: m.unit || "", gst_rate: typeof m.gst_rate === "number" ? m.gst_rate : null })));
      }

      const vendorOptionsArr: Array<{ id: string; name: string }> = [];
      if (vendorsRes.ok) {
        const vdata = await vendorsRes.json();
        // Purchase orders buy materials, so the vendor comes from the party
        // master. This used to read /billing/subcontractors, which meant the
        // "Supplier Vendor" picker offered only subcontractors and a registered
        // Supplier could never be selected on a PO.
        const buyable = new Set(["supplier", "material supplier", "equipment supplier", "contractor", "subcontractor", "labour contractor"]);
        (vdata || [])
          .filter((v: any) => !v.party_type || buyable.has(String(v.party_type).toLowerCase()))
          .forEach((v: any) => vendorOptionsArr.push({ id: String(v.id), name: v.name }));
        setVendorOptions(vendorOptionsArr);
      }
      const vendorById: Record<string, string> = {};
      vendorOptionsArr.forEach((v) => (vendorById[v.id] = v.name));

      if (indentsRes.ok) {
        const data = await indentsRes.json();
        const mapped = data.map((ind: any) => ({
          id: ind.id,
          indentNumber: ind.indent_number,
          projectId: ind.project_id,
          projectName: ind.project_id === projectId ? "Active Project" : `Project ${String(ind.project_id).slice(0, 8)}`,
          items: (ind.items || []).map((item: any) => ({ name: item.material_name, qty: item.quantity, unit: item.unit })),
          status: ind.status,
          requestedBy: ind.requested_by ? (teamById[String(ind.requested_by)] || "Site Member") : "Auto-synced",
          date: ind.created_at ? ind.created_at.split("T")[0] : "",
        }));
        setIndents(mapped);
      }
      if (posRes.ok) {
        const data = await posRes.json();
        const mapped = data.map((po: any) => ({
          id: po.id,
          poNumber: po.po_number,
          vendor: po.vendor_name || (po.vendor_id ? (vendorById[String(po.vendor_id)] || "—") : "—"),
          items: (po.items || []).map((item: any) => ({
            id: item.id,
            name: item.material_name,
            qty: item.quantity,
            unit: item.unit,
            rate: item.rate,
            tax_pct: item.tax_pct ?? 18,
          })),
          grossAmount: po.gross_amount,
          taxAmount: po.tax_amount,
          totalAmount: po.total_amount,
          status: po.status,
          approvalFlag: po.approval_flag,
          date: po.po_date ? po.po_date.split("T")[0] : "",
          expectedDeliveryDate: po.expected_delivery_date || null,
        }));
        setPos(mapped);
      }
      if (grnsRes.ok) {
        const data = await grnsRes.json();
        const mapped = data.map((grn: any) => ({
          id: grn.id,
          grnNumber: grn.grn_number,
          poNumber: "",
          vendor: "",
          receivedDate: grn.received_date ? grn.received_date.split("T")[0] : "",
          receivedBy: grn.received_by ? (teamById[String(grn.received_by)] || "Store Incharge") : "Auto-synced",
          items: (grn.items || []).map((item: any) => ({ name: "", qty: item.received_qty, unit: "", rate: 0 })),
          isBilled: billedGrnIds.has(String(grn.id)),
          isCancelled: cancelledGrnIds.has(String(grn.id)),
        }));
        setGrns(mapped);
      }
      if (invRes.ok) {
        const data = await invRes.json();
        const mapped = data.map((inv: any) => ({
          name: inv.material_name,
          onHand: inv.on_hand_qty,
          reserved: inv.reserved_qty,
          unit: inv.unit,
          minAlertThreshold: 0,
        }));
        setInventory(mapped);
      }
      setIsOffline(false);
    } catch (err) {
      console.error("Procurement API unavailable", err);
      setIsOffline(true);
    }
  };

  useEffect(() => {
    fetchProcurementData();
  }, [projectId]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${getApiHost()}/apis/v3/settings/company-terms/${companyId}`, { headers: authHeaders() });
        if (r.ok) {
          const d = await r.json();
          setPoDefaultTerms(d.purchase_order_terms || "");
        }
      } catch {
        /* ignore: terms are optional */
      }
    })();
  }, [companyId]);

  // Modal and drawer control states
  const [showIndentModal, setShowIndentModal] = useState(false);
  const [showPOModal, setShowPOModal] = useState(false);
  const [showGRNModal, setShowGRNModal] = useState(false);
  const [showUseModal, setShowUseModal] = useState(false);
  const [showRFQDrawer, setShowRFQDrawer] = useState(false);
  const [selectedRFQItem, setSelectedRFQItem] = useState<string>("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // Team members for user attribution
  const [teamMembers, setTeamMembers] = useState<Array<{ id: string; name: string }>>([]);

  // New Indent form state
  const [newIndentNum, setNewIndentNum] = useState("");
  const [newIndentMaterial, setNewIndentMaterial] = useState("");
  const [newIndentQty, setNewIndentQty] = useState(50);
  const [newIndentUnit, setNewIndentUnit] = useState("");
  const [newIndentSpec, setNewIndentSpec] = useState("");
  const [newIndentRequestedBy, setNewIndentRequestedBy] = useState("");

  // New PO form state (Multi-item support with tax and expected delivery date)
  const [newPONum, setNewPONum] = useState("");
  const [newPOVendor, setNewPOVendor] = useState("");
  const [newPOExpectedDeliveryDate, setNewPOExpectedDeliveryDate] = useState("");
  const [vendorOptions, setVendorOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [materials, setMaterials] = useState<Array<{ id: string; name: string; unit: string; gst_rate: number | null }>>([]);
  const [poFormItems, setPoFormItems] = useState<POItem[]>([
    { name: "", qty: 0, unit: "", rate: 0, tax_pct: 18 }
  ]);
  const [newPOTerms, setNewPOTerms] = useState("");
  const [poDefaultTerms, setPoDefaultTerms] = useState("");

  useEffect(() => {
    if (showPOModal && !newPOTerms) setNewPOTerms(poDefaultTerms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPOModal]);

  // GRN form state
  const [selectedPOForGRN, setSelectedPOForGRN] = useState<PO | null>(null);
  const [grnNum, setGrnNum] = useState("");
  const [grnReceivedBy, setGrnReceivedBy] = useState("");
  const [grnItemsChecked, setGrnItemsChecked] = useState<Record<string, boolean>>({});
  const [grnReceivedQtys, setGrnReceivedQtys] = useState<Record<string, string>>({});
  // D-010: gate photo upload removed until object storage exists
  // Material usage form state
  const [useMaterialName, setUseMaterialName] = useState("");
  const [useQty, setUseQty] = useState(10);
  const [useSourceRef, setUseSourceRef] = useState("");

  // Add Material Indent Submission
  const handleCreateIndent = async () => {
    const requestedName = teamMembers.find(t => t.id === newIndentRequestedBy)?.name || "Site Engineer";
    const newIndent: Indent = {
      id: `IND-${Date.now()}`,
      indentNumber: newIndentNum,
      items: [{ 
        name: newIndentMaterial, 
        qty: newIndentQty, 
        unit: newIndentUnit, 
        specOverride: newIndentSpec || undefined,
      }],
      status: "pending",
      requestedBy: requestedName,
      date: todayLocalISO()
    };

    try {
      const apiHost = getApiHost();
      const res = await fetch(`${apiHost}/apis/v3/procurement/indents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id: companyId,
          project_id: projectId,
          indent_number: newIndentNum,
          requested_by: newIndentRequestedBy || null,
          items: [{ material_name: newIndentMaterial, quantity: newIndentQty, unit: newIndentUnit }],
        }),
      });
      if (res.ok) {
        const saved = await res.json();
        newIndent.id = saved.id;
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
        return;
      }
    } catch (err) {
      console.error("Indent create error, using local only:", err);
    }

    setIndents([newIndent, ...indents]);
    setShowIndentModal(false);
    setNewIndentSpec("");
    setNewIndentNum("");
    setNewIndentRequestedBy("");
  };

  // Approve Indent
  const handleApproveIndent = async (id: string) => {
    try {
      const apiHost = getApiHost();
      const res = await fetch(`${apiHost}/apis/v3/procurement/indents/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Approval failed: ${typeof err.detail === "string" ? err.detail : `HTTP ${res.status}`}`);
        return;
      }
      fetchProcurementData();
    } catch (err) {
      console.error("Indent approve error:", err);
      alert("Approval failed. Check your connection.");
    }
  };

  // Reject Indent
  const handleRejectIndent = async (id: string) => {
    try {
      const apiHost = getApiHost();
      const res = await fetch(`${apiHost}/apis/v3/procurement/indents/${id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Rejection failed: ${typeof err.detail === "string" ? err.detail : `HTTP ${res.status}`}`);
        return;
      }
      fetchProcurementData();
    } catch (err) {
      console.error("Indent reject error:", err);
      alert("Rejection failed. Check your connection.");
    }
  };

  // Cancel Indent
  const handleCancelIndent = async (id: string) => {
    if (!confirm("Are you sure you want to cancel this indent? Any reserved stock held for this indent will be released.")) {
      return;
    }
    try {
      const apiHost = getApiHost();
      const res = await fetch(`${apiHost}/apis/v3/procurement/indents/${id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Cancellation failed: ${typeof err.detail === "string" ? err.detail : `HTTP ${res.status}`}`);
        return;
      }
      fetchProcurementData();
    } catch (err) {
      console.error("Indent cancel error:", err);
      alert("Cancellation failed. Check your connection.");
    }
  };

  // Add Purchase Order Submission (Multi-item support with line-item tax and delivery date)
  const handleCreatePO = async () => {
    let gross = 0;
    let totalTax = 0;
    poFormItems.forEach(item => {
      const lineGross = (item.qty || 0) * (item.rate || 0);
      const taxRate = typeof item.tax_pct === "number" ? item.tax_pct : 18;
      const lineTax = lineGross * (taxRate / 100);
      gross += lineGross;
      totalTax += lineTax;
    });
    const total = gross + totalTax;

    const newPO: PO = {
      id: `PO-${Date.now()}`,
      poNumber: newPONum,
      vendor: vendorOptions.find((v) => v.id === newPOVendor)?.name || "—",
      items: poFormItems,
      grossAmount: gross,
      taxAmount: totalTax,
      totalAmount: total,
      status: "draft",
      approvalFlag: "pending",
      date: todayLocalISO(),
      expectedDeliveryDate: newPOExpectedDeliveryDate || null,
    };

    try {
      const apiHost = getApiHost();
      const dupRes = await fetch(`${apiHost}/apis/v3/procurement/duplicate-po-check?company_id=${companyId}&po_number=${encodeURIComponent(newPONum)}`, { headers: authHeaders() });
      if (dupRes.ok) {
        const dupData = await dupRes.json();
        if (dupData.is_duplicate) {
          alert(`Duplicate PO number: ${dupData.message}`);
          return;
        }
      }

      const res = await fetch(`${apiHost}/apis/v3/procurement/pos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id: companyId,
          project_id: projectId,
          po_number: newPONum,
          po_date: new Date().toISOString(),
          expected_delivery_date: newPOExpectedDeliveryDate ? new Date(newPOExpectedDeliveryDate).toISOString() : null,
          // The picker lists Party Library entries, so send the party id and
          // let the backend resolve the company_team row that vendor_id must
          // point at. Sending a party id as vendor_id would violate that FK.
          vendor_party_id: newPOVendor || null,
          items: poFormItems.map(item => ({
            material_name: item.name,
            quantity: item.qty,
            unit: item.unit,
            rate: item.rate,
            tax_pct: typeof item.tax_pct === "number" ? item.tax_pct : 18.0,
          })),
          terms: newPOTerms || null,
        }),
      });
      if (res.ok) {
        const saved = await res.json();
        newPO.id = saved.id;
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
        return;
      }
    } catch (err) {
      console.error("PO create error, using local only:", err);
    }

    setPos([newPO, ...pos]);
    setShowPOModal(false);
    setPoFormItems([{ name: "", qty: 0, unit: "", rate: 0, tax_pct: 18 }]);
    setNewPOTerms("");
    setNewPONum("");
    setNewPOVendor("");
    setNewPOExpectedDeliveryDate("");
  };

  // Approve PO
  const handleApprovePO = async (id: string) => {
    try {
      const apiHost = getApiHost();
      const res = await fetch(`${apiHost}/apis/v3/procurement/pos/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      });
      if (!res.ok) {
        const err = await readErrorDetail(res);
        alert(err || "Failed to approve purchase order");
        return;
      }
      fetchProcurementData();
    } catch (err) {
      console.error("PO approve error:", err);
      alert("Approval failed. Check your connection.");
    }
  };

  // Reject PO
  const handleRejectPO = async (id: string) => {
    if (!confirm("Are you sure you want to reject this purchase order?")) return;
    try {
      const apiHost = getApiHost();
      const res = await fetch(`${apiHost}/apis/v3/procurement/pos/${id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      });
      if (!res.ok) {
        const err = await readErrorDetail(res);
        alert(err || "Failed to reject purchase order");
        return;
      }
      fetchProcurementData();
    } catch (err) {
      console.error("PO reject error:", err);
      alert("Failed to reject purchase order. Check your connection.");
    }
  };

  // Cancel PO
  const handleCancelPO = async (id: string) => {
    if (!confirm("Are you sure you want to cancel this purchase order?")) return;
    try {
      const apiHost = getApiHost();
      const res = await fetch(`${apiHost}/apis/v3/procurement/pos/${id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      });
      if (!res.ok) {
        const err = await readErrorDetail(res);
        alert(err || "Failed to cancel purchase order");
        return;
      }
      fetchProcurementData();
    } catch (err) {
      console.error("PO cancel error:", err);
      alert("Failed to cancel purchase order. Check your connection.");
    }
  };

  // Close PO
  const handleClosePO = async (id: string) => {
    if (!confirm("Are you sure you want to mark this purchase order as closed / completed?")) return;
    try {
      const apiHost = getApiHost();
      const res = await fetch(`${apiHost}/apis/v3/procurement/pos/${id}/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      });
      if (!res.ok) {
        const err = await readErrorDetail(res);
        alert(err || "Failed to close purchase order");
        return;
      }
      fetchProcurementData();
    } catch (err) {
      console.error("PO close error:", err);
      alert("Failed to close purchase order. Check your connection.");
    }
  };

  // Initialize GRN items
  const handleOpenGRNModal = (po: PO) => {
    setSelectedPOForGRN(po);
    const checks: Record<string, boolean> = {};
    const qtys: Record<string, string> = {};
    po.items.forEach((item, idx) => {
      checks[idx.toString()] = true;
      qtys[idx.toString()] = item.qty.toString();
    });
    setGrnItemsChecked(checks);
    setGrnReceivedQtys(qtys);
    setShowGRNModal(true);
  };

  // GRN submission
  const handleCreateGRN = async () => {
    if (!selectedPOForGRN) return;
    
    const receivedItems = selectedPOForGRN.items
      .map((item, idx) => ({
        id: item.id,
        name: item.name,
        qty: parseFloat(grnReceivedQtys[idx.toString()] || "0"),
        unit: item.unit,
        rate: item.rate
      }))
      .filter((_, idx) => grnItemsChecked[idx.toString()]);

    if (receivedItems.length === 0) return;
    if (receivedItems.some((item) => !item.id)) {
      alert("Some PO items are missing references; GRN not submitted");
      return;
    }

    try {
      const apiHost = getApiHost();
      const res = await fetch(`${apiHost}/apis/v3/procurement/grns`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id: companyId,
          project_id: projectId,
          po_id: selectedPOForGRN.id,
          ...(grnNum.trim() ? { grn_number: grnNum.trim() } : {}),
          received_date: todayLocalISO(),
          received_by: grnReceivedBy || null,
          items: receivedItems.map((item) => ({ po_item_id: item.id, received_qty: item.qty })),
        }),
      });
      if (!res.ok) {
        const err = await readErrorDetail(res);
        alert(`Failed to record GRN: ${err}`);
        return;
      }
    } catch (err) {
      console.error("GRN create error:", err);
      alert("Failed to record GRN. Check your connection.");
      return;
    }

    setShowGRNModal(false);
    setSelectedPOForGRN(null);
    setGrnReceivedBy("");
    fetchProcurementData();
  };

  // Record material usage
  const handleRecordUsage = async () => {
    const qty = parseFloat(useQty as any) || 0;
    if (qty <= 0) return;
    if (!useMaterialName) {
      alert("Select a material first.");
      return;
    }
    try {
      const apiHost = getApiHost();
      const res = await fetch(`${apiHost}/apis/v3/procurement/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          project_id: projectId,
          material_name: useMaterialName,
          qty,
          type: "used",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Failed to log usage: ${typeof err.detail === "string" ? err.detail : `HTTP ${res.status}`}`);
        return;
      }
      setShowUseModal(false);
      fetchProcurementData();
    } catch (e) {
      console.error("Usage log error:", e);
      alert("Failed to log usage. Check your connection.");
    }
  };

  // Mark GRN as billed (Unbilled Materials tracker action)
  const handleMarkAsBilled = (_grnId: string) => {
    alert("GRN billing is reconciled server-side via 3-Way Matching against an invoice; this tracker now reflects matched GRNs and there is no manual mark-billed endpoint, so this action cannot persist.");
  };

  const [cancellingGrnId, setCancellingGrnId] = useState<string | null>(null);

  const handleCancelGRN = async (grn: GRN) => {
    const grnLabel = grn.grnNumber || "this GRN";
    const ok = window.confirm(
      `Are you sure you want to cancel ${grnLabel}? Received material quantities will be deducted back out of warehouse inventory.`
    );
    if (!ok) return;

    setCancellingGrnId(grn.id);
    try {
      const apiHost = getApiHost();
      const res = await fetch(`${apiHost}/apis/v3/procurement/grns/${grn.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      });
      if (res.ok) {
        fetchProcurementData();
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to cancel GRN");
      }
    } catch (e: any) {
      alert(e?.message || "Failed to cancel GRN. Check your connection.");
    } finally {
      setCancellingGrnId(null);
    }
  };

  // 3-way matching check helper
  const getThreeWayMatchStatus = (grn: GRN) => {
    const matchingPO = pos.find(p => p.poNumber === grn.poNumber);
    if (!matchingPO) return { match: false, text: "No PO Found" };
    
    let match = true;
    let reason = "";

    grn.items.forEach(gItem => {
      const poItem = matchingPO.items.find(p => p.name === gItem.name);
      if (!poItem) {
        match = false;
        reason = "Item mismatch";
      } else {
        if (poItem.rate !== gItem.rate) {
          match = false;
          reason = "Rate mismatch";
        }
        if (gItem.qty > poItem.qty) {
          match = false;
          reason = "Qty excess";
        }
      }
    });

    return { match, text: match ? "3-Way Match Verified" : `Mismatch: ${reason}` };
  };
  // Compute unbilled GRNs grouped by vendor
  const unbilledGRNs = grns.filter(g => !g.isBilled);
  const unbilledByVendor = unbilledGRNs.reduce<Record<string, { vendor: string; grns: GRN[]; totalValue: number }>>((acc, g) => {
    if (!acc[g.vendor]) acc[g.vendor] = { vendor: g.vendor, grns: [], totalValue: 0 };
    acc[g.vendor].grns.push(g);
    acc[g.vendor].totalValue += g.items.reduce((s, i) => s + i.qty * i.rate, 0);
    return acc;
  }, {});

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ── Top Bar Switcher ── */}
      <div className="px-6 py-2 border-b border-border-custom bg-card shrink-0 flex items-center justify-between overflow-x-auto gap-3">
        <SegmentedTabs
          tabs={[
            { id: "po", label: "PO", icon: <Icon name="description" className="w-3.5 h-3.5" /> },
            { id: "indent", label: "Indent", icon: <Icon name="inbox" className="w-3.5 h-3.5" /> },
            { id: "inventory", label: "Inventory", icon: <Icon name="package" className="w-3.5 h-3.5" /> },
            { id: "ledger", label: "Ledger", icon: <Icon name="receipt" className="w-3.5 h-3.5" /> },
            { id: "unbilled", label: "Unbilled", icon: <Icon name="warning" className="w-3.5 h-3.5" /> },
          ]}
          activeTab={tab}
          onChange={(t) => setTab(t as any)}
        />
        <Link href={`/c/${companyId}/d/procurement/vendor-performance`} className="whitespace-nowrap px-3 py-1.5 rounded-md text-xs font-semibold transition-all text-muted hover:text-foreground hover:bg-elevated inline-flex items-center gap-1.5 shrink-0 border border-border-custom">
          <Icon name="bar_chart" className="w-3.5 h-3.5" />Vendor Performance
        </Link>
      </div>

      {/* Main Framework */}
      <main className="flex-1 flex flex-col overflow-hidden h-full">
        {isOffline && (
          <div className="px-6 py-2.5 bg-warning/10 border-b border-warning/20 text-warning text-xs">
            Offline mode: backend connection unavailable
          </div>
        )}
        <PageHeader
          title="Site Material Procurement"
          subtitle="SiteFlow purchase orders, indents and inventory workflows"
        >
          <div className="flex items-center gap-2">
            <button onClick={() => { setSelectedRFQItem(""); setShowRFQDrawer(true); }} className="px-3.5 py-1.5 border border-primary/20 hover:bg-primary/10 rounded-md text-xs font-bold text-primary transition-all inline-flex items-center gap-1.5 cursor-pointer">
              <Icon name="bolt" className="w-3.5 h-3.5" />Compare RFQs
            </button>
            <button onClick={() => setShowIndentModal(true)} className="px-3.5 py-1.5 border border-border-custom hover:bg-elevated rounded-md text-xs font-bold text-foreground transition-all cursor-pointer">
              + Material Indent
            </button>
            <button onClick={() => setShowPOModal(true)} className="px-3.5 py-1.5 border border-border-custom hover:bg-elevated rounded-md text-xs font-bold text-foreground transition-all cursor-pointer">
              + Purchase Order
            </button>
            <button onClick={() => setShowUseModal(true)} className="px-3.5 py-1.5 bg-primary rounded-md text-xs font-bold text-white hover:opacity-90 transition-all cursor-pointer">
              Log Usage
            </button>
          </div>
        </PageHeader>

        {/* Content Workspace */}
        <div className="flex-1 overflow-y-auto">
          <PageShell width="wide">
          
          {/* TAB 1: INDENTS / REQUISITIONS */}
          {tab === "indent" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <h2 className="text-xs font-bold text-muted uppercase tracking-wider">Indent & Requisitions</h2>
                  <p className="text-[10px] text-muted mt-0.5">
                    {indentScope === "company" ? "Showing all indents across all company projects" : "Showing indents for currently active project"}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 bg-card border border-border-custom p-1 rounded-lg">
                  <button
                    type="button"
                    onClick={() => {
                      setIndentScope("project");
                      fetchIndentsByScope("project");
                    }}
                    className={`px-3 py-1 text-xs font-bold rounded cursor-pointer transition-all ${
                      indentScope === "project" ? "bg-primary text-white" : "text-muted hover:text-foreground"
                    }`}
                  >
                    Project Indents
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIndentScope("company");
                      fetchIndentsByScope("company");
                    }}
                    className={`px-3 py-1 text-xs font-bold rounded cursor-pointer transition-all ${
                      indentScope === "company" ? "bg-primary text-white" : "text-muted hover:text-foreground"
                    }`}
                  >
                    Company All Indents
                  </button>
                </div>
              </div>
              {indents.length === 0 ? (
                <EmptyState
                  title={indentScope === "company" ? "No company indents found" : "No project indents found"}
                  description={indentScope === "company" ? "No requisitions have been raised across any company projects." : "Create your first material requisition to request site materials from procurement."}
                  action={{
                    label: "+ Material Indent",
                    onClick: () => setShowIndentModal(true),
                  }}
                />
              ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {indents.map((ind) => (
                  <div key={ind.id} className="bg-card border border-border-custom rounded-lg p-5 space-y-4">
                    <div className="flex justify-between items-center text-xs">
                      <div className="flex items-center gap-2">
                        <strong className="text-foreground font-extrabold">{ind.indentNumber}</strong>
                        {indentScope === "company" && (
                          <span className="text-[10px] bg-elevated text-muted px-2 py-0.5 rounded font-semibold border border-border-custom">
                            {(ind as any).projectName || "Project"}
                          </span>
                        )}
                      </div>
                      <Badge tone={ind.status === "approved" ? "success" : (ind.status === "cancelled" || ind.status === "rejected") ? "neutral" : "warning"} className="uppercase font-bold">{formatLabel(ind.status)}</Badge>
                    </div>

                    <div className="space-y-2 border-t border-border-custom pt-3">
                      {ind.items.map((item, i) => {
                        // Find current warehouse stock context directly on indent card (Screen 5720)
                        const stock = inventory.find(inv => inv.name === item.name);
                        return (
                          <div key={i} className="flex justify-between items-center text-xs">
                            <span className="font-semibold text-foreground">{item.name}</span>
                            <div className="flex items-center gap-3">
                              <span className="text-muted font-sans font-bold">{item.qty} {item.unit}</span>
                              {stock && (() => {
                                const avail = stock.onHand - stock.reserved;
                                return (
                                  <span className={`text-[10px] px-2 py-0.5 rounded font-sans ${avail < 0 ? "bg-danger/10 text-danger border border-danger/20 font-bold" : "bg-elevated text-muted"}`}>
                                    avail: <span className={`font-bold ${avail < 0 ? "text-danger" : "text-foreground"}`}>{avail}</span>
                                    {avail < 0 && <span className="ml-1 text-[9px] font-normal">(needs reconciling)</span>}
                                  </span>
                                );
                              })()}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="flex justify-between items-center pt-2 border-t border-border-custom text-[11px] text-muted">
                      <span>By {ind.requestedBy} on {formatDate(ind.date)}</span>
                      {ind.status === "pending" && (
                        <div className="flex gap-2">
                          <button onClick={() => handleApproveIndent(ind.id)} className="px-3 py-1 bg-success/10 text-success border border-success/20 rounded font-bold hover:bg-success/20">Approve</button>
                          <button onClick={() => handleRejectIndent(ind.id)} className="px-3 py-1 bg-danger/10 text-danger border border-danger/20 rounded font-bold hover:bg-danger/20">Reject</button>
                        </div>
                      )}
                      {(ind.status === "approved" || ind.status === "ordered") && (
                        <div className="flex gap-2">
                          <button onClick={() => handleCancelIndent(ind.id)} className="px-3 py-1 bg-danger/10 text-danger border border-danger/20 rounded font-bold hover:bg-danger/20">Cancel Indent</button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              )}
            </div>
          )}

          {/* TAB 2: PURCHASE ORDERS */}
          {tab === "po" && (
            <div className="space-y-4">
              <h2 className="text-xs font-bold text-muted uppercase tracking-wider">Purchase Orders</h2>
              <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-elevated text-muted border-b border-border-custom">
                      <tr>
                        <th className="px-5 py-3 font-semibold">PO No.</th>
                        <th className="px-5 py-3 font-semibold">Vendor</th>
                        <th className="px-5 py-3 font-semibold">Item Line(s)</th>
                        <th className="px-5 py-3 font-semibold">Approval</th>
                        <th className="px-5 py-3 font-semibold">Status</th>
                        <th className="px-5 py-3 font-semibold text-right">Total Amount</th>
                        <th className="px-5 py-3 font-semibold text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pos.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="p-8">
                            <EmptyState
                              title="No purchase orders found"
                              description="Create purchase orders to procure materials and equipment from suppliers."
                              action={{
                                label: "+ Purchase Order",
                                onClick: () => setShowPOModal(true),
                              }}
                            />
                          </td>
                        </tr>
                      ) : (
                        pos.map((po) => (
                          <tr key={po.id} className="border-b border-border-custom hover:bg-elevated transition-all align-top">
                            <td className="px-5 py-3 font-sans text-foreground whitespace-nowrap">
                              <div className="font-bold text-foreground">{po.poNumber}</div>
                              <div className="text-[10px] text-muted font-normal">Date: {formatDate(po.date)}</div>
                              {po.expectedDeliveryDate && (
                                <div className="text-[10px] text-primary font-medium mt-0.5">Exp: {formatDate(po.expectedDeliveryDate)}</div>
                              )}
                            </td>
                            <td className="px-5 py-3 text-foreground whitespace-nowrap">{po.vendor}</td>
                            <td className="px-5 py-3 space-y-1">
                              {po.items.map((item, i) => (
                                <div key={i} className="text-muted text-xs">
                                  <span className="font-semibold text-foreground">{item.name}</span>{" "}
                                  <span className="text-muted">{item.qty} {item.unit} @ ₹{item.rate.toLocaleString("en-IN")}</span>
                                  {typeof item.tax_pct === "number" && item.tax_pct > 0 ? (
                                    <span className="text-[10px] ml-1 bg-elevated px-1.5 py-0.2 rounded text-muted font-medium border border-border-custom">+{item.tax_pct}% GST</span>
                                  ) : (
                                    <span className="text-[10px] ml-1 bg-elevated px-1.5 py-0.2 rounded text-muted border border-border-custom">0% Tax</span>
                                  )}
                                </div>
                              ))}
                            </td>
                            <td className="px-5 py-3">
                              <Badge tone={po.approvalFlag === "approved" ? "success" : po.approvalFlag === "rejected" ? "danger" : "warning"} className="uppercase font-bold">{formatLabel(po.approvalFlag)}</Badge>
                            </td>
                            <td className="px-5 py-3">
                              <Badge tone={(po.status === "received" || po.status === "closed") ? "success" : "primary"} className="uppercase font-bold">{formatLabel(po.status)}</Badge>
                            </td>
                            <td className="px-5 py-3 text-right font-sans whitespace-nowrap">
                              <div className="font-bold text-foreground">₹{po.totalAmount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                              <div className="text-[10px] text-muted font-normal">
                                Sub: ₹{po.grossAmount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Tax: ₹{po.taxAmount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </div>
                            </td>
                            <td className="px-5 py-3 text-right whitespace-nowrap">
                              <div className="flex gap-2 justify-end">
                                <button
                                  type="button"
                                  onClick={async () => {
                                    try {
                                      await downloadWithAuth(`/procurement/pos/${po.id}/pdf`);
                                    } catch (e) {
                                      alert(`Download failed (${e instanceof Error ? e.message : "unknown error"}).`);
                                    }
                                  }}
                                  className="px-3 py-1.5 bg-elevated hover:bg-elevated border border-border-custom text-muted rounded-lg text-[10px] font-bold cursor-pointer"
                                >
                                  PDF
                                </button>
                                {po.approvalFlag === "pending" && po.status !== "cancelled" && po.status !== "closed" && (
                                    <>
                                      <button
                                        onClick={() => handleApprovePO(po.id)}
                                        className="px-2.5 py-1.5 bg-primary/10 hover:bg-primary/20 border border-primary/20 text-primary rounded-lg text-[10px] font-bold cursor-pointer"
                                      >
                                        Approve
                                      </button>
                                      <button
                                        onClick={() => handleRejectPO(po.id)}
                                        className="px-2.5 py-1.5 bg-danger/10 hover:bg-danger/20 border border-danger/20 text-danger rounded-lg text-[10px] font-bold cursor-pointer"
                                      >
                                        Reject
                                      </button>
                                    </>
                                  )}
                                  {(po.status === "sent" || po.status === "partial") && po.approvalFlag === "approved" && (
                                    <button
                                      onClick={() => handleOpenGRNModal(po)}
                                      className="px-2.5 py-1.5 bg-success/10 hover:bg-success/20 border border-success/20 text-success rounded-lg text-[10px] font-bold inline-flex items-center gap-1.5 cursor-pointer"
                                    >
                                      <Icon name="truck" className="w-3 h-3" />Record GRN
                                    </button>
                                  )}
                                  {po.status !== "cancelled" && po.status !== "closed" && (
                                    <>
                                      <button
                                        onClick={() => handleClosePO(po.id)}
                                        className="px-2.5 py-1.5 bg-elevated hover:bg-card border border-border-custom text-foreground rounded-lg text-[10px] font-bold cursor-pointer"
                                        title="Close PO"
                                      >
                                        Close
                                      </button>
                                      <button
                                        onClick={() => handleCancelPO(po.id)}
                                        className="px-2.5 py-1.5 bg-elevated hover:bg-danger/10 border border-border-custom text-muted hover:text-danger rounded-lg text-[10px] font-bold cursor-pointer"
                                        title="Cancel PO"
                                      >
                                        Cancel
                                      </button>
                                    </>
                                  )}
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: INVENTORY */}
          {tab === "inventory" && (
            <div className="space-y-4">
              <h2 className="text-xs font-bold text-muted uppercase tracking-wider">Real-time Warehouse Stock Balance</h2>
              <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
                <table className="w-full text-xs text-left">
                  <thead className="bg-elevated text-muted border-b border-border-custom">
                    <tr>
                      <th className="px-5 py-3 font-semibold">Material Item</th>
                      <th className="px-5 py-3 font-semibold">Unit</th>
                      <th className="px-5 py-3 font-semibold">Current Stock</th>
                      <th className="px-5 py-3 font-semibold">Reserved Stock</th>
                      <th className="px-5 py-3 font-semibold">Available Stock</th>
                      <th className="px-5 py-3 font-semibold">Reorder Level</th>
                      <th className="px-5 py-3 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inventory.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="p-8">
                          <EmptyState
                            title="No warehouse inventory yet"
                            description="Receive materials against approved purchase orders via GRN to build inventory stock."
                          />
                        </td>
                      </tr>
                    ) : (
                    inventory.map((inv, idx) => {
                      const netAvail = inv.onHand - inv.reserved;
                      return (
                        <tr key={idx} className="border-b border-border-custom hover:bg-elevated transition-all">
                          <td className="px-5 py-3 font-bold text-foreground">{inv.name}</td>
                          <td className="px-5 py-3 text-muted font-sans uppercase">{inv.unit}</td>
                          <td className={`px-5 py-3 font-sans font-bold ${inv.onHand < 0 ? "text-danger font-extrabold" : "text-foreground"}`}>
                            {fmtQty(inv.onHand)} {inv.unit}
                          </td>
                          <td className="px-5 py-3 text-muted font-sans">{fmtQty(inv.reserved)} {inv.unit}</td>
                          <td className={`px-5 py-3 font-sans font-semibold ${netAvail < 0 ? "text-danger font-extrabold" : "text-foreground"}`}>
                            {fmtQty(netAvail)} {inv.unit}
                            {netAvail < 0 && (
                              <span className="block text-[10px] text-danger font-normal">Negative stock (needs reconciling)</span>
                            )}
                          </td>
                          <td className="px-5 py-3 text-muted font-sans">{fmtQty(inv.minAlertThreshold)} {inv.unit}</td>
                          <td className="px-5 py-3">
                            {inv.onHand < 0 || netAvail < 0 ? (
                              <span className="px-2 py-0.5 rounded bg-danger/10 border border-danger/20 text-danger font-bold uppercase text-[9px]">Negative stock</span>
                            ) : inv.onHand < inv.minAlertThreshold ? (
                              <span className="px-2 py-0.5 rounded bg-warning/10 border border-warning/20 text-warning font-bold uppercase text-[9px]">Reorder Alert</span>
                            ) : (
                              <span className="px-2 py-0.5 rounded bg-success/10 border border-success/20 text-success font-bold uppercase text-[9px]">Healthy</span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 4: LEDGER */}
          {tab === "ledger" && (
            <div className="space-y-4">
              <h2 className="text-xs font-bold text-muted uppercase tracking-wider">Inventory Transactions</h2>
              <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
                <table className="w-full text-xs text-left">
                  <thead className="bg-elevated text-muted border-b border-border-custom">
                    <tr>
                      <th className="px-5 py-3 font-semibold">Material</th>
                      <th className="px-5 py-3 font-semibold">Transaction Qty</th>
                      <th className="px-5 py-3 font-semibold">Type</th>
                      <th className="px-5 py-3 font-semibold">Reference</th>
                      <th className="px-5 py-3 font-semibold">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="p-8">
                          <EmptyState
                            title="No material transactions yet"
                            description="All material receipts, issues to site, and warehouse transfers will be recorded here."
                          />
                        </td>
                      </tr>
                    ) : (
                    transactions.map((txn, idx) => (
                      <tr key={idx} className="border-b border-border-custom hover:bg-elevated transition-all">
                        <td className="px-5 py-3 font-bold text-foreground">{txn.materialName}</td>
                        <td className={`px-5 py-3 font-sans font-bold ${txn.type === "used" ? "text-warning" : "text-success"}`}>
                          {txn.type === "used" ? "-" : "+"}{fmtQty(txn.qty)} {txn.unit}
                        </td>
                        <td className="px-5 py-3 capitalize">{txn.type}</td>
                        <td className="px-5 py-3 text-muted font-sans">{txn.sourceRef}</td>
                        <td className="px-5 py-3 text-muted">{txn.date}</td>
                      </tr>
                    ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 5: UNBILLED MATERIALS TRACKER */}
          {tab === "unbilled" && (
            <div className="space-y-5">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-xs font-bold text-muted uppercase tracking-wider">Unbilled Materials Tracker</h2>
                  <p className="text-[10px] text-muted mt-1 max-w-lg">GRNs received from vendors but not yet linked to a Material Purchase invoice. Review and mark as billed to reconcile Accounts Payable. Unmatched GRNs inflate stock figures without a corresponding payable.</p>
                </div>
                {unbilledGRNs.length === 0 && (
                  <Badge tone="success" icon="check" className="font-bold">All GRNs Reconciled</Badge>
                )}
              </div>

              {/* Summary Strip */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="bg-input border border-border-custom rounded-md p-4">
                  <span className="text-[9px] uppercase text-muted tracking-wider block">Unbilled GRN Count</span>
                  <strong className={`text-xl font-extrabold mt-1 block ${unbilledGRNs.length > 0 ? "text-warning" : "text-success"}`}>{unbilledGRNs.length}</strong>
                </div>
                <div className="bg-input border border-border-custom rounded-md p-4">
                  <span className="text-[9px] uppercase text-muted tracking-wider block">Unbilled Value (est.)</span>
                  <strong className={`text-xl font-extrabold mt-1 block font-sans ${unbilledGRNs.length > 0 ? "text-warning" : "text-success"}`}>
                    ₹{unbilledGRNs.reduce((s, g) => s + g.items.reduce((a, i) => a + i.qty * i.rate, 0), 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                  </strong>
                </div>
                <div className="bg-input border border-border-custom rounded-md p-4">
                  <span className="text-[9px] uppercase text-muted tracking-wider block">Vendors Pending</span>
                  <strong className="text-xl font-extrabold mt-1 block text-foreground">{Object.keys(unbilledByVendor).length}</strong>
                </div>
              </div>

              {/* Vendor-grouped GRN cards */}
              {Object.values(unbilledByVendor).length === 0 ? (
                <div className="text-center py-14 text-muted text-xs">No unbilled GRNs. All received goods have matching invoices.</div>
              ) : (
                Object.values(unbilledByVendor).map(group => (
                  <div key={group.vendor} className="bg-background border border-border-custom rounded-lg overflow-hidden">
                    {/* Vendor header */}
                    <div className="flex items-center justify-between px-5 py-3 bg-warning/5 border-b border-warning/10">
                      <div className="flex items-center gap-3">
                        <span className="text-[9px] font-extrabold uppercase tracking-widest text-warning inline-flex items-center gap-1"><Icon name="warning" className="w-3 h-3" />Unbilled</span>
                        <span className="text-xs font-bold text-foreground">{group.vendor}</span>
                        <span className="text-[9px] text-muted">{group.grns.length} GRN{group.grns.length > 1 ? "s" : ""} pending</span>
                      </div>
                      <div className="text-right">
                        <span className="text-[9px] text-muted block">Est. Unbilled Value</span>
                        <strong className="text-sm font-extrabold text-warning font-sans">₹{group.totalValue.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</strong>
                      </div>
                    </div>

                    {/* Individual GRN rows */}
                    <table className="w-full text-xs text-left">
                      <thead>
                        <tr className="border-b border-border-custom text-muted font-bold uppercase tracking-wider text-[9px]">
                          <th className="px-5 py-2.5 font-semibold">GRN No.</th>
                          <th className="px-5 py-2.5 font-semibold">Received Date</th>
                          <th className="px-5 py-2.5 font-semibold">Items</th>
                          <th className="px-5 py-2.5 text-center font-semibold">3-Way Match Check</th>
                          <th className="px-5 py-2.5 text-right font-semibold">Value</th>
                          <th className="px-5 py-2.5 text-right font-semibold">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.grns.map(grn => {
                          const grnValue = grn.items.reduce((s, i) => s + i.qty * i.rate, 0);
                          const threeWay = getThreeWayMatchStatus(grn);
                          return (
                            <tr key={grn.id} className="border-b border-border-custom hover:bg-elevated transition-all">
                              <td className="px-5 py-3">
                                <span className="font-sans font-bold text-foreground">{grn.grnNumber}</span>
                                <span className="block text-[9px] text-muted mt-0.5">PO: {grn.poNumber}</span>
                              </td>
                              <td className="px-5 py-3 text-muted">{grn.receivedDate}</td>
                              <td className="px-5 py-3">
                                {grn.items.map((item, i) => (
                                  <div key={i} className="text-muted">
                                    {item.name}: <span className="font-sans font-bold">{item.qty} {item.unit}</span> @ ₹{item.rate.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                                  </div>
                                ))}
                              </td>
                              <td className="px-5 py-3 text-center">
                                <Badge tone={threeWay.match ? "success" : "danger"} icon={threeWay.match ? "check" : "warning"} className="font-bold">{threeWay.text}</Badge>
                              </td>
                              <td className="px-5 py-3 text-right font-sans font-bold text-warning">₹{grnValue.toLocaleString("en-IN")}</td>
                              <td className="px-5 py-3 text-right">
                                <div className="flex items-center justify-end gap-2">
                                  {grn.isCancelled ? (
                                    <Badge tone="danger" className="font-bold">CANCELLED</Badge>
                                  ) : (
                                    <>
                                      <button
                                        onClick={() => handleMarkAsBilled(grn.id)}
                                        className="px-3 py-1.5 text-[10px] font-bold bg-success/10 hover:bg-success/20 border border-success/20 text-success rounded-lg transition-all inline-flex items-center gap-1 cursor-pointer"
                                      >
                                        <Icon name="check" className="w-3 h-3" /> Mark as Billed
                                      </button>
                                      <button
                                        onClick={() => handleCancelGRN(grn)}
                                        disabled={cancellingGrnId === grn.id}
                                        className="px-2.5 py-1.5 text-[10px] font-bold bg-danger/10 hover:bg-danger/20 border border-danger/20 text-danger rounded-lg transition-all inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                                        title="Cancel GRN and reverse received stock"
                                      >
                                        <Icon name="trash" className="w-3 h-3" /> {cancellingGrnId === grn.id ? "Cancelling..." : "Cancel GRN"}
                                      </button>
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ))
              )}

              {/* Already-billed GRNs reference section */}
              {grns.filter(g => g.isBilled).length > 0 && (
                <div className="mt-6">
                  <h3 className="text-[10px] uppercase font-bold text-muted tracking-wider mb-3 inline-flex items-center gap-1">
                    <Icon name="check" className="w-3 h-3" /> Reconciled GRNs (Billed)
                  </h3>
                  <div className="bg-background border border-border-custom rounded-lg overflow-hidden opacity-60">
                    <table className="w-full text-xs">
                      <tbody>
                        {grns.filter(g => g.isBilled).map(grn => (
                          <tr key={grn.id} className="border-b border-border-custom">
                            <td className="px-5 py-3 font-sans font-bold text-muted">{grn.grnNumber}</td>
                            <td className="px-5 py-3 text-muted">{grn.vendor}</td>
                            <td className="px-5 py-3 text-muted">{grn.receivedDate}</td>
                            <td className="px-5 py-3 text-right">
                              {grn.isCancelled ? (
                                <Badge tone="danger" className="font-bold">CANCELLED</Badge>
                              ) : (
                                <Badge tone="success" className="font-bold">BILLED</Badge>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
          </PageShell>
        </div>
      </main>

      {/* Add Indent Modal Drawer (Specs overrides per item) */}
      {showIndentModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-background border border-border-custom rounded-lg w-full max-w-md shadow-2xl p-6 space-y-4 text-xs">
            <div className="flex justify-between items-center border-b border-border-custom pb-2">
              <h3 className="text-xs font-extrabold text-foreground">Create Material Indent (Requisition)</h3>
              <button onClick={() => setShowIndentModal(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>

            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-muted">Indent Number</label>
                <input type="text" value={newIndentNum} onChange={(e) => setNewIndentNum(e.target.value)} required className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" />
              </div>

              <div className="space-y-1">
                <label className="text-muted">Requested By (Team Member)</label>
                <select value={newIndentRequestedBy} onChange={(e) => setNewIndentRequestedBy(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground">
                  <option value="">Select Team Member (Default: Site Engineer)</option>
                  {teamMembers.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              
              <div className="space-y-1">
                <label className="text-muted">Material Item</label>
                <select
                  value={newIndentMaterial}
                  onChange={(e) => {
                    setNewIndentMaterial(e.target.value);
                    // Take the UOM from the library instead of leaving the
                    // hardcoded "bags", which produced indents and POs reading
                    // "500 bags" for a material measured in MT.
                    const picked = materials.find((m) => m.name === e.target.value);
                    if (picked?.unit) setNewIndentUnit(picked.unit);
                  }}
                  className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground"
                >
                  <option value="">Select Material</option>
                  {materials.map((m) => (
                    <option key={m.id} value={m.name}>{m.name}</option>
                  ))}
                </select>
                {materials.length === 0 && (
                  <FieldHint text="No materials yet. Add one in Library." href={`/c/${companyId}/d/library`} linkLabel="Go to Library" />
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-muted">Required Quantity</label>
                  <input type="number" value={newIndentQty} onChange={(e) => setNewIndentQty(parseFloat(e.target.value) || 0)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" />
                </div>
                <div className="space-y-1">
                  <label className="text-muted">Unit</label>
                  <input type="text" value={newIndentUnit} onChange={(e) => setNewIndentUnit(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" />
                </div>
              </div>

              {/* Item-level Spec override (Screen 5761-5762) */}
              <div className="space-y-1">
                <label className="text-muted">Line-Item Custom Specification Override</label>
                <input type="text" value={newIndentSpec} onChange={(e) => setNewIndentSpec(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" placeholder="Grade 53 OPC Cement, Fe 550D Rebars..." />
              </div>
            </div>

            <div className="flex gap-2 justify-end border-t border-border-custom pt-4">
              <button onClick={() => setShowIndentModal(false)} className="px-4 py-2 bg-elevated text-muted hover:text-foreground rounded-md">Cancel</button>
              <button onClick={handleCreateIndent} className="px-5 py-2.5 bg-primary text-white font-bold rounded-md">Submit Indent</button>
            </div>
          </div>
        </div>
      )}

      {/* Log GRN PO Checklist Modal (Screen 5767-5768) */}
      {showGRNModal && selectedPOForGRN && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-background border border-border-custom rounded-lg w-full max-w-lg shadow-2xl p-6 space-y-4 text-xs">
            <div className="flex justify-between items-center border-b border-border-custom pb-2">
              <div>
                <h3 className="text-xs font-extrabold text-foreground">Record Goods Receipt Note (GRN)</h3>
                <p className="text-[10px] text-muted mt-0.5">PO: {selectedPOForGRN.poNumber} · Vendor: {selectedPOForGRN.vendor}</p>
              </div>
              <button onClick={() => { setShowGRNModal(false); setSelectedPOForGRN(null); }} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>

            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-muted">GRN Number (leave blank for automatic)</label>
                <input type="text" value={grnNum} onChange={(e) => setGrnNum(e.target.value)} placeholder="Auto-assigned from GRN Numbering setting" className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" />
              </div>

              <div className="space-y-1">
                <label className="text-muted">Received By (Store / Site Incharge)</label>
                <select value={grnReceivedBy} onChange={(e) => setGrnReceivedBy(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground">
                  <option value="">Select Team Member (Default: Incharge)</option>
                  {teamMembers.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>

              {/* Checklist list of PO items (Screen 5768) */}
              <div className="space-y-2">
                <span className="text-muted font-bold block uppercase tracking-wider text-[10px]">Select Delivered PO Items</span>
                {selectedPOForGRN.items.map((item, idx) => {
                  const idxStr = idx.toString();
                  return (
                    <div key={idx} className="p-3 bg-input border border-border-custom rounded-md flex items-center justify-between gap-4">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={grnItemsChecked[idxStr] || false}
                          onChange={(e) => setGrnItemsChecked({ ...grnItemsChecked, [idxStr]: e.target.checked })}
                          className="accent-primary h-4 w-4 rounded cursor-pointer"
                        />
                        <span className="text-foreground font-bold">{item.name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-muted">Rec Qty:</span>
                        <input
                          type="number"
                          value={grnReceivedQtys[idxStr] || "0"}
                          onChange={(e) => setGrnReceivedQtys({ ...grnReceivedQtys, [idxStr]: e.target.value })}
                          disabled={!grnItemsChecked[idxStr]}
                          className="bg-elevated border border-border-custom rounded px-2 py-1 text-foreground w-20 text-center font-bold disabled:opacity-50"
                        />
                        <span className="text-muted">{item.unit}</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="rounded-lg border border-dashed border-border-custom bg-elevated/30 p-3 text-center">
                <p className="text-[10px] text-muted">Gate photo upload is not available yet. Object storage is required and has not been configured. Photos are not stored.</p>
              </div>
            </div>

            <div className="flex gap-2 justify-end border-t border-border-custom pt-4">
              <button onClick={() => { setShowGRNModal(false); setSelectedPOForGRN(null); }} className="px-4 py-2 bg-elevated text-muted hover:text-foreground rounded-md">Cancel</button>
              <button onClick={handleCreateGRN} className="px-5 py-2.5 bg-primary text-white font-bold rounded-md">Record GRN Items</button>
            </div>
          </div>
        </div>
      )}

      {/* Log Material Usage Drawer */}
      {showUseModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-background border border-border-custom rounded-lg w-full max-w-md shadow-2xl p-6 space-y-4 text-xs">
            <div className="flex justify-between items-center border-b border-border-custom pb-2">
              <h3 className="text-xs font-extrabold text-foreground">Log Site Material Usage</h3>
              <button onClick={() => setShowUseModal(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>

            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-muted">Select Material Item</label>
                <select value={useMaterialName} onChange={(e) => setUseMaterialName(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground">
                  <option value="">Select Material</option>
                  {materials.map((m) => (
                    <option key={m.id} value={m.name}>{m.name}</option>
                  ))}
                </select>
                {materials.length === 0 && (
                  <FieldHint text="No materials yet. Add one in Library." href={`/c/${companyId}/d/library`} linkLabel="Go to Library" />
                )}
              </div>

              <div className="space-y-1">
                <label className="text-muted">Usage Quantity</label>
                <input type="number" value={useQty} onChange={(e) => setUseQty(parseFloat(e.target.value) || 0)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" />
              </div>

              <div className="space-y-1">
                <label className="text-muted">Consumption Reference (Location / Lorry No.)</label>
                <input type="text" value={useSourceRef} onChange={(e) => setUseSourceRef(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" />
              </div>
            </div>

            <div className="flex gap-2 justify-end border-t border-border-custom pt-4">
              <button onClick={() => setShowUseModal(false)} className="px-4 py-2 bg-elevated text-muted hover:text-foreground rounded-md">Cancel</button>
              <button onClick={handleRecordUsage} className="px-5 py-2.5 bg-primary text-white font-bold rounded-md">Record Usage</button>
            </div>
          </div>
        </div>
      )}

      {/* PO Creation modal */}
      {showPOModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-background border border-border-custom rounded-lg w-full max-w-lg shadow-2xl p-6 space-y-4 text-xs font-sans max-h-[85vh] overflow-y-auto">
            <div className="flex justify-between items-center border-b border-border-custom pb-2">
              <div>
                <h3 className="text-xs font-extrabold text-foreground">Create Purchase Order (PO)</h3>
                <p className="text-[10px] text-muted mt-0.5">Procurement order with line-item tax and vendor promised delivery date</p>
              </div>
              <button onClick={() => setShowPOModal(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-muted font-bold">PO Number*</label>
                  <input type="text" value={newPONum} onChange={(e) => setNewPONum(e.target.value)} required className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" placeholder="PO-2026-001" />
                </div>
                <div className="space-y-1">
                  <label className="text-muted font-bold">Expected Delivery Date</label>
                  <input type="date" value={newPOExpectedDeliveryDate} onChange={(e) => setNewPOExpectedDeliveryDate(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-muted font-bold">Supplier Vendor</label>
                <select value={newPOVendor} onChange={(e) => setNewPOVendor(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground">
                  <option value="">Select Vendor</option>
                  {vendorOptions.map(v => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
                {vendorOptions.length === 0 && (
                  <FieldHint text="No vendors yet. Add one in Subcontractors." href={`/c/${companyId}/d/subcon`} linkLabel="Go to Subcontractors" />
                )}
              </div>

              {/* Multi-item list form */}
              <div className="space-y-2 border-t border-border-custom pt-3">
                <div className="flex justify-between items-center">
                  <span className="text-muted font-bold uppercase tracking-wider text-[9px]">PO Line Items</span>
                  <button type="button" onClick={() => setPoFormItems([...poFormItems, { name: "", qty: 0, unit: "", rate: 0, tax_pct: 18 }])}
                    className="text-[9px] text-primary font-bold hover:underline">+ Add Item Line</button>
                </div>
                {poFormItems.map((item, idx) => (
                  <div key={idx} className="bg-elevated p-3 rounded-lg border border-border-custom space-y-2 relative">
                    <button type="button" onClick={() => setPoFormItems(poFormItems.filter((_, i) => i !== idx))}
                      className="absolute top-2 right-2 text-muted hover:text-danger cursor-pointer"><Icon name="close" className="w-4 h-4" /></button>
                    <div className="space-y-1">
                      <label className="text-muted text-[9px]">Item Name</label>
                      <select value={item.name}
                        onChange={e => {
                          const next = [...poFormItems];
                          next[idx].name = e.target.value;
                          // The unit and the tax rate belong to the material in
                          // the library. This used to guess from the name:
                          // anything containing "Cement" became bags, everything
                          // else became tons, so a PO for 12mm TMT read "tons"
                          // and a PO for sand read "tons" too.
                          const picked = materials.find((m) => m.name === e.target.value);
                          next[idx].unit = picked?.unit || "";
                          if (picked?.gst_rate != null) next[idx].tax_pct = picked.gst_rate;
                          setPoFormItems(next);
                        }}
                        className="w-full bg-input border border-border-custom rounded p-1 text-foreground text-[11px]">
                        <option value="">Select Material</option>
                        {materials.map((m) => (
                          <option key={m.id} value={m.name}>{m.name}</option>
                        ))}
                      </select>
                      {materials.length === 0 && (
                        <FieldHint text="No materials yet. Add one in Library." href={`/c/${companyId}/d/library`} linkLabel="Go to Library" />
                      )}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                      <div className="space-y-1">
                        <label className="text-muted text-[9px]">Quantity ({item.unit || "unit"})</label>
                        <input type="number" value={item.qty}
                          onChange={e => { const next = [...poFormItems]; next[idx].qty = parseFloat(e.target.value) || 0; setPoFormItems(next); }}
                          className="w-full bg-input border border-border-custom rounded p-1 text-foreground text-[11px]" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-muted text-[9px]">Rate (₹)</label>
                        <input type="number" value={item.rate}
                          onChange={e => { const next = [...poFormItems]; next[idx].rate = parseFloat(e.target.value) || 0; setPoFormItems(next); }}
                          className="w-full bg-input border border-border-custom rounded p-1 text-foreground text-[11px]" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-muted text-[9px]">GST Tax %</label>
                        <select
                          value={item.tax_pct ?? 18}
                          onChange={e => { const next = [...poFormItems]; next[idx].tax_pct = parseFloat(e.target.value) || 0; setPoFormItems(next); }}
                          className="w-full bg-input border border-border-custom rounded p-1 text-foreground text-[11px]"
                        >
                          <option value={0}>0% (Exempt)</option>
                          <option value={5}>5%</option>
                          <option value={12}>12%</option>
                          <option value={18}>18% (Standard GST)</option>
                          <option value={28}>28%</option>
                        </select>
                      </div>
                    </div>
                    {item.qty > 0 && item.rate > 0 && (
                      <div className="text-[10px] text-muted flex justify-between pt-1 border-t border-border-custom/50">
                        <span>Line Total (incl. {item.tax_pct ?? 18}% tax):</span>
                        <span className="font-semibold text-foreground">
                          ₹{((item.qty * item.rate) * (1 + (item.tax_pct ?? 18) / 100)).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Running total calculation breakdown matching backend */}
              {(() => {
                let subtotal = 0;
                let totalTax = 0;
                poFormItems.forEach(it => {
                  const lineSub = (it.qty || 0) * (it.rate || 0);
                  const taxRate = typeof it.tax_pct === "number" ? it.tax_pct : 18;
                  const lineTax = lineSub * (taxRate / 100);
                  subtotal += lineSub;
                  totalTax += lineTax;
                });
                const grandTotal = subtotal + totalTax;
                return (
                  <div className="bg-card/70 border border-border-custom rounded-lg p-3 space-y-1.5 text-xs">
                    <div className="flex justify-between text-muted">
                      <span>Items Subtotal:</span>
                      <span className="font-semibold text-foreground">₹{subtotal.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between text-muted">
                      <span>GST Tax Amount:</span>
                      <span className="font-semibold text-foreground">₹{totalTax.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                    <div className="flex justify-between border-t border-border-custom pt-1.5 font-bold text-sm text-foreground">
                      <span>Grand Total:</span>
                      <span className="text-primary font-sans">₹{grandTotal.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                  </div>
                );
              })()}

              <div className="space-y-1 border-t border-border-custom pt-3">
                <label className="text-muted font-bold">Terms &amp; Conditions</label>
                <textarea value={newPOTerms} onChange={(e) => setNewPOTerms(e.target.value)}
                  placeholder="Pre-filled from company Purchase Order Terms; edit as needed" rows={3}
                  className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" />
              </div>
            </div>

            <div className="flex gap-2 justify-end border-t border-border-custom pt-4">
              <button onClick={() => setShowPOModal(false)} className="px-4 py-2 bg-elevated text-muted hover:text-foreground rounded-md">Cancel</button>
              <button onClick={handleCreatePO} className="px-5 py-2.5 bg-primary text-white font-bold rounded-md">Save PO Draft</button>
            </div>
          </div>
        </div>
      )}

      {/* RFQ Comparison Drawer */}
      {showRFQDrawer && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-end">
          <div className="bg-background border-l border-border-custom w-full max-w-xl h-full shadow-2xl flex flex-col overflow-hidden text-xs">
            <div className="px-6 py-4 border-b border-border-custom flex items-center justify-between bg-background">
              <div>
                <span className="text-[9px] uppercase tracking-wider font-extrabold text-primary">RFQ Analysis Center</span>
                <h2 className="text-base font-extrabold text-foreground mt-1">Vendor Quote Comparisons</h2>
              </div>
              <button onClick={() => setShowRFQDrawer(false)} className="text-muted hover:text-foreground cursor-pointer inline-flex items-center gap-1"><Icon name="close" className="w-4 h-4" /> Close</button>
            </div>

            <div className="flex-1 p-6 overflow-y-auto space-y-6">
              <EmptyState
                title="No vendor quotes yet"
                description="Quote comparisons will appear here once supplier bids are received for RFQs."
                action={{
                  label: "Go to RFQ Management",
                  href: `/c/${companyId}/d/procurement/rfq`,
                }}
              />
            </div>
          </div>
        </div>
      )}

      {previewUrl && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4"
          onClick={() => setPreviewUrl(null)}
        >
          <div
            className="bg-card border border-border-custom rounded-lg p-4 max-w-3xl w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-end mb-2">
              <button onClick={() => setPreviewUrl(null)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>
            <img src={previewUrl} className="max-h-[70vh] rounded-lg mx-auto" alt="Item photo proof" />
          </div>
        </div>
      )}
    </div>
  );
}