"use client";
import Badge, { type BadgeTone } from "@/components/ui/Badge";
import { getApiHost } from "@/lib/api";
import { authHeaders, todayLocalISO } from "@/lib/siteflow";
import React, { useState, useEffect } from "react";
import { useProject } from "@/context/ProjectContext";
import { useParams } from "next/navigation";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import SegmentedTabs from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";

interface FaceLog {
  id: string;
  employee_id: string;
  punch_type: string;
  face_verified: boolean;
  confidence_score?: number;
  image_url?: string;
  lat?: number;
  lng?: number;
  is_within_geofence: boolean;
  created_at: string;
}

interface DailySummary {
  attendance_date: string;
  employee_id: string;
  employee_name: string;
  punch_in?: string;
  punch_out?: string;
  confidence_in?: number;
  confidence_out?: number;
  is_within_geofence_in: boolean;
  is_within_geofence_out: boolean;
}

export default function FaceRecognitionPage() {
  const params = useParams();
  const companyId = params?.company_id as string;
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;

  const [logs, setLogs] = useState<FaceLog[]>([]);
  const [summary, setSummary] = useState<DailySummary[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [selectedDate, setSelectedDate] = useState(todayLocalISO());
  const [view, setView] = useState<"logs" | "summary">("logs");

  const fetchLogs = async () => {
    try {
      const url = projectId
        ? `${getApiHost()}/apis/v3/face/logs/${companyId}?project_id=${projectId}`
        : `${getApiHost()}/apis/v3/face/logs/${companyId}`;
      const res = await fetch(url, { headers: authHeaders() });
      if (res.ok) {
        setLogs(await res.json());
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    } catch (e) {
      console.error("Failed to load face logs", e);
      setLoadError(true);
    }
  };

  const fetchSummary = async () => {
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
      console.error("Failed to load summary", e);
      setLoadError(true);
    }
  };

  useEffect(() => {
    const id = setTimeout(() => {
      fetchLogs();
    }, 0);
    return () => clearTimeout(id);
  }, [companyId, projectId]);

  useEffect(() => {
    const id = setTimeout(() => {
      if (view === "summary") fetchSummary();
    }, 0);
    return () => clearTimeout(id);
  }, [view, selectedDate]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title="Face Recognition Attendance"
        subtitle="Face verification audit trail for attendance punches"
      >
        <div className="flex items-center gap-2">
          <SegmentedTabs
            tabs={[
              { id: "logs", label: "Audit Logs" },
              { id: "summary", label: "Daily Summary" },
            ]}
            activeTab={view}
            onChange={(t) => setView(t as any)}
          />
          <button onClick={fetchLogs} className="px-3.5 py-1.5 bg-card border border-border-custom hover:bg-elevated text-foreground rounded-md text-xs font-semibold transition-all cursor-pointer">
            Refresh
          </button>
        </div>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">

        {view === "logs" && (
          <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
            {loadError ? (
              <div className="px-6 py-8 text-center text-muted">Failed to load face recognition data. The server returned an error.</div>
            ) : (
            <table className="w-full text-left text-sm">
              <thead className="bg-elevated/40 text-muted">
                <tr>
                  <th className="px-6 py-4 font-medium">Time</th>
                  <th className="px-6 py-4 font-medium">Employee</th>
                  <th className="px-6 py-4 font-medium">Type</th>
                  <th className="px-6 py-4 font-medium">Verified</th>
                  <th className="px-6 py-4 font-medium">Confidence</th>
                  <th className="px-6 py-4 font-medium">Location</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-custom">
                {logs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-8">
                      <EmptyState
                        title="No face recognition logs found"
                        description="Audit logs will appear as biometric punches are captured."
                      />
                    </td>
                  </tr>
                ) : (
                  logs.map((log) => (
                    <tr key={log.id} className="hover:bg-elevated transition-colors">
                      <td className="px-6 py-4">{new Date(log.created_at).toLocaleString("en-IN")}</td>
                      <td className="px-6 py-4">{log.employee_id.slice(0, 8)}...</td>
                      <td className="px-6 py-4 capitalize">{log.punch_type}</td>
                      <td className="px-6 py-4">
                        <Badge tone={log.face_verified ? "success" : "danger"}>{log.face_verified ? "Verified" : "Failed"}</Badge>
                      </td>
                      <td className="px-6 py-4">{log.confidence_score ? `${Number(log.confidence_score).toFixed(1)}%` : "-"}</td>
                      <td className="px-6 py-4">
                        {log.is_within_geofence ? (
                          <span className="text-success">Within Geofence</span>
                        ) : (
                          <span className="text-danger">Off-site</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            )}
          </div>
        )}

        {view === "summary" && (
          <div className="bg-white/5 border border-border-custom rounded-lg overflow-hidden">
            <div className="p-4 border-b border-border-custom flex items-center gap-3">
              <label className="text-xs font-medium text-muted">Date</label>
              <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className="bg-white/5 border border-border-custom rounded-md px-4 py-2 text-foreground text-sm" />
            </div>
            {loadError ? (
              <div className="px-6 py-8 text-center text-muted">Failed to load face recognition data. The server returned an error.</div>
            ) : (
            <table className="w-full text-left text-sm">
              <thead className="bg-white/5 text-muted">
                <tr>
                  <th className="px-6 py-4 font-medium">Employee</th>
                  <th className="px-6 py-4 font-medium">Punch In</th>
                  <th className="px-6 py-4 font-medium">Punch Out</th>
                  <th className="px-6 py-4 font-medium">Confidence In</th>
                  <th className="px-6 py-4 font-medium">Confidence Out</th>
                  <th className="px-6 py-4 font-medium">Geofence</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-custom">
                {summary.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-8">
                      <EmptyState
                        title="No attendance records for this date"
                        description="Select a different date or punch in to record face attendance."
                      />
                    </td>
                  </tr>
                ) : (
                  summary.map((s) => (
                    <tr key={s.employee_id} className="hover:bg-elevated transition-colors">
                      <td className="px-6 py-4 font-medium">{s.employee_name}</td>
                      <td className="px-6 py-4">{s.punch_in || "-"}</td>
                      <td className="px-6 py-4">{s.punch_out || "-"}</td>
                      <td className="px-6 py-4">{s.confidence_in ? `${s.confidence_in.toFixed(1)}%` : "-"}</td>
                      <td className="px-6 py-4">{s.confidence_out ? `${s.confidence_out.toFixed(1)}%` : "-"}</td>
                      <td className="px-6 py-4">
                        {s.punch_in && !s.punch_out ? (
                          <span className="text-warning">In Progress</span>
                        ) : s.punch_out ? (
                          <span className="text-success">Complete</span>
                        ) : (
                          <span className="text-danger">Missing</span>
                        )}
                      </td>
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
