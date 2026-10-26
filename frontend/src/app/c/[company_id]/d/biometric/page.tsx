"use client";
import React, { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Badge from "@/components/ui/Badge";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import SegmentedTabs from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import { getApiHost, readErrorDetail } from "@/lib/api";
import { authHeaders, formatDateTime } from "@/lib/siteflow";

interface Device {
  id: string;
  project_id: string;
  serial_number: string;
  name: string;
  last_seen_at?: string | null;
}
interface EmployeePin {
  id: string;
  name: string;
  employee_code?: string | null;
  designation?: string | null;
  biometric_pin?: string | null;
}
interface Punch {
  id: string;
  device_name: string;
  device_pin: string;
  punch_time: string;
  verify_mode?: string | null;
  employee_id?: string | null;
  employee_name?: string | null;
}
interface Project { id: string; name: string }

const ONLINE_WINDOW_MS = 10 * 60 * 1000;

export default function BiometricDevicesPage() {
  const params = useParams();
  const companyId = params?.company_id as string;
  const api = `${getApiHost()}/apis/v3/biometric`;

  const [view, setView] = useState<"devices" | "employees" | "punches">("devices");
  const [devices, setDevices] = useState<Device[]>([]);
  const [employees, setEmployees] = useState<EmployeePin[]>([]);
  const [punches, setPunches] = useState<Punch[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [pinDrafts, setPinDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ serial_number: "", name: "", project_id: "" });
  const [saving, setSaving] = useState(false);
  const [loadedAt, setLoadedAt] = useState(0);

  const projectName = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p.name])), [projects]);
  const unmatchedCount = punches.filter((p) => !p.employee_id).length;

  const load = async () => {
    try {
      const [d, e, p, pr] = await Promise.all([
        fetch(`${api}/devices/${companyId}`, { headers: authHeaders() }),
        fetch(`${api}/employees/${companyId}`, { headers: authHeaders() }),
        fetch(`${api}/punches/${companyId}?limit=300`, { headers: authHeaders() }),
        fetch(`${getApiHost()}/apis/v3/planning/projects?company_id=${companyId}`, { headers: authHeaders() }),
      ]);
      if (!d.ok || !e.ok || !p.ok) throw new Error("load");
      setDevices(await d.json());
      const emps: EmployeePin[] = await e.json();
      setEmployees(emps);
      setPinDrafts(Object.fromEntries(emps.map((x) => [x.id, x.biometric_pin || ""])));
      setPunches(await p.json());
      if (pr.ok) setProjects(await pr.json());
      setLoadedAt(Date.now());
      setError("");
    } catch {
      setError("Could not load biometric data. Check your connection and try Refresh.");
    }
  };

  useEffect(() => {
    const id = setTimeout(() => {
      if (companyId) load();
    }, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(""), 4000);
  };

  const registerDevice = async () => {
    if (!form.serial_number.trim() || !form.name.trim() || !form.project_id) {
      setError("Enter the serial number, a name and the site for the device.");
      return;
    }
    setSaving(true);
    const res = await fetch(`${api}/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      body: JSON.stringify({ company_id: companyId, ...form }),
    });
    setSaving(false);
    if (!res.ok) {
      setError(await readErrorDetail(res));
      return;
    }
    setForm({ serial_number: "", name: "", project_id: "" });
    flash("Device registered. Point it at this server and it will appear online within a minute.");
    load();
  };

  const removeDevice = async (d: Device) => {
    if (!confirm(`Remove ${d.name}? Its punches already recorded are deleted with it; attendance already marked stays.`)) return;
    const res = await fetch(`${api}/devices/${d.id}`, { method: "DELETE", headers: authHeaders() });
    if (!res.ok) setError(await readErrorDetail(res));
    load();
  };

  const savePin = async (emp: EmployeePin) => {
    const res = await fetch(`${api}/employees/${emp.id}/pin`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      body: JSON.stringify({ biometric_pin: pinDrafts[emp.id] || null }),
    });
    if (!res.ok) {
      setError(await readErrorDetail(res));
      return;
    }
    flash(`Saved device user ID for ${emp.name}. Any punches already made with it now count.`);
    load();
  };

  const host = getApiHost().replace(/^https?:\/\//, "").replace(/\/$/, "");

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader title="Biometric Devices" subtitle="Fingerprint and face machines at site gates, feeding attendance and payroll">
        <div className="flex items-center gap-2">
          <SegmentedTabs
            tabs={[
              { id: "devices", label: "Devices" },
              { id: "employees", label: "Employee IDs" },
              { id: "punches", label: unmatchedCount ? `Punches (${unmatchedCount} unmatched)` : "Punches" },
            ]}
            activeTab={view}
            onChange={(t) => setView(t as typeof view)}
          />
          <button onClick={load} className="px-3.5 py-1.5 bg-card border border-border-custom hover:bg-elevated text-foreground rounded-md text-xs font-semibold cursor-pointer">
            Refresh
          </button>
        </div>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">
          {error && <div className="mb-4 px-4 py-3 rounded-md border border-danger/40 bg-danger/10 text-danger text-sm">{error}</div>}
          {notice && <div className="mb-4 px-4 py-3 rounded-md border border-success/40 bg-success/10 text-success text-sm">{notice}</div>}

          {view === "devices" && (
            <div className="space-y-6">
              <div className="bg-card border border-border-custom rounded-lg p-5">
                <h3 className="text-sm font-semibold text-foreground mb-1">Connect a machine</h3>
                <p className="text-xs text-muted mb-4">
                  Works with eSSL and ZKTeco machines that have a Cloud Server (ADMS) option. On the machine open
                  Comm, then Cloud Server Setting, and enter server address <span className="font-mono text-foreground">{host}</span>,
                  port <span className="font-mono text-foreground">443</span>, with HTTPS on. Then register its serial number below.
                  The serial number is on the machine label and under System Info.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <input value={form.serial_number} onChange={(e) => setForm({ ...form, serial_number: e.target.value })}
                    placeholder="Serial number" className="px-3 py-2 bg-elevated border border-border-custom rounded-md text-sm text-foreground" />
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Name, e.g. Tower A gate" className="px-3 py-2 bg-elevated border border-border-custom rounded-md text-sm text-foreground" />
                  <select value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })}
                    className="px-3 py-2 bg-elevated border border-border-custom rounded-md text-sm text-foreground">
                    <option value="">Site</option>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <button onClick={registerDevice} disabled={saving}
                    className="px-4 py-2 bg-primary text-white rounded-md text-sm font-semibold disabled:opacity-50 cursor-pointer">
                    {saving ? "Registering..." : "Register Device"}
                  </button>
                </div>
              </div>

              <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
                {devices.length === 0 ? (
                  <div className="p-8"><EmptyState title="No machines registered" description="Register a machine above. Punches from unregistered machines are refused." /></div>
                ) : (
                  <table className="w-full text-left text-sm">
                    <thead className="bg-elevated/40 text-muted">
                      <tr>
                        <th className="px-6 py-3 font-medium">Name</th>
                        <th className="px-6 py-3 font-medium">Serial</th>
                        <th className="px-6 py-3 font-medium">Site</th>
                        <th className="px-6 py-3 font-medium">Status</th>
                        <th className="px-6 py-3 font-medium">Last contact</th>
                        <th className="px-6 py-3" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-custom">
                      {devices.map((d) => {
                        const online = d.last_seen_at && loadedAt - new Date(d.last_seen_at).getTime() < ONLINE_WINDOW_MS;
                        return (
                          <tr key={d.id}>
                            <td className="px-6 py-3 text-foreground font-medium">{d.name}</td>
                            <td className="px-6 py-3 font-mono text-xs">{d.serial_number}</td>
                            <td className="px-6 py-3">{projectName[d.project_id] || "—"}</td>
                            <td className="px-6 py-3">
                              <Badge tone={online ? "success" : d.last_seen_at ? "warning" : "neutral"}>
                                {online ? "Online" : d.last_seen_at ? "Offline" : "Never connected"}
                              </Badge>
                            </td>
                            <td className="px-6 py-3 text-muted">{d.last_seen_at ? formatDateTime(d.last_seen_at) : "—"}</td>
                            <td className="px-6 py-3 text-right">
                              <button onClick={() => removeDevice(d)} className="text-xs text-danger hover:underline cursor-pointer">Remove</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {view === "employees" && (
            <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
              <p className="px-6 pt-4 text-xs text-muted">
                Enter the user ID each person was enrolled with on the machine. Punches are matched to people by this ID.
              </p>
              {employees.length === 0 ? (
                <div className="p-8"><EmptyState title="No employees yet" description="Add staff under Attendance & Payroll first." /></div>
              ) : (
                <table className="w-full text-left text-sm mt-2">
                  <thead className="bg-elevated/40 text-muted">
                    <tr>
                      <th className="px-6 py-3 font-medium">Employee</th>
                      <th className="px-6 py-3 font-medium">Code</th>
                      <th className="px-6 py-3 font-medium">Designation</th>
                      <th className="px-6 py-3 font-medium">Machine user ID</th>
                      <th className="px-6 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-custom">
                    {employees.map((e) => {
                      const changed = (pinDrafts[e.id] || "") !== (e.biometric_pin || "");
                      return (
                        <tr key={e.id}>
                          <td className="px-6 py-3 text-foreground font-medium">{e.name}</td>
                          <td className="px-6 py-3 text-muted">{e.employee_code || "—"}</td>
                          <td className="px-6 py-3 text-muted">{e.designation || "—"}</td>
                          <td className="px-6 py-3">
                            <input value={pinDrafts[e.id] || ""} onChange={(ev) => setPinDrafts({ ...pinDrafts, [e.id]: ev.target.value })}
                              placeholder="Not set" className="w-28 px-2 py-1 bg-elevated border border-border-custom rounded text-sm font-mono text-foreground" />
                          </td>
                          <td className="px-6 py-3 text-right">
                            <button onClick={() => savePin(e)} disabled={!changed}
                              className="px-3 py-1 bg-primary text-white rounded text-xs font-semibold disabled:opacity-30 cursor-pointer">Save</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {view === "punches" && (
            <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
              {punches.length === 0 ? (
                <div className="p-8"><EmptyState title="No punches yet" description="Punches appear here the moment a registered machine sends them." /></div>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="bg-elevated/40 text-muted">
                    <tr>
                      <th className="px-6 py-3 font-medium">Time</th>
                      <th className="px-6 py-3 font-medium">Machine</th>
                      <th className="px-6 py-3 font-medium">User ID</th>
                      <th className="px-6 py-3 font-medium">Employee</th>
                      <th className="px-6 py-3 font-medium">Method</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-custom">
                    {punches.map((p) => (
                      <tr key={p.id}>
                        <td className="px-6 py-3 text-foreground">{formatDateTime(p.punch_time)}</td>
                        <td className="px-6 py-3">{p.device_name}</td>
                        <td className="px-6 py-3 font-mono text-xs">{p.device_pin}</td>
                        <td className="px-6 py-3">
                          {p.employee_name || <Badge tone="warning">Not matched. Set this ID under Employee IDs</Badge>}
                        </td>
                        <td className="px-6 py-3 text-muted">{p.verify_mode || "—"}</td>
                      </tr>
                    ))}
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
