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
  asset_id: string;
  entry_date: string;
  depreciation_amount: number;
  accumulated_depreciation: number;
  book_value: number;
  notes?: string;
}

export default function DepreciationPage() {
  const params = useParams();
  const companyId = params?.company_id as string;
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;

  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
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
    depreciation_amount: 0,
    accumulated_depreciation: 0,
    book_value: 0,
    notes: "",
  });

  const fetchSchedules = async () => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/assets/schedules/${companyId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setSchedules(data);
      }
    } catch (e) {
      console.error("Failed to load schedules", e);
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
    }
  };

  useEffect(() => {
    const id = setTimeout(() => {
      if (activeTab === "schedules") fetchSchedules();
      else fetchEntries();
    }, 0);
    return () => clearTimeout(id);
  }, [activeTab, companyId]);

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

  const handleCreateEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/assets/entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ ...entryForm, company_id: companyId }),
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
            onClick={() => { setShowEntryModal(true); setMessage(""); }}
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
                  <th className="px-6 py-4 font-medium">Method</th>
                  <th className="px-6 py-4 font-medium">Life (Yrs)</th>
                  <th className="px-6 py-4 font-medium">Salvage Value</th>
                  <th className="px-6 py-4 font-medium">Depreciation %</th>
                  <th className="px-6 py-4 font-medium">Start Date</th>
                  <th className="px-6 py-4 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-custom">
                {schedules.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-8">
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
                      <td className="px-6 py-4">{formatLabel(s.method)}</td>
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
                  <th className="px-6 py-4 font-medium">Date</th>
                  <th className="px-6 py-4 font-medium">Depreciation</th>
                  <th className="px-6 py-4 font-medium">Accumulated</th>
                  <th className="px-6 py-4 font-medium">Book Value</th>
                  <th className="px-6 py-4 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-custom">
                {entries.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-8">
                      <EmptyState
                        icon="ledger"
                        title="No depreciation entries found"
                        description="Log depreciation journal entries to calculate monthly asset write-offs."
                        action={{
                          label: "New Entry",
                          onClick: () => setShowEntryModal(true),
                          icon: "add",
                        }}
                      />
                    </td>
                  </tr>
                ) : (
                  entries.map((e) => (
                    <tr key={e.id} className="hover:bg-elevated transition-colors">
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
                <label className="block text-xs font-medium text-muted mb-1">Asset ID</label>
                <input type="text" required className="w-full bg-elevated border border-border-custom rounded-md px-4 py-2 text-foreground" value={schedForm.asset_id} onChange={(e) => setSchedForm({...schedForm, asset_id: e.target.value})} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Method</label>
                  <select className="w-full bg-elevated border border-border-custom rounded-md px-4 py-2 text-foreground" value={schedForm.method} onChange={(e) => setSchedForm({...schedForm, method: e.target.value})}>
                    <option value="straight_line">Straight Line</option>
                    <option value="reducing_balance">Reducing Balance</option>
                    <option value="written_down_value">Written Down Value</option>
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
                <label className="block text-xs font-medium text-muted mb-1">Schedule ID</label>
                <input type="text" required className="w-full bg-elevated border border-border-custom rounded-md px-4 py-2 text-foreground" value={entryForm.schedule_id} onChange={(e) => setEntryForm({...entryForm, schedule_id: e.target.value})} />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Asset ID</label>
                <input type="text" required className="w-full bg-elevated border border-border-custom rounded-md px-4 py-2 text-foreground" value={entryForm.asset_id} onChange={(e) => setEntryForm({...entryForm, asset_id: e.target.value})} />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Entry Date</label>
                <input type="date" required className="w-full bg-elevated border border-border-custom rounded-md px-4 py-2 text-foreground" value={entryForm.entry_date} onChange={(e) => setEntryForm({...entryForm, entry_date: e.target.value})} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Depreciation (₹)</label>
                  <input type="number" required className="w-full bg-elevated border border-border-custom rounded-md px-4 py-2 text-foreground" value={entryForm.depreciation_amount} onChange={(e) => setEntryForm({...entryForm, depreciation_amount: parseFloat(e.target.value)})} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Accumulated (₹)</label>
                  <input type="number" required className="w-full bg-elevated border border-border-custom rounded-md px-4 py-2 text-foreground" value={entryForm.accumulated_depreciation} onChange={(e) => setEntryForm({...entryForm, accumulated_depreciation: parseFloat(e.target.value)})} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Book Value (₹)</label>
                  <input type="number" required className="w-full bg-elevated border border-border-custom rounded-md px-4 py-2 text-foreground" value={entryForm.book_value} onChange={(e) => setEntryForm({...entryForm, book_value: parseFloat(e.target.value)})} />
                </div>
              </div>
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
