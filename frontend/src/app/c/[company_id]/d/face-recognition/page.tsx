"use client";
import Badge from "@/components/ui/Badge";
import { getApiHost } from "@/lib/api";
import { authHeaders, todayLocalISO } from "@/lib/siteflow";
import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useProject } from "@/context/ProjectContext";
import { useParams } from "next/navigation";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import SegmentedTabs from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";

// Face punches come from the site's face-scan terminal. The terminal matches
// the face itself and sends each punch to SiteFlow, where it also counts for
// attendance and payroll. Terminals are added under Biometric Devices.

interface FacePunch {
  id: string;
  punch_time: string;
  employee_id?: string | null;
  employee_name?: string | null;
  employee_code?: string | null;
  device_pin: string;
  device_name: string;
  site_name: string;
}

interface DailySummary {
  attendance_date: string;
  employee_id: string;
  employee_name: string;
  employee_code?: string | null;
  first_punch: string;
  last_punch?: string | null;
  punches: number;
  site_name: string;
}

type View = "logs" | "summary";

export default function FaceRecognitionPage() {
  const params = useParams();
  const companyId = params?.company_id as string;
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;

  const [logs, setLogs] = useState<FacePunch[]>([]);
  const [summary, setSummary] = useState<DailySummary[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [selectedDate, setSelectedDate] = useState(todayLocalISO());
  const [view, setView] = useState<View>("logs");

  const fetchLogs = useCallback(async () => {
    try {
      const url = `${getApiHost()}/apis/v3/face/logs/${companyId}${projectId ? `?project_id=${projectId}` : ""}`;
      const res = await fetch(url, { headers: authHeaders() });
      if (res.ok) {
        setLogs(await res.json());
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    } catch (e) {
      console.error("Failed to load face punches", e);
      setLoadError(true);
    } finally {
      setLoaded(true);
    }
  }, [companyId, projectId]);

  const fetchSummary = useCallback(async () => {
    try {
      const url = `${getApiHost()}/apis/v3/face/summary/${companyId}?date=${selectedDate}${projectId ? `&project_id=${projectId}` : ""}`;
      const res = await fetch(url, { headers: authHeaders() });
      if (res.ok) {
        setSummary(await res.json());
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    } catch (e) {
      console.error("Failed to load the day's face punches", e);
      setLoadError(true);
    }
  }, [companyId, projectId, selectedDate]);

  useEffect(() => {
    const id = setTimeout(() => { fetchLogs(); }, 0);
    return () => clearTimeout(id);
  }, [fetchLogs]);

  useEffect(() => {
    const id = setTimeout(() => { if (view === "summary") fetchSummary(); }, 0);
    return () => clearTimeout(id);
  }, [view, fetchSummary]);

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });

  const howItWorks = (
    <>
      Face punches come from the face-scan terminal at the site. Add the terminal under{" "}
      <Link href={`/c/${companyId}/d/biometric`} className="text-primary underline">Biometric Devices</Link>{" "}
      and link each person to their terminal ID on the same page. Every punch also counts for attendance and payroll.
    </>
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader title="Face Attendance" subtitle="Punches checked by face at the site's terminal">
        <div className="flex items-center gap-2">
          <SegmentedTabs
            tabs={[
              { id: "logs", label: "All Face Punches" },
              { id: "summary", label: "By Day" },
            ]}
            activeTab={view}
            onChange={(t) => setView(t as View)}
          />
          <button
            onClick={() => (view === "logs" ? fetchLogs() : fetchSummary())}
            className="px-3.5 py-1.5 bg-card border border-border-custom hover:bg-elevated text-foreground rounded-md text-xs font-semibold transition-all cursor-pointer"
          >
            Refresh
          </button>
        </div>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">
          <p className="text-xs text-muted mb-4">{howItWorks}</p>

          {view === "logs" && (
            <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
              {loadError ? (
                <div className="px-6 py-8 text-center text-muted">Could not load face punches. Try Refresh.</div>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="bg-elevated/40 text-muted">
                    <tr>
                      <th className="px-6 py-4 font-medium">Time</th>
                      <th className="px-6 py-4 font-medium">Person</th>
                      <th className="px-6 py-4 font-medium">Site</th>
                      <th className="px-6 py-4 font-medium">Terminal</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-custom">
                    {logs.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="p-8">
                          <EmptyState
                            title={loaded ? "No face punches yet" : "Loading..."}
                            description={loaded ? "Punches will show here once a face terminal at the site starts sending them." : ""}
                          />
                        </td>
                      </tr>
                    ) : (
                      logs.map((log) => (
                        <tr key={log.id} className="hover:bg-elevated transition-colors">
                          <td className="px-6 py-4 whitespace-nowrap">{fmtTime(log.punch_time)}</td>
                          <td className="px-6 py-4">
                            {log.employee_name ? (
                              <>
                                {log.employee_name}
                                {log.employee_code && <span className="text-muted text-xs"> ({log.employee_code})</span>}
                              </>
                            ) : (
                              <Badge tone="warning">Not linked: terminal ID {log.device_pin}</Badge>
                            )}
                          </td>
                          <td className="px-6 py-4">{log.site_name}</td>
                          <td className="px-6 py-4">{log.device_name}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {view === "summary" && (
            <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
              <div className="p-4 border-b border-border-custom flex items-center gap-3">
                <label className="text-xs font-medium text-muted">Date</label>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="bg-elevated border border-border-custom rounded-md px-4 py-2 text-foreground text-sm"
                />
              </div>
              {loadError ? (
                <div className="px-6 py-8 text-center text-muted">Could not load the day&apos;s face punches. Try Refresh.</div>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="bg-elevated/40 text-muted">
                    <tr>
                      <th className="px-6 py-4 font-medium">Person</th>
                      <th className="px-6 py-4 font-medium">Site</th>
                      <th className="px-6 py-4 font-medium">First Punch</th>
                      <th className="px-6 py-4 font-medium">Last Punch</th>
                      <th className="px-6 py-4 font-medium">Punches</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-custom">
                    {summary.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="p-8">
                          <EmptyState title="No face punches on this day" description="Pick another date." />
                        </td>
                      </tr>
                    ) : (
                      summary.map((s) => (
                        <tr key={s.employee_id} className="hover:bg-elevated transition-colors">
                          <td className="px-6 py-4 font-medium">
                            {s.employee_name}
                            {s.employee_code && <span className="text-muted text-xs font-normal"> ({s.employee_code})</span>}
                          </td>
                          <td className="px-6 py-4">{s.site_name}</td>
                          <td className="px-6 py-4">{s.first_punch}</td>
                          <td className="px-6 py-4">
                            {s.last_punch || <span className="text-warning">Only one punch</span>}
                          </td>
                          <td className="px-6 py-4">{s.punches}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </PageShell>
      </div>
    </div>
  );
}
