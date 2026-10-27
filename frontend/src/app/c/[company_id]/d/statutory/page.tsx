"use client";

import React, { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { useProject } from "@/context/ProjectContext";
import { usePermissions } from "@/context/PermissionsContext";
import { getApiHost, readErrorDetail } from "@/lib/api";
import { authHeaders, formatDate, formatLabel } from "@/lib/siteflow";
import Badge, { type BadgeTone } from "@/components/ui/Badge";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import Icon from "@/components/marketing/Icon";

interface Report {
  id: string;
  report_type: string;
  return_period: string;
  total_employees: number;
  total_wages: number;
  pf_employee_contribution: number;
  pf_employer_contribution: number;
  esi_employee_contribution: number;
  esi_employer_contribution: number;
  bocw_cess: number;
  tds_deducted: number;
  filed_at?: string;
  filed_by?: string;
  acknowledgment_number?: string;
  status: string;
  due_date?: string;
  days_overdue: number;
  penalty_estimate: number;
  created_at: string;
}

interface PenaltyEstimate {
  report_type: string;
  return_period: string;
  total_wages: number;
  due_date?: string;
  estimated_penalty: number;
}

interface GSTR1Record {
  invoice_number: string;
  invoice_date: string;
  party_name: string | null;
  party_gstin: string | null;
  taxable_value: number;
  gst_amount: number;
  cgst: number;
  sgst: number;
  igst: number;
}

interface GSTR1Response {
  report: string;
  company_id: string;
  return_period: string;
  due_date: string;
  status: string;
  total_invoices: number;
  total_taxable_value: number;
  total_gst: number;
  records: GSTR1Record[];
}

interface PFECRLine {
  uan: string | null;
  employee_code: string;
  name: string;
  pf_wages: number;
  ee_pf_contribution: number;
  er_pf_contribution: number;
  eps_contribution: number;
  epf_contribution: number;
  total_pf: number;
}

interface PFECRResponse {
  report: string;
  company_id: string;
  return_period: string;
  due_date: string;
  total_employees: number;
  total_ee_pf: number;
  total_er_pf: number;
  total_eps_pf: number;
  total_epf_pf: number;
  total_pf_liability: number;
  ecr_lines: PFECRLine[];
}

interface TDS26QRow {
  pan: string;
  name: string | null;
  invoice_number: string;
  tds_section: string;
  gross_payment: number;
  tds_deducted: number;
  deduction_date: string;
}

interface TDS26QResponse {
  report: string;
  company_id: string;
  quarter: string;
  year: number;
  due_date: string;
  total_deductees: number;
  total_tds_liability: number;
  deductee_rows: TDS26QRow[];
}

type GeneratorTab = "gstr1" | "pf-ecr" | "tds-26q";

const MONTHS = [
  { value: 1, label: "January (01)" },
  { value: 2, label: "February (02)" },
  { value: 3, label: "March (03)" },
  { value: 4, label: "April (04)" },
  { value: 5, label: "May (05)" },
  { value: 6, label: "June (06)" },
  { value: 7, label: "July (07)" },
  { value: 8, label: "August (08)" },
  { value: 9, label: "September (09)" },
  { value: 10, label: "October (10)" },
  { value: 11, label: "November (11)" },
  { value: 12, label: "December (12)" },
];

const QUARTERS = [
  { value: "Q1", label: "Q1 (Apr - Jun)" },
  { value: "Q2", label: "Q2 (Jul - Sep)" },
  { value: "Q3", label: "Q3 (Oct - Dec)" },
  { value: "Q4", label: "Q4 (Jan - Mar)" },
];

const currentCalendarYear = new Date().getFullYear();
const YEARS = Array.from({ length: 6 }, (_, i) => currentCalendarYear - 3 + i);

function downloadCSV(filename: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const csvContent = [
    headers.join(","),
    ...rows.map((row) =>
      row
        .map((val) => {
          const str = String(val ?? "").replace(/"/g, '""');
          return str.includes(",") || str.includes('"') || str.includes("\n") ? `"${str}"` : str;
        })
        .join(",")
    ),
  ].join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function getClosedTdsQuarterAndFy(now = new Date()): { quarter: string; fy: number } {
  const m = now.getMonth(); // 0-indexed: 0 is Jan, 11 is Dec
  const y = now.getFullYear();
  if (m < 3) return { quarter: "Q3", fy: y - 1 };
  if (m < 6) return { quarter: "Q4", fy: y - 1 };
  if (m < 9) return { quarter: "Q1", fy: y };
  return { quarter: "Q2", fy: y };
}

export default function StatutoryPage() {
  const params = useParams();
  const companyId = (params?.company_id as string) || "demo-company";
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;
  const { can } = usePermissions();

  const canFinance = can("finance:view");
  const canPayroll = can("payroll:view");

  const [reports, setReports] = useState<Report[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [filterType, setFilterType] = useState("");
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [showPenalty, setShowPenalty] = useState(false);
  const [penaltyData, setPenaltyData] = useState<PenaltyEstimate | null>(null);

  // Return Generator State
  const defaultTab: GeneratorTab = canFinance ? "gstr1" : canPayroll ? "pf-ecr" : "gstr1";
  const [activeGeneratorTab, setActiveGeneratorTab] = useState<GeneratorTab>(defaultTab);

  const [genMonth, setGenMonth] = useState<number>(() => {
    const now = new Date();
    const m = now.getMonth(); // 0 is Jan, 8 is Sep
    return m === 0 ? 12 : m;
  });
  const [genCalendarYear, setGenCalendarYear] = useState<number>(() => {
    const now = new Date();
    return now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  });
  const [genFinancialYear, setGenFinancialYear] = useState<number>(() => getClosedTdsQuarterAndFy().fy);
  const [genQuarter, setGenQuarter] = useState<string>(() => getClosedTdsQuarterAndFy().quarter);
  const [isGenerating, setIsGenerating] = useState(false);

  // Return Data State
  const [gstr1Result, setGstr1Result] = useState<GSTR1Response | null>(null);
  const [pfEcrResult, setPfEcrResult] = useState<PFECRResponse | null>(null);
  const [tdsResult, setTdsResult] = useState<TDS26QResponse | null>(null);

  const [form, setForm] = useState({
    report_type: "pf",
    return_period: "",
    total_employees: 0,
    total_wages: 0,
    pf_employee_contribution: 0,
    pf_employer_contribution: 0,
    esi_employee_contribution: 0,
    esi_employer_contribution: 0,
    bocw_cess: 0,
    tds_deducted: 0,
    filed_by: "",
  });

  // Filter the reports were last loaded for; until it matches, say Loading.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const reportsLoading = loadedFor !== (filterType || "all");

  const fetchReports = async () => {
    try {
      const url = `${getApiHost()}/apis/v3/statutory/${companyId}${
        filterType ? `?report_type=${filterType}` : ""
      }`;
      const res = await fetch(url, { headers: authHeaders() });
      if (res.ok) setReports(await res.json());
    } catch (e) {
      console.error("Failed to load reports", e);
    } finally {
      setLoadedFor(filterType || "all");
    }
  };

  useEffect(() => {
    if (companyId) {
      fetchReports();
    }
  }, [companyId, filterType]);

  const handleGenerateGSTR1 = async () => {
    setIsGenerating(true);
    setMessage(null);
    try {
      const res = await fetch(
        `${getApiHost()}/apis/v3/statutory/${companyId}/gstr1?month=${genMonth}&year=${genCalendarYear}`,
        { headers: authHeaders() }
      );
      if (res.ok) {
        const data = await res.json();
        setGstr1Result(data);
        setMessage({ text: `GSTR-1 return for ${genCalendarYear}-${String(genMonth).padStart(2, "0")} generated successfully.`, type: "success" });
      } else {
        const err = await readErrorDetail(res);
        setMessage({ text: err || "Failed to generate GSTR-1 return", type: "error" });
      }
    } catch (e) {
      setMessage({ text: "Network error generating GSTR-1", type: "error" });
    }
    setIsGenerating(false);
  };

  const handleGeneratePFECR = async () => {
    setIsGenerating(true);
    setMessage(null);
    try {
      const res = await fetch(
        `${getApiHost()}/apis/v3/statutory/${companyId}/pf-ecr?month=${genMonth}&year=${genCalendarYear}`,
        { headers: authHeaders() }
      );
      if (res.ok) {
        const data = await res.json();
        setPfEcrResult(data);
        setMessage({ text: `PF ECR return for ${genCalendarYear}-${String(genMonth).padStart(2, "0")} generated successfully.`, type: "success" });
      } else {
        const err = await readErrorDetail(res);
        setMessage({ text: err || "Failed to generate PF ECR return", type: "error" });
      }
    } catch (e) {
      setMessage({ text: "Network error generating PF ECR", type: "error" });
    }
    setIsGenerating(false);
  };

  const handleGenerateTDS26Q = async () => {
    setIsGenerating(true);
    setMessage(null);
    try {
      const res = await fetch(
        `${getApiHost()}/apis/v3/statutory/${companyId}/tds-26q?quarter=${genQuarter}&year=${genFinancialYear}`,
        { headers: authHeaders() }
      );
      if (res.ok) {
        const data = await res.json();
        setTdsResult(data);
        setMessage({ text: `TDS-26Q return for ${genQuarter} FY ${genFinancialYear} generated successfully.`, type: "success" });
      } else {
        const err = await readErrorDetail(res);
        setMessage({ text: err || "Failed to generate TDS-26Q return", type: "error" });
      }
    } catch (e) {
      setMessage({ text: "Network error generating TDS-26Q", type: "error" });
    }
    setIsGenerating(false);
  };

  const exportGSTR1CSV = () => {
    if (!gstr1Result) return;
    const headers = [
      "Invoice Number",
      "Invoice Date",
      "Party Name",
      "Party GSTIN",
      "Taxable Value (INR)",
      "GST Amount (INR)",
      "CGST (INR)",
      "SGST (INR)",
      "IGST (INR)",
    ];
    const rows = gstr1Result.records.map((r) => [
      r.invoice_number,
      r.invoice_date,
      r.party_name || "",
      r.party_gstin || "",
      r.taxable_value,
      r.gst_amount,
      r.cgst,
      r.sgst,
      r.igst,
    ]);
    downloadCSV(`GSTR1_${gstr1Result.return_period}.csv`, headers, rows);
  };

  const exportPFECRCSV = () => {
    if (!pfEcrResult) return;
    const headers = [
      "UAN",
      "Employee Code",
      "Name",
      "PF Wages (INR)",
      "EE PF Contribution (INR)",
      "ER PF Contribution (INR)",
      "EPS Contribution (INR)",
      "EPF Contribution (INR)",
      "Total PF (INR)",
    ];
    const rows = pfEcrResult.ecr_lines.map((r) => [
      r.uan || "",
      r.employee_code,
      r.name,
      r.pf_wages,
      r.ee_pf_contribution,
      r.er_pf_contribution,
      r.eps_contribution,
      r.epf_contribution,
      r.total_pf,
    ]);
    downloadCSV(`PF_ECR_${pfEcrResult.return_period}.csv`, headers, rows);
  };

  const exportTDSCSV = () => {
    if (!tdsResult) return;
    const headers = [
      "PAN",
      "Name",
      "Invoice Number",
      "TDS Section",
      "Gross Payment (INR)",
      "TDS Deducted (INR)",
      "Deduction Date",
    ];
    const rows = tdsResult.deductee_rows.map((r) => [
      r.pan,
      r.name || "",
      r.invoice_number,
      r.tds_section,
      r.gross_payment,
      r.tds_deducted,
      r.deduction_date,
    ]);
    downloadCSV(`TDS_26Q_${tdsResult.quarter}_${tdsResult.year}.csv`, headers, rows);
  };

  const handleAutoPopulate = async () => {
    const reportType = form.report_type;
    const returnPeriod = form.return_period;
    if (!returnPeriod) {
      setMessage({ text: "Please enter return period first", type: "error" });
      return;
    }
    try {
      const url = `${getApiHost()}/apis/v3/statutory/${companyId}/auto-populate?report_type=${reportType}&return_period=${returnPeriod}${
        projectId ? `&project_id=${projectId}` : ""
      }`;
      const res = await fetch(url, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setForm({
          report_type: data.report_type,
          return_period: data.return_period,
          total_employees: data.total_employees,
          total_wages: Number(data.total_wages),
          pf_employee_contribution: Number(data.pf_employee_contribution),
          pf_employer_contribution: Number(data.pf_employer_contribution),
          esi_employee_contribution: Number(data.esi_employee_contribution),
          esi_employer_contribution: Number(data.esi_employer_contribution),
          bocw_cess: Number(data.bocw_cess),
          tds_deducted: Number(data.tds_deducted),
          filed_by: "",
        });
        setMessage({ text: "Auto-populated from employee data", type: "success" });
      } else {
        const err = await readErrorDetail(res);
        setMessage({ text: err || "Failed to auto-populate", type: "error" });
      }
    } catch (_e) {
      setMessage({ text: "Error auto-populating", type: "error" });
    }
  };

  const handleEstimatePenalty = async () => {
    const returnPeriod = form.return_period;
    if (!returnPeriod) {
      setMessage({ text: "Please enter return period first", type: "error" });
      return;
    }
    try {
      const url = `${getApiHost()}/apis/v3/statutory/${companyId}/penalty?report_type=${
        form.report_type
      }&return_period=${returnPeriod}&total_wages=${form.total_wages}`;
      const res = await fetch(url, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setPenaltyData(data);
        setShowPenalty(true);
      } else {
        const err = await readErrorDetail(res);
        setMessage({ text: err || "Failed to estimate penalty", type: "error" });
      }
    } catch (_e2) {
      setMessage({ text: "Error estimating penalty", type: "error" });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    try {
      const body = { ...form, company_id: companyId, project_id: projectId || null, status: "draft" };
      const res = await fetch(`${getApiHost()}/apis/v3/statutory`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setMessage({ text: "Report created successfully", type: "success" });
        setShowModal(false);
        setForm({
          report_type: "pf",
          return_period: "",
          total_employees: 0,
          total_wages: 0,
          pf_employee_contribution: 0,
          pf_employer_contribution: 0,
          esi_employee_contribution: 0,
          esi_employer_contribution: 0,
          bocw_cess: 0,
          tds_deducted: 0,
          filed_by: "",
        });
        fetchReports();
      } else {
        const err = await readErrorDetail(res);
        setMessage({ text: err || "Failed to create report", type: "error" });
      }
    } catch (_e) {
      setMessage({ text: "Error creating report", type: "error" });
    }
  };

  const handleFile = async (reportId: string) => {
    const ack = prompt("Enter acknowledgment number:");
    const by = prompt("Enter filed by name:");
    if (!ack || !by) return;
    try {
      const res = await fetch(
        `${getApiHost()}/apis/v3/statutory/${reportId}/file?acknowledgment_number=${encodeURIComponent(
          ack
        )}&filed_by=${encodeURIComponent(by)}`,
        { method: "PATCH", headers: authHeaders() }
      );
      if (res.ok) {
        setMessage({ text: "Report filed successfully", type: "success" });
        fetchReports();
      } else {
        const err = await readErrorDetail(res);
        setMessage({ text: err || "Failed to file report", type: "error" });
      }
    } catch (_e) {
      setMessage({ text: "Error filing report", type: "error" });
    }
  };

  const typeLabels: Record<string, string> = {
    pf: "Provident Fund",
    esi: "ESI",
    bocw: "BOCW Cess",
    tds: "TDS",
    pt: "Professional Tax",
    it: "Income Tax",
  };

  const statusTones: Record<string, BadgeTone> = {
    draft: "neutral",
    filed: "success",
    overdue: "danger",
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden font-sans">
      <PageHeader
        title="Statutory Reports & Returns"
        subtitle="PF, ESI, BOCW, TDS 26Q, and GSTR-1 compliance filings"
        action={
          <button
            onClick={() => setShowModal(true)}
            className="px-3.5 py-1.5 bg-primary hover:bg-primary/90 text-white rounded-md text-xs font-semibold transition-all cursor-pointer"
          >
            + New Compliance Record
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto z-10">
        <PageShell width="wide">
          <div className="space-y-6">
            {message && (
              <div
                className={`p-3.5 rounded-md text-xs font-medium ${
                  message.type === "success"
                    ? "bg-success/10 text-success border border-success/20"
                    : "bg-danger/10 text-danger border border-danger/20"
                }`}
              >
                {message.text}
              </div>
            )}

            {/* Statutory Return Generators Card */}
            <div className="bg-card border border-border-custom rounded-lg overflow-hidden space-y-4 p-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border-custom pb-4">
                <div>
                  <span className="text-[10px] uppercase tracking-wider font-extrabold text-primary">
                    Automated Return Generation
                  </span>
                  <h2 className="text-sm font-bold text-foreground mt-0.5">
                    Statutory Filing Data Generators
                  </h2>
                </div>

                <div className="flex items-center gap-1.5 bg-elevated p-1 rounded-md border border-border-custom">
                  {canFinance && (
                    <button
                      onClick={() => setActiveGeneratorTab("gstr1")}
                      className={`px-3 py-1 text-xs font-semibold rounded cursor-pointer transition-all ${
                        activeGeneratorTab === "gstr1"
                          ? "bg-primary text-white"
                          : "text-muted hover:text-foreground"
                      }`}
                    >
                      GSTR-1
                    </button>
                  )}
                  {canPayroll && (
                    <>
                      <button
                        onClick={() => setActiveGeneratorTab("pf-ecr")}
                        className={`px-3 py-1 text-xs font-semibold rounded cursor-pointer transition-all ${
                          activeGeneratorTab === "pf-ecr"
                            ? "bg-primary text-white"
                            : "text-muted hover:text-foreground"
                        }`}
                      >
                        PF-ECR
                      </button>
                      <button
                        onClick={() => setActiveGeneratorTab("tds-26q")}
                        className={`px-3 py-1 text-xs font-semibold rounded cursor-pointer transition-all ${
                          activeGeneratorTab === "tds-26q"
                            ? "bg-primary text-white"
                            : "text-muted hover:text-foreground"
                        }`}
                      >
                        TDS Form 26Q
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Period Selector & Action Bar */}
              <div className="flex flex-wrap items-end gap-3 pt-1">
                {activeGeneratorTab !== "tds-26q" ? (
                  <>
                    <div>
                      <label className="text-[10px] uppercase font-bold text-muted block mb-1">Month</label>
                      <select
                        value={genMonth}
                        onChange={(e) => setGenMonth(parseInt(e.target.value))}
                        className="bg-input border border-border-custom rounded-md px-3 py-1.5 text-xs text-foreground outline-none"
                      >
                        {MONTHS.map((m) => (
                          <option key={m.value} value={m.value}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-[10px] uppercase font-bold text-muted block mb-1">Year</label>
                      <select
                        value={genCalendarYear}
                        onChange={(e) => setGenCalendarYear(parseInt(e.target.value))}
                        className="bg-input border border-border-custom rounded-md px-3 py-1.5 text-xs text-foreground outline-none"
                      >
                        {YEARS.map((y) => (
                          <option key={y} value={y}>
                            {y}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <label className="text-[10px] uppercase font-bold text-muted block mb-1">Quarter</label>
                      <select
                        value={genQuarter}
                        onChange={(e) => setGenQuarter(e.target.value)}
                        className="bg-input border border-border-custom rounded-md px-3 py-1.5 text-xs text-foreground outline-none"
                      >
                        {QUARTERS.map((q) => (
                          <option key={q.value} value={q.value}>
                            {q.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-[10px] uppercase font-bold text-muted block mb-1">Financial Year</label>
                      <select
                        value={genFinancialYear}
                        onChange={(e) => setGenFinancialYear(parseInt(e.target.value))}
                        className="bg-input border border-border-custom rounded-md px-3 py-1.5 text-xs text-foreground outline-none"
                      >
                        {YEARS.map((y) => (
                          <option key={y} value={y}>
                            {y} to {String(y + 1).slice(2)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                )}

                <div className="flex items-center gap-2">
                  {activeGeneratorTab === "gstr1" && (
                    <button
                      onClick={handleGenerateGSTR1}
                      disabled={isGenerating}
                      className="px-4 py-1.5 bg-primary text-white rounded-md text-xs font-bold hover:opacity-90 cursor-pointer disabled:opacity-50"
                    >
                      {isGenerating ? "Generating..." : "Generate GSTR-1"}
                    </button>
                  )}
                  {activeGeneratorTab === "pf-ecr" && (
                    <button
                      onClick={handleGeneratePFECR}
                      disabled={isGenerating}
                      className="px-4 py-1.5 bg-primary text-white rounded-md text-xs font-bold hover:opacity-90 cursor-pointer disabled:opacity-50"
                    >
                      {isGenerating ? "Generating..." : "Generate PF-ECR"}
                    </button>
                  )}
                  {activeGeneratorTab === "tds-26q" && (
                    <button
                      onClick={handleGenerateTDS26Q}
                      disabled={isGenerating}
                      className="px-4 py-1.5 bg-primary text-white rounded-md text-xs font-bold hover:opacity-90 cursor-pointer disabled:opacity-50"
                    >
                      {isGenerating ? "Generating..." : "Generate TDS-26Q"}
                    </button>
                  )}
                </div>
              </div>

              {/* GSTR-1 View */}
              {activeGeneratorTab === "gstr1" && gstr1Result && (
                <div className="space-y-4 pt-3 border-t border-border-custom">
                  <div className="flex flex-wrap items-center justify-between gap-3 bg-elevated/40 p-4 rounded-lg border border-border-custom">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
                      <div>
                        <span className="text-muted block text-[10px] uppercase font-bold">Return Period</span>
                        <span className="font-bold text-foreground">{gstr1Result.return_period}</span>
                      </div>
                      <div>
                        <span className="text-muted block text-[10px] uppercase font-bold">Total Invoices</span>
                        <span className="font-bold text-foreground">{gstr1Result.total_invoices}</span>
                      </div>
                      <div>
                        <span className="text-muted block text-[10px] uppercase font-bold">Taxable Value</span>
                        <span className="font-bold text-foreground">₹{gstr1Result.total_taxable_value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                      </div>
                      <div>
                        <span className="text-muted block text-[10px] uppercase font-bold">Total GST Liability</span>
                        <span className="font-bold text-primary font-sans">₹{gstr1Result.total_gst.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                      </div>
                    </div>

                    <button
                      onClick={exportGSTR1CSV}
                      className="px-3 py-1.5 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer flex items-center gap-1.5"
                    >
                      <Icon name="cloud_drive" className="w-3.5 h-3.5" />
                      Download GSTR-1 CSV
                    </button>
                  </div>

                  <div className="overflow-x-auto border border-border-custom rounded-lg">
                    <table className="w-full text-xs text-left">
                      <thead className="bg-elevated/50 text-muted border-b border-border-custom">
                        <tr>
                          <th className="px-4 py-2.5 font-bold">Invoice #</th>
                          <th className="px-4 py-2.5 font-bold">Date</th>
                          <th className="px-4 py-2.5 font-bold">Party Name</th>
                          <th className="px-4 py-2.5 font-bold">GSTIN</th>
                          <th className="px-4 py-2.5 font-bold text-right">Taxable (₹)</th>
                          <th className="px-4 py-2.5 font-bold text-right">CGST (₹)</th>
                          <th className="px-4 py-2.5 font-bold text-right">SGST (₹)</th>
                          <th className="px-4 py-2.5 font-bold text-right">IGST (₹)</th>
                          <th className="px-4 py-2.5 font-bold text-right">Total GST (₹)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border-custom/30">
                        {gstr1Result.records.map((r, i) => (
                          <tr key={i} className="hover:bg-elevated/20 transition-all">
                            <td className="px-4 py-2.5 font-bold text-foreground">{r.invoice_number}</td>
                            <td className="px-4 py-2.5 text-muted">{r.invoice_date}</td>
                            <td className="px-4 py-2.5 text-foreground">{r.party_name || "—"}</td>
                            <td className="px-4 py-2.5 text-muted font-mono text-[11px]">{r.party_gstin || "—"}</td>
                            <td className="px-4 py-2.5 text-right font-medium text-foreground">₹{r.taxable_value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                            <td className="px-4 py-2.5 text-right text-muted">₹{r.cgst.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                            <td className="px-4 py-2.5 text-right text-muted">₹{r.sgst.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                            <td className="px-4 py-2.5 text-right text-muted">₹{r.igst.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                            <td className="px-4 py-2.5 text-right font-bold text-foreground">₹{r.gst_amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                          </tr>
                        ))}
                        {gstr1Result.records.length === 0 && (
                          <tr>
                            <td colSpan={9} className="px-4 py-6 text-center text-muted">
                              No outward supply invoices found for period {gstr1Result.return_period}.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* PF-ECR View */}
              {activeGeneratorTab === "pf-ecr" && pfEcrResult && (
                <div className="space-y-4 pt-3 border-t border-border-custom">
                  <div className="flex flex-wrap items-center justify-between gap-3 bg-elevated/40 p-4 rounded-lg border border-border-custom">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
                      <div>
                        <span className="text-muted block text-[10px] uppercase font-bold">Return Period</span>
                        <span className="font-bold text-foreground">{pfEcrResult.return_period}</span>
                      </div>
                      <div>
                        <span className="text-muted block text-[10px] uppercase font-bold">Employees</span>
                        <span className="font-bold text-foreground">{pfEcrResult.total_employees}</span>
                      </div>
                      <div>
                        <span className="text-muted block text-[10px] uppercase font-bold">EE + ER PF</span>
                        <span className="font-bold text-foreground">
                          ₹{pfEcrResult.total_ee_pf.toLocaleString("en-IN", { maximumFractionDigits: 2 })} / ₹{pfEcrResult.total_er_pf.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted block text-[10px] uppercase font-bold">Total Liability</span>
                        <span className="font-bold text-primary font-sans">₹{pfEcrResult.total_pf_liability.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                      </div>
                    </div>

                    <button
                      onClick={exportPFECRCSV}
                      className="px-3 py-1.5 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer flex items-center gap-1.5"
                    >
                      <Icon name="cloud_drive" className="w-3.5 h-3.5" />
                      Download PF ECR CSV
                    </button>
                  </div>

                  <div className="overflow-x-auto border border-border-custom rounded-lg">
                    <table className="w-full text-xs text-left">
                      <thead className="bg-elevated/50 text-muted border-b border-border-custom">
                        <tr>
                          <th className="px-4 py-2.5 font-bold">UAN</th>
                          <th className="px-4 py-2.5 font-bold">Emp Code</th>
                          <th className="px-4 py-2.5 font-bold">Employee Name</th>
                          <th className="px-4 py-2.5 font-bold text-right">PF Wages (₹)</th>
                          <th className="px-4 py-2.5 font-bold text-right">EE Share (₹)</th>
                          <th className="px-4 py-2.5 font-bold text-right">EPS (₹)</th>
                          <th className="px-4 py-2.5 font-bold text-right">EPF (₹)</th>
                          <th className="px-4 py-2.5 font-bold text-right">Total PF (₹)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border-custom/30">
                        {pfEcrResult.ecr_lines.map((r, i) => (
                          <tr key={i} className="hover:bg-elevated/20 transition-all">
                            <td className="px-4 py-2.5 font-mono text-[11px] text-foreground">{r.uan || "—"}</td>
                            <td className="px-4 py-2.5 text-muted">{r.employee_code}</td>
                            <td className="px-4 py-2.5 font-medium text-foreground">{r.name}</td>
                            <td className="px-4 py-2.5 text-right font-medium text-foreground">₹{r.pf_wages.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                            <td className="px-4 py-2.5 text-right text-muted">₹{r.ee_pf_contribution.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                            <td className="px-4 py-2.5 text-right text-muted">₹{r.eps_contribution.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                            <td className="px-4 py-2.5 text-right text-muted">₹{r.epf_contribution.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                            <td className="px-4 py-2.5 text-right font-bold text-foreground">₹{r.total_pf.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                          </tr>
                        ))}
                        {pfEcrResult.ecr_lines.length === 0 && (
                          <tr>
                            <td colSpan={8} className="px-4 py-6 text-center text-muted">
                              No PF ECR lines found for period {pfEcrResult.return_period}.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* TDS-26Q View */}
              {activeGeneratorTab === "tds-26q" && tdsResult && (
                <div className="space-y-4 pt-3 border-t border-border-custom">
                  <div className="flex flex-wrap items-center justify-between gap-3 bg-elevated/40 p-4 rounded-lg border border-border-custom">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
                      <div>
                        <span className="text-muted block text-[10px] uppercase font-bold">Quarter</span>
                        <span className="font-bold text-foreground">{tdsResult.quarter} FY {tdsResult.year}</span>
                      </div>
                      <div>
                        <span className="text-muted block text-[10px] uppercase font-bold">Due Date</span>
                        <span className="font-bold text-foreground">{tdsResult.due_date}</span>
                      </div>
                      <div>
                        <span className="text-muted block text-[10px] uppercase font-bold">Deductees</span>
                        <span className="font-bold text-foreground">{tdsResult.total_deductees}</span>
                      </div>
                      <div>
                        <span className="text-muted block text-[10px] uppercase font-bold">Total TDS Withheld</span>
                        <span className="font-bold text-primary font-sans">₹{tdsResult.total_tds_liability.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                      </div>
                    </div>

                    <button
                      onClick={exportTDSCSV}
                      className="px-3 py-1.5 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer flex items-center gap-1.5"
                    >
                      <Icon name="cloud_drive" className="w-3.5 h-3.5" />
                      Download Form 26Q CSV
                    </button>
                  </div>

                  <div className="overflow-x-auto border border-border-custom rounded-lg">
                    <table className="w-full text-xs text-left">
                      <thead className="bg-elevated/50 text-muted border-b border-border-custom">
                        <tr>
                          <th className="px-4 py-2.5 font-bold">PAN</th>
                          <th className="px-4 py-2.5 font-bold">Deductee Name</th>
                          <th className="px-4 py-2.5 font-bold">Invoice #</th>
                          <th className="px-4 py-2.5 font-bold">TDS Section</th>
                          <th className="px-4 py-2.5 font-bold text-right">Gross Payment (₹)</th>
                          <th className="px-4 py-2.5 font-bold text-right">TDS Deducted (₹)</th>
                          <th className="px-4 py-2.5 font-bold">Deduction Date</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border-custom/30">
                        {tdsResult.deductee_rows.map((r, i) => (
                          <tr key={i} className="hover:bg-elevated/20 transition-all">
                            <td className="px-4 py-2.5 font-mono text-[11px] text-foreground font-bold">{r.pan}</td>
                            <td className="px-4 py-2.5 font-medium text-foreground">{r.name || "—"}</td>
                            <td className="px-4 py-2.5 text-muted">{r.invoice_number}</td>
                            <td className="px-4 py-2.5 text-foreground">
                              <Badge tone="info" className="text-[10px]">
                                {r.tds_section}
                              </Badge>
                            </td>
                            <td className="px-4 py-2.5 text-right font-medium text-foreground">₹{r.gross_payment.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                            <td className="px-4 py-2.5 text-right font-bold text-foreground">₹{r.tds_deducted.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                            <td className="px-4 py-2.5 text-muted">{r.deduction_date}</td>
                          </tr>
                        ))}
                        {tdsResult.deductee_rows.length === 0 && (
                          <tr>
                            <td colSpan={7} className="px-4 py-6 text-center text-muted">
                              No non-salary TDS deductions recorded in {tdsResult.quarter} FY {tdsResult.year}.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* Compliance Register Table */}
            <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
              <div className="px-5 py-4 border-b border-border-custom flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-xs font-bold uppercase tracking-wider text-muted">Compliance Filing Records</h2>
                  <p className="text-[11px] text-muted mt-0.5">Historical and draft statutory filings tracking</p>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={filterType}
                    onChange={(e) => setFilterType(e.target.value)}
                    className="bg-input border border-border-custom rounded-md px-2.5 py-1.5 text-foreground text-xs"
                  >
                    <option value="">All Types</option>
                    <option value="pf">PF</option>
                    <option value="esi">ESI</option>
                    <option value="bocw">BOCW</option>
                    <option value="tds">TDS</option>
                    <option value="pt">PT</option>
                    <option value="it">IT</option>
                  </select>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-elevated/50 text-muted border-b border-border-custom">
                    <tr>
                      <th className="px-4 py-3 font-bold">Type</th>
                      <th className="px-4 py-3 font-bold">Period</th>
                      <th className="px-4 py-3 font-bold">Employees</th>
                      <th className="px-4 py-3 font-bold text-right">Total Wages</th>
                      <th className="px-4 py-3 font-bold text-right">PF (EE / ER)</th>
                      <th className="px-4 py-3 font-bold text-right">ESI (EE / ER)</th>
                      <th className="px-4 py-3 font-bold text-right">BOCW</th>
                      <th className="px-4 py-3 font-bold text-right">TDS</th>
                      <th className="px-4 py-3 font-bold">Status</th>
                      <th className="px-4 py-3 font-bold">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-custom/30">
                    {reports.length === 0 && reportsLoading ? (
                      <tr><td colSpan={10} className="p-8 text-center text-muted text-sm">Loading statutory reports...</td></tr>
                    ) : reports.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="p-8">
                          <EmptyState
                            title="No statutory compliance reports found"
                            description="Create statutory filing summaries for PF, ESI, BOCW Cess and contractor TDS."
                            action={{
                              label: "+ New Compliance Record",
                              onClick: () => setShowModal(true),
                            }}
                          />
                        </td>
                      </tr>
                    ) : (
                      reports.map((r) => (
                        <tr key={r.id} className="hover:bg-elevated/20 transition-colors">
                          <td className="px-4 py-3 font-bold text-foreground">
                            {typeLabels[r.report_type] || r.report_type.toUpperCase()}
                          </td>
                          <td className="px-4 py-3 text-muted">{r.return_period}</td>
                          <td className="px-4 py-3 text-foreground">{r.total_employees}</td>
                          <td className="px-4 py-3 text-right font-medium text-foreground">
                            ₹{Number(r.total_wages).toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                          </td>
                          <td className="px-4 py-3 text-right text-muted">
                            ₹{Number(r.pf_employee_contribution).toLocaleString("en-IN", { maximumFractionDigits: 2 })} / ₹{Number(r.pf_employer_contribution).toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                          </td>
                          <td className="px-4 py-3 text-right text-muted">
                            ₹{Number(r.esi_employee_contribution).toLocaleString("en-IN", { maximumFractionDigits: 2 })} / ₹{Number(r.esi_employer_contribution).toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-foreground">
                            ₹{Number(r.bocw_cess).toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                          </td>
                          <td className="px-4 py-3 text-right font-medium text-foreground">
                            ₹{Number(r.tds_deducted).toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5">
                              <Badge tone={statusTones[r.status] || "neutral"}>{formatLabel(r.status)}</Badge>
                              {r.days_overdue > 0 && (
                                <span className="text-[10px] text-danger font-semibold">{r.days_overdue}d overdue</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            {r.status === "draft" && (
                              <button
                                onClick={() => handleFile(r.id)}
                                className="px-2.5 py-1 bg-primary/10 text-primary border border-primary/20 rounded text-[11px] font-semibold hover:bg-primary/20 cursor-pointer"
                              >
                                Mark Filed
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

            {showPenalty && penaltyData && (
              <div className="bg-card border border-border-custom rounded-lg p-5 space-y-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-warning">Penalty Estimate</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                  <div>
                    <span className="text-muted">Report Type:</span>{" "}
                    <span className="text-foreground font-semibold">{penaltyData.report_type.toUpperCase()}</span>
                  </div>
                  <div>
                    <span className="text-muted">Period:</span>{" "}
                    <span className="text-foreground font-semibold">{penaltyData.return_period}</span>
                  </div>
                  <div>
                    <span className="text-muted">Total Wages:</span>{" "}
                    <span className="text-foreground font-semibold">₹{Number(penaltyData.total_wages).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                  </div>
                  <div>
                    <span className="text-muted">Due Date:</span>{" "}
                    <span className="text-foreground font-semibold">
                      {formatDate(penaltyData.due_date)}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted">Estimated Penalty:</span>{" "}
                    <span className="text-danger font-bold">₹{Number(penaltyData.estimated_penalty).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                  </div>
                </div>
                <button
                  onClick={() => setShowPenalty(false)}
                  className="px-3 py-1.5 bg-elevated border border-border-custom text-foreground rounded text-xs font-semibold hover:bg-card cursor-pointer"
                >
                  Close
                </button>
              </div>
            )}

            {/* New Compliance Record Modal */}
            {showModal && (
              <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                <div className="bg-card border border-border-custom rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto space-y-4">
                  <div className="flex items-center justify-between border-b border-border-custom pb-3">
                    <h2 className="text-sm font-bold text-foreground">New Statutory Compliance Record</h2>
                    <button
                      onClick={() => {
                        setShowModal(false);
                        setMessage(null);
                      }}
                      className="text-muted hover:text-foreground cursor-pointer"
                    >
                      <Icon name="close" className="w-4 h-4" />
                    </button>
                  </div>

                  <form onSubmit={handleSubmit} className="space-y-4 text-xs">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] uppercase font-bold text-muted mb-1">Report Type</label>
                        <select
                          className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-foreground text-xs"
                          value={form.report_type}
                          onChange={(e) => setForm({ ...form, report_type: e.target.value })}
                        >
                          <option value="pf">Provident Fund (PF)</option>
                          <option value="esi">Employee State Insurance (ESI)</option>
                          <option value="bocw">BOCW Cess</option>
                          <option value="tds">TDS</option>
                          <option value="pt">Professional Tax (PT)</option>
                          <option value="it">Income Tax (IT)</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase font-bold text-muted mb-1">
                          Return Period (YYYY-MM) *
                        </label>
                        <input
                          type="text"
                          required
                          placeholder="2026-06"
                          className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-foreground text-xs"
                          value={form.return_period}
                          onChange={(e) => setForm({ ...form, return_period: e.target.value })}
                        />
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleAutoPopulate}
                        className="px-3 py-1.5 bg-elevated border border-border-custom text-foreground rounded-md text-xs font-semibold hover:bg-card cursor-pointer"
                      >
                        Auto-fill from Employee Payroll
                      </button>
                      <button
                        type="button"
                        onClick={handleEstimatePenalty}
                        className="px-3 py-1.5 bg-warning/10 text-warning border border-warning/20 rounded-md text-xs font-semibold hover:bg-warning/20 cursor-pointer"
                      >
                        Estimate Penalty
                      </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] uppercase font-bold text-muted mb-1">Total Employees</label>
                        <input
                          type="number"
                          required
                          className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-foreground text-xs"
                          value={form.total_employees}
                          onChange={(e) => setForm({ ...form, total_employees: parseInt(e.target.value) || 0 })}
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase font-bold text-muted mb-1">Total Wages (₹)</label>
                        <input
                          type="number"
                          required
                          className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-foreground text-xs"
                          value={form.total_wages}
                          onChange={(e) => setForm({ ...form, total_wages: parseFloat(e.target.value) || 0 })}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] uppercase font-bold text-muted mb-1">PF Employee Share (₹)</label>
                        <input
                          type="number"
                          required
                          className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-foreground text-xs"
                          value={form.pf_employee_contribution}
                          onChange={(e) =>
                            setForm({ ...form, pf_employee_contribution: parseFloat(e.target.value) || 0 })
                          }
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase font-bold text-muted mb-1">PF Employer Share (₹)</label>
                        <input
                          type="number"
                          required
                          className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-foreground text-xs"
                          value={form.pf_employer_contribution}
                          onChange={(e) =>
                            setForm({ ...form, pf_employer_contribution: parseFloat(e.target.value) || 0 })
                          }
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] uppercase font-bold text-muted mb-1">ESI Employee Share (₹)</label>
                        <input
                          type="number"
                          required
                          className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-foreground text-xs"
                          value={form.esi_employee_contribution}
                          onChange={(e) =>
                            setForm({ ...form, esi_employee_contribution: parseFloat(e.target.value) || 0 })
                          }
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase font-bold text-muted mb-1">ESI Employer Share (₹)</label>
                        <input
                          type="number"
                          required
                          className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-foreground text-xs"
                          value={form.esi_employer_contribution}
                          onChange={(e) =>
                            setForm({ ...form, esi_employer_contribution: parseFloat(e.target.value) || 0 })
                          }
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] uppercase font-bold text-muted mb-1">BOCW Cess (₹)</label>
                        <input
                          type="number"
                          required
                          className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-foreground text-xs"
                          value={form.bocw_cess}
                          onChange={(e) => setForm({ ...form, bocw_cess: parseFloat(e.target.value) || 0 })}
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase font-bold text-muted mb-1">TDS Deducted (₹)</label>
                        <input
                          type="number"
                          required
                          className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-foreground text-xs"
                          value={form.tds_deducted}
                          onChange={(e) => setForm({ ...form, tds_deducted: parseFloat(e.target.value) || 0 })}
                        />
                      </div>
                    </div>

                    <div className="flex gap-2 justify-end pt-3 border-t border-border-custom">
                      <button
                        type="button"
                        onClick={() => {
                          setShowModal(false);
                          setMessage(null);
                        }}
                        className="px-4 py-2 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="px-5 py-2 bg-primary hover:bg-primary/90 text-white rounded-md text-xs font-bold cursor-pointer"
                      >
                        Create Record
                      </button>
                    </div>
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

