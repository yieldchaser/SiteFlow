"use client";
import {  getApiHost , readErrorDetail } from "@/lib/api";
import { authHeaders, formatLabel, toLocalISODate, formatDate } from "@/lib/siteflow";
import React, { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Icon, { type IconName } from "@/components/marketing/Icon";
import SegmentedTabs from "@/components/ui/Tabs";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import FieldHint from "@/components/ui/FieldHint";
import { EmptyState } from "@/components/ui/EmptyState";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChecklistItem {
  id: string;
  sequence: number;
  description: string;
  criteria: string;
  mandatory: boolean;
}

interface Checklist {
  id: string;
  title: string;
  category: string;
  isCode: string;
  items: ChecklistItem[];
}

interface InspectionResponse {
  itemId: string;
  result: "Pass" | "Fail" | "NA";
  remarks: string;
}

interface Inspection {
  id: string;
  zone: string;
  checklist: string;
  date: string;
  status: "pending" | "pass" | "fail" | "partial";
  passCount: number;
  failCount: number;
  naCount: number;
  inspector: string;
}

interface NCR {
  id: string;
  number: string;
  title: string;
  severity: "Minor" | "Major" | "Critical";
  status: "open" | "under_review" | "closed";
  zone: string;
  raisedBy: string;
  date: string;
  dueDate: string;
  resolution?: string;
}

interface LabTest {
  id: string;
  type: string;
  material: string;
  sampleRef: string;
  date: string;
  value: number;
  unit: string;
  min: number | null;
  max: number | null;
  pass: boolean;
  zone: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const severityTones: Record<string, BadgeTone> = {
  Critical: "danger",
  Major: "warning",
  Minor: "info",
};

const statusTones: Record<string, BadgeTone> = {
  open: "danger",
  under_review: "info",
  closed: "success",
  pass: "success",
  fail: "danger",
  partial: "warning",
  pending: "neutral",
};

const badge = (label: string, tone?: BadgeTone) => (
  <Badge tone={tone || "neutral"}>
    {label}
  </Badge>
);

const passRate = (p: number, f: number) => {
  const total = p + f;
  if (total === 0) return 0;
  return Math.round((p / total) * 100);
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function QualityPage() {
  const params = useParams();
  const companyId = (params?.company_id as string) || "";
  const projectId = (params.project_id as string) || "d0000000-0000-0000-0000-000000000001";

  useEffect(() => {
    if (!companyId || companyId === "e0000000-0000-0000-0000-000000000000") {
      if (typeof window !== "undefined") window.location.replace("/login");
    }
  }, [companyId]);

  const [tab, setTab] = useState<"checklists" | "inspections" | "ncr" | "labtests">("inspections");
  
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [ncrs, setNcrs] = useState<NCR[]>([]);
  const [labTests, setLabTests] = useState<LabTest[]>([]);
  const [isOffline, setIsOffline] = useState(false);

  const [selectedInspection, setSelectedInspection] = useState<Inspection | null>(null);
  const [activeInspectionItems, setActiveInspectionItems] = useState<ChecklistItem[]>([]);
  const [inspectionResponses, setInspectionResponses] = useState<Record<string, "Pass" | "Fail" | "NA">>({});
  const [existingResponses, setExistingResponses] = useState<{ id: string; checklist_item_id: string; result: string; remarks?: string | null; photo_url?: string | null }[]>([]);
  const [loadingResponses, setLoadingResponses] = useState(false);
  const [inspectionSearch, setInspectionSearch] = useState("");
  const [inspectionInspectorFilter, setInspectionInspectorFilter] = useState("all");
  const [inspectionStatusFilter, setInspectionStatusFilter] = useState("all");

  const [showNCRForm, setShowNCRForm] = useState(false);
  const [ncrForm, setNcrForm] = useState({
    ncrNumber: "",
    title: "",
    description: "",
    severity: "Major" as "Minor" | "Major" | "Critical",
    zone: "",
    inspectionId: "",
    dueDate: toLocalISODate(new Date(Date.now() + 86400000))
  });

  const [showTestForm, setShowTestForm] = useState(false);
  const [testForm, setTestForm] = useState({
    type: "Cube Test",
    material: "Concrete M25",
    sampleRef: "",
    value: "28.0",
    unit: "MPa",
    min: "25.0",
    max: "50.0",
    zone: ""
  });

  const [showInspForm, setShowInspForm] = useState(false);
  const [inspForm, setInspForm] = useState({
    checklistId: "",
    zone: "",
    overallRemarks: ""
  });

  const loadAll = async () => {
    if (!companyId || companyId === "e0000000-0000-0000-0000-000000000000") return;
    let currentChecklists: Checklist[] = [];
    try {
      const clRes = await fetch(`${getApiHost()}/apis/v3/quality/checklists/${companyId}`, { headers: authHeaders() });
      if (clRes.ok) {
        const clData = await clRes.json();
        currentChecklists = await Promise.all(clData.map(async (cl: any) => {
          const itemsRes = await fetch(`${getApiHost()}/apis/v3/quality/checklists/${cl.id}/items`, { headers: authHeaders() });
          let items: ChecklistItem[] = [];
          if (itemsRes.ok) {
            const itemsData = await itemsRes.json();
            items = itemsData.map((item: any) => ({
              id: item.id,
              sequence: item.sequence,
              description: item.description,
              criteria: item.acceptable_criteria || "",
              mandatory: item.is_mandatory
            }));
          }
          return {
            id: cl.id,
            title: cl.title,
category: cl.category || "—",
isCode: cl.is_code_reference || "—",
            items
          };
        }));
        setChecklists(currentChecklists);
        setIsOffline(false);
      } else {
        throw new Error(`HTTP ${clRes.status}`);
      }
    } catch (e) {
      console.error("Failed to fetch checklists", e);
      setIsOffline(true);
    }

    try {
      const inspRes = await fetch(`${getApiHost()}/apis/v3/quality/inspections/${projectId}`, { headers: authHeaders() });
      if (inspRes.ok) {
        const inspData = await inspRes.json();
        const mapped = inspData.map((insp: any) => {
          const foundCl = currentChecklists.find(c => c.id === insp.checklist_id);
          return {
            id: insp.id,
            checklistId: insp.checklist_id,
            zone: insp.zone || "—",
            checklist: foundCl ? foundCl.title : "Unknown checklist",
            date: insp.inspection_date ? insp.inspection_date.split("T")[0] : "",
            status: insp.status,
            passCount: insp.pass_count,
            failCount: insp.fail_count,
            naCount: insp.na_count,
            inspector: insp.inspected_by_name || (insp.inspected_by ? "Team member" : "—")
          };
        });
        setInspections(mapped);
      }
    } catch (e) {
      console.error("Failed to fetch inspections", e);
    }
  };

  const fetchNcrs = async () => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/quality/ncr/${projectId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        const mapped = data.map((n: any) => ({
          id: n.id,
          number: n.ncr_number,
          title: n.title,
          severity: n.severity,
          status: n.status,
          zone: "Site Zone",
          raisedBy: "Inspector",
          date: n.created_at ? n.created_at.split("T")[0] : "",
          dueDate: n.due_date ? n.due_date.split("T")[0] : "",
          resolution: n.resolution_notes || undefined
        }));
        setNcrs(mapped);
      }
    } catch (e) {
      console.error("Failed to fetch NCRs", e);
    }
  };

  const fetchLabTests = async () => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/quality/material-tests/${projectId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        const mapped = data.map((t: any) => ({
          id: t.id,
          type: t.test_type,
          material: t.material || "—",
          sampleRef: t.sample_ref || "",
          date: t.test_date ? t.test_date.split("T")[0] : "",
          value: t.result_value,
          unit: t.unit || "",
          min: t.min_acceptable ?? null,
          max: t.max_acceptable ?? null,
          pass: t.is_pass,
          zone: t.zone || "—"
        }));
        setLabTests(mapped);
      }
    } catch (e) {
      console.error("Failed to fetch lab tests", e);
    }
  };

  useEffect(() => {
    if (projectId) {
      loadAll();
      fetchNcrs();
      fetchLabTests();
    }
  }, [projectId]);

  useEffect(() => {
    if (selectedInspection) {
      const fetchResponses = async () => {
        setLoadingResponses(true);
        try {
          const res = await fetch(`${getApiHost()}/apis/v3/quality/inspections/${selectedInspection.id}/responses`, { headers: authHeaders() });
          if (res.ok) {
            const data = await res.json();
            setExistingResponses(Array.isArray(data) ? data : []);
          } else {
            setExistingResponses([]);
          }
        } catch (e) {
          console.error("Failed to fetch inspection responses", e);
          setExistingResponses([]);
        } finally {
          setLoadingResponses(false);
        }
      };
      fetchResponses();

      const cl = checklists.find(c => c.id === (selectedInspection as any).checklistId);
      if (cl) {
        setActiveInspectionItems(cl.items);
      } else {
        setActiveInspectionItems([]);
      }
      setInspectionResponses({});
    }
  }, [selectedInspection, checklists]);

  const moveNCR = async (id: string, newStatus: "under_review" | "closed") => {
    try {
      const action = newStatus === "under_review" ? "review" : "close";
      const body = newStatus === "closed" ? JSON.stringify({ resolution_notes: "Resolved and verified on-site." }) : undefined;
      const res = await fetch(`${getApiHost()}/apis/v3/quality/ncr/${id}/${action}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body
      });
      if (res.ok) {
        fetchNcrs();
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (e) {
      console.error("Failed to transition NCR status", e);
    }
  };

  const handleCreateNCR = async () => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/quality/ncr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          project_id: projectId,
          inspection_id: ncrForm.inspectionId || null,
          ...(ncrForm.ncrNumber.trim() ? { ncr_number: ncrForm.ncrNumber.trim() } : {}),
          title: ncrForm.title,
          description: ncrForm.description,
          severity: ncrForm.severity,
          due_date: new Date(ncrForm.dueDate).toISOString()
        })
      });
      if (res.ok) {
        fetchNcrs();
        setShowNCRForm(false);
        setNcrForm({
          ncrNumber: "",
          title: "",
          description: "",
          severity: "Major",
          zone: "",
          inspectionId: "",
          dueDate: toLocalISODate(new Date(Date.now() + 86400000))
        });
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (e) {
      console.error("Failed to create NCR", e);
    }
  };

  const handleCreateTest = async () => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/quality/material-tests`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          project_id: projectId,
          test_type: testForm.type,
          material: testForm.material,
          sample_ref: testForm.sampleRef || `REF-${Math.floor(1000 + Math.random() * 9000)}`,
          test_date: new Date().toISOString(),
          result_value: parseFloat(testForm.value),
          unit: testForm.unit,
          min_acceptable: parseFloat(testForm.min),
          max_acceptable: parseFloat(testForm.max),
          zone: testForm.zone
        })
      });
      if (res.ok) {
        fetchLabTests();
        setShowTestForm(false);
        setTestForm({
          type: "Cube Test",
          material: "Concrete M25",
          sampleRef: "",
          value: "28.0",
          unit: "MPa",
          min: "25.0",
          max: "50.0",
          zone: ""
        });
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (e) {
      console.error("Failed to log material test", e);
    }
  };

  const handleCreateInspection = async () => {
    if (!inspForm.checklistId) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/quality/inspections`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          project_id: projectId,
          checklist_id: inspForm.checklistId,
          zone: inspForm.zone,
          inspection_date: new Date().toISOString(),
          overall_remarks: inspForm.overallRemarks
        })
      });
      if (res.ok) {
        loadAll();
        setShowInspForm(false);
        setInspForm({
          checklistId: "",
          zone: "",
          overallRemarks: ""
        });
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (e) {
      console.error("Failed to start site inspection", e);
    }
  };

  const handleSubmitAuditResponses = async () => {
    if (!selectedInspection) return;
    const responses = Object.entries(inspectionResponses).map(([itemId, result]) => ({
      checklist_item_id: itemId,
      result,
      remarks: null
    }));

    try {
      const res = await fetch(`${getApiHost()}/apis/v3/quality/inspections/${selectedInspection.id}/respond`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ responses })
      });
      if (res.ok) {
        loadAll();
        setSelectedInspection(null);
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (e) {
      console.error("Failed to submit audit responses", e);
    }
  };

  const openNCRs = ncrs.filter(n => n.status === "open");
  const reviewNCRs = ncrs.filter(n => n.status === "under_review");
  const closedNCRs = ncrs.filter(n => n.status === "closed");
  const inspectionInspectorOptions = Array.from(new Set(inspections.map((inspection) => inspection.inspector).filter((name) => name && name !== "—"))).sort((a, b) => a.localeCompare(b));
  const inspectionStatusOptions = ["pending", "pass", "partial", "fail"];
  const inspectionSearchValue = inspectionSearch.trim().toLowerCase();
  const filteredInspections = inspections.filter((insp) => {
    const matchesSearch =
      inspectionSearchValue.length === 0 ||
      [insp.zone, insp.checklist, insp.inspector].some((value) => value.toLowerCase().includes(inspectionSearchValue));
    const matchesInspector = inspectionInspectorFilter === "all" || insp.inspector === inspectionInspectorFilter;
    const matchesStatus = inspectionStatusFilter === "all" || insp.status === inspectionStatusFilter;
    return matchesSearch && matchesInspector && matchesStatus;
  });

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Main */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <PageHeader
          title={
            (tab === "inspections" && "Site Inspections") ||
            (tab === "checklists" && "IS-Code Checklist Library") ||
            (tab === "ncr" && "Non-Conformance Reports (NCR)") ||
            (tab === "labtests" && "Material Lab Tests") || "Quality Control & Assurance"
          }
          subtitle="Site inspections, checklists, NCR tracker and lab test logs"
        >
          <div>
            {tab === "ncr" && (
              <button onClick={() => setShowNCRForm(true)}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-xs font-bold hover:bg-primary/90 transition-all cursor-pointer">
                + Raise NCR
              </button>
            )}
            {tab === "inspections" && (
              <button onClick={() => setShowInspForm(true)} className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-xs font-bold hover:bg-primary/90 transition-all cursor-pointer">
                + New Inspection
              </button>
            )}
          </div>
        </PageHeader>

        <div className="px-6 py-2 border-b border-border-custom bg-card shrink-0 overflow-x-auto">
          <SegmentedTabs
            tabs={[
              { id: "inspections", icon: <Icon name="search" className="w-3.5 h-3.5" />, label: "Inspections" },
              { id: "checklists", icon: <Icon name="clipboard" className="w-3.5 h-3.5" />, label: "Checklists" },
              { id: "ncr", icon: <Icon name="siren" className="w-3.5 h-3.5" />, label: "NCR Tracker" },
              { id: "labtests", icon: <Icon name="test_tube" className="w-3.5 h-3.5" />, label: "Lab Tests" },
            ]}
            activeTab={tab}
            onChange={(t) => setTab(t as any)}
          />
        </div>

        {isOffline && (
          <div className="px-6 py-2.5 bg-warning/10 border-b border-warning/20 text-warning text-xs">
            Offline mode: backend connection unavailable
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          <PageShell width="wide">

          {/* ── INSPECTIONS ─────────────────────────────────────────────────── */}
          {tab === "inspections" && (
            <div className="space-y-4">
              {/* KPI row */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                {[
                  { label: "Total Inspections", val: inspections.length, color: "text-foreground" },
                  { label: "All Pass", val: inspections.filter(i => i.status === "pass").length, color: "text-success" },
                  { label: "Partial", val: inspections.filter(i => i.status === "partial").length, color: "text-warning" },
                  { label: "Fail", val: inspections.filter(i => i.status === "fail").length, color: "text-danger" },
                ].map(({ label, val, color }) => (
                  <div key={label} className="bg-card border border-border-custom rounded-md p-4">
                    <p className="text-[10px] text-muted uppercase font-bold tracking-wider mb-1">{label}</p>
                    <p className={`text-2xl font-bold ${color}`}>{val}</p>
                  </div>
                ))}
              </div>
              {/* Inspection Filters */}
              <div className="rounded-md border border-border-custom bg-card p-4 space-y-4">
                <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
                  <div>
                    <h3 className="text-xs font-bold text-muted uppercase tracking-wider">Inspection Register</h3>
                    <p className="text-[10px] text-muted mt-1">Search by zone, checklist, or inspector. Filter the register by inspector and status.</p>
                  </div>
                  <div className="text-[10px] text-muted font-medium">
                    {filteredInspections.length} inspection{filteredInspections.length === 1 ? "" : "s"} shown
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase font-bold text-muted tracking-wider">Search</label>
                    <input
                      value={inspectionSearch}
                      onChange={(e) => setInspectionSearch(e.target.value)}
                      placeholder="Search zone, checklist, or inspector..."
                      className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-xs text-foreground placeholder:text-muted"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase font-bold text-muted tracking-wider">Inspected By</label>
                    <select
                      value={inspectionInspectorFilter}
                      onChange={(e) => setInspectionInspectorFilter(e.target.value)}
                      className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-xs text-foreground"
                    >
                      <option value="all">All Inspectors</option>
                      {inspectionInspectorOptions.map((name) => (
                        <option key={name} value={name}>{name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase font-bold text-muted tracking-wider">Status</label>
                    <select
                      value={inspectionStatusFilter}
                      onChange={(e) => setInspectionStatusFilter(e.target.value)}
                      className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-xs text-foreground"
                    >
                      <option value="all">All Statuses</option>
                      <option value="pass">Pass</option>
                      <option value="fail">Fail</option>
                      <option value="partial">Partial</option>
                      <option value="pending">Pending</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="bg-card border border-border-custom rounded-md overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-elevated border-b border-border-custom">
                      <tr>
                        <th className="px-5 py-3 font-semibold">Zone</th>
                        <th className="px-5 py-3 font-semibold">Checklist</th>
                        <th className="px-5 py-3 font-semibold">Date</th>
                        <th className="px-5 py-3 font-semibold">Inspected By</th>
                        <th className="px-5 py-3 font-semibold">Pass / Fail</th>
                        <th className="px-5 py-3 font-semibold">Status</th>
                        <th className="px-5 py-3 font-semibold text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inspections.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-5 py-8">
                            <EmptyState
                              icon="search"
                              title="No inspections yet"
                              description="Conduct quality inspections to record pass/fail checklists across project zones."
                              action={{
                                label: "+ New Inspection",
                                onClick: () => setShowInspForm(true),
                              }}
                            />
                          </td>
                        </tr>
                      ) : filteredInspections.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-5 py-10 text-center text-muted">No inspections match the current filters.</td>
                        </tr>
                      ) : (
                        filteredInspections.map((insp) => {
                          const rate = passRate(insp.passCount, insp.failCount);
                          return (
                            <tr key={insp.id} className="border-b border-border-custom hover:bg-elevated transition-all">
                              <td className="px-5 py-3 font-bold text-foreground">{insp.zone}</td>
                              <td className="px-5 py-3 text-muted">{insp.checklist}</td>
                              <td className="px-5 py-3 text-muted">{formatDate(insp.date)}</td>
                              <td className="px-5 py-3 text-muted">{insp.inspector}</td>
                              <td className="px-5 py-3">
                                <div className="flex items-center gap-3">
                                  <div className="flex-1 h-1.5 bg-elevated rounded-full overflow-hidden max-w-28">
                                    <div className="h-full bg-success rounded-full" style={{ width: `${rate}%` }} />
                                  </div>
                                  <div className="text-[10px] text-muted whitespace-nowrap">
                                    <span className="text-success font-bold inline-flex items-center gap-0.5"><Icon name="check" className="w-3 h-3" /> {insp.passCount}</span>
                                    <span className="mx-1">/</span>
                                    <span className="text-danger font-bold inline-flex items-center gap-0.5"><Icon name="close" className="w-3 h-3" /> {insp.failCount}</span>
                                  </div>
                                </div>
                              </td>
                              <td className="px-5 py-3">{badge(formatLabel(insp.status), statusTones[insp.status])}</td>
                              <td className="px-5 py-3 text-right whitespace-nowrap">
                                <div className="flex gap-2 justify-end">
                                  <button
                                    onClick={() => setSelectedInspection(insp)}
                                    className="px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-[10px] font-bold border border-primary/20 hover:bg-primary/20 cursor-pointer"
                                  >
                                    View
                                  </button>
                                  {(insp.status === "fail" || insp.failCount > 0) && (
                                    <button
                                      onClick={() => {
                                        setNcrForm({
                                          ncrNumber: "",
                                          title: `NCR: Failed Inspection - ${insp.checklist}`,
                                          description: `Quality non-conformance logged from inspection with ${insp.failCount} failed checkpoints.`,
                                          severity: insp.failCount > 2 ? "Critical" : "Major",
                                          zone: insp.zone || "",
                                          inspectionId: insp.id,
                                          dueDate: toLocalISODate(new Date(Date.now() + 86400000))
                                        });
                                        setShowNCRForm(true);
                                      }}
                                      className="px-2.5 py-1.5 rounded-lg bg-danger/10 text-danger text-[10px] font-bold border border-danger/20 hover:bg-danger/20 cursor-pointer"
                                    >
                                      + Raise NCR
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ── CHECKLISTS ──────────────────────────────────────────────────── */}
          {tab === "checklists" && (
            <div className="space-y-4">
              {checklists.map(cl => (
                <div key={cl.id} className="bg-card border border-border-custom rounded-md overflow-hidden">
                  <div className="px-5 py-4 border-b border-border-custom flex items-center justify-between">
                    <div>
                      <p className="font-bold text-foreground">{cl.title}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge tone="info">{cl.category}</Badge>
                        <Badge tone="primary">{cl.isCode}</Badge>
                        <span className="text-[10px] text-muted">{cl.items.length} items</span>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        setInspForm(prev => ({ ...prev, checklistId: cl.id }));
                        setShowInspForm(true);
                      }}
                      className="px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-bold border border-primary/20 hover:bg-primary/20 cursor-pointer"
                    >
                      Use Template
                    </button>
                  </div>
                  <table className="w-full text-xs">
                    <thead className="bg-elevated border-b border-border-custom">
                      <tr>
                        {["#", "Checkpoint", "Acceptable Criteria", "Mandatory"].map(h => (
                          <th key={h} className="text-left px-4 py-2 text-[10px] font-bold text-muted uppercase tracking-wider">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-custom">
                      {cl.items.map(item => (
                        <tr key={item.id} className="hover:bg-elevated">
                          <td className="px-4 py-2.5 text-muted font-sans">{item.sequence}</td>
                          <td className="px-4 py-2.5 text-foreground">{item.description}</td>
                          <td className="px-4 py-2.5 text-muted">{item.criteria}</td>
                          <td className="px-4 py-2.5">
                            {item.mandatory
                              ? <Badge tone="danger">MANDATORY</Badge>
                              : <span className="text-muted text-[10px]">Optional</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}

          {/* ── NCR KANBAN ──────────────────────────────────────────────────── */}
          {tab === "ncr" && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Open */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-2 w-2 rounded-full bg-danger" />
                  <span className="text-xs font-bold text-muted uppercase tracking-wider">Open</span>
                  <span className="ml-auto text-xs text-muted">{openNCRs.length}</span>
                </div>
                {openNCRs.map(ncr => (
                  <div key={ncr.id} className="bg-card border border-danger/10 rounded-md p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      {badge(ncr.severity, severityTones[ncr.severity])}
                      <span className="text-[10px] text-muted font-sans">{ncr.number}</span>
                    </div>
                    <p className="text-xs font-semibold text-foreground leading-snug">{ncr.title}</p>
                    <p className="text-[10px] text-muted">{ncr.zone} · Due {ncr.dueDate}</p>
                    <button onClick={() => moveNCR(ncr.id, "under_review")}
                      className="w-full text-[10px] py-1 rounded bg-info/10 text-info border border-info/20 hover:bg-info/10 font-bold transition-all cursor-pointer inline-flex items-center justify-center gap-1">
                      <Icon name="arrow_forward" className="w-3 h-3" /> Move to Review
                    </button>
                  </div>
                ))}
              </div>

              {/* Under Review */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-2 w-2 rounded-full bg-info" />
                  <span className="text-xs font-bold text-muted uppercase tracking-wider">Under Review</span>
                  <span className="ml-auto text-xs text-muted">{reviewNCRs.length}</span>
                </div>
                {reviewNCRs.map(ncr => (
                  <div key={ncr.id} className="bg-card border border-info/10 rounded-md p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      {badge(ncr.severity, severityTones[ncr.severity])}
                      <span className="text-[10px] text-muted font-sans">{ncr.number}</span>
                    </div>
                    <p className="text-xs font-semibold text-foreground leading-snug">{ncr.title}</p>
                    <p className="text-[10px] text-muted">{ncr.zone} · Due {ncr.dueDate}</p>
                    <button onClick={() => moveNCR(ncr.id, "closed")}
                      className="w-full text-[10px] py-1 rounded bg-success/10 text-success border border-success/20 hover:bg-success/10 font-bold transition-all cursor-pointer inline-flex items-center justify-center gap-1">
                      <Icon name="check" className="w-3 h-3" /> Close NCR
                    </button>
                  </div>
                ))}
              </div>

              {/* Closed */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-2 w-2 rounded-full bg-success" />
                  <span className="text-xs font-bold text-muted uppercase tracking-wider">Closed</span>
                  <span className="ml-auto text-xs text-muted">{closedNCRs.length}</span>
                </div>
                {closedNCRs.map(ncr => (
                  <div key={ncr.id} className="bg-card border border-success/10 rounded-md p-4 space-y-2 opacity-70">
                    <div className="flex items-center justify-between">
                      {badge(ncr.severity, severityTones[ncr.severity])}
                      <span className="text-[10px] text-muted font-sans">{ncr.number}</span>
                    </div>
                    <p className="text-xs font-semibold text-foreground leading-snug">{ncr.title}</p>
                    <p className="text-[10px] text-muted italic">{ncr.resolution}</p>
                    {badge("Closed", statusTones["closed"])}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── LAB TESTS ───────────────────────────────────────────────────── */}
          {tab === "labtests" && (
            <div className="space-y-4">
              {/* Summary row */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-2">
                {[
                  { label: "Total Tests", val: labTests.length, color: "text-foreground" },
                  { label: "Passed", val: labTests.filter(t => t.pass === true).length, color: "text-success" },
                  { label: "Failed", val: labTests.filter(t => t.pass === false).length, color: "text-danger" },
                  { label: "Pass Rate", val: (() => { const ev = labTests.filter(t => t.pass != null); return ev.length ? `${Math.round(ev.filter(t => t.pass).length / ev.length * 100)}%` : "0%"; })(), color: "text-primary" },
                ].map(({ label, val, color }) => (
                  <div key={label} className="bg-card border border-border-custom rounded-md p-4">
                    <p className="text-[10px] text-muted uppercase font-bold tracking-wider mb-1">{label}</p>
                    <p className={`text-2xl font-bold ${color}`}>{val}</p>
                  </div>
                ))}
              </div>

              <div className="bg-card border border-border-custom rounded-md overflow-hidden">
                <div className="px-5 py-3 border-b border-border-custom flex items-center justify-between">
                  <span className="text-xs font-bold text-foreground">Test Results Log</span>
                  <button onClick={() => setShowTestForm(true)} className="px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-bold border border-primary/20 hover:bg-primary/20 cursor-pointer">+ Log Test</button>
                </div>
                <table className="w-full text-xs">
                  <thead className="bg-elevated border-b border-border-custom">
                    <tr>
                      {["Test Type", "Material", "Sample Ref", "Date", "Result", "Range", "Zone", "Status"].map(h => (
                        <th key={h} className="text-left px-4 py-2.5 text-[10px] font-bold text-muted uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-custom">
                    {labTests.map(t => (
                      <tr key={t.id} className="hover:bg-elevated transition-colors">
                        <td className="px-4 py-3 font-semibold text-foreground">{t.type}</td>
                        <td className="px-4 py-3 text-muted">{t.material}</td>
                        <td className="px-4 py-3 font-sans text-muted text-[10px]">{t.sampleRef}</td>
                        <td className="px-4 py-3 text-muted">{formatDate(t.date)}</td>
                        <td className="px-4 py-3">
                          <span className={`font-bold text-sm ${t.pass == null ? "text-muted" : t.pass ? "text-success" : "text-danger"}`}>
                            {t.value} {t.unit}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-muted">{t.min != null && t.max != null ? `${t.min}–${t.max} ${t.unit}` : "—"}</td>
                        <td className="px-4 py-3 text-muted">{t.zone}</td>
                        <td className="px-4 py-3">
                          {t.pass == null
                            ? <span className="flex items-center gap-1 text-muted font-bold text-[10px]"><span className="h-1.5 w-1.5 rounded-full bg-elevated" />Not evaluated</span>
                            : t.pass
                              ? <span className="flex items-center gap-1 text-success font-bold text-[10px]"><span className="h-1.5 w-1.5 rounded-full bg-success" />PASS</span>
                              : <span className="flex items-center gap-1 text-danger font-bold text-[10px]"><span className="h-1.5 w-1.5 rounded-full bg-danger" />FAIL</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          </PageShell>
        </div>
      </main>

      {/* Inspection Detail Modal */}
      {selectedInspection && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => setSelectedInspection(null)}>
          <div className="bg-card border border-border-custom rounded-lg w-full max-w-xl p-6 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="font-bold text-foreground">{selectedInspection.zone}</h2>
                <p className="text-xs text-muted">{selectedInspection.checklist} · {formatDate(selectedInspection.date)}</p>
              </div>
              <button onClick={() => setSelectedInspection(null)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>

            <div className="flex items-center gap-4 mb-5">
              <div className="flex-1 h-2 bg-elevated rounded-full overflow-hidden">
                <div className="h-full bg-success rounded-full"
                  style={{ width: `${passRate(selectedInspection.passCount, selectedInspection.failCount)}%` }} />
              </div>
              <span className="text-sm font-bold text-foreground">{passRate(selectedInspection.passCount, selectedInspection.failCount)}%</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-5">
              {[
                { label: "Pass", val: selectedInspection.passCount, color: "text-success bg-success/10 border-success/20" },
                { label: "Fail", val: selectedInspection.failCount, color: "text-danger bg-danger/10 border-danger/20" },
                { label: "N/A", val: selectedInspection.naCount, color: "text-muted bg-elevated border-border-custom" },
              ].map(({ label, val, color }) => (
                <div key={label} className={`rounded-md border p-3 text-center ${color}`}>
                  <p className="text-xl font-bold">{val}</p>
                  <p className="text-[10px] font-bold uppercase">{label}</p>
                </div>
              ))}
            </div>

            <div className="mb-4">
              {badge(selectedInspection.status, statusTones[selectedInspection.status])}
            </div>

            {/* Recorded Inspection Responses */}
            <div className="space-y-3 border-t border-border-custom pt-4 mt-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted">Inspection Checkpoint Records</h3>
                <span className="text-[10px] text-muted">{existingResponses.length} logged responses</span>
              </div>
              {loadingResponses ? (
                <div className="text-xs text-muted text-center py-4">Loading inspection responses...</div>
              ) : existingResponses.length === 0 ? (
                <div className="text-xs text-muted text-center py-3 bg-elevated/50 rounded-lg">
                  No individual checkpoint responses logged yet.
                </div>
              ) : (
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {existingResponses.map((resp, idx) => (
                    <div key={resp.id || idx} className="p-2.5 rounded-lg bg-elevated border border-border-custom flex items-center justify-between gap-3 text-xs">
                      <div>
                        <span className="font-semibold text-foreground">Checkpoint #{idx + 1}</span>
                        {resp.remarks && <p className="text-[10px] text-muted mt-0.5">{resp.remarks}</p>}
                      </div>
                      <div className="flex items-center gap-2">
                        {resp.photo_url && (
                          <a href={resp.photo_url} target="_blank" rel="noreferrer" className="text-[10px] text-primary underline font-medium">
                            Photo
                          </a>
                        )}
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                          resp.result?.toLowerCase() === "pass"
                            ? "bg-success/10 text-success border border-success/20"
                            : resp.result?.toLowerCase() === "fail"
                            ? "bg-danger/10 text-danger border border-danger/20"
                            : "bg-elevated text-muted border border-border-custom"
                        }`}>
                          {resp.result}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Checklist Checkpoints Audit Form */}
            {activeInspectionItems.length > 0 && (
              <div className="space-y-4 border-t border-border-custom pt-4 mt-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted">Verify Checkpoints</h3>
                <div className="space-y-3">
                  {activeInspectionItems.map((item) => (
                    <div key={item.id} className="p-3 rounded-lg bg-elevated border border-border-custom flex flex-col md:flex-row md:items-center justify-between gap-3 text-left">
                      <div className="text-left">
                        <p className="text-xs text-foreground font-semibold">{item.sequence}. {item.description}</p>
                        <p className="text-[10px] text-muted mt-0.5">Criteria: {item.criteria}</p>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        {["Pass", "Fail", "NA"].map((res) => {
                          const isSelected = inspectionResponses[item.id] === res;
                          return (
                            <button
                              key={res}
                              onClick={() => setInspectionResponses(prev => ({ ...prev, [item.id]: res as any }))}
                              className={`px-2.5 py-1 text-[10px] font-bold rounded border transition-all cursor-pointer ${
                                isSelected
                                  ? res === "Pass"
                                    ? "bg-success/10 border-success text-success"
                                    : res === "Fail"
                                    ? "bg-danger/10 border-danger text-danger"
                                    : "bg-elevated border-border-custom text-muted"
                                  : "bg-elevated border-border-custom text-muted hover:text-foreground"
                              }`}
                            >
                              {res}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                <button
                  onClick={handleSubmitAuditResponses}
                  className="w-full bg-primary hover:bg-primary/95 text-white py-2 rounded-md text-xs font-bold transition-all mt-4 cursor-pointer"
                >
                  Submit Audit Responses
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal: Start Site Inspection */}
      {showInspForm && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-card border border-border-custom rounded-lg w-full max-w-md border border-border-custom rounded-md p-6 space-y-4 text-left">
            <div>
              <h3 className="text-sm font-extrabold text-foreground">Start Site Inspection</h3>
              <p className="text-xs text-muted mt-1">Initiate a quality control verification event.</p>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Select Checklist Template</label>
                <select
                  value={inspForm.checklistId}
                  onChange={(e) => setInspForm(prev => ({ ...prev, checklistId: e.target.value }))}
                  className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary font-semibold"
                >
                  <option value="">Choose Template</option>
                  {checklists.map(cl => (
                    <option key={cl.id} value={cl.id} className="bg-card text-foreground">{cl.title} ({cl.isCode})</option>
                  ))}
                </select>
                {checklists.length === 0 && (
                  <FieldHint text="No checklist templates yet. Create templates in Quality." href={`/c/${companyId}/d/quality`} linkLabel="Go to Quality" />
                )}
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Location Zone</label>
                <input
                  type="text"
                  placeholder="Floor 3 Grid C-D"
                  value={inspForm.zone}
                  onChange={(e) => setInspForm(prev => ({ ...prev, zone: e.target.value }))}
                  className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Remarks</label>
                <textarea
                  placeholder="Additional inspection instructions..."
                  value={inspForm.overallRemarks}
                  onChange={(e) => setInspForm(prev => ({ ...prev, overallRemarks: e.target.value }))}
                  rows={2}
                  className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary"
                />
              </div>
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <button onClick={() => setShowInspForm(false)} className="px-4 py-2 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer">Cancel</button>
              <button onClick={handleCreateInspection} className="bg-primary hover:opacity-90 text-white px-5 py-2 rounded-md text-xs font-bold cursor-pointer">Start Inspection</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Raise NCR */}
      {showNCRForm && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-card border border-border-custom rounded-lg w-full max-w-md border border-border-custom rounded-md p-6 space-y-4 text-left">
            <div>
              <h3 className="text-sm font-extrabold text-foreground">Raise Non-Conformance Report (NCR)</h3>
              <p className="text-xs text-muted mt-1">Issue a formal quality deviation report.</p>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Linked Inspection (Optional)</label>
                <select
                  value={ncrForm.inspectionId}
                  onChange={(e) => setNcrForm(prev => ({ ...prev, inspectionId: e.target.value }))}
                  className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary"
                >
                  <option value="">General NCR / Not Linked to Inspection</option>
                  {inspections.map((insp) => (
                    <option key={insp.id} value={insp.id}>
                      {insp.checklist} ({insp.zone || "No Zone"}) - {insp.status.toUpperCase()} ({formatDate(insp.date)})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">NCR Number (leave blank for automatic)</label>
                <input
                  type="text"
                  placeholder="Auto-assigned sequentially"
                  value={ncrForm.ncrNumber}
                  onChange={(e) => setNcrForm(prev => ({ ...prev, ncrNumber: e.target.value }))}
                  className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Deviation Title</label>
                <input
                  type="text"
                  placeholder="Shuttering misalignment >10mm"
                  value={ncrForm.title}
                  onChange={(e) => setNcrForm(prev => ({ ...prev, title: e.target.value }))}
                  className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Description / Snags details</label>
                <textarea
                  placeholder="Describe the exact quality issue..."
                  value={ncrForm.description}
                  onChange={(e) => setNcrForm(prev => ({ ...prev, description: e.target.value }))}
                  rows={2}
                  className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary"
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Severity</label>
                  <select
                    value={ncrForm.severity}
                    onChange={(e) => setNcrForm(prev => ({ ...prev, severity: e.target.value as any }))}
                    className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary font-semibold"
                  >
                    <option value="Minor" className="bg-card text-foreground">Minor</option>
                    <option value="Major" className="bg-card text-foreground">Major</option>
                    <option value="Critical" className="bg-card text-foreground">Critical</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Due Date</label>
                  <input
                    type="date"
                    value={ncrForm.dueDate}
                    onChange={(e) => setNcrForm(prev => ({ ...prev, dueDate: e.target.value }))}
                    className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary"
                  />
                </div>
              </div>
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <button onClick={() => setShowNCRForm(false)} className="px-4 py-2 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer">Cancel</button>
              <button onClick={handleCreateNCR} className="bg-primary hover:opacity-90 text-white px-5 py-2 rounded-md text-xs font-bold cursor-pointer">Raise NCR</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Log Material Test */}
      {showTestForm && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-card border border-border-custom rounded-lg w-full max-w-md border border-border-custom rounded-md p-6 space-y-4 text-left">
            <div>
              <h3 className="text-sm font-extrabold text-foreground">Log Material Lab Test</h3>
              <p className="text-xs text-muted mt-1">Record on-site / lab compressive, slump, or soil test results.</p>
            </div>
            <div className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Test Type</label>
                  <input
                    type="text"
                    placeholder="Cube Test"
                    value={testForm.type}
                    onChange={(e) => setTestForm(prev => ({ ...prev, type: e.target.value }))}
                    className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary"
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Material Name</label>
                  <input
                    type="text"
                    placeholder="Concrete M25"
                    value={testForm.material}
                    onChange={(e) => setTestForm(prev => ({ ...prev, material: e.target.value }))}
                    className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary font-semibold"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Result Value</label>
                  <input
                    type="number"
                    step="0.1"
                    value={testForm.value}
                    onChange={(e) => setTestForm(prev => ({ ...prev, value: e.target.value }))}
                    className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary"
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Unit</label>
                  <input
                    type="text"
                    placeholder="MPa"
                    value={testForm.unit}
                    onChange={(e) => setTestForm(prev => ({ ...prev, unit: e.target.value }))}
                    className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary"
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Sample Ref</label>
                  <input
                    type="text"
                    placeholder="CB-001"
                    value={testForm.sampleRef}
                    onChange={(e) => setTestForm(prev => ({ ...prev, sampleRef: e.target.value }))}
                    className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Min Acceptable</label>
                  <input
                    type="number"
                    step="0.1"
                    value={testForm.min}
                    onChange={(e) => setTestForm(prev => ({ ...prev, min: e.target.value }))}
                    className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary"
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase font-bold text-muted block mb-1">Max Acceptable</label>
                  <input
                    type="number"
                    step="0.1"
                    value={testForm.max}
                    onChange={(e) => setTestForm(prev => ({ ...prev, max: e.target.value }))}
                    className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary"
                  />
                </div>
              </div>
              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">Zone / Area Used</label>
                <input
                  type="text"
                  placeholder="Floor 3 Column C3"
                  value={testForm.zone}
                  onChange={(e) => setTestForm(prev => ({ ...prev, zone: e.target.value }))}
                  className="w-full bg-card border border-border-custom rounded-md px-3 py-2 text-xs text-foreground outline-none focus:border-secondary"
                />
              </div>
            </div>
            <div className="flex gap-3 justify-end pt-2">
              <button onClick={() => setShowTestForm(false)} className="px-4 py-2 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer">Cancel</button>
              <button onClick={handleCreateTest} className="bg-primary hover:opacity-90 text-white px-5 py-2 rounded-md text-xs font-bold cursor-pointer">Log Test</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}