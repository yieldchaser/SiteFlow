"use client";
import Badge, { type BadgeTone } from "@/components/ui/Badge";

import React, { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { getApiHost, readErrorDetail } from "@/lib/api";
import { authHeaders, fmtINR, formatDate, formatLabel, todayLocalISO } from "@/lib/siteflow";
import Icon from "@/components/marketing/Icon";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { GST_STATES } from "@/lib/gstStates";

/** Indian compact money: 2.45 Cr, 18.6 L, 42.5K. Sign is preserved. */
const compactINR = (val: number): string => {
  const a = Math.abs(val || 0);
  const sign = val < 0 ? "-" : "";
  if (a >= 1e7) return `${sign}${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${sign}${(a / 1e5).toFixed(2)} L`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)}K`;
  return `${sign}${Math.round(a)}`;
};

/**
 * Monthly bar chart for the financial tab. Bars share the 160-unit plot width,
 * so any number of months fits, and the zero line sits where the data needs it.
 */
function MonthlyBars({
  series,
  months,
  color,
  label,
}: {
  series: number[];
  months: string[];
  color: (val: number) => string;
  label: (val: number) => string;
}) {
  const posMax = Math.max(0, ...series);
  const negMax = Math.max(0, ...series.map((v) => -v));
  const span = posMax + negMax || 1;
  const top = 14;
  const plot = 76;
  const base = top + (plot * posMax) / span;
  const slot = 160 / series.length;
  const width = Math.min(30, slot * 0.6);
  const crowded = series.length > 4;
  const labelEvery = Math.ceil(series.length / 5);
  const monthLabel = (m: string) => (crowded ? m.replace(/ 20(\d\d)$/, " '$1") : m);
  return (
    <div className="h-40 flex items-center justify-center bg-transparent relative">
      <svg className="w-full h-full" viewBox="0 0 200 120">
        <line x1="20" y1={base} x2="180" y2={base} stroke="var(--border)" strokeWidth="1" />
        {posMax > 0 && <line x1="20" y1={top} x2="180" y2={top} stroke="var(--border)" strokeWidth="1" strokeDasharray="3" />}
        {negMax > 0 && <line x1="20" y1={top + plot} x2="180" y2={top + plot} stroke="var(--border)" strokeWidth="1" strokeDasharray="3" />}
        <text x="17" y={base + 3} fill="var(--muted)" fontSize="7" textAnchor="end">0</text>
        {posMax > 0 && base - top > 10 && <text x="17" y={top + 3} fill="var(--muted)" fontSize="7" textAnchor="end">{compactINR(posMax)}</text>}
        {negMax > 0 && top + plot - base > 10 && <text x="17" y={top + plot + 3} fill="var(--muted)" fontSize="7" textAnchor="end">{compactINR(-negMax)}</text>}
        {series.map((val, idx) => {
          const height = (Math.abs(val) / span) * plot;
          const x = 20 + idx * slot + (slot - width) / 2;
          const cx = x + width / 2;
          const y = val < 0 ? base : base - height;
          const showMonth = idx % labelEvery === 0 || idx === series.length - 1;
          return (
            <g key={idx}>
              <title>{`${months[idx] || ""}: ${label(val)}`}</title>
              <rect x={x} y={y} width={width} height={height || 1.5} fill={color(val)} rx="1.5" className="transition-all hover:opacity-90" />
              {(!crowded || idx === series.length - 1) && (
                <text x={cx} y={val < 0 ? y + height + 8 : y - 3} fill={color(val)} fontSize="7" fontWeight="bold" textAnchor="middle">
                  {label(val)}
                </text>
              )}
              {showMonth && (
                <text x={cx} y="108" fill="var(--muted)" fontSize="7" textAnchor="middle">
                  {monthLabel(months[idx] || "")}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function DashboardPage() {
  const params = useParams();
  const companyId = params?.company_id as string;

  const [activeProject, setActiveProject] = useState("d0000000-0000-0000-0000-000000000001");
  const [tallySyncStatus, setTallySyncStatus] = useState("Not synced yet");
  const [isSyncing, setIsSyncing] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  const [overviewTab, setOverviewTab] = useState<"operational" | "financial">("operational");
  const [operationalData, setOperationalData] = useState<any>(null);
  const [financialData, setFinancialData] = useState<any>({
    advance_paid: 0.0,
    to_pay: 0.0,
    to_receive: 0.0,
    advance_received: 0.0,
    chart_months: [(() => { const d = new Date(); return ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()] + " " + d.getFullYear(); })()],
    sales_series: [0.0],
    expense_series: [0.0],
    margin_series: [0.0],
    expense_by_type: [],
    party_balances: [],
    project_summaries: []
  });
  const [workforceEmployees, setWorkforceEmployees] = useState<any[]>([]);
  const [workforceLibraries, setWorkforceLibraries] = useState<any[]>([]);
  const [materialLibraries, setMaterialLibraries] = useState<any[]>([]);
  const [isLightTheme, setIsLightTheme] = useState(false);

  useEffect(() => {
    setIsLightTheme(document.documentElement.classList.contains("light-theme"));
  }, []);

  const toggleTheme = () => {
    const nextVal = !isLightTheme;
    setIsLightTheme(nextVal);
    if (nextVal) {
      document.documentElement.classList.add("light-theme");
    } else {
      document.documentElement.classList.remove("light-theme");
    }
  };

  useEffect(() => {
    if (companyId) {
      const apiHost = getApiHost();
      const toList = (value: any) => Array.isArray(value)
        ? value
        : Array.isArray(value?.data)
          ? value.data
          : Array.isArray(value?.items)
            ? value.items
            : Array.isArray(value?.results)
              ? value.results
              : Array.isArray(value?.rows)
                ? value.rows
                : [];
      fetch(`${apiHost}/apis/v3/analytics/company/${companyId}/operational`, { headers: authHeaders() })
        .then((res) => res.json())
        .then((data) => setOperationalData(data))
        .catch((err) => console.error("Failed to fetch operational stats", err));

      fetch(`${apiHost}/apis/v3/analytics/company/${companyId}/financial`, { headers: authHeaders() })
        .then((res) => res.json())
        .then((data) => setFinancialData(data))
        .catch((err) => console.error("Failed to fetch financial stats", err));

      if (activeProject && !activeProject.startsWith("d0000000-")) {
        fetch(`${apiHost}/apis/v3/hr/employees/${activeProject}`, { headers: authHeaders() })
          .then((res) => res.json())
          .then((data) => setWorkforceEmployees(toList(data)))
          .catch((err) => console.error("Failed to fetch workforce employees", err));
      } else {
        fetch(`${apiHost}/apis/v3/hr/company/employees/${companyId}`, { headers: authHeaders() })
          .then((res) => res.json())
          .then((data) => setWorkforceEmployees(toList(data)))
          .catch((err) => console.error("Failed to fetch workforce employees", err));
      }

      fetch(`${apiHost}/apis/v3/library/workforces/${companyId}`, { headers: authHeaders() })
        .then((res) => res.json())
        .then((data) => setWorkforceLibraries(toList(data)))
        .catch((err) => console.error("Failed to fetch workforce library", err));

      fetch(`${apiHost}/apis/v3/library/materials/${companyId}`, { headers: authHeaders() })
        .then((res) => res.json())
        .then((data) => setMaterialLibraries(toList(data)))
        .catch((err) => console.error("Failed to fetch material library", err));

      fetch(`${apiHost}/apis/v3/planning/projects?company_id=${companyId}`, { headers: authHeaders() })
        .then((res) => res.json())
        .then((data) => {
          const list = Array.isArray(data) ? data : [];
          if (list.length > 0) {
            const merged = list.map((dbProj: any) => {
              let uiHealth = dbProj.health;
              if (uiHealth === "Good" || uiHealth === "healthy") uiHealth = "Healthy";
              if (uiHealth === "warning") uiHealth = "Warning";
              if (uiHealth === "critical") uiHealth = "Critical";

              return {
                id: dbProj.id,
                name: dbProj.name,
                code: dbProj.code,
                city: dbProj.city,
                address: dbProj.address,
                attendance_radius_meters: dbProj.attendance_radius_meters,
                status: dbProj.status || "—",
                health: uiHealth || "—",
                startDate: dbProj.start_date || "",
                endDate: dbProj.end_date || "",
                category: dbProj.category || "—",
                keyPersonnel: dbProj.key_personnel_id ? "Staff Member" : "Unassigned",
                progress: dbProj.progress ?? 0.0,
                customerName: dbProj.customer_name || "—",
                projectStage: dbProj.stage || "—"
              };
            });
            setProjects(merged);
          }
        })
        .catch((err) => console.error("Failed to fetch projects list", err));
    }
  }, [companyId, activeProject]);

  // Project setup wizard state
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [wizardData, setWizardData] = useState({
    name: "",
    code: "",
    address: "",
    city: "",
    // Required by the create route. A project without it can never be invoiced.
    state: "",
    attendance_radius_meters: 500,
    teamMember: ""
  });

  // Operational dashboard filters
  const [selProject, setSelProject] = useState("All");
  const [selStatus, setSelStatus] = useState("All");
  const [selHealth, setSelHealth] = useState("All");

  const [projects, setProjects] = useState<any[]>([]);

  // Steel calculator states
  const [diameter, setDiameter] = useState(12);
  const [barCount, setBarCount] = useState(10);
  const [barLength, setBarLength] = useState(3);
  const [wastagePercent, setWastagePercent] = useState(5);

  // ── Chart type switcher ────────────────────────────────────────────────────
  const [openPicker, setOpenPicker] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [ctHealth, setCtHealth] = useState("bar");
  const [ctAttendance, setCtAttendance] = useState("bar");
  const [ctMaterial, setCtMaterial] = useState("bar");

  // Close picker when clicking outside
  useEffect(() => {
    if (!openPicker) return;
    const close = () => setOpenPicker(null);
    // Use mousedown (not click) so it's consistent with picker button onMouseDown handlers
    const t = setTimeout(() => document.addEventListener("mousedown", close), 0);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", close); };
  }, [openPicker]);

  // Mini SVG icons for each chart type in the picker grid
  const chartTypeIcon = (id: string, active: boolean) => {
    const c = active ? "var(--primary)" : "var(--muted)";
    switch (id) {
      case "pie": return <svg viewBox="0 0 18 18" width="16" height="16"><path d="M9,9L9,2A7,7,0,0,1,16,9Z" fill={c}/><path d="M9,9L16,9A7,7,0,0,1,4.5,14.6Z" fill={c} opacity="0.6"/><path d="M9,9L4.5,14.6A7,7,0,1,1,9,2Z" fill={c} opacity="0.3"/></svg>;
      case "donut": return <svg viewBox="0 0 18 18" width="16" height="16"><path d="M9,2A7,7,0,0,1,16,9" stroke={c} fill="none" strokeWidth="3.5"/><path d="M16,9A7,7,0,0,1,4.5,14.6" stroke={c} fill="none" strokeWidth="3.5" opacity="0.6"/><path d="M4.5,14.6A7,7,0,1,1,9,2" stroke={c} fill="none" strokeWidth="3.5" opacity="0.3"/></svg>;
      case "funnel": case "funnel2": case "funnel_ring": return <svg viewBox="0 0 18 18" width="16" height="16"><polygon points="2,2 16,2 11,10 11,16 7,16 7,10" fill={c} opacity="0.7"/></svg>;
      case "bar": case "bar_col": case "grouped_col": return <svg viewBox="0 0 18 18" width="16" height="16"><rect x="1" y="10" width="4" height="7" rx="0.5" fill={c}/><rect x="7" y="6" width="4" height="11" rx="0.5" fill={c} opacity="0.8"/><rect x="13" y="3" width="4" height="14" rx="0.5" fill={c} opacity="0.6"/></svg>;
      case "stacked": case "stacked_bar": return <svg viewBox="0 0 18 18" width="16" height="16"><rect x="1" y="12" width="4" height="5" rx="0.5" fill={c}/><rect x="1" y="8" width="4" height="4" rx="0.5" fill={c} opacity="0.5"/><rect x="7" y="9" width="4" height="8" rx="0.5" fill={c} opacity="0.9"/><rect x="7" y="5" width="4" height="4" rx="0.5" fill={c} opacity="0.45"/><rect x="13" y="6" width="4" height="11" rx="0.5" fill={c} opacity="0.8"/><rect x="13" y="2" width="4" height="4" rx="0.5" fill={c} opacity="0.4"/></svg>;
      case "grouped": return <svg viewBox="0 0 18 18" width="16" height="16"><rect x="1" y="9" width="2.5" height="8" rx="0.5" fill={c}/><rect x="4" y="5" width="2.5" height="12" rx="0.5" fill={c} opacity="0.5"/><rect x="8" y="6" width="2.5" height="11" rx="0.5" fill={c}/><rect x="11" y="3" width="2.5" height="14" rx="0.5" fill={c} opacity="0.5"/></svg>;
      case "scatter": case "scatter2": case "scatter3": case "scatter_ring": case "scatter_group": return <svg viewBox="0 0 18 18" width="16" height="16"><circle cx="3" cy="14" r="2" fill={c}/><circle cx="7" cy="9" r="2" fill={c} opacity="0.7"/><circle cx="12" cy="12" r="2" fill={c} opacity="0.9"/><circle cx="15" cy="5" r="2" fill={c} opacity="0.5"/><circle cx="5" cy="5" r="2" fill={c} opacity="0.8"/></svg>;
      case "line": case "cross": return <svg viewBox="0 0 18 18" width="16" height="16"><polyline points="1,14 5,8 9,11 13,4 17,7" stroke={c} fill="none" strokeWidth="2"/><line x1="1" y1="17" x2="17" y2="17" stroke={c} strokeWidth="1" opacity="0.3"/></svg>;
      case "smooth": return <svg viewBox="0 0 18 18" width="16" height="16"><path d="M1,14 C4,14 4,6 8,9 C12,12 12,3 17,6" stroke={c} fill="none" strokeWidth="2"/><line x1="1" y1="17" x2="17" y2="17" stroke={c} strokeWidth="1" opacity="0.3"/></svg>;
      case "line_pt": return <svg viewBox="0 0 18 18" width="16" height="16"><polyline points="1,14 5,8 9,11 13,4 17,7" stroke={c} fill="none" strokeWidth="1.5"/><circle cx="1" cy="14" r="1.5" fill={c}/><circle cx="5" cy="8" r="1.5" fill={c}/><circle cx="9" cy="11" r="1.5" fill={c}/><circle cx="13" cy="4" r="1.5" fill={c}/><circle cx="17" cy="7" r="1.5" fill={c}/></svg>;
      case "smooth_pt": return <svg viewBox="0 0 18 18" width="16" height="16"><path d="M1,14 C4,14 4,6 8,9 C12,12 12,3 17,6" stroke={c} fill="none" strokeWidth="1.5"/><circle cx="1" cy="14" r="1.5" fill={c}/><circle cx="8" cy="9" r="1.5" fill={c}/><circle cx="17" cy="6" r="1.5" fill={c}/></svg>;
      case "area": case "area_pt": return <svg viewBox="0 0 18 18" width="16" height="16"><polygon points="1,17 1,14 5,8 9,11 13,4 17,7 17,17" fill={c} opacity="0.25"/><polyline points="1,14 5,8 9,11 13,4 17,7" stroke={c} fill="none" strokeWidth="1.5"/></svg>;
      case "smooth_area": case "smooth_area_pt": return <svg viewBox="0 0 18 18" width="16" height="16"><path d="M1,14 C4,14 4,6 8,9 C12,12 12,3 17,6" stroke={c} fill="none" strokeWidth="1.5"/><path d="M1,17 L1,14 C4,14 4,6 8,9 C12,12 12,3 17,6 L17,17 Z" fill={c} opacity="0.25"/></svg>;
      case "sunburst": case "rose": return <svg viewBox="0 0 18 18" width="16" height="16"><circle cx="9" cy="9" r="2.5" fill={c}/><path d="M9,2 L9,5.5 M14.2,4.8 L11.4,6.6 M14.2,13.2 L11.4,11.4 M9,16 L9,12.5 M3.8,13.2 L6.6,11.4 M3.8,4.8 L6.6,6.6" stroke={c} strokeWidth="1.5" strokeLinecap="round"/></svg>;
      case "filter": case "heatmap": case "grid": return <svg viewBox="0 0 18 18" width="16" height="16"><rect x="1" y="1" width="7" height="7" rx="1" fill={c} opacity="0.8"/><rect x="10" y="1" width="7" height="7" rx="1" fill={c} opacity="0.3"/><rect x="1" y="10" width="7" height="7" rx="1" fill={c} opacity="0.4"/><rect x="10" y="10" width="7" height="7" rx="1" fill={c} opacity="0.9"/></svg>;
      case "table": return <svg viewBox="0 0 18 18" width="16" height="16"><rect x="1" y="1" width="16" height="16" rx="1.5" stroke={c} fill="none" strokeWidth="1.2"/><line x1="1" y1="5.5" x2="17" y2="5.5" stroke={c} strokeWidth="1.2"/><line x1="1" y1="10" x2="17" y2="10" stroke={c} strokeWidth="1.2"/><line x1="1" y1="14.5" x2="17" y2="14.5" stroke={c} strokeWidth="1.2"/><line x1="6" y1="5.5" x2="6" y2="17" stroke={c} strokeWidth="1.2"/><line x1="12" y1="5.5" x2="12" y2="17" stroke={c} strokeWidth="1.2"/></svg>;
      default: return <svg viewBox="0 0 18 18" width="16" height="16"><rect x="2" y="2" width="14" height="14" rx="2" fill="none" stroke={c} strokeWidth="1.2" opacity="0.5"/></svg>;
    }
  };

  // Chart picker popup (5×5 grid matching reference app)
  const renderChartPicker = (pickerId: string, activeType: string, setType: (t: string) => void) => {
    if (openPicker !== pickerId) return null;
    const ALL = [
      "pie","donut","funnel","funnel2","bar",
      "stacked","grouped","scatter","line","smooth",
      "line_pt","smooth_pt","area","smooth_area","area_pt",
      "smooth_area_pt","filter","grouped_col","sunburst","rose",
      "scatter2","scatter3","cross","heatmap","table"
    ];
    return (
      // Positioned relative to the OUTER buttons row (not the tiny trigger div)
      // right-0 = flush with right edge of buttons row; top-full = just below it
      <div
        style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 9999, width: 264 }}
        className="bg-elevated border border-border-custom rounded-md p-3 shadow-2xl"
        onClick={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-1.5">
          {ALL.map(ct => (
            <button
              key={ct}
              onMouseDown={e => { e.stopPropagation(); e.preventDefault(); setType(ct); setOpenPicker(null); }}
              title={ct.replace(/_/g," ")}
              className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all hover:bg-elevated border ${
                activeType === ct ? "bg-primary/20 border-primary/40" : "border-transparent hover:border-border-custom"
              }`}
            >
              {chartTypeIcon(ct, activeType === ct)}
            </button>
          ))}
        </div>
      </div>
    );
  };

  // Reusable chart header with type switcher icon buttons
  // The picker is rendered INSIDE the outer buttons-row div (which has relative)
  // so the popup is anchored to that div, not the tiny individual button.
  const renderChartHeader = (title: string, pickerId: string, activeType: string, setType: (t: string) => void) => (
    <div className="w-full flex justify-between items-center border-b border-border-custom pb-3">
      <span className="text-xs font-semibold text-foreground uppercase tracking-wider">{title}</span>
      {/* relative here is the positioning context for the picker popup */}
      <div className="flex items-center gap-0.5 relative">
        {/* Chart type toggle button */}
        <button
          onMouseDown={e => { e.stopPropagation(); e.preventDefault(); setOpenPicker(openPicker === pickerId ? null : pickerId); }}
          className={`p-1.5 rounded transition-all ${
            openPicker === pickerId ? "bg-primary/20 text-primary" : "text-muted hover:text-foreground hover:bg-elevated"
          }`}
          title="Change chart type"
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="currentColor">
            <rect x="1" y="8" width="3" height="4" rx="0.5"/><rect x="5" y="5" width="3" height="7" rx="0.5"/><rect x="9" y="2" width="3" height="10" rx="0.5"/>
          </svg>
        </button>
        {/* Picker popup — anchored here, wide enough for 5 columns */}
        {renderChartPicker(pickerId, activeType, setType)}
      </div>
    </div>
  );

  const standardUnitWeight = (diameter * diameter) / 162.0; // kg/m — IS 800 standard: D²/162
  const totalBarLength = barCount * barLength; // meters
  const totalWeightNoWastage = totalBarLength * standardUnitWeight; // kg
  const reinforcementWeight = totalWeightNoWastage * (1 + wastagePercent / 100); // kg

  const activeProjDetails = projects.find(p => p.id === activeProject) || projects[0] || {};
  const normalizeText = (value: any) => (typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim());
  const activeProjectName = normalizeText(activeProjDetails.name) || "Active Project";
  const activeProjectStatus = normalizeText(activeProjDetails.status) || "—";
  const formatMoney = (value: number) => `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

  const handleSyncTally = async () => {
    setIsSyncing(true);
    try {
      const apiHost = getApiHost();
      const res = await fetch(`${apiHost}/apis/v3/tally/sync?company_id=${companyId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) }
      });
      if (res.ok) {
        setTallySyncStatus("Synced");
      } else {
        setTallySyncStatus("Sync Failed");
      }
    } catch (e) {
      setTallySyncStatus("Sync Error");
    } finally {
      setIsSyncing(false);
    }
  };

  // Helper calculations for Company Party Balance half-donut chart
  const polarToCartesian = (cx: number, cy: number, r: number, angleInDegrees: number) => {
    const angleInRadians = ((angleInDegrees - 180) * Math.PI) / 180;
    return {
      x: cx + r * Math.cos(angleInRadians),
      y: cy + r * Math.sin(angleInRadians),
    };
  };

  const getArcPath = (cx: number, cy: number, rx: number, ry: number, startAngle: number, endAngle: number, innerR: number) => {
    const startRad = ((startAngle - 180) * Math.PI) / 180;
    const endRad = ((endAngle - 180) * Math.PI) / 180;
    
    const x1 = cx + rx * Math.cos(startRad);
    const y1 = cy + rx * Math.sin(startRad);
    const x2 = cx + rx * Math.cos(endRad);
    const y2 = cy + rx * Math.sin(endRad);
    
    const x3 = cx + innerR * Math.cos(endRad);
    const y3 = cy + innerR * Math.sin(endRad);
    const x4 = cx + innerR * Math.cos(startRad);
    const y4 = cy + innerR * Math.sin(startRad);
    
    const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
    
    return `M ${x1} ${y1} A ${rx} ${rx} 0 ${largeArcFlag} 1 ${x2} ${y2} L ${x3} ${y3} A ${innerR} ${innerR} 0 ${largeArcFlag} 0 ${x4} ${y4} Z`;
  };

  // Balance calculations
  const advPaid = financialData?.advance_paid ?? 0;
  const toPay = financialData?.to_pay ?? 0;
  const toReceive = financialData?.to_receive ?? 0;
  const advReceived = financialData?.advance_received ?? 0.0;
  const totalBalance = advPaid + toPay + toReceive;

  const formatCompact = (val: number) => compactINR(val);

  const advPaidPct = totalBalance > 0 ? advPaid / totalBalance : 0.5;
  const toPayPct = totalBalance > 0 ? toPay / totalBalance : 0.5;
  const toReceivePct = totalBalance > 0 ? toReceive / totalBalance : 0.0;

  const advPaidAngle = advPaidPct * 180;
  const toPayAngle = toPayPct * 180;
  const toReceiveAngle = toReceivePct * 180;

  // Middle angles for text/callout placement
  const midAngle1 = advPaidAngle / 2;
  const midAngle2 = advPaidAngle + toPayAngle / 2;
  const midAngle3 = advPaidAngle + toPayAngle + toReceiveAngle / 2;

  const pos1 = polarToCartesian(160, 150, 92, midAngle1);
  const pos2 = polarToCartesian(160, 150, 92, midAngle2);

  const line1Start = polarToCartesian(160, 150, 110, midAngle1);
  const line1End = polarToCartesian(160, 150, 130, midAngle1 - 10);

  const line2Start = polarToCartesian(160, 150, 110, midAngle2);
  const line2End = polarToCartesian(160, 150, 130, midAngle2 + 10);

  const line3Start = polarToCartesian(160, 150, 110, midAngle3 - 1);
  const line3End = polarToCartesian(160, 150, 138, midAngle3 + 3);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">

      {/* Main Workspace Frame */}
      <main className="flex-1 flex flex-col overflow-hidden h-full">
        <PageHeader
          title="Company Dashboard"
          subtitle="Real-time KPI overview, financial ledger metrics and physical progress"
        >
          <div className="flex items-center gap-3">
            {/* Tally Connection status dot */}
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-elevated border border-border-custom text-xs text-muted">
              <span className={`h-2 w-2 rounded-full ${tallySyncStatus === "Synced" ? "bg-success" : "bg-muted"}`} />
              <span>Tally: {tallySyncStatus}</span>
            </div>

            <button
              onClick={handleSyncTally}
              disabled={isSyncing}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-secondary/15 hover:bg-secondary/25 border border-secondary/20 px-3.5 py-1.5 text-xs font-semibold text-secondary transition-all cursor-pointer"
            >
              {isSyncing ? (
                <>
                  <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Syncing Ledgers...
                </>
              ) : (
                "Trigger Sync"
              )}
            </button>
          </div>
        </PageHeader>

        {/* Tab Selector Row (Under Header) */}
        <div className="flex border-b border-border-custom px-6 bg-card shrink-0">
          <button
            onClick={() => setOverviewTab("operational")}
            className={`px-4 py-3 text-xs font-bold transition-all border-b-2 -mb-px ${
              overviewTab === "operational"
                ? "border-primary text-primary font-bold"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            Operational
          </button>
          <button
            onClick={() => setOverviewTab("financial")}
            className={`px-4 py-3 text-xs font-bold transition-all border-b-2 -mb-px ${
              overviewTab === "financial"
                ? "border-primary text-primary font-bold"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            Financial
          </button>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto">
          <PageShell width="wide">
          {activeTab === "overview" && (
            <>
              {overviewTab === "operational" && (() => {
                // The planning list carries no dates, progress, customer or key
                // personnel; the operational analytics row for the project does.
                const opById = new Map<string, any>((operationalData?.projects || []).map((o: any) => [o.project_id, o]));
                const projRows = projects.map(p => {
                  const o = opById.get(p.id);
                  if (!o) return p;
                  const val = (v: any) => (v && v !== "—" ? v : "");
                  return {
                    ...p,
                    startDate: val(o.start_date) || p.startDate,
                    endDate: val(o.end_date) || p.endDate,
                    progress: Number(o.progress) || 0,
                    customerName: val(o.customer_name) || p.customerName,
                    keyPersonnel: val(o.key_personnel) || p.keyPersonnel,
                  };
                });
                const filteredProjList = projRows.filter(p => {
                  const matchProj = selProject === "All" || p.id === selProject;
                  const matchStatus = selStatus === "All" || p.status === selStatus || (selStatus === "On Hold" && p.status === "Onhold") || (selStatus === "Planning" && p.status === "Not Started");
                  const matchHealth = selHealth === "All" || p.health === selHealth;
                  return matchProj && matchStatus && matchHealth;
                });

                const notStartedCount = filteredProjList.filter(p => p.status === "Planning" || p.status === "Not Started").length;
                const ongoingCount = filteredProjList.filter(p => p.status === "Ongoing").length;
                const onHoldCount = filteredProjList.filter(p => p.status === "On Hold" || p.status === "Onhold").length;
                const completedCount = filteredProjList.filter(p => p.status === "Completed").length;
                const cancelledCount = filteredProjList.filter(p => p.status === "Cancelled").length;

                const healthyCount = filteredProjList.filter(p => p.health === "Healthy").length;
                const warningCount = filteredProjList.filter(p => p.health === "Warning").length;
                const criticalCount = filteredProjList.filter(p => p.health === "Critical").length;
                const totalHealthCount = healthyCount + warningCount + criticalCount || 1;

                const healthyPct = healthyCount / totalHealthCount;
                const warningPct = warningCount / totalHealthCount;
                const criticalPct = criticalCount / totalHealthCount;

                const healthyAngle = healthyPct * 180;
                const warningAngle = warningPct * 180;
                const criticalAngle = criticalPct * 180;

                const pathHealthy = getArcPath(160, 150, 110, 110, 0, healthyAngle, 70);
                const pathWarning = getArcPath(160, 150, 110, 110, healthyAngle, healthyAngle + warningAngle, 70);
                const pathCritical = getArcPath(160, 150, 110, 110, healthyAngle + warningAngle, 180, 70);

                const midAngleH = healthyAngle / 2;
                const midAngleW = healthyAngle + (warningAngle / 2);
                const midAngleC = healthyAngle + warningAngle + (criticalAngle / 2);

                const calloutH1 = polarToCartesian(160, 150, 90, midAngleH);
                const calloutH2 = polarToCartesian(160, 150, 130, midAngleH - 10);

                const calloutW1 = polarToCartesian(160, 150, 90, midAngleW);
                const calloutW2 = polarToCartesian(160, 150, 130, midAngleW);

                const calloutC1 = polarToCartesian(160, 150, 90, midAngleC);
                const calloutC2 = polarToCartesian(160, 150, 130, midAngleC + 10);

                return (
                  <div className="space-y-6 font-sans">
                    {/* Filters Bar */}
                    <div className="bg-card border border-border-custom rounded-lg p-4 flex flex-wrap gap-4 items-center justify-between transition-all">
                      <div className="flex flex-wrap gap-4 items-center">
                        <div className="space-y-1">
                          <label className="text-[9px] text-muted uppercase tracking-wider font-bold block">Project Name</label>
                          <select 
                            value={selProject}
                            onChange={(e) => setSelProject(e.target.value)}
                            className="bg-input border border-border-custom rounded-lg px-3 py-1.5 text-xs text-foreground focus:outline-none min-w-[150px] transition-all"
                          >
                            <option value="All">All</option>
                            {projects.map((p) => (
                              <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                          </select>
                        </div>

                        <div className="space-y-1">
                          <label className="text-[9px] text-muted uppercase tracking-wider font-bold block">Project Status</label>
                          <select 
                            value={selStatus}
                            onChange={(e) => setSelStatus(e.target.value)}
                            className="bg-input border border-border-custom rounded-lg px-3 py-1.5 text-xs text-foreground focus:outline-none min-w-[150px] transition-all"
                          >
                            <option value="All">All</option>
                            <option value="Planning">Not Started</option>
                            <option value="Ongoing">Ongoing</option>
                            <option value="On Hold">On Hold</option>
                            <option value="Completed">Completed</option>
                            <option value="Cancelled">Cancelled</option>
                          </select>
                        </div>

                        <div className="space-y-1">
                          <label className="text-[9px] text-muted uppercase tracking-wider font-bold block">Project Health</label>
                          <select 
                            value={selHealth}
                            onChange={(e) => setSelHealth(e.target.value)}
                            className="bg-input border border-border-custom rounded-lg px-3 py-1.5 text-xs text-foreground focus:outline-none min-w-[150px] transition-all"
                          >
                            <option value="All">All</option>
                            <option value="Healthy">Healthy</option>
                            <option value="Warning">Warning</option>
                            <option value="Critical">Critical</option>
                          </select>
                        </div>
                      </div>
                    </div>

                    {/* Summary Counters Grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-6">
                      <div className="rounded-md border border-border-custom bg-card p-5 flex flex-col justify-center items-center text-center transition-all">
                        <span className="text-[11px] font-bold text-danger [.light-theme_&]:text-danger uppercase tracking-wider block mb-1">Not Started Projects</span>
                        <span className="text-2xl font-bold text-foreground">{notStartedCount}</span>
                      </div>
                      <div className="rounded-md border border-border-custom bg-card p-5 flex flex-col justify-center items-center text-center transition-all">
                        <span className="text-[11px] font-bold text-success [.light-theme_&]:text-success uppercase tracking-wider block mb-1">Ongoing Projects</span>
                        <span className="text-2xl font-bold text-foreground">{ongoingCount}</span>
                      </div>
                      <div className="rounded-md border border-border-custom bg-card p-5 flex flex-col justify-center items-center text-center transition-all">
                        <span className="text-[11px] font-bold text-warning [.light-theme_&]:text-warning uppercase tracking-wider block mb-1">On Hold Projects</span>
                        <span className="text-2xl font-bold text-foreground">{onHoldCount}</span>
                      </div>
                      <div className="rounded-md border border-border-custom bg-card p-5 flex flex-col justify-center items-center text-center transition-all">
                        <span className="text-[11px] font-bold text-muted uppercase tracking-wider block mb-1">Completed Projects</span>
                        <span className="text-2xl font-bold text-foreground">{completedCount}</span>
                      </div>
                      <div className="rounded-md border border-border-custom bg-card p-5 flex flex-col justify-center items-center text-center transition-all">
                        <span className="text-[11px] font-bold text-danger uppercase tracking-wider block mb-1">Cancelled Projects</span>
                        <span className="text-2xl font-bold text-foreground">{cancelledCount}</span>
                      </div>
                    </div>

                    {/* Project Health Card */}
                    <div className="bg-card border border-border-custom rounded-lg p-6 transition-all">
                      <h4 className="text-xs font-bold text-muted uppercase tracking-wider mb-6">Project Health</h4>
                      <div className="flex flex-col md:flex-row items-center justify-around gap-8">
                        {/* Half donut chart */}
                        <div className="relative w-80 h-40 flex items-center justify-center overflow-visible">
                          <svg className="w-full h-full overflow-visible" viewBox="0 0 320 180">
                            {/* Inner background arc */}
                            <path
                              d="M 50 150 A 110 110 0 0 1 270 150 L 230 150 A 70 70 0 0 0 90 150 Z"
                              fill="var(--border)"
                            />
                            {/* Slice 1: Healthy */}
                            {healthyCount > 0 && (
                              <path d={pathHealthy} fill="var(--success)" className="transition-all hover:opacity-90 cursor-pointer" />
                            )}
                            {/* Slice 2: Warning */}
                            {warningCount > 0 && (
                              <path d={pathWarning} fill="var(--warning)" className="transition-all hover:opacity-90 cursor-pointer" />
                            )}
                            {/* Slice 3: Critical */}
                            {criticalCount > 0 && (
                              <path d={pathCritical} fill="var(--danger)" className="transition-all hover:opacity-90 cursor-pointer" />
                            )}

                            {/* Callout lines & percentage labels */}
                            {healthyCount > 0 && (
                              <>
                                <path
                                  d={`M ${calloutH1.x} ${calloutH1.y} L ${calloutH2.x} ${calloutH2.y} h -20`}
                                  fill="none"
                                  stroke="var(--success)"
                                  strokeWidth="1"
                                />
                                <rect
                                  x={calloutH2.x - 55}
                                  y={calloutH2.y - 10}
                                  width="32"
                                  height="16"
                                  rx="2"
                                  fill="var(--success)"
                                />
                                <text
                                  x={calloutH2.x - 39}
                                  y={calloutH2.y + 1}
                                  fill="white"
                                  fontSize="9"
                                  fontWeight="bold"
                                  textAnchor="middle"
                                >
                                  {Math.round(healthyPct * 100)}%
                                </text>
                              </>
                            )}

                            {warningCount > 0 && (
                              <>
                                <path
                                  d={`M ${calloutW1.x} ${calloutW1.y} L ${calloutW2.x} ${calloutW2.y} h 20`}
                                  fill="none"
                                  stroke="var(--warning)"
                                  strokeWidth="1"
                                />
                                <rect
                                  x={calloutW2.x + 23}
                                  y={calloutW2.y - 10}
                                  width="32"
                                  height="16"
                                  rx="2"
                                  fill="var(--warning)"
                                />
                                <text
                                  x={calloutW2.x + 39}
                                  y={calloutW2.y + 1}
                                  fill="white"
                                  fontSize="9"
                                  fontWeight="bold"
                                  textAnchor="middle"
                                >
                                  {Math.round(warningPct * 100)}%
                                </text>
                              </>
                            )}

                            {criticalCount > 0 && (
                              <>
                                <path
                                  d={`M ${calloutC1.x} ${calloutC1.y} L ${calloutC2.x} ${calloutC2.y} h 20`}
                                  fill="none"
                                  stroke="var(--danger)"
                                  strokeWidth="1"
                                />
                                <rect
                                  x={calloutC2.x + 23}
                                  y={calloutC2.y - 10}
                                  width="32"
                                  height="16"
                                  rx="2"
                                  fill="var(--danger)"
                                />
                                <text
                                  x={calloutC2.x + 39}
                                  y={calloutC2.y + 1}
                                  fill="white"
                                  fontSize="9"
                                  fontWeight="bold"
                                  textAnchor="middle"
                                >
                                  {Math.round(criticalPct * 100)}%
                                </text>
                              </>
                            )}

                            {/* Center Value */}
                            <text
                              x="160"
                              y="140"
                              fill="currentColor"
                              className="text-foreground font-extrabold"
                              fontSize="22"
                              textAnchor="middle"
                            >
                              {filteredProjList.length}
                            </text>
                            <text
                              x="160"
                              y="155"
                              fill="var(--muted)"
                              fontSize="8"
                              fontWeight="bold"
                              textAnchor="middle"
                              className="uppercase tracking-wider"
                            >
                              Projects
                            </text>
                          </svg>
                        </div>

                        {/* Legend Checklist Table */}
                        <div className="w-full max-w-sm rounded-lg border border-border-custom bg-elevated p-4 space-y-3">
                          <div className="flex items-center gap-2.5 pb-2 border-b border-border-custom text-xs font-bold text-foreground">
                            <input
                              type="checkbox"
                              checked={true}
                              readOnly
                              className="rounded border-border-custom text-primary focus:ring-primary h-3.5 w-3.5 cursor-pointer"
                            />
                            <span>Project Health</span>
                          </div>

                          <div className="space-y-2 text-xs">
                            <div className="flex items-center gap-2.5">
                              <input
                                type="checkbox"
                                checked={healthyCount > 0}
                                readOnly
                                className="rounded border-border-custom text-success focus:ring-success h-3.5 w-3.5 cursor-pointer"
                              />
                              <div className="h-2.5 w-2.5 rounded-full bg-success" />
                              <span className="text-muted font-medium">Healthy</span>
                              <strong className="text-foreground font-bold ml-auto">{healthyCount}</strong>
                            </div>

                            <div className="flex items-center gap-2.5">
                              <input
                                type="checkbox"
                                checked={warningCount > 0}
                                readOnly
                                className="rounded border-border-custom text-warning focus:ring-warning h-3.5 w-3.5 cursor-pointer"
                              />
                              <div className="h-2.5 w-2.5 rounded-full bg-warning" />
                              <span className="text-muted font-medium">Warning</span>
                              <strong className="text-foreground font-bold ml-auto">{warningCount}</strong>
                            </div>

                            <div className="flex items-center gap-2.5">
                              <input
                                type="checkbox"
                                checked={criticalCount > 0}
                                readOnly
                                className="rounded border-border-custom text-danger focus:ring-danger h-3.5 w-3.5 cursor-pointer"
                              />
                              <div className="h-2.5 w-2.5 rounded-full bg-danger" />
                              <span className="text-muted font-medium">Critical</span>
                              <strong className="text-foreground font-bold ml-auto">{criticalCount}</strong>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Attendance & Material Cards */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      <div className="bg-card border border-border-custom rounded-lg p-5 flex flex-col justify-between transition-all">
                        <div className="space-y-4">
                          <h4 className="text-xs font-bold text-muted uppercase tracking-wider">Last 7 Days Attendance</h4>
                          <div className="flex items-center gap-4 text-[10px] text-muted">
                            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-success" />Present</span>
                            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-danger" />Absent</span>
                          </div>
                          {(() => {
                            const series = operationalData?.attendance_series || [];
                            const hasData = series.length > 0 && series.some((day: any) => day.present > 0 || day.absent > 0);

                            if (!hasData) {
                              return (
                                <div className="h-40 flex items-center justify-center rounded-md bg-transparent">
                                  <span className="text-danger [.light-theme_&]:text-danger text-xs font-bold uppercase tracking-wider">No Data Available</span>
                                </div>
                              );
                            }

                            // Calculate maximum value for scaling
                            const maxVal = Math.max(...series.map((day: any) => Math.max(day.present, day.absent)), 5);
                            const chartWidth = 240;
                            const barWidth = 10;

                            return (
                              <div className="h-40 flex items-center justify-center bg-transparent relative overflow-visible">
                                <svg className="w-full h-full overflow-visible" viewBox="0 0 280 120">
                                  {/* Gridline / Baseline */}
                                  <line x1="20" y1="90" x2="260" y2="90" stroke="var(--border)" strokeWidth="1" />
                                  
                                  {series.map((day: any, idx: number) => {
                                    const x = 30 + idx * (chartWidth / series.length);
                                    
                                    const presentHeight = (day.present / maxVal) * 70;
                                    const absentHeight = (day.absent / maxVal) * 70;
                                    
                                    const presentY = 90 - presentHeight;
                                    const absentY = 90 - absentHeight;

                                    // Format short date (e.g. "09 Jul" or just day name "Mon")
                                    const dateObj = new Date(day.date);
                                    const formattedDate = isNaN(dateObj.getTime()) 
                                      ? day.date 
                                      : dateObj.toLocaleDateString("en-IN", { day: "numeric", month: "short" });

                                    return (
                                      <g key={idx}>
                                        {/* Present Bar */}
                                        <rect x={x} y={presentY} width={barWidth} height={presentHeight || 1} fill="var(--success)" rx="1" className="transition-all hover:opacity-90" />
                                        {day.present > 0 && (
                                          <text x={x + barWidth / 2} y={presentY - 3} fill="var(--success)" fontSize="7" fontWeight="bold" textAnchor="middle">
                                            {day.present}
                                          </text>
                                        )}

                                        {/* Absent Bar */}
                                        <rect x={x + barWidth + 2} y={absentY} width={barWidth} height={absentHeight || 1} fill="var(--danger)" rx="1" className="transition-all hover:opacity-90" />
                                        {day.absent > 0 && (
                                          <text x={x + barWidth + 2 + barWidth / 2} y={absentY - 3} fill="var(--danger)" fontSize="7" fontWeight="bold" textAnchor="middle">
                                            {day.absent}
                                          </text>
                                        )}

                                        {/* Date Label */}
                                        <text x={x + barWidth + 1} y="105" fill="var(--muted)" fontSize="7" textAnchor="middle" transform={`rotate(-15 ${x + barWidth + 1} 105)`}>
                                          {formattedDate}
                                        </text>
                                      </g>
                                    );
                                  })}
                                </svg>
                              </div>
                            );
                          })()}
                        </div>
                      </div>

                      <div className="bg-card border border-border-custom rounded-lg p-5 flex flex-col justify-between transition-all">
                        <div className="space-y-4">
                          <h4 className="text-xs font-bold text-muted uppercase tracking-wider">Last 7 Days Material Received</h4>
                          <p className="text-[10px] text-muted">Material lines received into stock per day, all sites.</p>
                          {(() => {
                            const series = operationalData?.material_series || [];
                            const hasData = series.length > 0 && series.some((day: any) => day.count > 0);

                            if (!hasData) {
                              return (
                                <div className="h-40 flex items-center justify-center rounded-md bg-transparent">
                                  <span className="text-danger [.light-theme_&]:text-danger text-xs font-bold uppercase tracking-wider">No Data Available</span>
                                </div>
                              );
                            }

                            const maxVal = Math.max(...series.map((day: any) => day.count), 5);
                            const chartWidth = 240;
                            const barWidth = 16;

                            return (
                              <div className="h-40 flex items-center justify-center bg-transparent relative overflow-visible">
                                <svg className="w-full h-full overflow-visible" viewBox="0 0 280 120">
                                  {/* Gridline / Baseline */}
                                  <line x1="20" y1="90" x2="260" y2="90" stroke="var(--border)" strokeWidth="1" />
                                  
                                  {series.map((day: any, idx: number) => {
                                    const x = 30 + idx * (chartWidth / series.length);
                                    const barHeight = (day.count / maxVal) * 70;
                                    const y = 90 - barHeight;

                                    const dateObj = new Date(day.date);
                                    const formattedDate = isNaN(dateObj.getTime()) 
                                      ? day.date 
                                      : dateObj.toLocaleDateString("en-IN", { day: "numeric", month: "short" });

                                    return (
                                      <g key={idx}>
                                        {/* Material Received Bar */}
                                        <rect x={x} y={y} width={barWidth} height={barHeight || 1} fill="var(--primary)" rx="1.5" className="transition-all hover:opacity-90" />
                                        {day.count > 0 && (
                                          <text x={x + barWidth / 2} y={y - 3} fill="var(--primary)" fontSize="7" fontWeight="bold" textAnchor="middle">
                                            {day.count}
                                          </text>
                                        )}

                                        {/* Date Label */}
                                        <text x={x + barWidth / 2} y="105" fill="var(--muted)" fontSize="7" textAnchor="middle" transform={`rotate(-15 ${x + barWidth / 2} 105)`}>
                                          {formattedDate}
                                        </text>
                                      </g>
                                    );
                                  })}
                                </svg>
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    </div>

                    {/* Table */}
                    <div className="bg-card border border-border-custom rounded-lg p-5 space-y-4 transition-all">
                      <div className="flex justify-between items-center">
                        <h4 className="text-xs font-bold text-muted uppercase tracking-wider">Project Operational Summary Dashboard</h4>
                      </div>
                      <div className="overflow-x-auto rounded-lg border border-border-custom">
                        <table className="w-full text-left text-xs border-collapse min-w-[1200px]">
                          <thead>
                            <tr className="bg-primary/90 text-white font-semibold text-[11px] tracking-wider uppercase border-b border-primary">
                              <th className="px-4 py-3 border-r border-primary-hover font-semibold text-center w-12">#</th>
                              <th className="px-4 py-3 border-r border-primary-hover font-semibold">Project Name</th>
                              <th className="px-4 py-3 border-r border-primary-hover font-semibold">Project Category</th>
                              <th className="px-4 py-3 border-r border-primary-hover font-semibold">Key Personnel</th>
                              <th className="px-4 py-3 border-r border-primary-hover font-semibold text-center w-28">Project Status</th>
                              <th className="px-4 py-3 border-r border-primary-hover font-semibold text-center w-28">Project Health</th>
                              <th className="px-4 py-3 border-r border-primary-hover font-semibold text-center w-28">Start Date</th>
                              <th className="px-4 py-3 border-r border-primary-hover font-semibold text-center w-28">End Date</th>
                              <th className="px-4 py-3 border-r border-border-custom font-semibold text-right w-24">Progress</th>
                              <th className="px-4 py-3 border-r border-primary-hover font-semibold">Customer Name</th>
                              <th className="px-4 py-3 font-semibold">Project Stage</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border-custom">
                            {filteredProjList.length === 0 ? (
                              <tr>
                                <td colSpan={11} className="p-8">
                                  <EmptyState
                                    title="No projects found"
                                    description="No matching projects in your company portfolio."
                                  />
                                </td>
                              </tr>
                            ) : (
                              filteredProjList.map((p, idx) => (
                                <tr key={p.id} className="hover:bg-elevated transition-colors">
                                  <td className="px-4 py-3 text-center border-r border-border-custom text-muted font-sans">{idx + 1}</td>
                                  <td className="px-4 py-3 border-r border-border-custom font-bold text-foreground">{p.name}</td>
                                  <td className="px-4 py-3 border-r border-border-custom text-muted font-semibold">{p.category || "-"}</td>
                                  <td className="px-4 py-3 border-r border-border-custom text-muted font-semibold">{p.keyPersonnel || "-"}</td>
                                  <td className="px-4 py-3 text-center border-r border-border-custom">
                                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                                      p.status === "Ongoing" ? "bg-success/15 text-success border-success/30" :
                                      p.status === "Onhold" || p.status === "On Hold" ? "bg-warning/10 text-warning border-warning/20" :
                                      p.status === "Completed" ? "bg-elevated text-muted border-border-custom" :
                                      "bg-danger/10 text-danger border-danger/20"
                                    }`}>
                                      {formatLabel(p.status)}
                                    </span>
                                  </td>
                                  <td className="px-4 py-3 text-center border-r border-border-custom">
                                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${
                                      p.health === "Healthy" ? "bg-success/15 text-success border-success/30" :
                                      p.health === "Warning" ? "bg-warning/10 text-warning border-warning/20" :
                                      "bg-danger/10 text-danger border-danger/20"
                                    }`}>
                                      {p.health}
                                    </span>
                                  </td>
                                  <td className="px-4 py-3 text-center border-r border-border-custom text-muted font-semibold font-sans">{p.startDate || "-"}</td>
                                  <td className="px-4 py-3 text-center border-r border-border-custom text-muted font-semibold font-sans">{p.endDate || "-"}</td>
                                  <td className="px-4 py-3 text-right border-r border-border-custom font-bold text-foreground font-sans">{p.progress.toFixed(2)}%</td>
                                  <td className="px-4 py-3 border-r border-border-custom text-muted font-medium">{p.customerName || "-"}</td>
                                  <td className="px-4 py-3 text-muted font-medium">{p.projectStage || "-"}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {overviewTab === "financial" && (
                <div className="space-y-6 font-sans">
                  {/* Filters Bar */}
                  <div className="bg-card border border-border-custom rounded-lg p-4 flex flex-wrap gap-4 items-center justify-between transition-all">
                    <div className="flex gap-4 items-center">
                      <div className="space-y-1">
                        <label className="text-[9px] text-muted uppercase tracking-wider font-bold block">Project Name</label>
                        <select className="bg-input border border-border-custom rounded-lg px-3 py-1.5 text-xs text-foreground focus:outline-none min-w-[150px] transition-all">
                          <option>All</option>
                          {financialData?.project_summaries?.map((p: any, idx: number) => (
                            <option key={idx}>{p.project_name}</option>
                          ))}
                        </select>
                      </div>

                    </div>
                  </div>

                  {/* Company Party Balance (All Projects) - Half-circle Donut & Metrics */}
                  <div className="bg-card border border-border-custom rounded-lg p-5 space-y-6 transition-all">
                    <div className="flex justify-between items-center border-b border-border-custom pb-3">
                      <h4 className="text-xs font-bold text-muted uppercase tracking-wider">Company Party Balance (All Projects)</h4>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
                      {/* Left: Half Donut SVG */}
                      <div className="md:col-span-7 flex justify-center items-center relative overflow-visible py-4">
                        <svg width="100%" height="150" viewBox="0 0 320 160" className="overflow-visible">
                          {/* Segments */}
                          <path
                            d={getArcPath(160, 150, 110, 110, 0, advPaidAngle, 75)}
                            fill="var(--primary)"
                            className="transition-all duration-300 hover:opacity-90"
                          />
                          <path
                            d={getArcPath(160, 150, 110, 110, advPaidAngle, advPaidAngle + toPayAngle, 75)}
                            fill="var(--success)"
                            className="transition-all duration-300 hover:opacity-90"
                          />
                          <path
                            d={getArcPath(160, 150, 110, 110, advPaidAngle + toPayAngle, 180, 75)}
                            fill="var(--danger)"
                            className="transition-all duration-300 hover:opacity-90"
                          />

                          {/* Inner Circle Base for clean looks */}
                          <path d="M 85 150 A 75 75 0 0 1 235 150 Z" fill="transparent" />

                          {/* Percentage labels inside segments */}
                          {advPaidPct > 0.05 && (
                            <text x={pos1.x} y={pos1.y + 3} fill="white" fontSize="9" fontWeight="bold" textAnchor="middle">
                              {Math.round(advPaidPct * 100)}%
                            </text>
                          )}
                          {toPayPct > 0.05 && (
                            <text x={pos2.x} y={pos2.y + 3} fill="white" fontSize="9" fontWeight="bold" textAnchor="middle">
                              {Math.round(toPayPct * 100)}%
                            </text>
                          )}

                          {/* Callout Lines and Labels */}
                          {/* Advance Paid Label (Left) */}
                          <line x1={line1Start.x} y1={line1Start.y} x2={line1End.x} y2={line1End.y} stroke="var(--primary)" strokeWidth="1" />
                          <circle cx={line1Start.x} cy={line1Start.y} r="2" fill="var(--primary)" />
                          <rect x={line1End.x - 55} y={line1End.y - 10} width="50" height="16" rx="3" fill="var(--primary)" />
                          <text x={line1End.x - 30} y={line1End.y + 2} fill="white" fontSize="8" fontWeight="bold" textAnchor="middle">
                            {formatCompact(advPaid)}
                          </text>

                          {/* To Pay Label (Right/Top) */}
                          <line x1={line2Start.x} y1={line2Start.y} x2={line2End.x} y2={line2End.y} stroke="var(--success)" strokeWidth="1" />
                          <circle cx={line2Start.x} cy={line2Start.y} r="2" fill="var(--success)" />
                          <rect x={line2End.x + 5} y={line2End.y - 10} width="50" height="16" rx="3" fill="var(--success)" />
                          <text x={line2End.x + 30} y={line2End.y + 2} fill="white" fontSize="8" fontWeight="bold" textAnchor="middle">
                            {formatCompact(toPay)}
                          </text>

                          {/* To Receive Label (Far Right/Bottom) */}
                          <line x1={line3Start.x} y1={line3Start.y} x2={line3End.x} y2={line3End.y} stroke="var(--danger)" strokeWidth="1" />
                          <circle cx={line3Start.x} cy={line3Start.y} r="2" fill="var(--danger)" />
                          <rect x={line3End.x + 5} y={line3End.y - 10} width="55" height="16" rx="3" fill="var(--danger)" />
                          <text x={line3End.x + 32.5} y={line3End.y + 2} fill="white" fontSize="8" fontWeight="bold" textAnchor="middle">
                            {formatCompact(toReceive)}
                          </text>
                        </svg>
                      </div>

                      {/* Right: Legend Checklist */}
                      <div className="md:col-span-5 space-y-3">
                        <div className="flex items-center gap-2 border-b border-border-custom pb-2">
                          <input type="checkbox" checked readOnly className="accent-primary rounded cursor-pointer" />
                          <span className="text-[11px] font-bold text-foreground">Balance Type</span>
                        </div>
                        <div className="space-y-2">
                          <div className="flex justify-between items-center text-xs">
                            <div className="flex items-center gap-2">
                              <span className="h-2.5 w-2.5 rounded-sm bg-primary" />
                              <span className="text-muted font-medium">Advance Paid</span>
                            </div>
                            <span className="font-semibold text-foreground">{formatCompact(advPaid)}</span>
                          </div>
                          <div className="flex justify-between items-center text-xs">
                            <div className="flex items-center gap-2">
                              <span className="h-2.5 w-2.5 rounded-sm bg-success" />
                              <span className="text-muted font-medium">To Pay</span>
                            </div>
                            <span className="font-semibold text-foreground">{formatCompact(toPay)}</span>
                          </div>
                          <div className="flex justify-between items-center text-xs">
                            <div className="flex items-center gap-2">
                              <span className="h-2.5 w-2.5 rounded-sm bg-danger" />
                              <span className="text-muted font-medium">To Receive</span>
                            </div>
                            <span className="font-semibold text-foreground">{formatCompact(toReceive)}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Bottom metrics grid */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-4 border-t border-border-custom">
                      {/* Advance Paid */}
                      <div className="bg-success/10 border border-success/10 [.light-theme_&]:bg-success/10 [.light-theme_&]:border-success rounded-lg p-3 flex flex-col items-center justify-center transition-all">
                        <span className="text-[10px] font-bold text-success [.light-theme_&]:text-success uppercase tracking-wider block text-center">Advance Paid</span>
                        <strong className="text-md font-bold text-success [.light-theme_&]:text-success mt-1 block text-center">
                          {advPaid > 0 ? fmtINR(advPaid, 2) : "-"}
                        </strong>
                      </div>

                      {/* To Pay */}
                      <div className="bg-danger/10 border border-danger/10 [.light-theme_&]:bg-danger/10 [.light-theme_&]:border-danger rounded-lg p-3 flex flex-col items-center justify-center transition-all">
                        <span className="text-[10px] font-bold text-danger [.light-theme_&]:text-danger uppercase tracking-wider block text-center">To Pay</span>
                        <strong className="text-md font-bold text-danger [.light-theme_&]:text-danger mt-1 block text-center">
                          {toPay > 0 ? fmtINR(toPay, 2) : "-"}
                        </strong>
                      </div>

                      {/* To Receive */}
                      <div className="bg-danger/10 border border-danger/10 [.light-theme_&]:bg-danger/10 [.light-theme_&]:border-danger rounded-lg p-3 flex flex-col items-center justify-center transition-all">
                        <span className="text-[10px] font-bold text-danger [.light-theme_&]:text-danger uppercase tracking-wider block text-center">To Receive</span>
                        <strong className="text-md font-bold text-danger [.light-theme_&]:text-danger mt-1 block text-center">
                          {toReceive > 0 ? fmtINR(toReceive, 2) : "-"}
                        </strong>
                      </div>

                      {/* Advance Received */}
                      <div className="bg-elevated border border-border-custom rounded-lg p-3 flex flex-col items-center justify-center transition-all">
                        <span className="text-[10px] font-bold text-muted uppercase tracking-wider block text-center">Advance Received</span>
                        <strong className="text-md font-bold text-foreground mt-1 block text-center">
                          {advReceived > 0 ? fmtINR(advReceived, 2) : "-"}
                        </strong>
                      </div>
                    </div>
                  </div>

                  {/* Project Financial Summary Table */}
                  <div className="bg-card border border-border-custom rounded-lg overflow-hidden transition-all">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs text-left border-collapse">
                        <thead>
                          <tr className="bg-primary/90 text-white font-bold uppercase tracking-wider text-[9px]">
                            <th className="px-3 py-3 text-center border-r border-white/10 w-10">#</th>
                            <th className="px-4 py-3 border-r border-white/10">Project Name</th>
                            <th className="px-4 py-3 border-r border-white/10">Project Status</th>
                            <th className="px-4 py-3 text-center border-r border-white/10">Project Health</th>
                            <th className="px-4 py-3 text-right border-r border-white/10">Project Budget</th>
                            <th className="px-4 py-3 text-right border-r border-white/10">Total Expense</th>
                            <th className="px-4 py-3 text-right border-r border-white/10">Budget Remaining</th>
                            <th className="px-4 py-3 text-right border-r border-white/10">Total Sales</th>
                            <th className="px-4 py-3 text-right border-r border-white/10">Project Margin</th>
                            <th className="px-4 py-3 text-right border-r border-white/10">Payment In</th>
                            <th className="px-4 py-3 text-right border-r border-white/10">Payment Out</th>
                            <th className="px-4 py-3 text-right">Cash Balance</th>
                          </tr>
                        </thead>
                        <tbody>
                          {financialData?.project_summaries?.length === 0 ? (
                            <tr>
                              <td colSpan={12} className="p-8">
                                <EmptyState
                                  title="No financial data found"
                                  description="Financial data will appear as project budgets and transactions are recorded."
                                />
                              </td>
                            </tr>
                          ) : (
                            financialData.project_summaries.map((p: any, idx: number) => (
                              <tr key={idx} className="border-t border-border-custom hover:bg-elevated transition-all text-foreground">
                                <td className="px-3 py-3 text-center border-r border-border-custom text-muted font-sans font-bold">{idx + 1}</td>
                                <td className="px-4 py-3 border-r border-border-custom font-bold text-foreground">{p.project_name}</td>
                                <td className="px-4 py-3 border-r border-border-custom text-muted">{formatLabel(p.project_status)}</td>
                                <td className="px-4 py-3 text-center border-r border-border-custom">
                                  {p.project_health === "-" ? (
                                    <span className="text-muted font-bold font-sans">-</span>
                                  ) : (
                                    <Badge tone={p.project_health === "Healthy" ? "success" : p.project_health === "Warning" || p.project_health === "Onhold" ? "warning" : p.project_health === "Completed" || p.project_health === "Cancelled" ? "neutral" : "danger"} className="font-bold">{p.project_health === "Onhold" ? "On Hold" : p.project_health}</Badge>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-right border-r border-border-custom font-semibold text-muted">
                                  {fmtINR(p.project_budget)}
                                </td>
                                <td className="px-4 py-3 text-right border-r border-border-custom font-semibold text-muted">
                                  {fmtINR(p.total_expense)}
                                </td>
                                <td className="px-4 py-3 text-right border-r border-border-custom font-semibold text-muted">
                                  {fmtINR(p.budget_remaining)}
                                </td>
                                <td className="px-4 py-3 text-right border-r border-border-custom font-semibold text-muted">
                                  {fmtINR(p.total_sales)}
                                </td>
                                <td className="px-4 py-3 text-right border-r border-border-custom font-semibold text-muted">
                                  {fmtINR(p.project_margin)}
                                </td>
                                <td className="px-4 py-3 text-right border-r border-border-custom font-semibold text-muted">
                                  {fmtINR(p.payment_in)}
                                </td>
                                <td className="px-4 py-3 text-right border-r border-border-custom font-semibold text-muted">
                                  {fmtINR(p.payment_out)}
                                </td>
                                <td className="px-4 py-3 text-right font-bold text-muted">
                                  {fmtINR(p.cash_balance)}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Charts Grid - First Row (Sales, Expense, Margin) */}
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Sales */}
                    <div className="bg-card border border-border-custom rounded-lg p-5 flex flex-col justify-between transition-all">
                      <div className="space-y-4">
                        <h4 className="text-xs font-bold text-muted uppercase tracking-wider">Sales</h4>
                        {(() => {
                          const series = financialData?.sales_series || [];
                          const months = financialData?.chart_months || [];
                          const hasData = series.length > 0 && series.some((v: number) => v !== 0);

                          if (!hasData) {
                            return (
                              <div className="h-40 flex items-center justify-center bg-transparent">
                                <span className="text-danger [.light-theme_&]:text-danger text-xs font-bold uppercase tracking-wider">No Data Available</span>
                              </div>
                            );
                          }

                          return <MonthlyBars series={series} months={months} color={() => "var(--success)"} label={(v) => (v === 0 ? "0" : compactINR(v))} />;
                        })()}
                      </div>
                      <div className="border-t border-border-custom pt-3 flex justify-between items-center text-xs mt-4">
                        <span className="text-muted font-medium">Total Sales</span>
                        {(() => {
                          const totalSales = financialData?.sales_series?.reduce((a: number, b: number) => a + b, 0) || 0;
                          return (
                            <span className={`font-bold px-2 py-0.5 rounded ${
                              totalSales >= 0 ? "text-success bg-success/10 [.light-theme_&]:bg-success/10 text-success" : "text-danger bg-danger/10 [.light-theme_&]:bg-danger/10 text-danger"
                            }`}>
                              {totalSales === 0 ? "-" : totalSales.toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 })}
                            </span>
                          );
                        })()}
                      </div>
                    </div>

                    {/* Expense */}
                    <div className="bg-card border border-border-custom rounded-lg p-5 flex flex-col justify-between transition-all">
                      <div className="space-y-4">
                        <h4 className="text-xs font-bold text-muted uppercase tracking-wider">Expense</h4>
                        {(() => {
                          const series = financialData?.expense_series || [];
                          const months = financialData?.chart_months || [];
                          const hasData = series.length > 0 && series.some((v: number) => v !== 0);

                          if (!hasData) {
                            return (
                              <div className="h-40 flex items-center justify-center bg-transparent">
                                <span className="text-danger [.light-theme_&]:text-danger text-xs font-bold uppercase tracking-wider">No Data Available</span>
                              </div>
                            );
                          }

                          return <MonthlyBars series={series.map((v: number) => -Math.abs(v))} months={months} color={() => "var(--danger)"} label={(v) => (v === 0 ? "0" : compactINR(v))} />;
                        })()}
                      </div>
                      <div className="border-t border-border-custom pt-3 flex justify-between items-center text-xs mt-4">
                        <span className="text-muted font-medium">Total Expense</span>
                        {(() => {
                          const totalExpense = financialData?.expense_series?.reduce((a: number, b: number) => a + b, 0) || 0;
                          return (
                            <span className="font-bold text-danger [.light-theme_&]:text-danger bg-danger/10 [.light-theme_&]:bg-danger/10 px-2 py-0.5 rounded">
                              {totalExpense === 0 ? "-" : `-${totalExpense.toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 })}`}
                            </span>
                          );
                        })()}
                      </div>
                    </div>

                    {/* Margin */}
                    <div className="bg-card border border-border-custom rounded-lg p-5 flex flex-col justify-between transition-all">
                      <div className="space-y-4">
                        <h4 className="text-xs font-bold text-muted uppercase tracking-wider">Margin</h4>
                        {(() => {
                          const series = financialData?.margin_series || [];
                          const months = financialData?.chart_months || [];
                          const hasData = series.length > 0 && series.some((v: number) => v !== 0);

                          if (!hasData) {
                            return (
                              <div className="h-40 flex items-center justify-center bg-transparent">
                                <span className="text-danger [.light-theme_&]:text-danger text-xs font-bold uppercase tracking-wider">No Data Available</span>
                              </div>
                            );
                          }

                          return <MonthlyBars series={series} months={months} color={(v) => (v < 0 ? "var(--danger)" : "var(--success)")} label={(v) => (v === 0 ? "0" : compactINR(v))} />;
                        })()}
                      </div>
                      <div className="border-t border-border-custom pt-3 flex justify-between items-center text-xs mt-4">
                        <span className="text-muted font-medium">Total Margin</span>
                        {(() => {
                          const totalMargin = financialData?.margin_series?.reduce((a: number, b: number) => a + b, 0) || 0;
                          return (
                            <span className={`font-bold px-2 py-0.5 rounded ${
                              totalMargin >= 0 ? "text-success bg-success/10 [.light-theme_&]:bg-success/10 text-success" : "text-danger bg-danger/10 [.light-theme_&]:bg-danger/10 text-danger"
                            }`}>
                              {totalMargin === 0 ? "-" : totalMargin.toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 })}
                            </span>
                          );
                        })()}
                      </div>
                    </div>
                  </div>

                  {/* Charts Grid - Second Row (Payments, Expense Type) */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Payments */}
                    <div className="bg-card border border-border-custom rounded-lg p-5 flex flex-col justify-between transition-all">
                      <div className="space-y-4">
                        <h4 className="text-xs font-bold text-muted uppercase tracking-wider">Payments</h4>
                        {(() => {
                          const totalPaymentIn = financialData?.project_summaries?.reduce((acc: number, p: any) => acc + (p.payment_in || 0), 0) || 0;
                          const totalPaymentOut = financialData?.project_summaries?.reduce((acc: number, p: any) => acc + (p.payment_out || 0), 0) || 0;
                          const hasPaymentData = totalPaymentIn > 0 || totalPaymentOut > 0;

                          if (!hasPaymentData) {
                            return (
                              <div className="h-40 flex items-center justify-center rounded-md bg-transparent">
                                <span className="text-danger [.light-theme_&]:text-danger text-xs font-bold uppercase tracking-wider">No Data Available</span>
                              </div>
                            );
                          }

                          const maxVal = Math.max(totalPaymentIn, totalPaymentOut);
                          const bar1Height = maxVal > 0 ? (totalPaymentIn / maxVal) * 80 : 0;
                          const bar2Height = maxVal > 0 ? (totalPaymentOut / maxVal) * 80 : 0;

                          return (
                            <div className="h-40 flex items-center justify-center rounded-md bg-transparent relative overflow-visible">
                              <svg className="w-full h-full overflow-visible" viewBox="0 0 240 120">
                                <line x1="20" y1="90" x2="220" y2="90" stroke="var(--border)" strokeWidth="1" />
                                
                                {/* Payments In Bar */}
                                <rect x="60" y={90 - bar1Height} width="40" height={bar1Height} fill="var(--success)" rx="2" className="transition-all hover:opacity-90" />
                                <text x="80" y={90 - bar1Height - 5} fill="var(--success)" fontSize="8" fontWeight="bold" textAnchor="middle">
                                  {compactINR(totalPaymentIn)}
                                </text>
                                <text x="80" y="105" fill="var(--muted)" fontSize="8" textAnchor="middle">Inflow</text>

                                {/* Payments Out Bar */}
                                <rect x="140" y={90 - bar2Height} width="40" height={bar2Height} fill="var(--danger)" rx="2" className="transition-all hover:opacity-90" />
                                <text x="160" y={90 - bar2Height - 5} fill="var(--danger)" fontSize="8" fontWeight="bold" textAnchor="middle">
                                  {compactINR(totalPaymentOut)}
                                </text>
                                <text x="160" y="105" fill="var(--muted)" fontSize="8" textAnchor="middle">Outflow</text>
                              </svg>
                            </div>
                          );
                        })()}
                      </div>
                      <div className="border-t border-border-custom pt-3 flex justify-between items-center text-xs mt-4">
                        <span className="text-muted font-medium">Payment Inflow vs Outflow</span>
                        <span className="font-bold text-muted bg-elevated px-2 py-0.5 rounded">Live</span>
                      </div>
                    </div>

                    {/* Expense Type */}
                    <div className="bg-card border border-border-custom rounded-lg p-5 flex flex-col justify-between transition-all">
                      <div className="space-y-4 w-full">
                        <h4 className="text-xs font-bold text-muted uppercase tracking-wider">Expense Type</h4>
                        {(() => {
                          const expenseItems = financialData?.expense_by_type || [];
                          const hasExpenseData = expenseItems.length > 0 && expenseItems.some((e: any) => e.value > 0);

                          if (!hasExpenseData) {
                            return (
                              <div className="h-40 flex items-center justify-center rounded-md bg-transparent">
                                <span className="text-danger [.light-theme_&]:text-danger text-xs font-bold uppercase tracking-wider">No Data Available</span>
                              </div>
                            );
                          }

                          const totalExp = expenseItems.reduce((acc: number, item: any) => acc + (item.value || 0), 0) || 1;

                          return (
                            <div className="space-y-3 py-2 max-h-[160px] overflow-y-auto pr-1">
                              {expenseItems.map((item: any, idx: number) => {
                                const pct = Math.round((item.value / totalExp) * 100) || 0;
                                const colors = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
                                const color = colors[idx % colors.length];
                                return (
                                  <div key={idx} className="space-y-1">
                                    <div className="flex justify-between items-center text-xs font-medium text-muted">
                                      <span>{item.name}</span>
                                      <span className="font-bold">{item.value.toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 })} ({pct}%)</span>
                                    </div>
                                    <div className="w-full bg-elevated rounded-full h-2">
                                      <div className="rounded-full h-2 transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </div>
                      <div className="border-t border-border-custom pt-3 flex justify-between items-center text-xs mt-4">
                        <span className="text-muted font-medium">Expense Breakdown</span>
                        <span className="font-bold text-muted bg-elevated px-2 py-0.5 rounded">Live</span>
                      </div>
                    </div>
                  </div>

                </div>
              )}
            </>
          )}

          {activeTab === "scheduler" && (
            <div className="rounded-lg bg-card border border-border-custom rounded-lg p-6 space-y-6">
              <div className="flex justify-between items-center border-b border-border-custom pb-4">
                <h3 className="font-bold text-sm uppercase tracking-wider text-foreground inline-flex items-center gap-1.5"><Icon name="sparkles" className="w-4 h-4" /> Interactive Gantt Timeline Scheduler</h3>
                <span className="text-xs text-muted">Module 1: Planning</span>
              </div>

              {/* Gantt Simulation */}
              <div className="w-full bg-input border border-border-custom rounded-md overflow-hidden p-6 space-y-4">
                <div className="grid grid-cols-12 gap-2 text-[10px] font-bold text-muted border-b border-border-custom pb-2 uppercase tracking-wider">
                  <div className="col-span-3">Task Name</div>
                  <div className="col-span-1 text-center">Days</div>
                  <div className="col-span-8 flex justify-between px-4">
                    <span>Jun 01</span>
                    <span>Jun 08</span>
                    <span>Jun 15</span>
                    <span>Jun 22</span>
                    <span>Jun 29</span>
                  </div>
                </div>

                <div className="space-y-4 pt-2">
                  {/* Task 1 */}
                  <div className="grid grid-cols-12 gap-2 items-center text-xs">
                    <div className="col-span-3 font-semibold text-foreground">Shoring Wall Piling</div>
                    <div className="col-span-1 text-center text-muted">14</div>
                    <div className="col-span-8 relative h-6 bg-elevated rounded-lg">
                      <div className="absolute left-[5%] w-[45%] h-full bg-primary rounded-lg flex items-center px-2 text-[10px] font-bold text-white shadow-lg">
                        100%
                      </div>
                    </div>
                  </div>

                  {/* Task 2 */}
                  <div className="grid grid-cols-12 gap-2 items-center text-xs">
                    <div className="col-span-3 font-semibold text-foreground">Raft Foundation Rebar</div>
                    <div className="col-span-1 text-center text-muted">10</div>
                    <div className="col-span-8 relative h-6 bg-elevated rounded-lg">
                      <div className="absolute left-[48%] w-[32%] h-full bg-primary rounded-lg flex items-center px-2 text-[10px] font-bold text-white shadow-lg animate-shimmer">
                        75% (In Progress)
                      </div>
                    </div>
                  </div>

                  {/* Task 3 */}
                  <div className="grid grid-cols-12 gap-2 items-center text-xs">
                    <div className="col-span-3 font-semibold text-foreground">Base slab Concrete Pouring</div>
                    <div className="col-span-1 text-center text-muted">5</div>
                    <div className="col-span-8 relative h-6 bg-elevated rounded-lg">
                      <div className="absolute left-[78%] w-[18%] h-full bg-elevated rounded-lg flex items-center px-2 text-[10px] font-medium text-muted">
                        Planned
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "finance" && (
            <div className="rounded-lg bg-card border border-border-custom rounded-lg p-6 space-y-6">
              <div className="flex justify-between items-center border-b border-border-custom pb-4">
                <h3 className="font-bold text-sm uppercase tracking-wider text-foreground inline-flex items-center gap-1.5"><Icon name="bar_chart" className="w-4 h-4" /> Waterfall Cashflow Chart</h3>
                <span className="text-xs text-muted">Module 13: Project P&L</span>
              </div>

              <div className="w-full bg-input border border-border-custom rounded-md p-8 flex flex-col md:flex-row items-center justify-between gap-8">
                {/* SVG Waterfall Chart */}
                <div className="w-full md:w-2/3 h-64 relative flex items-end justify-between px-6 border-b border-l border-border-custom pb-2">
                  <div className="h-full absolute left-4 bottom-2 flex flex-col justify-between text-[10px] text-muted pointer-events-none">
                    <span>Rs 20 L</span>
                    <span>Rs 15 L</span>
                    <span>Rs 10 L</span>
                    <span>Rs 5 L</span>
                    <span>Rs 0</span>
                  </div>

                  {/* Bar 1: Invoiced */}
                  <div className="flex flex-col items-center gap-2 w-16">
                    <span className="text-[10px] font-semibold text-success">₹18.5 L</span>
                    <div className="w-full bg-success/80 rounded-t-md h-48" />
                    <span className="text-[10px] text-muted">Claim Invoiced</span>
                  </div>

                  {/* Bar 2: Materials */}
                  <div className="flex flex-col items-center gap-2 w-16">
                    <span className="text-[10px] font-semibold text-danger">-₹6.2 L</span>
                    <div className="w-full bg-danger/80 rounded-t-md h-16" />
                    <span className="text-[10px] text-muted">Material POs</span>
                  </div>

                  {/* Bar 3: Labour */}
                  <div className="flex flex-col items-center gap-2 w-16">
                    <span className="text-[10px] font-semibold text-danger">-₹3.1 L</span>
                    <div className="w-full bg-danger/80 rounded-t-md h-8" />
                    <span className="text-[10px] text-muted">Labour Pay</span>
                  </div>

                  {/* Bar 4: Net P&L */}
                  <div className="flex flex-col items-center gap-2 w-16">
                    <span className="text-[10px] font-semibold text-primary">₹9.2 L</span>
                    <div className="w-full bg-primary/80 rounded-t-md h-24" />
                    <span className="text-[10px] text-muted font-medium">Net Profit</span>
                  </div>
                </div>

                <div className="w-full md:w-1/3 space-y-4">
                  <h4 className="font-bold text-xs uppercase tracking-widest text-muted">Cashflow Analytics</h4>
                  <div className="space-y-3 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted">Client billing cleared:</span>
                      <span className="font-semibold text-foreground">Rs 18,50,000</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">Total project spend:</span>
                      <span className="font-semibold text-foreground">Rs 9,30,000</span>
                    </div>
                    <hr className="border-border-custom" />
                    <div className="flex justify-between">
                      <span className="text-muted font-semibold text-primary">Pre-Tax Deduct Section 194C:</span>
                      <span className="font-semibold text-primary">-Rs 37,000</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "tally" && (
            <div className="rounded-lg bg-card border border-border-custom rounded-lg p-6 space-y-6">
              <div className="flex justify-between items-center border-b border-border-custom pb-4">
                <h3 className="font-bold text-sm uppercase tracking-wider text-foreground inline-flex items-center gap-1.5"><Icon name="plug" className="w-4 h-4" /> SiteFlow Tally Integration Control</h3>
                <span className="text-xs text-muted">Module 16: Ledgers Synchronization</span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="p-5 rounded-md border border-border-custom bg-elevated space-y-3">
                  <div className="text-xs font-bold text-muted uppercase tracking-wider">XML Agent Authentication</div>
                  <div className="p-3 bg-input rounded-lg border border-border-custom flex items-center justify-between text-xs">
                    <code className="text-secondary font-sans font-bold">SF-TALLY-1082-MUM</code>
                    <button
                      onClick={() => {
                        if (typeof navigator !== "undefined" && navigator.clipboard) {
                          navigator.clipboard.writeText("SF-TALLY-1082-MUM");
                          setCopiedKey(true);
                          setTimeout(() => setCopiedKey(false), 2000);
                        }
                      }}
                      className="text-[10px] text-muted hover:text-foreground uppercase font-bold cursor-pointer"
                    >
                      {copiedKey ? "Copied!" : "Copy Key"}
                    </button>
                  </div>
                  <p className="text-[10px] text-muted">Enter this key into your desktop Tally.ERP agent configuration panel.</p>
                </div>

                <div className="p-5 rounded-md border border-border-custom bg-elevated space-y-3">
                  <div className="text-xs font-bold text-muted uppercase tracking-wider">Sync Mode Settings</div>
                  <div className="space-y-2 text-xs">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" defaultChecked className="accent-primary" />
                      <span>Post item-wise instead of Lumpsum</span>
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" defaultChecked className="accent-primary" />
                      <span>Auto-create missing party ledgers</span>
                    </label>
                  </div>
                </div>

                <div className="p-5 rounded-md border border-border-custom bg-elevated space-y-3 flex flex-col justify-between">
                  <div>
                    <div className="text-xs font-bold text-muted uppercase tracking-wider">Voucher sync logs</div>
                    <div className="text-xs text-muted mt-2">
                      Last sync window: <span className="text-foreground font-medium">Today, 18:42</span>
                    </div>
                    <div className="text-xs text-muted">
                      Vouchers sent: <span className="text-success font-medium">18 Purchases, 2 Payments</span>
                    </div>
                  </div>
                  <button
                    onClick={handleSyncTally}
                    className="w-full flex justify-center items-center py-2 px-4 rounded-lg bg-secondary text-white font-semibold text-xs hover:opacity-90 active:scale-[0.98] transition-all cursor-pointer"
                  >
                    Resync Voucher Window
                  </button>
                </div>
              </div>
            </div>
          )}
          </PageShell>
        </div>
      </main>

      {/* 2-Step Project Setup Wizard Modal */}
      {isWizardOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm">
          <div className="bg-card border border-border-custom rounded-lg w-full max-w-lg overflow-hidden shadow-2xl">
            {/* Header */}
            <div className="p-6 border-b border-border-custom flex items-center justify-between bg-elevated">
              <div>
                <h3 className="text-sm font-bold uppercase tracking-wider text-foreground">Creating Project</h3>
                <p className="text-[10px] text-muted mt-0.5">Set up your project workspace in 2 steps</p>
              </div>
              <button
                onClick={() => setIsWizardOpen(false)}
                className="text-muted hover:text-foreground cursor-pointer"
              >
                <Icon name="close" className="w-5 h-5" />
              </button>
            </div>

            {/* Step Indicators */}
            <div className="px-6 py-4 bg-elevated border-b border-border-custom flex items-center justify-center gap-8">
              <div className="flex items-center gap-2">
                <span className={`h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold ${wizardStep === 1 ? "bg-primary text-white" : "bg-success text-white"}`}>
                  {wizardStep > 1 ? <Icon name="check" className="w-3.5 h-3.5" /> : "1"}
                </span>
                <span className={`text-xs font-semibold ${wizardStep === 1 ? "text-foreground" : "text-muted"}`}>Project Details</span>
              </div>
              <div className="h-px w-12 bg-border-custom" />
              <div className="flex items-center gap-2">
                <span className={`h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold ${wizardStep === 2 ? "bg-primary text-white" : "bg-elevated text-muted"}`}>
                  2
                </span>
                <span className={`text-xs font-semibold ${wizardStep === 2 ? "text-foreground" : "text-muted"}`}>Add Team Member</span>
              </div>
            </div>

            {/* Body */}
            <div className="p-6 space-y-4">
              {wizardStep === 1 ? (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-[11px] text-muted font-medium">Project Name</label>
                      <input
                        type="text"
                        placeholder="e.g. MP SITE"
                        value={wizardData.name}
                        onChange={(e) => setWizardData({ ...wizardData, name: e.target.value })}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-primary text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] text-muted font-medium">Project Code</label>
                      <input
                        type="text"
                        placeholder="e.g. MP-01"
                        value={wizardData.code}
                        onChange={(e) => setWizardData({ ...wizardData, code: e.target.value })}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-primary text-foreground"
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] text-muted font-medium">Project Address</label>
                    <input
                      type="text"
                      placeholder="e.g. MP ,SATNA"
                      value={wizardData.address}
                      onChange={(e) => setWizardData({ ...wizardData, address: e.target.value })}
                      className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-primary text-foreground"
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-[11px] text-muted font-medium">City</label>
                      <input
                        type="text"
                        placeholder="e.g. Satna"
                        value={wizardData.city}
                        onChange={(e) => setWizardData({ ...wizardData, city: e.target.value })}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-primary text-foreground"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] text-muted font-medium">State *</label>
                      <select
                        value={wizardData.state}
                        onChange={(e) => setWizardData({ ...wizardData, state: e.target.value })}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-primary text-foreground"
                      >
                        <option value="">Select state</option>
                        {GST_STATES.map((st) => (
                          <option key={st.code} value={st.name}>{st.code} - {st.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] text-muted font-medium">Attendance Radius (meters)</label>
                      <input
                        type="number"
                        placeholder="500"
                        value={wizardData.attendance_radius_meters}
                        onChange={(e) => setWizardData({ ...wizardData, attendance_radius_meters: Number(e.target.value) })}
                        className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-primary text-foreground"
                      />
                    </div>
                  </div>
                </>
              ) : (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <label className="text-[11px] text-muted font-medium">Team Member Name</label>
                    <input
                      type="text"
                      placeholder="e.g. PrateekUpadhyay"
                      value={wizardData.teamMember}
                      onChange={(e) => setWizardData({ ...wizardData, teamMember: e.target.value })}
                      className="w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-primary text-foreground"
                    />
                  </div>
                  <p className="text-[10px] text-muted italic">
                    Assigned members can punch attendance and log reports from their mobile app.
                  </p>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="p-6 border-t border-border-custom flex items-center justify-between bg-elevated">
              <button
                onClick={() => {
                  if (wizardStep === 2) {
                    setWizardStep(1);
                  } else {
                    setIsWizardOpen(false);
                  }
                }}
                className="px-4 py-2 border border-border-custom rounded-lg text-xs font-semibold text-muted hover:text-foreground transition-all cursor-pointer"
              >
                {wizardStep === 2 ? "Back" : "Cancel"}
              </button>

              <button
                onClick={async () => {
                  if (wizardStep === 1) {
                    if (!wizardData.name) return alert("Project name is required!");
                    if (!wizardData.state) return alert("State is required. Place of supply for every invoice on this project derives from the site state.");
                    setWizardStep(2);
                  } else {
                    const newProjId = "p-" + Math.random().toString(36).substr(2, 9);
                    const newProj = {
                      id: newProjId,
                      name: wizardData.name,
                      code: wizardData.code || "",
                      city: wizardData.city || "",
                      address: wizardData.address,
                      attendance_radius_meters: wizardData.attendance_radius_meters ?? 500,
                      status: "Ongoing",
                      health: "Healthy",
                      startDate: todayLocalISO(),
                      endDate: undefined
                    };
                    
                    try {
                       const apiHost = getApiHost();
                        const res = await fetch(`${apiHost}/apis/v3/planning/projects`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
                          body: JSON.stringify({
                           company_id: companyId,
                           name: newProj.name,
                           code: newProj.code,
                           address: newProj.address,
                           city: newProj.city,
                           state: wizardData.state,
                           attendance_radius_meters: newProj.attendance_radius_meters
                         })
                       });
                       if (!res.ok) {
                         // Tell the user. Logging to the console and carrying on
                         // is how a failed create used to look like a success.
                         alert(`Could not create the project: ${await readErrorDetail(res)}`);
                         return;
                       }
                     } catch (e) {
                       console.error("Project creation error", e);
                     }

                    setProjects([...projects, newProj]);
                    setActiveProject(newProjId);
                    setIsWizardOpen(false);
                  }
                }}
                className="px-5 py-2 rounded-lg bg-primary hover:opacity-90 text-xs font-bold text-white transition-all cursor-pointer"
              >
                {wizardStep === 1 ? "Continue" : "Create Project"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}