"use client";
import Badge, { type BadgeTone } from "@/components/ui/Badge";
import {  getApiHost , readErrorDetail, detailToMessage} from "@/lib/api";
import { authHeaders, downloadWithAuth, formatDate, formatLabel, toLocalISODate } from "@/lib/siteflow";

import React, { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { useProject } from "@/context/ProjectContext";
import Icon, { type IconName } from "@/components/marketing/Icon";
import SegmentedTabs from "@/components/ui/Tabs";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { CardSkeleton } from "@/components/ui/Skeleton";

interface Equipment {
  id: string;
  company_id: string;
  name: string;
  code: string;
  category: string;
  ownership_type: string;
  status: string;
  hourly_rate: number;
  created_at: string;
}

interface EquipmentDeployment {
  id: string;
  equipment_id: string;
  project_id: string;
  start_date: string;
  end_date: string | null;
  remarks: string | null;
}

interface FuelLog {
  id: string;
  equipment_id: string;
  project_id: string;
  logged_date: string;
  liters: number;
  cost_per_liter: number;
  total_cost: number;
  odometer_hours: number | null;
  remarks: string | null;
}

interface MaintenanceSchedule {
  id: string;
  equipment_id: string;
  service_type: string;
  scheduled_date: string;
  completed_date: string | null;
  cost: number;
  status: string;
  remarks: string | null;
}

interface EquipmentExpenseBill {
  id: string;
  invoice_number: string;
  invoice_date: string;
  subtotal: number;
  gst_amount: number;
  total_payable: number;
  status: string;
  terms?: string | null;
}

export default function EquipmentTrackingPage() {
  const params = useParams();
  const companyId = params?.company_id as string;
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;

  const [activeTab, setActiveTab] = useState<"fleet" | "timeline" | "odologs" | "maintenance" | "expenses">("fleet");
  
  // Data states
  const [fleet, setFleet] = useState<Equipment[]>([]);
  const [deployments, setDeployments] = useState<EquipmentDeployment[]>([]);
  const [fuelLogs, setFuelLogs] = useState<FuelLog[]>([]);
  const [maintenanceLogs, setMaintenanceLogs] = useState<MaintenanceSchedule[]>([]);
  const [expenseBills, setExpenseBills] = useState<EquipmentExpenseBill[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal open states
  const [isAddEqOpen, setIsAddEqOpen] = useState(false);
  const [editingEqId, setEditingEqId] = useState<string | null>(null);
  
  // Start/Stop wizard modal states
  const [activeDeployingEq, setActiveDeployingEq] = useState<Equipment | null>(null);
  const [startMeterVal, setStartMeterVal] = useState("");
  const [startHoursUsed, setStartHoursUsed] = useState("");
  const [isStartPhotoCaptured, setIsStartPhotoCaptured] = useState(false);

  const [activeStoppingEq, setActiveStoppingEq] = useState<Equipment | null>(null);
  const [stopMeterVal, setStopMeterVal] = useState("");
  const [isStopPhotoCaptured, setIsStopPhotoCaptured] = useState(false);
  const [isGpsLocked, setIsGpsLocked] = useState(true);
  const [isBreakdown, setIsBreakdown] = useState(false);

  // Log Fuel States
  const [activeFuelingEq, setActiveFuelingEq] = useState<Equipment | null>(null);
  const [fuelDate, setFuelDate] = useState("");
  const [fuelLiters, setFuelLiters] = useState("");
  const [fuelRate, setFuelRate] = useState("");
  const [fuelOdo, setFuelOdo] = useState("");
  const [fuelRemarks, setFuelRemarks] = useState("");

  // Add Equipment Form
  const [eqName, setEqName] = useState("");
  const [eqCode, setEqCode] = useState("");
  const [eqCategory, setEqCategory] = useState("Excavator");
  const [eqOwnership, setEqOwnership] = useState("Owned");
  const [eqRate, setEqRate] = useState("0");

  const [error, setError] = useState("");
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  const loadData = async () => {
    try {
      setLoading(true);
      setError("");
      
      const fleetRes = await fetch(`${getApiHost()}/apis/v3/equipment/${companyId}`, { headers: authHeaders() });
      if (fleetRes.ok) {
        const fleetData = await fleetRes.json();
        setFleet(fleetData);
        // Try fetching maintenance logs for all equipment
        try {
          const maintenancePromises = fleetData.map((eq: any) =>
            fetch(`${getApiHost()}/apis/v3/equipment/maintenance-schedules/${eq.id}`, { headers: authHeaders() }).then(res => res.ok ? res.json() : [])
          );
          const maintenanceResults = await Promise.all(maintenancePromises);
          setMaintenanceLogs(maintenanceResults.flat());
        } catch {
          setMaintenanceLogs([]);
        }
      } else {
        throw new Error("Fleet API failed");
      }
      const depRes = await fetch(`${getApiHost()}/apis/v3/equipment/deployments/${projectId}`, { headers: authHeaders() });
      if (depRes.ok) {
        setDeployments(await depRes.json());
      }
      const fuelRes = await fetch(`${getApiHost()}/apis/v3/equipment/fuel-logs/${projectId}`, { headers: authHeaders() });
      if (fuelRes.ok) {
        setFuelLogs(await fuelRes.json());
      }
      const billsRes = await fetch(
        projectId
          ? `${getApiHost()}/apis/v3/billing/bills?project_id=${projectId}&invoice_type=equipment`
          : `${getApiHost()}/apis/v3/billing/bills?invoice_type=equipment`,
        { headers: authHeaders() }
      );
      if (billsRes.ok) {
        setExpenseBills(await billsRes.json());
      }
    } catch (err) {
      console.error("Error loading equipment data:", err);
      setError("Could not load equipment data");
      setFleet([]);
      setDeployments([]);
      setFuelLogs([]);
      setMaintenanceLogs([]);
      setExpenseBills([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (companyId && projectId) {
      loadData();
    } else {
      setLoading(false);
    }
  }, [companyId, projectId]);

  const handleEditEquipment = (eq: Equipment) => {
    setEditingEqId(eq.id);
    setEqName(eq.name);
    setEqCode(eq.code);
    setEqCategory(eq.category);
    setEqOwnership(eq.ownership_type);
    setEqRate(String(eq.hourly_rate));
    setIsAddEqOpen(true);
  };

  const handleAddEquipment = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!eqName.trim()) errs.eqName = "Equipment name is required";
    if (!eqCode.trim()) errs.eqCode = "Equipment code is required";
    if (Object.keys(errs).length > 0) {
      setValidationErrors(errs);
      return;
    }
    setValidationErrors({});
    try {
      const url = editingEqId ? `${getApiHost()}/apis/v3/equipment/${editingEqId}` : `${getApiHost()}/apis/v3/equipment`;
      const res = await fetch(url, {
        method: editingEqId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id: companyId,
          name: eqName,
          code: eqCode,
          category: eqCategory,
          ownership_type: eqOwnership,
          hourly_rate: parseFloat(eqRate) || 0.0,
        }),
      });
      if (res.ok) {
        setIsAddEqOpen(false);
        setEditingEqId(null);
        setEqName("");
        setEqCode("");
        setEqRate("0");
        loadData();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(detailToMessage(data.detail, "Failed to add equipment"));
      }
    } catch (err) {
      console.error(err);
      setError("Network error while adding equipment");
    }
  };

  // Start Machinery deployment
  const handleStartMachinery = async () => {
    if (!activeDeployingEq || !startMeterVal) return;
    try {
      const hoursNum = startHoursUsed ? parseFloat(startHoursUsed) : 0;
      const res = await fetch(`${getApiHost()}/apis/v3/equipment/${activeDeployingEq.id}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          equipment_id: activeDeployingEq.id,
          project_id: projectId,
          start_date: new Date().toISOString(),
          hours_used: hoursNum >= 0 ? hoursNum : 0,
          // The meter reading is a number, not prose. It used to live only
          // inside `remarks`, so nothing downstream could compute mileage.
          start_meter: parseFloat(startMeterVal) || null,
          remarks: `Photo proof captured: ${isStartPhotoCaptured}`
        }),
      });
      if (res.ok) {
        setActiveDeployingEq(null);
        setStartMeterVal("");
        setStartHoursUsed("");
        setIsStartPhotoCaptured(false);
        loadData();
      } else {
        const err = await readErrorDetail(res);
        setError(err || 'Action failed');
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Stop Machinery deployment
  const handleStopMachinery = async (andAddFuel: boolean = false) => {
    if (!activeStoppingEq || !stopMeterVal) return;
    try {
      // Find active deployment
      const dep = deployments.find(d => d.equipment_id === activeStoppingEq.id && d.end_date === null);
      if (!dep) return;
      const res = await fetch(`${getApiHost()}/apis/v3/equipment/deployments/${dep.id}/return`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          end_date: new Date().toISOString(),
          // The return endpoint now stores these. Previously it accepted no body
          // at all, so the closing reading was discarded and hours_used stayed
          // 0 for every completed deployment.
          end_meter: parseFloat(stopMeterVal) || null,
          remarks: `Stop photo proof: ${isStopPhotoCaptured}. GPS lock: ${isGpsLocked}`
        }),
      });
      if (res.ok) {
        const targetEq = activeStoppingEq;
        setActiveStoppingEq(null);
        setStopMeterVal("");
        setIsStopPhotoCaptured(false);
        loadData();

        if (andAddFuel) {
          setFuelOdo(stopMeterVal);
          setActiveFuelingEq(targetEq);
        }
      } else {
        const err = await readErrorDetail(res);
        setError(err || 'Action failed');
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Fuel logging
  const handleLogFuel = async () => {
    if (!activeFuelingEq || !fuelLiters || !fuelRate) return;
    try {
      const litersVal = parseFloat(fuelLiters);
      const rateVal = parseFloat(fuelRate);
      const odoVal = fuelOdo ? parseFloat(fuelOdo) : null;
      const total = litersVal * rateVal;

      const res = await fetch(`${getApiHost()}/apis/v3/equipment/${activeFuelingEq.id}/fuel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          equipment_id: activeFuelingEq.id,
          project_id: projectId,
          logged_date: new Date().toISOString(),
          liters: litersVal,
          cost_per_liter: rateVal,
          total_cost: total,
          odometer_hours: odoVal,
          remarks: fuelRemarks || null
        })
      });
      if (res.ok) {
        setActiveFuelingEq(null);
        setFuelLiters("");
        setFuelRate("");
        setFuelOdo("");
        setFuelRemarks("");
        loadData();
      } else {
        const err = await readErrorDetail(res);
        setError(err || 'Action failed');
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Compile Unified timeline (logs + fuels)
  const timelineEvents = [
    ...deployments.map(d => {
      const eq = fleet.find(e => e.id === d.equipment_id);
      return {
        id: d.id,
        eqName: eq ? eq.name : "Machinery",
        type: "usage",
        date: d.start_date,
        endDate: d.end_date,
        remarks: d.remarks,
        display: d.end_date 
          ? `Deployment hours logged: ${new Date(d.start_date).toLocaleTimeString()} - ${new Date(d.end_date).toLocaleTimeString()} (${d.remarks || ""})`
          : `Deploying JCB: Active reading wizard running...`
      };
    }),
    ...fuelLogs.map(f => {
      const eq = fleet.find(e => e.id === f.equipment_id);
      return {
        id: f.id,
        eqName: eq ? eq.name : "Machinery",
        type: "fuel",
        date: f.logged_date,
        endDate: null,
        remarks: f.remarks,
        display: `Fuel added: ${f.liters} Liters Diesel at ₹${f.cost_per_liter}/L (Total: ₹${f.total_cost})`
      };
    })
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Main Framework */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <PageHeader
          title="Equipment & Machinery Logs"
          subtitle="GPS verified mileage and refueling timeline"
        >
          <button onClick={() => { setEditingEqId(null); setEqName(""); setEqCode(""); setEqRate("0"); setIsAddEqOpen(true); }} className="px-3.5 py-1.5 bg-primary rounded-md text-xs font-bold text-white hover:opacity-90 transition-all cursor-pointer">
            + Add Equipment
          </button>
        </PageHeader>

        {/* Tab Controls */}
        <div className="px-6 py-2 border-b border-border-custom bg-card shrink-0 overflow-x-auto">
          <SegmentedTabs
            tabs={[
              { id: "fleet", icon: <Icon name="tractor" className="w-3.5 h-3.5" />, label: "Fleet Inventory" },
              { id: "timeline", icon: <Icon name="fuel_pump" className="w-3.5 h-3.5" />, label: "Usage & Refuel Timeline" },
              { id: "odologs", icon: <Icon name="bar_chart" className="w-3.5 h-3.5" />, label: "Odometer Run Logs" },
              { id: "maintenance", icon: <Icon name="wrench" className="w-3.5 h-3.5" />, label: "Maintenance Schedule" },
              { id: "expenses", icon: <Icon name="receipt" className="w-3.5 h-3.5" />, label: "Equipment Expenses & Invoices" },
            ]}
            activeTab={activeTab}
            onChange={(t) => setActiveTab(t as any)}
          />
        </div>

        {/* Workspace */}
        <div className="flex-1 overflow-y-auto">
          <PageShell width="wide">
            {error && (
              <div className="p-4 bg-danger/10 border border-danger/20 text-danger rounded-lg text-xs">
                {error}
              </div>
            )}
            {!projectId ? (
              <EmptyState
                icon="building"
                title="No project selected"
                description='No active projects. Click "+ New Project" to create one.'
                action={{
                  label: "New Project",
                  href: `/c/${companyId}/projects`,
                  icon: "add",
                }}
              />
            ) : loading ? (
              <CardSkeleton />
            ) : (
            <>
              {activeTab === "fleet" && (
                <div className="space-y-6">
                  {/* Overdue Maintenance Banner Alert */}
                  {maintenanceLogs.filter(m => m.completed_date === null && new Date(m.scheduled_date) < new Date()).length > 0 && (
                    <div className="p-4 bg-danger/10 border border-danger/20 text-danger rounded-lg flex items-start gap-3 text-xs">
                      <Icon name="warning" className="w-5 h-5 shrink-0" />
                      <div>
                        <strong className="font-extrabold block text-foreground">Overdue Maintenance Alert!</strong>
                        <p className="text-muted mt-0.5">The following machinery requires immediate servicing to prevent site safety incidents:</p>
                        <ul className="list-disc pl-5 mt-1.5 space-y-1 font-sans text-[10px]">
                          {maintenanceLogs.filter(m => m.completed_date === null && new Date(m.scheduled_date) < new Date()).map(m => {
                            const eq = fleet.find(e => e.id === m.equipment_id);
                            return (
                              <li key={m.id}>
                                <span className="text-foreground font-bold">{eq?.name ?? "—"} ({eq?.code})</span>: {m.service_type} (due {formatDate(m.scheduled_date)})
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    </div>
                  )}

                  {fleet.length === 0 ? (
                    <EmptyState
                      title="No equipment yet"
                      description="Register machinery, vehicles, and tools to track deployments, fuel logs, and running hours."
                      action={{
                        label: "+ Add Equipment",
                        onClick: () => setIsAddEqOpen(true),
                      }}
                    />
                  ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {fleet.map((eq) => {
                      const activeDep = deployments.find(d => d.equipment_id === eq.id && d.end_date === null);
                      const isOverdue = maintenanceLogs.some(m => m.equipment_id === eq.id && m.completed_date === null && new Date(m.scheduled_date) < new Date());
                      return (
                        <div key={eq.id} className="bg-card border border-border-custom rounded-lg p-5 flex flex-col justify-between space-y-4">
                          <div>
                            <div className="flex justify-between items-start gap-2">
                              <span className="text-xs font-bold text-foreground line-clamp-1">{eq.name}</span>
                              <div className="flex gap-1 items-center">
                                {isOverdue && (
                                  <Badge tone="danger" icon="warning" className="uppercase font-bold">SERVICING OVERDUE</Badge>
                                )}
                                <Badge tone={activeDep ? "primary" : "success"} className="uppercase font-bold">{activeDep ? "deployed" : "available"}</Badge>
                              </div>
                            </div>
                            <div className="text-[10px] text-muted mt-0.5">Code: {eq.code} · Category: {eq.category}</div>
                          </div>

                        <div className="border-t border-border-custom pt-3.5 flex justify-between items-center text-xs">
                          <div>
                            <span className="text-[9px] uppercase font-bold text-muted">Hourly Rate</span>
                            <div className="text-sm font-extrabold text-foreground mt-0.5">₹{eq.hourly_rate}/hr</div>
                          </div>
                          
                          <div className="flex gap-2">
                            {activeDep ? (
                                <button
                                  onClick={() => { setActiveStoppingEq(eq); setStopMeterVal(""); setIsStopPhotoCaptured(false); }}
                                  className="text-[10px] bg-danger/10 hover:bg-danger/10 border border-danger/20 text-danger px-3 py-1.5 rounded-md transition-all font-bold inline-flex items-center gap-1"
                                >
                                  <Icon name="close" className="w-3 h-3" /> Return from Site
                                </button>
                              ) : (
                                <button
                                  onClick={() => { setActiveDeployingEq(eq); setStartMeterVal(""); setIsStartPhotoCaptured(false); }}
                                  className="text-[10px] bg-success/10 hover:bg-success/10 border border-success/20 text-success px-3 py-1.5 rounded-md transition-all font-bold inline-flex items-center gap-1"
                                >
                                  <Icon name="chevron_right" className="w-3 h-3" /> Deploy to Site
                                </button>
                              )}

                            <button
                              onClick={() => handleEditEquipment(eq)}
                              className="text-[10px] bg-primary/10 hover:bg-primary/20 border border-primary/20 text-primary px-2.5 py-1.5 rounded-md transition-all inline-flex items-center gap-1 cursor-pointer"
                            >
                              <Icon name="edit" className="w-3 h-3" />Edit
                            </button>
                            <button
                              onClick={() => { setActiveFuelingEq(eq); setFuelLiters(""); setFuelRate(""); }}
                              className="text-[10px] bg-elevated border border-border-custom text-muted hover:text-foreground px-2.5 py-1.5 rounded-md transition-all inline-flex items-center gap-1"
                            >
                              <Icon name="fuel_pump" className="w-3 h-3" />Refuel
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  </div>
                  )}
                </div>
              )}

              {activeTab === "timeline" && (
                <div className="bg-card border border-border-custom rounded-lg p-6 space-y-4">
                  <div className="flex justify-between items-center pb-2 border-b border-border-custom">
                    <h3 className="text-xs font-bold text-muted uppercase tracking-wider">Refuel & Usage Feed</h3>
                    <div className="text-[10px] text-muted">Chronological machine-ledger timeline</div>
                  </div>

                  <div className="space-y-3">
                    {timelineEvents.length === 0 ? (
                      <EmptyState
                        title="No usage or refuel events yet"
                        description="Equipment refuels and machine-hour logs will appear here in chronological order."
                      />
                    ) : (
                    timelineEvents.map((evt) => (
                      <div key={evt.id} className="p-3.5 rounded-md border border-border-custom bg-input text-xs flex justify-between items-start gap-4">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <strong className="text-foreground font-bold">{evt.eqName}</strong>
                            <span className={`text-[9px] px-2 py-0.5 rounded font-bold uppercase ${evt.type === "usage" ? "bg-primary/10 text-primary" : "bg-warning/10 text-warning"}`}>
                              {evt.type}
                            </span>
                          </div>
                          <p className="text-muted mt-1">{evt.display}</p>
                        </div>
                        <div className="text-right text-[10px] text-muted">
                          {formatDate(evt.date)} · {new Date(evt.date).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                        </div>
                      </div>
                    )))}
                  </div>
                </div>
              )}

              {activeTab === "odologs" && (() => {
                // Parse meter values from remarks string (e.g., "Start reading: 435. ...")
                const parseMeters = (remarks: string | null | undefined) => {
                  if (!remarks) return { start: null, stop: null };
                  const startMatch = remarks.match(/Start reading[:\s]+([\d.]+)/i);
                  const stopMatch  = remarks.match(/Stop reading[:\s]+([\d.]+)/i);
                  return {
                    start: startMatch ? parseFloat(startMatch[1]) : null,
                    stop:  stopMatch  ? parseFloat(stopMatch[1])  : null,
                  };
                };

                // Build run records from completed deployments (those with end_date)
                const completedRuns = deployments
                  .filter(d => d.end_date)
                  .map(d => {
                    const eq = fleet.find(e => e.id === d.equipment_id);
                    const startMeters = parseMeters(d.remarks);
                    // For demo data where remarks captures both start and stop:
                    const startReading = startMeters.start;
                    const stopReading  = startMeters.stop;
                    const delta = (startReading != null && stopReading != null) ? (stopReading - startReading) : null;
                    const startDt = new Date(d.start_date);
                    const endDt   = new Date(d.end_date!);
                    const durationHrs = (endDt.getTime() - startDt.getTime()) / 3600000;
                    const costForRun  = eq ? durationHrs * eq.hourly_rate : null;
                    // Grab matching fuel log for that day
                    const dayStr = toLocalISODate(startDt);
                    const fuelForRun = fuelLogs
                      .filter(f => f.equipment_id === d.equipment_id && f.logged_date.startsWith(dayStr))
                      .reduce((s, f) => s + f.liters, 0);
                    const efficiency = (delta && fuelForRun > 0) ? (delta / fuelForRun).toFixed(2) : null;
                    return { d, eq, startReading, stopReading, delta, durationHrs, costForRun, fuelForRun, efficiency, dayStr };
                  })
                  .sort((a, b) => new Date(b.d.start_date).getTime() - new Date(a.d.start_date).getTime());

                return (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-bold text-muted uppercase tracking-wider">Odometer / Hour-Meter Run Logs</h3>
                      <span className="text-[10px] text-muted">{completedRuns.length} completed runs recorded</span>
                    </div>

                    {/* Summary kpi strip */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                      {[
                        { label: "Total Runs", value: completedRuns.length, color: "text-foreground" },
                        { label: "Total Hours", value: completedRuns.reduce((s,r) => s + r.durationHrs, 0).toFixed(1) + " hr", color: "text-primary" },
                        { label: "Total Fuel Used", value: completedRuns.reduce((s,r) => s + r.fuelForRun, 0).toFixed(0) + " L", color: "text-warning" },
                        { label: "Est. Machine Cost", value: "₹" + completedRuns.reduce((s,r) => s + (r.costForRun || 0), 0).toLocaleString(), color: "text-success" },
                      ].map(kpi => (
                        <div key={kpi.label} className="bg-input border border-border-custom rounded-md p-4">
                          <span className="text-[9px] uppercase text-muted tracking-wider block">{kpi.label}</span>
                          <strong className={`text-lg font-extrabold mt-1 block ${kpi.color}`}>{kpi.value}</strong>
                        </div>
                      ))}
                    </div>

                    {/* Run log table */}
                    <div className="bg-background border border-border-custom rounded-lg overflow-hidden">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-border-custom text-muted">
                            <th className="px-5 py-3 text-left font-semibold">Equipment</th>
                            <th className="px-5 py-3 text-left font-semibold">Date</th>
                            <th className="px-5 py-3 text-center font-semibold">Start Meter</th>
                            <th className="px-5 py-3 text-center font-semibold">Stop Meter</th>
                            <th className="px-5 py-3 text-center font-semibold">Δ Hours/km</th>
                            <th className="px-5 py-3 text-center font-semibold">Fuel Used</th>
                            <th className="px-5 py-3 text-center font-semibold">Efficiency</th>
                            <th className="px-5 py-3 text-right font-semibold">Est. Cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {completedRuns.length === 0 ? (
                            <tr>
                              <td colSpan={8} className="p-8">
                                <EmptyState
                                  title="No completed runs yet"
                                  description="Add a machine, then use Deploy to Site and Return from Site on its card to log meter readings."
                                />
                              </td>
                            </tr>
                          ) : completedRuns.map((run, idx) => (
                            <tr key={idx} className="border-b border-white/[0.03] hover:bg-elevated transition-all">
                              <td className="px-5 py-3">
                                <span className="font-bold text-foreground">{run.eq?.name ?? "Unknown"}</span>
                                <span className="block text-[9px] text-muted">{run.eq?.code} · {run.eq?.category}</span>
                              </td>
                              <td className="px-5 py-3 text-muted">
                                {formatDate(run.d.start_date)}
                                <span className="block text-[9px] text-muted">
                                  {new Date(run.d.start_date).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})} → {new Date(run.d.end_date!).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}
                                </span>
                              </td>
                              <td className="px-5 py-3 text-center font-sans">{run.startReading ?? <span className="text-muted">—</span>}</td>
                              <td className="px-5 py-3 text-center font-sans">{run.stopReading ?? <span className="text-muted">—</span>}</td>
                              <td className="px-5 py-3 text-center">
                                {run.delta != null
                                  ? <span className="font-bold text-primary">+{run.delta.toFixed(1)}</span>
                                  : <span className="text-muted">{run.durationHrs.toFixed(2)} hr</span>}
                              </td>
                              <td className="px-5 py-3 text-center text-warning font-sans">
                                {run.fuelForRun > 0 ? `${run.fuelForRun.toFixed(1)} L` : <span className="text-muted">—</span>}
                              </td>
                              <td className="px-5 py-3 text-center">
                                {run.efficiency
                                  ? <span className="text-success font-sans">{run.efficiency} km/L</span>
                                  : <span className="text-muted">—</span>}
                              </td>
                              <td className="px-5 py-3 text-right font-sans font-bold text-foreground">
                                {run.costForRun != null ? `₹${run.costForRun.toLocaleString()}` : <span className="text-muted">—</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}

              {activeTab === "maintenance" && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-bold text-muted uppercase tracking-wider">Maintenance Schedule & Service Logs</h3>
                    <span className="text-[10px] text-muted">{maintenanceLogs.length} schedule entries</span>
                  </div>

                  <div className="bg-background border border-border-custom rounded-lg overflow-hidden">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border-custom text-muted text-left">
                          <th className="px-5 py-3 font-semibold">Equipment</th>
                          <th className="px-5 py-3 font-semibold">Service Type</th>
                          <th className="px-5 py-3 font-semibold">Scheduled Date</th>
                          <th className="px-5 py-3 font-semibold">Completed Date</th>
                          <th className="px-5 py-3 text-right font-semibold">Est. Cost</th>
                          <th className="px-5 py-3 text-center font-semibold">Status</th>
                          <th className="px-5 py-3 font-semibold">Remarks</th>
                        </tr>
                      </thead>
                      <tbody>
                        {maintenanceLogs.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="p-8">
                              <EmptyState
                                title="No maintenance schedules recorded"
                                description="Schedule preventive maintenance or record servicing records for your equipment fleet."
                              />
                            </td>
                          </tr>
                        ) : maintenanceLogs.map((log) => {
                          const eq = fleet.find(e => e.id === log.equipment_id);
                          const isOverdue = log.completed_date === null && new Date(log.scheduled_date) < new Date();
                          return (
                            <tr key={log.id} className="border-b border-white/[0.03] hover:bg-elevated transition-all">
                              <td className="px-5 py-3">
                                <span className="font-bold text-foreground">{eq?.name ?? "Unknown"}</span>
                                <span className="block text-[9px] text-muted">{eq?.code} · {eq?.category}</span>
                              </td>
                              <td className="px-5 py-3 text-muted font-medium">{log.service_type}</td>
                              <td className="px-5 py-3 text-muted">{formatDate(log.scheduled_date)}</td>
                              <td className="px-5 py-3 text-muted">
                                {formatDate(log.completed_date)}
                              </td>
                              <td className="px-5 py-3 text-right font-sans font-bold text-foreground">
                                {log.cost > 0 ? `₹${log.cost.toLocaleString()}` : <span className="text-muted">—</span>}
                              </td>
                              <td className="px-5 py-3 text-center">
                                <span className={`text-[9px] font-bold px-2 py-0.5 rounded border ${
                                  log.status === "Completed" || log.completed_date
                                    ? "bg-success/10 border-success/20 text-success"
                                    : isOverdue
                                      ? "bg-danger/10 border-danger/20 text-danger font-bold"
                                      : "bg-warning/10 border-warning/20 text-warning"
                                }`}>
                                  {log.completed_date ? "Completed" : isOverdue ? "Overdue" : formatLabel(log.status)}
                                </span>
                              </td>
                              <td className="px-5 py-3 text-muted italic max-w-xs truncate" title={log.remarks || ""}>
                                {log.remarks || "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {activeTab === "expenses" && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-bold text-muted uppercase tracking-wider">Equipment Expense Bills & Invoices</h3>
                    <span className="text-[10px] text-muted">{expenseBills.length} invoice entries</span>
                  </div>

                  <div className="bg-background border border-border-custom rounded-lg overflow-hidden">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border-custom text-muted text-left">
                          <th className="px-5 py-3 font-semibold">Bill / Invoice #</th>
                          <th className="px-5 py-3 font-semibold">Date</th>
                          <th className="px-5 py-3 text-right font-semibold">Subtotal</th>
                          <th className="px-5 py-3 text-right font-semibold">GST</th>
                          <th className="px-5 py-3 text-right font-semibold">Total Payable</th>
                          <th className="px-5 py-3 text-center font-semibold">Status</th>
                          <th className="px-5 py-3 text-right font-semibold">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {expenseBills.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="p-8">
                              <EmptyState
                                title="No equipment expense bills recorded"
                                description="Billed equipment maintenance, rentals, and fuel adjustments will appear here."
                              />
                            </td>
                          </tr>
                        ) : expenseBills.map((bill) => (
                          <tr key={bill.id} className="border-b border-white/[0.03] hover:bg-elevated transition-all">
                            <td className="px-5 py-3">
                              <span className="font-bold text-primary font-sans">{bill.invoice_number}</span>
                              {bill.terms && <span className="block text-[9px] text-muted truncate max-w-xs">{bill.terms}</span>}
                            </td>
                            <td className="px-5 py-3 text-muted">
                              {formatDate(bill.invoice_date)}
                            </td>
                            <td className="px-5 py-3 text-right font-sans text-muted">
                              ₹{(bill.subtotal || 0).toLocaleString("en-IN")}
                            </td>
                            <td className="px-5 py-3 text-right font-sans text-muted">
                              ₹{(bill.gst_amount || 0).toLocaleString("en-IN")}
                            </td>
                            <td className="px-5 py-3 text-right font-sans font-bold text-foreground">
                              ₹{(bill.total_payable || 0).toLocaleString("en-IN")}
                            </td>
                            <td className="px-5 py-3 text-center">
                              <Badge
                                tone={bill.status === "Paid" ? "success" : bill.status === "Cancelled" ? "danger" : "warning"}
                                className="uppercase font-bold text-[9px]"
                              >
                                {bill.status || "Unpaid"}
                              </Badge>
                            </td>
                            <td className="px-5 py-3 text-right">
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await downloadWithAuth(`/equipment/expenses/${bill.id}/pdf`);
                                  } catch (e) {
                                    alert(`Download failed: ${e instanceof Error ? e.message : "unknown error"}`);
                                  }
                                }}
                                className="px-2.5 py-1 bg-elevated hover:bg-elevated/70 border border-border-custom text-foreground text-xs font-bold rounded transition-all cursor-pointer inline-flex items-center gap-1"
                              >
                                <Icon name="receipt" className="w-3.5 h-3.5" /> PDF
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
          </PageShell>
        </div>
      </main>

      {/* Start Machinery Wizard */}
      {activeDeployingEq && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-background border border-border-custom rounded-lg w-full max-w-md shadow-2xl p-6 space-y-4">
            <div className="flex justify-between items-center border-b border-border-custom pb-2">
              <h3 className="text-xs font-extrabold text-foreground">Deploy to Site: {activeDeployingEq.name}</h3>
              <button onClick={() => setActiveDeployingEq(null)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>
            
            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-muted">Start Meter / Odometer</label>
                  <input
                    type="number"
                    value={startMeterVal}
                    onChange={(e) => setStartMeterVal(e.target.value)}
                    placeholder="e.g. 435"
                    className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-muted">Initial / Base Hours Used</label>
                  <input
                    type="number"
                    value={startHoursUsed}
                    onChange={(e) => setStartHoursUsed(e.target.value)}
                    placeholder="e.g. 0 or 8.0"
                    className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground"
                  />
                </div>
              </div>

              {/* Photo scanning viewport */}
              <div className="space-y-2">
                <span className="text-muted block">Capture Odometer Photo Proof</span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setIsStartPhotoCaptured(true)}
                    className="flex items-center gap-2 px-3 py-1.5 bg-elevated border border-border-custom rounded-lg text-muted hover:text-foreground"
                  >
                    <Icon name="camera" className="w-4 h-4" />Take Photo
                  </button>
                  {isStartPhotoCaptured && <span className="inline-flex items-center gap-1 text-success font-bold"><Icon name="check" className="w-3.5 h-3.5" /> Captured (GPS Locked)</span>}
                </div>
              </div>
            </div>

            <div className="flex gap-2 justify-end border-t border-border-custom pt-4">
              <button onClick={() => setActiveDeployingEq(null)} className="px-4 py-2 bg-elevated text-muted hover:text-foreground rounded-md text-xs">Cancel</button>
              <button onClick={handleStartMachinery} className="px-5 py-2.5 bg-primary text-white font-bold rounded-md text-xs">Start Machinery</button>
            </div>
          </div>
        </div>
      )}

      {/* Stop Machinery Wizard */}
      {activeStoppingEq && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-background border border-border-custom rounded-lg w-full max-w-md shadow-2xl p-6 space-y-4">
            <div className="flex justify-between items-center border-b border-border-custom pb-2">
              <h3 className="text-xs font-extrabold text-foreground">Return from Site: {activeStoppingEq.name}</h3>
              <button onClick={() => setActiveStoppingEq(null)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="space-y-1">
                <label className="text-muted">Odometer / Stop Hour Meter Reading</label>
                <input
                  type="number"
                  value={stopMeterVal}
                  onChange={(e) => setStopMeterVal(e.target.value)}
                  placeholder="e.g. 443.5"
                  className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground"
                />
              </div>

              <div className="space-y-2">
                <span className="text-muted block">Capture Stop Odometer Photo Proof</span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setIsStopPhotoCaptured(true)}
                    className="flex items-center gap-2 px-3 py-1.5 bg-elevated border border-border-custom rounded-lg text-muted hover:text-foreground"
                  >
                    <Icon name="camera" className="w-4 h-4" />Take Photo
                  </button>
                  {isStopPhotoCaptured && <span className="inline-flex items-center gap-1 text-success font-bold"><Icon name="check" className="w-3.5 h-3.5" /> Captured (GPS verification active)</span>}
                </div>
              </div>

              <div className="flex items-center gap-2 pt-2">
                <input
                  type="checkbox"
                  id="breakdownCheck"
                  checked={isBreakdown}
                  onChange={(e) => setIsBreakdown(e.target.checked)}
                  className="accent-danger h-4 w-4"
                />
                <label htmlFor="breakdownCheck" className="text-danger font-semibold cursor-pointer">
                  Flag Breakdown Maintenance Required
                </label>
              </div>
            </div>

            <div className="flex gap-2 justify-end border-t border-border-custom pt-4">
              <button onClick={() => setActiveStoppingEq(null)} className="px-4 py-2 bg-elevated text-muted hover:text-foreground rounded-md text-xs">Cancel</button>
              <button onClick={() => handleStopMachinery()} className="px-5 py-2.5 bg-primary text-white font-bold rounded-md text-xs">Complete Shift & Clock Log</button>
            </div>
          </div>
        </div>
      )}

      {/* Fuel Log Modal */}
      {activeFuelingEq && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-background border border-border-custom rounded-lg w-full max-w-md shadow-2xl p-6 space-y-4">
            <div className="flex justify-between items-center border-b border-border-custom pb-2">
              <h3 className="text-xs font-extrabold text-foreground">Log Refueling: {activeFuelingEq.name}</h3>
              <button onClick={() => setActiveFuelingEq(null)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-muted">Diesel Liters</label>
                  <input type="number" value={fuelLiters} onChange={(e) => setFuelLiters(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" placeholder="e.g. 89" />
                </div>
                <div className="space-y-1">
                  <label className="text-muted">Cost per Liter (₹)</label>
                  <input type="number" value={fuelRate} onChange={(e) => setFuelRate(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" placeholder="e.g. 90" />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-muted">Current Odometer Hours (Optional)</label>
                <input type="number" value={fuelOdo} onChange={(e) => setFuelOdo(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" placeholder="e.g. 443.5" />
              </div>

              <div className="space-y-1">
                <label className="text-muted">Remarks / Supplier</label>
                <input type="text" value={fuelRemarks} onChange={(e) => setFuelRemarks(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" placeholder="Indian Oil Corp..." />
              </div>
            </div>

            <div className="flex gap-2 justify-end border-t border-border-custom pt-4">
              <button onClick={() => setActiveFuelingEq(null)} className="px-4 py-2 bg-elevated text-muted hover:text-foreground rounded-md text-xs">Cancel</button>
              <button onClick={handleLogFuel} className="px-5 py-2.5 bg-primary text-white font-bold rounded-md text-xs">Log Fuel Refill</button>
            </div>
          </div>
        </div>
      )}

      {/* Add Equipment Modal */}
      {isAddEqOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-background border border-border-custom rounded-lg w-full max-w-md shadow-2xl p-6 space-y-4">
            <div className="flex justify-between items-center border-b border-border-custom pb-2">
              <h3 className="text-xs font-extrabold text-foreground">{editingEqId ? "Edit Equipment Asset" : "Add Equipment Assets"}</h3>
              <button onClick={() => setIsAddEqOpen(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>

            <form onSubmit={handleAddEquipment} className="space-y-3 text-xs">
              <div className="space-y-1">
                <label className="text-muted">Equipment Name</label>
                <input type="text" value={eqName} onChange={(e) => setEqName(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" placeholder="JCB Excavator 3DX" />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-muted">Equipment Code</label>
                  <input type="text" value={eqCode} onChange={(e) => setEqCode(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" placeholder="JCB-3DX-01" />
                </div>
                <div className="space-y-1">
                  <label className="text-muted">Hourly Rental Rate (₹)</label>
                  <input type="number" value={eqRate} onChange={(e) => setEqRate(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground" placeholder="1200" />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-muted">Category</label>
                  <select value={eqCategory} onChange={(e) => setEqCategory(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground">
                    <option value="Excavator">Excavator</option>
                    <option value="Concrete Mixer">Concrete Mixer</option>
                    <option value="Tower Crane">Tower Crane</option>
                    <option value="Generator">Generator</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-muted">Ownership Type</label>
                  <select value={eqOwnership} onChange={(e) => setEqOwnership(e.target.value)} className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground">
                    <option value="Owned">Owned</option>
                    <option value="Hired">Hired</option>
                  </select>
                </div>
              </div>

              <div className="flex gap-2 justify-end border-t border-border-custom pt-4">
                <button type="button" onClick={() => setIsAddEqOpen(false)} className="px-4 py-2 bg-elevated text-muted hover:text-foreground rounded-md text-xs">Cancel</button>
                <button type="submit" className="px-5 py-2.5 bg-primary text-white font-bold rounded-md text-xs">{editingEqId ? "Update Asset" : "Save Asset"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}