"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { getApiHost } from "@/lib/api";
import { authHeaders } from "@/lib/siteflow";
import Icon, { type IconName } from "@/components/marketing/Icon";
// R2-755: shared CSV guard. Quote-doubling protects the delimiter, not the
// formula — a leading = + - @ executes when the export opens in Excel/Sheets.
import { buildCsv } from "@/lib/csv";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";

interface ReportItem {
  name: string;
  hasView: boolean;
  hasDownload: boolean;
  viewSlug?: string;
}

interface ReportCategory {
  title: string;
  icon: IconName;
  reports: ReportItem[];
}

// All 82 active report slugs implemented in backend/app/routers/reports.py.
const IMPLEMENTED_REPORT_SLUGS = new Set([
  "all-expense-deduction-retention",
  "all-party-balances",
  "asset-allocation",
  "asset-status",
  "attendance-salary",
  "bank-statement",
  "boq-bom",
  "boq-item",
  "boq-measurement-book",
  "boq-workorder-summary",
  "budget-vs-actual-cost-code",
  "budget-vs-actual-material-cost",
  "budget-vs-actual-material-qty",
  "company-attendance",
  "company-expense",
  "company-payments",
  "company-sales",
  "company-transactions",
  "company-user-activity-leaderboard",
  "cost-code-expense-analysis",
  "cost-code-library",
  "crm-lead-detail",
  "daily-based-equipment-used",
  "dpr",
  "equipment-expense-summary",
  "equipment-library",
  "equipment-trip",
  "equipment-usage-detail",
  "fuel-efficiency",
  "gstr1-sales",
  "gstr2-purchase",
  "item-wise-sales",
  "lead-status-funnel",
  "material-library",
  "material-purchase-item",
  "material-received-used",
  "material-received-without-po",
  "material-request-item",
  "material-stock",
  "material-stock-movement",
  "monthly-pl",
  "ot-shift",
  "party-ledger",
  "party-library",
  "payment-request",
  "payroll-library",
  "po-summary",
  "production-material",
  "project-activity-leaderboard",
  "project-financial-summary",
  "project-level-party-balance",
  "project-operational-summary",
  "project-payment",
  "project-wise-expense-summary",
  "project-wise-payment-summary",
  "project-wise-sales-summary",
  "purchase-order-item",
  "quotation",
  "quotation-item",
  "rate-card-library",
  "sales-deduction-retention",
  "site-inspection",
  "staff-monthly-salary-slip",
  "staff-muster-roll",
  "staff-punch-report",
  "staff-salary",
  "subcon-deduction-retention",
  "subcon-material-issue",
  "subcon-measurement-book",
  "subcon-workorder-summary",
  "task-attendance",
  "task-boq-billed-unbilled",
  "task-material",
  "task-measurement-book",
  "task-report",
  "task-resource-budget-vs-actual",
  "task-revenue-expense",
  "todo-report",
  "unbilled-item",
  "warehouse-current-stock",
  "warehouse-stock-movement",
  "warehouse-transaction",
]);

function isReportImplemented(report: ReportItem): boolean {
  if (report.viewSlug) {
    return IMPLEMENTED_REPORT_SLUGS.has(report.viewSlug);
  }
  const slug = report.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return IMPLEMENTED_REPORT_SLUGS.has(slug);
}

const ALL_TIME = "All time";
const MONTH_INDEX: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

// "Oct 2026" -> "2026-10"; All time -> null (no filter).
function toIsoMonth(label: string): string | null {
  const [mon, year] = label.split(" ");
  return MONTH_INDEX[mon] && year ? `${year}-${MONTH_INDEX[mon]}` : null;
}

export default function ReportsDashboard() {
  const params = useParams();
  const router = useRouter();
  const companyId = params?.company_id as string;

  useEffect(() => {
    if (!companyId) {
      router.replace("/login");
    }
  }, [companyId, router]);

  const [searchQuery, setSearchQuery] = useState("");
  const [toastMessage, setToastMessage] = useState("");
  const [selectedReport, setSelectedReport] = useState<ReportItem | null>(null);
  const [showModal, setShowModal] = useState(false);

  // Month picker: derive a rolling 24-month window from the current date so
  // the list is never stale.  Default to the last closed month (one month back)
  // matching the statutory page convention.
  const _buildMonths = (): string[] => {
    const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const now = new Date();
    const result: string[] = [];
    // 12 months back through 11 months ahead (24 total)
    for (let delta = -12; delta <= 11; delta++) {
      const d = new Date(now.getFullYear(), now.getMonth() + delta, 1);
      result.push(`${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`);
    }
    return [ALL_TIME, ...result];
  };
  const months = _buildMonths();
  // All time by default: most reports are lists people want whole, and the
  // arrows narrow it to one month when they need that.
  const [selectedMonth, setSelectedMonth] = useState(ALL_TIME);
  const [partyNameFilter, setPartyNameFilter] = useState("");
  const [isExporting, setIsExporting] = useState(false);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(""), 3000);
  };

  const shiftMonth = (dir: "prev" | "next") => {
    const idx = months.indexOf(selectedMonth);
    if (dir === "prev" && idx > 0) {
      setSelectedMonth(months[idx - 1]);
    } else if (dir === "next" && idx < months.length - 1) {
      setSelectedMonth(months[idx + 1]);
    }
  };

  // Report structure based on Onsite Teams
  const categories: ReportCategory[] = [
    {
      title: "Sales",
      icon: "trending_up",
      reports: [
        { name: "Company Sales Report", hasView: true, hasDownload: true, viewSlug: "company-sales" },
        { name: "Item Wise Sales Report", hasView: true, hasDownload: false, viewSlug: "item-wise-sales" },
        { name: "Sales Deduction / Retention Report", hasView: true, hasDownload: false, viewSlug: "sales-deduction-retention" },
        { name: "CRM Lead Detail Report", hasView: true, hasDownload: false, viewSlug: "crm-lead-detail" },
        { name: "Lead Status Funnel Report", hasView: true, hasDownload: false, viewSlug: "lead-status-funnel" },
        { name: "Project Wise Sales Summary", hasView: true, hasDownload: false, viewSlug: "project-wise-sales-summary" }
      ]
    },
    {
      title: "Payments",
      icon: "credit_card",
      reports: [
        { name: "Company Payments", hasView: true, hasDownload: true, viewSlug: "company-payments" },
        { name: "Bank Statement", hasView: true, hasDownload: false, viewSlug: "bank-statement" },
        { name: "Project Wise Payment Summary", hasView: true, hasDownload: false, viewSlug: "project-wise-payment-summary" },
        { name: "Project Payment Report", hasView: true, hasDownload: false, viewSlug: "project-payment" },
        { name: "Payment Request Report", hasView: true, hasDownload: false, viewSlug: "payment-request" }
      ]
    },
    {
      title: "Progress & task",
      icon: "clipboard",
      reports: [
        { name: "Daily Progress Report", hasView: true, hasDownload: false, viewSlug: "dpr" },
        { name: "Task Report", hasView: true, hasDownload: false, viewSlug: "task-report" },
        { name: "Task Measurement Book", hasView: true, hasDownload: false, viewSlug: "task-measurement-book" },
        { name: "Task Material Report", hasView: true, hasDownload: false, viewSlug: "task-material" },
        { name: "To Do Report", hasView: true, hasDownload: false, viewSlug: "todo-report" },
        { name: "Task Resource Budget Vs Actual Report", hasView: true, hasDownload: false, viewSlug: "task-resource-budget-vs-actual" },
        { name: "Site Inspection Report", hasView: true, hasDownload: false, viewSlug: "site-inspection" },
        { name: "Task Revenue & Expense Report", hasView: true, hasDownload: false, viewSlug: "task-revenue-expense" },
        { name: "Task BOQ Billed & Unbilled Qty Report", hasView: true, hasDownload: false, viewSlug: "task-boq-billed-unbilled" },
        { name: "Task Attendance Report", hasView: true, hasDownload: false, viewSlug: "task-attendance" }
      ]
    },
    {
      title: "Purchase & Expense",
      icon: "money_wings",
      reports: [
        { name: "Company Expense Report", hasView: true, hasDownload: true, viewSlug: "company-expense" },
        { name: "Cost Code Expense Analysis", hasView: true, hasDownload: false, viewSlug: "cost-code-expense-analysis" },
        { name: "Project Wise Expense Summary", hasView: true, hasDownload: false, viewSlug: "project-wise-expense-summary" },
        { name: "All Expense Deduction / Retention Report", hasView: true, hasDownload: false, viewSlug: "all-expense-deduction-retention" }
      ]
    },
    {
      title: "Party Balances",
      icon: "group",
      reports: [
        { name: "Party Ledger", hasView: true, hasDownload: false, viewSlug: "party-ledger" },
        { name: "All Party Balances", hasView: true, hasDownload: false, viewSlug: "all-party-balances" },
        { name: "Project level Party Balance Report", hasView: true, hasDownload: false, viewSlug: "project-level-party-balance" }
      ]
    },
    {
      title: "Materials & Inventory",
      icon: "package",
      reports: [
        { name: "Material Request Item Report", hasView: true, hasDownload: false, viewSlug: "material-request-item" },
        { name: "Material Received & Used Report", hasView: true, hasDownload: false, viewSlug: "material-received-used" },
        { name: "Material Stock Report", hasView: true, hasDownload: false, viewSlug: "material-stock" },
        { name: "Unbilled Item Report", hasView: true, hasDownload: false, viewSlug: "unbilled-item" },
        { name: "PO Summary Report", hasView: true, hasDownload: false, viewSlug: "po-summary" },
        { name: "Material Received without PO", hasView: true, hasDownload: false, viewSlug: "material-received-without-po" },
        { name: "Purchase Order Item Report", hasView: true, hasDownload: false, viewSlug: "purchase-order-item" },
        { name: "Production Material Report", hasView: true, hasDownload: false, viewSlug: "production-material" },
        { name: "Material Purchase Item Report", hasView: true, hasDownload: false, viewSlug: "material-purchase-item" },
        { name: "Material Stock Movement Report", hasView: true, hasDownload: false, viewSlug: "material-stock-movement" }
      ]
    },
    {
      title: "Attendance & Salary",
      icon: "computer",
      reports: [
        { name: "Attendance & Salary Report", hasView: true, hasDownload: false, viewSlug: "attendance-salary" },
        { name: "OT & Shift Report", hasView: true, hasDownload: false, viewSlug: "ot-shift" },
        { name: "Company Attendance", hasView: false, hasDownload: true, viewSlug: "company-attendance" },
        { name: "Staff Monthly Salary Slip", hasView: false, hasDownload: true, viewSlug: "staff-monthly-salary-slip" },
        { name: "Staff Salary Report", hasView: true, hasDownload: false, viewSlug: "staff-salary" },
        { name: "Staff Punch Report", hasView: false, hasDownload: true, viewSlug: "staff-punch-report" },
        { name: "Staff Muster Roll", hasView: false, hasDownload: true, viewSlug: "staff-muster-roll" }
      ]
    },
    {
      title: "Equipments",
      icon: "tractor",
      reports: [
        { name: "Equipment Usage Detail Report", hasView: true, hasDownload: false, viewSlug: "equipment-usage-detail" },
        { name: "Fuel Efficiency Report", hasView: true, hasDownload: false, viewSlug: "fuel-efficiency" },
        { name: "Daily based Equipment Used Report", hasView: true, hasDownload: false, viewSlug: "daily-based-equipment-used" },
        { name: "Equipment Expense Summary", hasView: true, hasDownload: false, viewSlug: "equipment-expense-summary" },
        { name: "Equipment Trip Report", hasView: true, hasDownload: false, viewSlug: "equipment-trip" }
      ]
    },
    {
      title: "Tax",
      icon: "receipt",
      reports: [
        { name: "Sales (GSTR-1)", hasView: true, hasDownload: true, viewSlug: "gstr1-sales" },
        { name: "Purchase (GSTR-2)", hasView: true, hasDownload: false, viewSlug: "gstr2-purchase" }
      ]
    },
    {
      title: "Warehouse",
      icon: "store",
      reports: [
        { name: "Warehouse Stock Movement Report", hasView: true, hasDownload: false, viewSlug: "warehouse-stock-movement" },
        { name: "Warehouse Transaction Report", hasView: true, hasDownload: false, viewSlug: "warehouse-transaction" },
        { name: "Warehouse Current Stock Report", hasView: true, hasDownload: false, viewSlug: "warehouse-current-stock" }
      ]
    },
    {
      title: "Sub Con.",
      icon: "construction",
      reports: [
        { name: "Subcon Workorder Summary Report", hasView: true, hasDownload: false, viewSlug: "subcon-workorder-summary" },
        { name: "Subcon Measurement Book", hasView: true, hasDownload: false, viewSlug: "subcon-measurement-book" },
        { name: "Subcon Deduction / Retention Report", hasView: true, hasDownload: false, viewSlug: "subcon-deduction-retention" },
        { name: "Subcon Material Issue Summary", hasView: true, hasDownload: false, viewSlug: "subcon-material-issue" }
      ]
    },
    {
      title: "Misc.",
      icon: "sparkles",
      reports: [
        { name: "Project Financial Summary", hasView: true, hasDownload: true, viewSlug: "project-financial-summary" },
        { name: "Project Operational Summary", hasView: true, hasDownload: false, viewSlug: "project-operational-summary" },
        { name: "Company Transactions Report", hasView: true, hasDownload: false, viewSlug: "company-transactions" },
        { name: "Monthly P&L Report", hasView: true, hasDownload: false, viewSlug: "monthly-pl" },
        { name: "Project Activity Leaderboard", hasView: true, hasDownload: false, viewSlug: "project-activity-leaderboard" },
        { name: "Company User Activity Leaderboard", hasView: true, hasDownload: false, viewSlug: "company-user-activity-leaderboard" }
      ]
    },
    {
      title: "Library",
      icon: "library",
      reports: [
        { name: "Party Library", hasView: true, hasDownload: false, viewSlug: "party-library" },
        { name: "Cost Code Library", hasView: true, hasDownload: false, viewSlug: "cost-code-library" },
        { name: "Material Library", hasView: true, hasDownload: false, viewSlug: "material-library" },
        { name: "Rate Card Library", hasView: true, hasDownload: false, viewSlug: "rate-card-library" },
        { name: "Payroll Library", hasView: true, hasDownload: false, viewSlug: "payroll-library" },
        { name: "Equipment Library", hasView: true, hasDownload: false, viewSlug: "equipment-library" }
      ]
    },
    {
      title: "BOQ",
      icon: "ruler",
      reports: [
        { name: "BOQ Workorder Summary Report", hasView: true, hasDownload: false, viewSlug: "boq-workorder-summary" },
        { name: "BOQ Item Report", hasView: true, hasDownload: false, viewSlug: "boq-item" },
        { name: "Quotation Report", hasView: true, hasDownload: false, viewSlug: "quotation" },
        { name: "Quotation Item Report", hasView: true, hasDownload: false, viewSlug: "quotation-item" },
        { name: "BOQ Measurement Book", hasView: true, hasDownload: false, viewSlug: "boq-measurement-book" }
      ]
    },
    {
      title: "Budget",
      icon: "bar_chart",
      reports: [
        { name: "BOQ BOM Report", hasView: true, hasDownload: false, viewSlug: "boq-bom" },
        { name: "Budget vs Actual (Material Cost)", hasView: true, hasDownload: false, viewSlug: "budget-vs-actual-material-cost" },
        { name: "Budget vs Actual (Material Qty)", hasView: true, hasDownload: false, viewSlug: "budget-vs-actual-material-qty" },
        { name: "Budget vs Actual (Cost Code)", hasView: true, hasDownload: false, viewSlug: "budget-vs-actual-cost-code" }
      ]
    },
    {
      title: "Asset",
      icon: "home",
      reports: [
        { name: "Asset Allocation Report", hasView: true, hasDownload: false, viewSlug: "asset-allocation" },
        { name: "Asset Status Report", hasView: true, hasDownload: false, viewSlug: "asset-status" }
      ]
    }
  ];

  const handleReportClick = (report: ReportItem) => {
    setSelectedReport(report);
    setShowModal(true);
  };

  const triggerDownload = async () => {
    if (!selectedReport) return;
    const slug = selectedReport.viewSlug;
    if (!slug) return;
    setIsExporting(true);

    try {
      const params = new URLSearchParams({ company_id: companyId });
      const isoMonth = toIsoMonth(selectedMonth);
      if (isoMonth) params.set("month", isoMonth);
      if (partyNameFilter.trim()) params.set("name", partyNameFilter.trim());
      const res = await fetch(`${getApiHost()}/apis/v3/reports/data/${slug}?${params}`, {
        headers: { ...(authHeaders() || {}) }
      });
      if (!res.ok) {
        // R2-075: an unimplemented report returns a 404 naming it. Surface
        // that instead of exporting a header-only CSV as a success.
        const err = await res.json().catch(() => null);
        showToast(typeof err?.detail === "string" && err.detail ? err.detail : "Export failed. Please try again.");
        return;
      }
      const data = await res.json();
      const rows: Record<string, any>[] = data.rows || [];
      const headers = rows[0] ? Object.keys(rows[0]) : [];

      // R2-755: this export quoted its cells but never neutralised a leading
      // = + - @, so a value typed by a user executed as a formula on open.
      const csvContent = buildCsv(
        headers,
        rows.map(r => headers.map(h => r[h] ?? "")),
      );

      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.setAttribute("href", url);
      const cleanFileName = selectedReport.name.toLowerCase().replace(/[^a-z0-9]/g, "_") + ".csv";
      link.setAttribute("download", cleanFileName);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      showToast(
        data.period_applied === false
          ? `Exported ${selectedReport.name}. This report has no date to filter by, so it covers all time.`
          : rows.length === 0
          ? `${selectedReport.name} has no rows for ${selectedMonth}. Exported an empty file.`
          : `Exported ${selectedReport.name} (${rows.length} rows).`
      );
    } catch {
      showToast("Export failed. Please try again.");
    } finally {
      setIsExporting(false);
      setShowModal(false);
    }
  };


  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-elevated/20">
      <PageHeader
        title="Reports & Analytics"
        subtitle="Pick a report and a month, then download it as a CSV file that opens in Excel."
      >
        <div className="relative w-72 shrink-0">
          <input
            type="text"
            placeholder="Search report names..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full bg-sidebar border border-border-custom rounded-lg pl-9 pr-4 py-1.5 text-xs text-foreground placeholder:text-muted focus:outline-none focus:border-primary transition-all"
          />
          <Icon name="search" className="absolute left-3 top-2 w-3.5 h-3.5 text-muted" />
        </div>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">

          {/* Reports Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {categories.map((category) => {
              const filteredReports = category.reports.filter(r =>
                r.name.toLowerCase().includes(searchQuery.toLowerCase())
              );

              if (filteredReports.length === 0) return null;

              return (
                <div key={category.title} className="bg-card border border-border-custom rounded-xl p-5 flex flex-col justify-between transition-all hover:border-border-custom/80">
                  <div>
                    <div className="flex items-center gap-2 mb-4">
                      <Icon name={category.icon} className="w-4 h-4 text-muted" />
                      <h3 className="text-sm font-bold text-foreground">{category.title}</h3>
                    </div>
                    <div className="space-y-3">
                      {filteredReports.map((report) => {
                        const isImplemented = isReportImplemented(report);
                        return (
                          <div key={report.name} className="flex items-center justify-between group">
                            <span className={`text-xs ${isImplemented ? "text-muted group-hover:text-foreground" : "text-muted/50"} transition-colors`}>
                              {report.name}
                            </span>
                            
                            <div className="flex items-center gap-2">
                              {!isImplemented ? (
                                <span className="text-[10px] bg-border-custom/50 text-muted px-2 py-0.5 rounded font-medium">Coming soon</span>
                              ) : (
                                <>
                                  {/* Download icon — only if hasDownload */}
                                  {report.hasDownload && (
                                    <button
                                      onClick={() => { setSelectedReport(report); setShowModal(true); }}
                                      className="inline-flex items-center text-muted hover:text-accent transition-colors"
                                      title="Download Report"
                                    >
                                      <Icon name="arrow_down" className="w-4 h-4" />
                                    </button>
                                  )}
                                  {/* Eye/View icon — only if hasView */}
                                  {report.hasView && report.viewSlug && (
                                    <Link
                                      href={`/c/${companyId}/reports/${report.viewSlug}`}
                                      className="inline-flex items-center text-muted hover:text-primary transition-colors"
                                      title="View Report"
                                    >
                                      <Icon name="eye" className="w-4 h-4" />
                                    </Link>
                                  )}
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </PageShell>
      </div>

        {/* Dynamic Download Modal */}
        {showModal && selectedReport && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setShowModal(false)}>
            <div className="bg-card border border-border-custom rounded-xl w-full max-w-md p-6 relative overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
              
              <button onClick={() => setShowModal(false)} className="absolute top-4 right-4 text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>

              <div className="flex flex-col items-center text-center mt-2">
                <span className="text-muted text-[10px] font-bold uppercase tracking-wider mb-1">Company Level Report</span>
                <h3 className="text-sm font-bold text-foreground mb-4">{selectedReport.name}</h3>
              </div>

              <div className="space-y-4 my-5">
                
                {/* PDF Special Input Fields */}
                {selectedReport.name === "Staff Monthly Salary Slip" || selectedReport.name === "Staff Salary Report" ? (
                  <div>
                    <label className="text-[10px] text-muted uppercase font-bold block mb-1">Party Name</label>
                    <div className="relative">
                      <input
                        type="text"
                        placeholder="Search employee by name..."
                        value={partyNameFilter}
                        onChange={e => setPartyNameFilter(e.target.value)}
                        className="w-full bg-background border border-border-custom rounded-lg pl-9 pr-3 py-2 text-xs text-white focus:outline-none focus:border-primary"
                      />
                      <Icon name="search" className="absolute left-3 top-2.5 w-4 h-4 text-muted" />
                    </div>
                  </div>
                ) : null}

                {/* Date Slider Selector */}
                <div>
                  <label className="text-[10px] text-muted uppercase font-bold block mb-1">Report Period</label>
                  <div className="flex items-center justify-between bg-background border border-border-custom rounded-lg p-1">
                    <button
                      onClick={() => shiftMonth("prev")}
                      className="px-3 py-1.5 text-xs text-muted hover:text-foreground hover:bg-elevated rounded-md transition-all cursor-pointer"
                    >
                      <Icon name="chevron_left" className="w-3.5 h-3.5" />
                    </button>
                    <span className="text-xs font-semibold text-white">{selectedMonth}</span>
                    <button
                      onClick={() => shiftMonth("next")}
                      className="px-3 py-1.5 text-xs text-muted hover:text-foreground hover:bg-elevated rounded-md transition-all cursor-pointer"
                    >
                      <Icon name="chevron_right" className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="mt-6 flex flex-col gap-2">
                <button
                  onClick={triggerDownload}
                  disabled={isExporting}
                  className={`w-full py-2.5 rounded-lg text-white text-xs font-bold transition-all flex items-center justify-center gap-2 ${
                    isExporting
                      ? "bg-muted cursor-not-allowed"
                      : selectedReport.name === "Staff Monthly Salary Slip" || selectedReport.name === "Staff Salary Report"
                      ? "bg-primary hover:bg-primary/90"
                      : "bg-accent hover:bg-accent-hover"
                  }`}
                >
                  {isExporting ? (
                    <>
                      <Icon name="schedule" className="w-4 h-4 animate-spin" /> Exporting file...
                    </>
                  ) : selectedReport.name === "Staff Monthly Salary Slip" || selectedReport.name === "Staff Salary Report" ? (
                    <><Icon name="arrow_down" className="w-4 h-4" /> Download CSV</>
                  ) : (
                    <><Icon name="arrow_down" className="w-4 h-4" /> Download CSV (opens in Excel)</>
                  )}
                </button>
                <button onClick={() => setShowModal(false)} className="w-full py-2 text-xs text-muted hover:text-foreground transition-all">Cancel</button>
              </div>
            </div>
          </div>
        )}

        {/* Global Toast */}
        {toastMessage && (
          <div className="fixed bottom-6 right-6 bg-card border border-success/30 rounded-lg px-4 py-3 text-xs text-success shadow-lg flex items-center gap-2 z-50 transition-all">
            <Icon name="bolt" className="w-4 h-4" />
            <span className="font-semibold">{toastMessage}</span>
          </div>
        )}
    </div>
  );
}
