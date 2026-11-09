"use client";
import Badge, { type BadgeTone } from "@/components/ui/Badge";
import { getApiHost, detailToMessage} from "@/lib/api";
import { authHeaders, formatDate, formatLabel } from "@/lib/siteflow";
import React, { useState, useEffect } from "react";
import { useProject } from "@/context/ProjectContext";
import { useParams } from "next/navigation";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import SegmentedTabs from "@/components/ui/Tabs";

interface Schedule {
  id: string;
  asset_id: string;
  method: string;
  useful_life_years: number;
  salvage_value: number;
  depreciation_pct: number;
  start_date: string;
  is_active: boolean;
}

interface Entry {
  id: string;
  schedule_id: string;
  asset_id: string;
  entry_date: string;
  depreciation_amount: number;
  accumulated_depreciation: number;
  book_value: number;
  notes?: string;
}

interface Asset {
  id: string;
  name: string;
  code: string;
}

export default function DepreciationPage() {
  const params = useParams();
  const companyId = params?.company_id as string;
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;

  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [activeTab, setActiveTab] = useState<"schedules" | "entries">("schedules");
  const [showSchedModal, setShowSchedModal] = useState(false);
  const [showEntryModal, setShowEntryModal] = useState(false);
  const [message, setMessage] = useState("");

  const [schedForm, setSchedForm] = useState({
    asset_id: "",
    method: "straight_line",
    useful_life_years: 10,
    salvage_value: 0,
    depreciation_pct: 10,
    start_date: "",
  });

  const [entryForm, setEntryForm] = useState({
    schedule_id: "",
    asset_id: "",
    project_id: projectId || "",
    entry_date: "",
    notes: "",
  });
  // First entry for an asset needs its purchase cost; later entries carry on
  // from the last one. The amount is suggested from the schedule and may be
  // changed; running total and book value always follow from it.
  const [entryCost, setEntryCost] = useState("");
  const [entryAmount, setEntryAmount] = useState<string | null>(null);

  // Which lists have answered at least once; until then they say Loading.
  const [schedulesLoaded, setSchedulesLoaded] = useState(false);
  const [entriesLoaded, setEntriesLoaded] = useState(false);

  const fetchSchedules = async () => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/assets/schedules/${companyId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setSchedules(data);
      }
    } catch (e) {
      console.error("Failed to load schedules", e);
    } finally {
      setSchedulesLoaded(true);
    }
  };

  const fetchEntries = async () => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/assets/entries/${companyId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setEntries(data);
      }
    } catch (e) {
      console.error("Failed to load entries", e);
    } finally {
      setEntriesLoaded(true);
    }
  };

  useEffect(() => {
    const id = setTimeout(() => {
      if (activeTab === "schedules") fetchSchedules();
      else fetchEntries();
    }, 0);
    return () => clearTimeout(id);
  }, [activeTab, companyId]);

  // Schedules feed the entry form's picker, and the fleet names every row.
  useEffect(() => {
    if (!companyId) return;
    fetchSchedules();
    fetch(`${getApiHost()}/apis/v3/equipment/${companyId}`, { headers: authHeaders() })
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setAssets(Array.isArray(data) ? data : []))
      .catch((e) => console.error("Failed to load equipment", e));
  }, [companyId]);

  const assetLabel = (assetId: string) => {
    const a = assets.find((x) => x.id === assetId);
    return a ? `${a.name} (${a.code})` : "Unknown asset";
  };
  const methodLabel = (m: string) => (m === "wdv" ? "Written Down Value" : formatLabel(m));

  const handleCreateSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/assets/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ ...schedForm, company_id: companyId }),
      });
      if (res.ok) {
        setMessage("Schedule created successfully");
        setShowSchedModal(false);
        fetchSchedules();
      } else {
        const err = await res.json();
        setMessage(detailToMessage(err.detail, "Failed to create schedule"));
      }
    } catch (_e) {
      void _e;
      setMessage("Error creating schedule");
    }
  };

  const openEntryModal = () => {
    setEntryForm({ schedule_id: "", asset_id: "", project_id: projectId || "", entry_date: "", notes: "" });
    setEntryCost("");
    setEntryAmount(null);
    setShowEntryModal(true);
    fetchEntries();
  };

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const entrySchedule = schedules.find((x) => x.id === entryForm.schedule_id);
  const priorEntry = entries
    .filter((x) => x.schedule_id === entryForm.schedule_id)
    .sort((a, b) => b.entry_date.localeCompare(a.entry_date))[0];
  const calc = (() => {
    if (!entrySchedule || !entryForm.entry_date) return null;
    const cost = priorEntry
      ? Number(priorEntry.book_value) + Number(priorEntry.accumulated_depreciation)
      : parseFloat(entryCost);
    if (!cost || cost <= 0) return null;
    const opening = priorEntry ? Number(priorEntry.book_value) : cost;
    const from = new Date(priorEntry ? priorEntry.entry_date : entrySchedule.start_date);
    const to = new Date(entryForm.entry_date + "T23:59:59+05:30");
    const days = Math.max(0, Math.min(365, Math.round((to.getTime() - from.getTime()) / 86400000)));
    const salvage = Number(entrySchedule.salvage_value) || 0;
    const yearly = entrySchedule.method === "wdv"
      ? opening * Number(entrySchedule.depreciation_pct) / 100
      : (cost - salvage) / Math.max(1, Number(entrySchedule.useful_life_years));
    const suggested = round2(Math.max(0, Math.min(yearly * days / 365, opening - salvage)));
    const amount = entryAmount === null ? suggested : (parseFloat(entryAmount) || 0);
    const before = priorEntry ? Number(priorEntry.accumulated_depreciation) : 0;
    return { opening, days, suggested, amount, accumulated: round2(before + amount), bookValue: round2(opening - amount) };
  })();
  const inr = (n: number) => "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });

  const handleCreateEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");
    if (!calc) {
      setMessage(priorEntry ? "Pick the date for this entry." : "Enter the asset's purchase cost and the date for this entry.");
      return;
    }
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/assets/entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          ...entryForm,
          company_id: companyId,
          depreciation_amount: calc.amount,
          accumulated_depreciation: calc.accumulated,
          book_value: calc.bookValue,
        }),
      });
      if (res.ok) {
        setMessage("Entry recorded successfully");
        setShowEntryModal(false);
        fetchEntries();
      } else {
        const err = await res.json();
        setMessage(detailToMessage(err.detail, "Failed to create entry"));
      }
    } catch (_e) {
      void _e;
      setMessage("Error creating entry");
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title="Asset Depreciation"
        subtitle="Track asset value decline and maintain depreciation schedules"
      >
        <div className="flex gap-2">
          <button
            onClick={() => { setShowSchedModal(true); setMessage(""); }}
            className="px-3.5 py-1.5 bg-primary hover:bg-primary/90 text-white rounded-md text-xs font-semibold transition-all cursor-pointer"
          >
            + New Schedule
          </button>
          <button
            onClick={() => { openEntryModal(); setMessage(""); }}
            className="px-3.5 py-1.5 bg-elevated hover:bg-elevated text-foreground rounded-md text-xs font-semibold transition-all cursor-pointer border border-border-custom"
          >
            Record Entry
          </button>
        </div>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">

        {message && (
          <div className={`mb-6 p-4 rounded-md ${message.includes("success") ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>
            {message}
          </div>
        )}

        <div className="pb-4">
          <SegmentedTabs
            tabs={[
              { id: "schedules", label: "Depreciation Schedules" },
              { id: "entries", label: "Depreciation Entries" },
            ]}
            activeTab={activeTab}
            onChange={(tab) => setActiveTab(tab as any)}
          />
        </div>

        {activeTab === "schedules" && (
          <div className="bg-elevated border border-border-custom rounded-lg overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="bg-elevated text-muted">
                <tr>
                  <th className="px-6 py-4 font-medium">Asset</th>
                  <th className="px-6 py-4 font-medium">Method</th>
                  <th className="px-6 py-4 font-medium">Life (Yrs)</th>
                  <th className="px-6 py-4 font-medium">Salvage Value</th>
                  <th className="px-6 py-4 font-medium">Depreciation %</th>
                  <th className="px-6 py-4 font-medium">Start Date</th>
                  <th className="px-6 py-4 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-custom">
                {schedules.length === 0 && !schedulesLoaded ? (
                  <tr><td colSpan={7} className="p-8 text-center text-muted text-sm">Loading schedules...</td></tr>
                ) : schedules.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-8">
                      <EmptyState
                        icon="trending_down"
                        title="No depreciation schedules found"
                        description="Create an asset depreciation schedule to track salvage value, life cycle and yearly depreciation."
                        action={{
                          label: "New Schedule",
                          onClick: () => setShowSchedModal(true),
                          icon: "add",
                        }}
                      />
                    </td>
                  </tr>
                ) : (
                  schedules.map((s) => (
                    <tr key={s.id} className="hover:bg-elevated transition-colors">
                      <td className="px-6 py-4 font-medium text-foreground">{assetLabel(s.asset_id)}</td>
                      <td className="px-6 py-4">{methodLabel(s.method)}</td>
                      <td className="px-6 py-4">{s.useful_life_years}</td>
                      <td className="px-6 py-4">₹{Number(s.salvage_value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                      <td className="px-6 py-4">{s.depreciation_pct}%</td>
                      <td className="px-6 py-4">{formatDate(s.start_date)}</td>
                      <td className="px-6 py-4">
                        <Badge tone={s.is_active ? "success" : "neutral"}>{s.is_active ? "Active" : "Inactive"}</Badge>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === "entries" && (
          <div className="bg-elevated border border-border-custom rounded-lg overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="bg-elevated text-muted">
                <tr>
                  <th className="px-6 py-4 font-medium">Asset</th>
                  <th className="px-6 py-4 font-medium">Date</th>
                  <th className="px-6 py-4 font-medium">Depreciation</th>
                  <th className="px-6 py-4 font-medium">Accumulated</th>
                  <th className="px-6 py-4 font-medium">Book Value</th>
                  <th className="px-6 py-4 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-custom">
                {entries.length === 0 && !entriesLoaded ? (
                  <tr><td colSpan={6} className="p-8 text-center text-muted text-sm">Loading entries...</td></tr>
                ) : entries.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-8">
                      <EmptyState
                        icon="ledger"
                        title="No depreciation entries found"
                        description="Log depreciation journal entries to calculate monthly asset write-offs."
                        action={{
                          label: "New Entry",
                          onClick: () => openEntryModal(),
                          icon: "add",
                        }}
                      />
                    </td>
                  </tr>
                ) : (
                  entries.map((e) => (
                    <tr key={e.id} className="hover:bg-elevated transition-colors">
                      <td className="px-6 py-4 font-medium text-foreground">{assetLabel(e.asset_id)}</td>
                      <td className="px-6 py-4">{formatDate(e.entry_date)}</td>
                      <td className="px-6 py-4">₹{Number(e.depreciation_amount).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                      <td className="px-6 py-4">₹{Number(e.accumulated_depreciation).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                      <td className="px-6 py-4">₹{Number(e.book_value).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                      <td className="px-6 py-4 text-muted">{e.notes || "-"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
        </PageShell>
      </div>

      {showSchedModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-elevated border border-border-custom rounded-lg p-6 w-full max-w-lg">
            <h2 className="text-xl font-bold text-foreground mb-4">New Depreciation Schedule</h2>
            <form onSubmit={handleCreateSchedule} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Asset</label>
                <select required className="w-full bg-elevated border border-border-custom rounded-md px-4 py-2 text-foreground" value={schedForm.asset_id} onChange={(e) => setSchedForm({...schedForm, asset_id: e.target.value})}>
                  <option value="">Select equipment</option>
                  {assets.map((a) => (
                    <option key={a.id} value={a.id}>{a.name} ({a.code})</option>
                  ))}
                </select>
                {assets.length === 0 && (
                  <p className="text-xs text-muted mt-1">Add the machine under Equipment first, then come back here.</p>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Method</label>
                  <select className="w-full bg-elevated border border-border-custom rounded-md px-4 py-2 text-foreground" value={schedForm.method} onChange={(e) => setSchedForm({...schedForm, method: e.target.value})}>
                    <option value="straight_line">Straight Line</option>
                    <option value="wdv">Written Down Value</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Useful Life (Years)</label>
                  <input type="number" required className="w-full bg-elevated border border-border-custom rounded-md px-4 py-2 text-foreground" value={schedForm.useful_life_years} onChange={(e) => setSchedForm({...schedForm, useful_life_years: parseInt(e.target.value)})} />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Salvage Value (₹)</label>
                  <input type="number" required className="w-full bg-elevated border border-border-custom rounded-md px-4 py-2 text-foreground" value={schedForm.salvage_value} onChange={(e) => setSchedForm({...schedForm, salvage_value: parseFloat(e.target.value)})} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Depreciation %</label>
                  <input type="number" required className="w-full bg-elevated border border-border-custom rounded-md px-4 py-2 text-foreground" value={schedForm.depreciation_pct} onChange={(e) => setSchedForm({...schedForm, depreciation_pct: parseFloat(e.target.value)})} />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Start Date</label>
                <input type="date" required className="w-full bg-elevated border border-border-custom rounded-md px-4 py-2 text-foreground" value={schedForm.start_date} onChange={(e) => setSchedForm({...schedForm, start_date: e.target.value})} />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="submit" className="flex-1 px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded-md text-sm font-semibold">Create Schedule</button>
                <button type="button" onClick={() => { setShowSchedModal(false); setMessage(""); }} className="px-4 py-2 bg-elevated hover:bg-elevated text-foreground rounded-md text-sm font-semibold">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showEntryModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-elevated border border-border-custom rounded-lg p-6 w-full max-w-lg">
            <h2 className="text-xl font-bold text-foreground mb-4">New Depreciation Entry</h2>
            <form onSubmit={handleCreateEntry} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Asset Schedule</label>
                <select
                  required
                  className="w-full bg-elevated border border-border-custom rounded-md px-4 py-2 text-foreground"
                  value={entryForm.schedule_id}
                  onChange={(e) => {
                    const s = schedules.find((x) => x.id === e.target.value);
                    setEntryForm({ ...entryForm, schedule_id: e.target.value, asset_id: s?.asset_id || "" });
                    setEntryAmount(null);
                  }}
                >
                  <option value="">Select a schedule</option>
                  {schedules.map((s) => (
                    <option key={s.id} value={s.id}>
                      {assetLabel(s.asset_id)}: {methodLabel(s.method)}, {s.depreciation_pct}%
                    </option>
                  ))}
                </select>
                {schedules.length === 0 && (
                  <p className="text-xs text-muted mt-1">Create a depreciation schedule for the asset first.</p>
                )}
              </div>
              {entrySchedule && !priorEntry && (
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Purchase Cost (₹)</label>
                  <input type="number" min="0" step="0.01" required className="w-full bg-elevated border border-border-custom rounded-md px-4 py-2 text-foreground" value={entryCost} onChange={(e) => { setEntryCost(e.target.value); setEntryAmount(null); }} />
                  <p className="text-xs text-muted mt-1">First entry for this asset. Later entries carry on from this one.</p>
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Up To Date</label>
                <input type="date" required className="w-full bg-elevated border border-border-custom rounded-md px-4 py-2 text-foreground" value={entryForm.entry_date} onChange={(e) => { setEntryForm({...entryForm, entry_date: e.target.value}); setEntryAmount(null); }} />
                {entrySchedule && (
                  <p className="text-xs text-muted mt-1">
                    {priorEntry ? "Counted from the last entry on " + formatDate(priorEntry.entry_date) + "." : "Counted from the schedule start on " + formatDate(entrySchedule.start_date) + "."}
                  </p>
                )}
              </div>
              {calc && entrySchedule && (
                <div className="space-y-3 rounded-md border border-border-custom p-3">
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">Depreciation for this period (₹)</label>
                    <input type="number" min="0" step="0.01" required className="w-full bg-elevated border border-border-custom rounded-md px-4 py-2 text-foreground" value={entryAmount === null ? calc.suggested : entryAmount} onChange={(e) => setEntryAmount(e.target.value)} />
                    <p className="text-xs text-muted mt-1">
                      Worked out as {calc.days} days of the yearly amount by {methodLabel(entrySchedule.method)}. You can change it.
                    </p>
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <div><div className="text-muted">Value before</div><div className="font-semibold text-foreground">{inr(calc.opening)}</div></div>
                    <div><div className="text-muted">Total depreciated</div><div className="font-semibold text-foreground">{inr(calc.accumulated)}</div></div>
                    <div><div className="text-muted">Value after</div><div className="font-semibold text-foreground">{inr(calc.bookValue)}</div></div>
                  </div>
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Notes</label>
                <textarea className="w-full bg-elevated border border-border-custom rounded-md px-4 py-2 text-foreground" value={entryForm.notes} onChange={(e) => setEntryForm({...entryForm, notes: e.target.value})} />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="submit" className="flex-1 px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded-md text-sm font-semibold">Record Entry</button>
                <button type="button" onClick={() => { setShowEntryModal(false); setMessage(""); }} className="px-4 py-2 bg-elevated hover:bg-elevated text-foreground rounded-md text-sm font-semibold">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
