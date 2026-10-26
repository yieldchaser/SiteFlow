'use client';
import { useProject } from '@/context/ProjectContext';
import { getApiHost, readErrorDetail } from '@/lib/api';
import { authHeaders, formatDate, todayLocalISO, nowLocalISO, localInputToInstantISO } from '@/lib/siteflow';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Icon, { type IconName } from '@/components/marketing/Icon';
import PageShell from '@/components/layout/PageShell';
import PageHeader from '@/components/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton, CardSkeleton } from '@/components/ui/Skeleton';
import SegmentedTabs from '@/components/ui/Tabs';
import { Badge, type BadgeTone } from '@/components/ui/Badge';

const API = `${getApiHost()}/apis/v3`;

// ─── Types ────────────────────────────────────────────────────────────────────
interface Incident {
  id: string;
  incident_type: string;
  severity: string;
  description: string;
  location?: string;
  injured_person?: string;
  lost_time_days: number;
  status: string;
  root_cause?: string;
  corrective_action?: string;
  reported_by: string;
  reported_at: string;
  closed_at?: string;
}

interface SafetyStats {
  total_incidents: number;
  open_incidents: number;
  closed_incidents: number;
  lti_count: number;
  total_lost_days: number;
  ltif: number;
  ltif_basis?: number;
  total_manhours_used?: number;
  type_breakdown: Record<string, number>;
  severity_breakdown: Record<string, number>;
  manhours_source?: "attendance" | "dpr" | "fallback";
}

interface ToolboxTalk {
  id: string;
  topic: string;
  conducted_by: string;
  conducted_at: string;
  attendee_count: number;
  notes?: string;
}

interface PPECheck {
  id: string;
  checked_by: string;
  check_date: string;
  total_workers: number;
  compliant_workers: number;
  compliance_pct: number;
  non_compliant_items: string[];
}

function getIncidentTypeTone(type?: string): BadgeTone {
  const norm = (type || "").trim().toLowerCase();
  if (norm === "fatal" || norm === "fatality") return "danger";
  if (norm === "lti" || norm === "lost time injury" || norm === "lost time") return "warning";
  if (norm === "first aid" || norm === "firstaid") return "info";
  if (norm === "near miss" || norm === "nearmiss") return "primary";
  return "neutral";
}

function getSeverityTone(sev?: string): BadgeTone {
  const norm = (sev || "").trim().toLowerCase();
  if (norm === "critical") return "danger";
  if (norm === "high") return "warning";
  if (norm === "medium") return "info";
  if (norm === "low") return "success";
  return "neutral";
}

function getIncidentTypeColor(type?: string): string {
  const norm = (type || "").trim().toLowerCase();
  if (norm === "fatal" || norm === "fatality") return "var(--danger)";
  if (norm === "lti" || norm === "lost time injury") return "var(--warning)";
  if (norm === "first aid" || norm === "firstaid") return "var(--info)";
  if (norm === "near miss" || norm === "nearmiss") return "var(--primary)";
  return "var(--muted)";
}

function getSeverityColor(sev?: string): string {
  const norm = (sev || "").trim().toLowerCase();
  if (norm === "critical") return "var(--danger)";
  if (norm === "high") return "var(--warning)";
  if (norm === "medium") return "var(--chart-3)";
  if (norm === "low") return "var(--success)";
  return "var(--muted)";
}

function fmtDate(iso?: string) {
  return formatDate(iso);
}

// ─── Donut Chart ─────────────────────────────────────────────────────────────
function DonutGauge({ pct }: { pct: number }) {
  const r = 54;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  const color = pct >= 90 ? 'var(--success)' : pct >= 70 ? 'var(--warning)' : 'var(--danger)';
  return (
    <svg width={140} height={140} viewBox="0 0 140 140">
      <circle cx={70} cy={70} r={r} fill="none" stroke="var(--border)" strokeWidth={16} />
      <circle
        cx={70} cy={70} r={r} fill="none" stroke={color} strokeWidth={16}
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        transform="rotate(-90 70 70)" style={{ transition: 'stroke-dasharray 0.8s ease' }}
      />
      <text x={70} y={66} textAnchor="middle" fill="var(--foreground)" fontSize={22} fontWeight={700}>{pct}%</text>
      <text x={70} y={84} textAnchor="middle" fill="var(--muted)" fontSize={11}>Compliant</text>
    </svg>
  );
}

// ─── Simple Bar ───────────────────────────────────────────────────────────────
function MiniBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="mb-2.5">
      <div className="flex justify-between mb-1">
        <span className="text-muted text-xs">{label}</span>
        <span className="text-foreground text-xs font-semibold">{value}</span>
      </div>
      <div className="h-2 rounded-full bg-border-custom overflow-hidden">
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 9999, transition: 'width 0.6s ease' }} />
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function SafetyPage() {
  const { company_id } = useParams() as { company_id: string };
  const { activeProjectId } = useProject();
  const project_id = activeProjectId;
  const [tab, setTab] = useState(0);

  // Data
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [stats, setStats] = useState<SafetyStats | null>(null);
  const [talks, setTalks] = useState<ToolboxTalk[]>([]);
  const [ppeChecks, setPpeChecks] = useState<PPECheck[]>([]);
  const [loading, setLoading] = useState(false);

  // Modals
  const [showIncidentModal, setShowIncidentModal] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState<string | null>(null);
  const [showTalkModal, setShowTalkModal] = useState(false);
  const [showPPEModal, setShowPPEModal] = useState(false);

  // Forms
  const [incidentForm, setIncidentForm] = useState({
    incident_type: 'Near Miss', severity: 'Low', description: '',
    location: '', injured_person: '', lost_time_days: 0, reported_by: '',
    reported_at: nowLocalISO(),
  });
  const [closeForm, setCloseForm] = useState({ root_cause: '', corrective_action: '' });
  const [talkForm, setTalkForm] = useState({
    topic: '', conducted_by: '', conducted_at: nowLocalISO(),
    attendee_count: 0, notes: '',
  });
  const [ppeForm, setPpeForm] = useState({
    checked_by: '', check_date: todayLocalISO(),
    total_workers: 0, compliant_workers: 0, non_compliant_items: '',
  });

  const [msg, setMsg] = useState('');

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  // Fetch all data
  const fetchAll = async () => {
    setLoading(true);
    try {
      const [incR, statsR, talkR, ppeR] = await Promise.all([
        fetch(`${API}/safety/incidents/${project_id}`, { headers: authHeaders() }),
        fetch(`${API}/safety/stats/${project_id}?total_manhours=50000`, { headers: authHeaders() }),
        fetch(`${API}/safety/toolbox-talks/${project_id}`, { headers: authHeaders() }),
        fetch(`${API}/safety/ppe-checks/${project_id}`, { headers: authHeaders() }),
      ]);
      const incData = incR.ok ? await incR.json() : [];
      const statsData = statsR.ok ? await statsR.json() : null;
      const talkData = talkR.ok ? await talkR.json() : [];
      const ppeData = ppeR.ok ? await ppeR.json() : [];
      setIncidents(incData);
      setStats(statsData);
      setTalks(talkData);
      setPpeChecks(ppeData);
    } catch {
      // Do not substitute fabricated records on failure; keep prior/empty state.
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchAll(); }, [project_id]);

  // Submit incident
  const submitIncident = async () => {
    const r = await fetch(`${API}/safety/incidents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(authHeaders() || {}) },
      // reported_at is held as a datetime-local value for the input to display.
      // It must go on the wire as an absolute instant: the backend attaches the
      // SERVER timezone to a naive datetime, so an IST wall-clock time arrived
      // as UTC and every incident was rejected as being in the future.
      body: JSON.stringify({
        ...incidentForm,
        reported_at: localInputToInstantISO(incidentForm.reported_at),
        project_id,
      }),
    });
    if (r.ok) { flash('Incident reported.'); setShowIncidentModal(false); fetchAll(); }
    else flash(`Error: ${await readErrorDetail(r)}`);
  };

  // Close incident
  const submitClose = async () => {
    if (!showCloseModal) return;
    const r = await fetch(`${API}/safety/incidents/${showCloseModal}/close`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(authHeaders() || {}) },
      body: JSON.stringify(closeForm),
    });
    if (r.ok) { flash('Incident closed.'); setShowCloseModal(null); fetchAll(); }
    else flash(`Error: ${await readErrorDetail(r)}`);
  };

  // Submit toolbox talk
  const submitTalk = async () => {
    const r = await fetch(`${API}/safety/toolbox-talks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(authHeaders() || {}) },
      // Same instant conversion as the incident form. Toolbox talks have no
      // not-future validator, so the naive local value saved successfully but
      // stored a time offset by the server-to-local difference.
      body: JSON.stringify({
        ...talkForm,
        conducted_at: localInputToInstantISO(talkForm.conducted_at),
        project_id,
      }),
    });
    if (r.ok) { flash('Talk logged.'); setShowTalkModal(false); fetchAll(); }
    else flash(`Error: ${await readErrorDetail(r)}`);
  };

  // Submit PPE check
  const submitPPE = async () => {
    const items = ppeForm.non_compliant_items.split(',').map(s => s.trim()).filter(Boolean);
    const r = await fetch(`${API}/safety/ppe-checks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(authHeaders() || {}) },
      body: JSON.stringify({ ...ppeForm, project_id, non_compliant_items: items }),
    });
    if (r.ok) { flash('PPE check recorded.'); setShowPPEModal(false); fetchAll(); }
    else {
      const err = await readErrorDetail(r);
      flash(`Error: ${err}`);
    }
  };

  const handleDeleteTalk = async (talkId: string) => {
    if (!confirm('Are you sure you want to delete this toolbox talk?')) return;
    const r = await fetch(`${API}/safety/toolbox-talks/${talkId}`, {
      method: 'DELETE',
      headers: authHeaders() || {},
    });
    if (r.ok) {
      flash('Toolbox talk deleted.');
      fetchAll();
    } else {
      const err = await readErrorDetail(r);
      flash(`Error: ${err}`);
    }
  };

  const handleDeletePPE = async (checkId: string) => {
    if (!confirm('Are you sure you want to delete this PPE check?')) return;
    const r = await fetch(`${API}/safety/ppe-checks/${checkId}`, {
      method: 'DELETE',
      headers: authHeaders() || {},
    });
    if (r.ok) {
      flash('PPE check deleted.');
      fetchAll();
    } else {
      const err = await readErrorDetail(r);
      flash(`Error: ${err}`);
    }
  };

  // Overall compliance %
  const overallPPE = ppeChecks.length > 0
    ? Math.round(ppeChecks.reduce((a, c) => a + c.compliance_pct, 0) / ppeChecks.length)
    : 0;

  // ─── Tabs ──────────────────────────────────────────────────────────────────
  const tabs: { label: string; icon: IconName }[] = [
    { label: 'Incident Board', icon: 'siren' },
    { label: 'LTIF & Stats', icon: 'bar_chart' },
    { label: 'Toolbox Talks', icon: 'toolbox_talk' },
    { label: 'PPE Compliance', icon: 'safety_vest' },
  ];
  return (
    <div className="min-h-0 flex-1 flex flex-col overflow-hidden bg-background text-foreground font-sans">
      <PageHeader
        title="HSE / Safety Management"
        subtitle="Incident tracking, toolbox talks & PPE compliance"
        action={
          tab === 0 ? (
            <button
              onClick={() => setShowIncidentModal(true)}
              className="py-2 px-4 rounded-lg bg-danger text-white text-xs font-semibold hover:opacity-90 transition-opacity cursor-pointer flex items-center gap-1.5"
            >
              <Icon name="siren" className="w-3.5 h-3.5" />
              + Report Incident
            </button>
          ) : tab === 2 ? (
            <button
              onClick={() => setShowTalkModal(true)}
              className="py-2 px-4 rounded-lg bg-primary text-white text-xs font-semibold hover:bg-primary/90 transition-colors cursor-pointer flex items-center gap-1.5"
            >
              <Icon name="toolbox_talk" className="w-3.5 h-3.5" />
              + Add Talk
            </button>
          ) : null
        }
      />
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">

        {/* Flash */}
        {msg && (
          <div className="p-3 rounded-lg bg-primary/10 border border-primary/25 mb-5 text-sm text-primary">
            {msg}
          </div>
        )}

        {/* Tab Bar */}
        <div className="mb-6">
          <SegmentedTabs
            tabs={tabs.map((t, i) => ({
              id: i.toString(),
              label: t.label,
              icon: <Icon name={t.icon} className="w-4 h-4" />,
            }))}
            activeTab={tab.toString()}
            onChange={(t) => setTab(parseInt(t, 10))}
            className="w-full justify-start"
          />
        </div>

        {/* ─── Tab 0: Incident Board ────────────────────────────────────────── */}
        {tab === 0 && (
          <div>
            <div className="flex justify-between items-center mb-5">
              <h2 className="text-base font-semibold text-foreground">Incident Board</h2>
            </div>

            {loading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <CardSkeleton key={i} />
                ))}
              </div>
            ) : incidents.length === 0 ? (
              <EmptyState
                icon="siren"
                title="No incidents logged"
                description="Maintain safety compliance by reporting and tracking any site incident or near miss."
                action={{
                  label: "Report Incident",
                  onClick: () => setShowIncidentModal(true),
                  icon: "add",
                }}
              />
            ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {incidents.map((inc) => (
                <div
                  key={inc.id}
                  className="rounded-xl p-5 border border-border-custom bg-card"
                >
                  <div className="flex justify-between items-start mb-3">
                    <div className="flex gap-1.5 flex-wrap">
                      <Badge tone={getIncidentTypeTone(inc.incident_type)}>
                        {inc.incident_type}
                      </Badge>
                      <Badge tone={getSeverityTone(inc.severity)}>
                        {inc.severity}
                      </Badge>
                    </div>
                    <Badge tone={inc.status === "closed" ? "success" : "warning"}>
                      {inc.status.toUpperCase()}
                    </Badge>
                  </div>
                  <p className="text-sm leading-relaxed text-foreground mb-3">{inc.description}</p>
                  <div className="text-xs text-muted space-y-1">
                    {inc.location && (
                      <div className="inline-flex items-center gap-1.5 mr-3">
                        <Icon name="location_pin" className="w-3.5 h-3.5" />
                        {inc.location}
                      </div>
                    )}
                    {inc.injured_person && (
                      <div className="inline-flex items-center gap-1.5 mr-3">
                        <Icon name="hospital" className="w-3.5 h-3.5" />
                        {inc.injured_person}
                      </div>
                    )}
                    {inc.lost_time_days > 0 && (
                      <div className="inline-flex items-center gap-1.5 mr-3">
                        <Icon name="schedule" className="w-3.5 h-3.5" />
                        {inc.lost_time_days} lost day{inc.lost_time_days > 1 ? "s" : ""}
                      </div>
                    )}
                    <div className="inline-flex items-center gap-1.5">
                      <Icon name="person" className="w-3.5 h-3.5" />
                      {inc.reported_by} · {fmtDate(inc.reported_at)}
                    </div>
                  </div>
                  {inc.root_cause && (
                    <div className="mt-3 p-2.5 rounded-lg bg-elevated text-xs text-muted">
                      <strong className="text-foreground">Root Cause: </strong>
                      {inc.root_cause}
                    </div>
                  )}
                  {inc.status !== "closed" && (
                    <button
                      onClick={() => {
                        setShowCloseModal(inc.id);
                        setCloseForm({ root_cause: "", corrective_action: "" });
                      }}
                      className="mt-3 py-1.5 px-3.5 rounded-lg border border-success/40 bg-success/10 text-success text-xs font-semibold hover:bg-success/20 transition-colors inline-flex items-center gap-1.5"
                    >
                      <Icon name="check" className="w-3.5 h-3.5" />
                      Close Incident
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── Tab 1: LTIF & Stats ──────────────────────────────────────────── */}
      {tab === 1 && (
        <div>
          <h2 className="text-base font-semibold text-foreground mb-5">LTIF & Safety Statistics</h2>
          {!stats ? (
            loading ? <CardSkeleton /> : <EmptyState title="No safety data yet" description="Record safety statistics and incidents to view safety metrics." />
          ) : (
            <>
              {/* KPI Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
                {(
                  [
                    { label: "Total Incidents", value: stats.total_incidents, icon: "siren", color: "var(--danger)" },
                    { label: "Open", value: stats.open_incidents, icon: "warning", color: "var(--warning)" },
                    { label: "Closed", value: stats.closed_incidents, icon: "check_circle", color: "var(--success)" },
                    { label: "LTI Count", value: stats.lti_count, icon: "hospital", color: "var(--warning)" },
                    { label: "Lost Days", value: stats.total_lost_days, icon: "calendar", color: "var(--chart-4)" },
                    { label: "LTIFR", value: stats.ltif, icon: "trending_up", color: "var(--info)" },
                  ] as { label: string; value: number; icon: IconName; color: string }[]
                ).map((k, i) => (
                  <div key={i} className="p-4 rounded-xl bg-card border border-border-custom">
                    <div className="mb-2" style={{ color: k.color }}>
                      <Icon name={k.icon} className="w-5 h-5" />
                    </div>
                    <div className="text-2xl font-extrabold" style={{ color: k.color }}>
                      {k.value}
                    </div>
                    <div className="text-xs text-muted mt-1">{k.label}</div>
                  </div>
                ))}
              </div>

              {/* Type & Severity Breakdown */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="p-5 rounded-xl bg-card border border-border-custom">
                  <h3 className="text-xs font-bold text-muted uppercase tracking-wider mb-4">BY INCIDENT TYPE</h3>
                  {Object.entries(stats.type_breakdown).map(([type, count]) => (
                    <MiniBar
                      key={type}
                      label={type}
                      value={count}
                      max={stats.total_incidents}
                      color={getIncidentTypeColor(type)}
                    />
                  ))}
                  {Object.keys(stats.type_breakdown).length === 0 && (
                    <EmptyState title="No incident breakdown data yet" description="Incident category statistics will appear as safety events are logged." />
                  )}
                </div>
                <div className="p-5 rounded-xl bg-card border border-border-custom">
                  <h3 className="text-xs font-bold text-muted uppercase tracking-wider mb-4">BY SEVERITY</h3>
                  {Object.entries(stats.severity_breakdown).map(([sev, count]) => (
                    <MiniBar
                      key={sev}
                      label={sev}
                      value={count}
                      max={stats.total_incidents}
                      color={getSeverityColor(sev)}
                    />
                  ))}
                  {Object.keys(stats.severity_breakdown).length === 0 && (
                    <EmptyState title="No severity breakdown data yet" description="Severity statistics will populate as safety events are logged." />
                  )}
                </div>
              </div>

              {/* LTIF Formula */}
              <div className="mt-5 p-4 rounded-xl bg-primary/5 border border-primary/20 text-xs text-muted flex items-center gap-2">
                <Icon name="clipboard" className="w-4 h-4 text-primary shrink-0" />
                <span>
                  <strong className="text-primary">LTIFR Formula:</strong> (Number of LTIs ×{" "}
                  {stats.ltif_basis ? stats.ltif_basis.toLocaleString("en-IN") : "200,000"}) ÷ Total Manhours
                  Worked · Calculated on{" "}
                  {stats.total_manhours_used ? stats.total_manhours_used.toLocaleString("en-IN") : "50,000"} manhours
                  basis
                  {stats.manhours_source === "dpr"
                    ? " (from workers on the daily progress reports at 8 hours a day)"
                    : stats.manhours_source === "fallback"
                      ? " (estimated: no attendance or DPR labour recorded)"
                      : ""}.
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {/* ─── Tab 2: Toolbox Talks ─────────────────────────────────────────── */}
      {tab === 2 && (
        <div>
          <div className="flex justify-between items-center mb-5">
            <h2 className="text-base font-semibold text-foreground">Toolbox Talks & Briefings</h2>
          </div>
          {talks.length === 0 ? (
            loading ? (
              <CardSkeleton />
            ) : (
              <EmptyState
                icon="toolbox_talk"
                title="No toolbox talks recorded"
                description="Log daily safety briefings, hazard awareness sessions and attendee records."
                action={{
                  label: "Add Talk",
                  onClick: () => setShowTalkModal(true),
                  icon: "add",
                }}
              />
            )
          ) : (
            <div className="flex flex-col gap-3">
              {talks.map((t) => (
                <div
                  key={t.id}
                  className="p-4 rounded-xl bg-card border border-border-custom flex items-center gap-4"
                >
                  <div className="w-11 h-11 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center text-primary shrink-0">
                    <Icon name="toolbox_talk" className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm text-foreground mb-0.5">{t.topic}</div>
                    <div className="text-xs text-muted">
                      Conducted by {t.conducted_by} · {fmtDate(t.conducted_at)}
                    </div>
                    {t.notes && <div className="text-xs text-muted/80 mt-1">{t.notes}</div>}
                  </div>
                  <div className="text-center py-2 px-4 rounded-xl bg-primary/10 border border-primary/20 shrink-0">
                    <div className="text-xl font-extrabold text-primary">{t.attendee_count}</div>
                    <div className="text-[10px] text-muted uppercase tracking-wider">Attendees</div>
                  </div>
                  <button
                    onClick={() => handleDeleteTalk(t.id)}
                    className="p-2 rounded-lg text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                    title="Delete toolbox talk"
                  >
                    <Icon name="trash" className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── Tab 3: PPE Compliance ────────────────────────────────────────── */}
      {tab === 3 && (
        <div>
          <div className="flex justify-between items-center mb-5">
            <h2 className="text-base font-semibold text-foreground">PPE Compliance</h2>
            <button
              onClick={() => setShowPPEModal(true)}
              className="py-2 px-4 rounded-lg bg-info text-white text-xs font-semibold hover:opacity-90 transition-opacity"
            >
              + Record Check
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-6 items-start">
            {/* Donut */}
            <div className="p-6 rounded-2xl bg-card border border-border-custom text-center">
              {ppeChecks.length === 0 ? (
                <>
                  <div className="w-[140px] h-[140px] mx-auto flex items-center justify-center text-3xl font-extrabold text-muted">
                    —
                  </div>
                  <p className="mt-3 text-xs text-muted">
                    Overall Compliance
                    <br />
                    (no checks recorded yet)
                  </p>
                </>
              ) : (
                <>
                  <div className="flex justify-center">
                    <DonutGauge pct={overallPPE} />
                  </div>
                  <p className="mt-3 text-xs text-muted">
                    Overall Compliance
                    <br />
                    (average of all checks)
                  </p>
                </>
              )}
            </div>
            {/* Check list */}
            <div>
              {ppeChecks.length === 0 ? (
                <EmptyState
                  icon="safety_vest"
                  title="No PPE checks logged"
                  description="Audit on-site protective equipment compliance and worker gear."
                  action={{
                    label: "Record Check",
                    onClick: () => setShowPPEModal(true),
                    icon: "add",
                  }}
                />
              ) : (
                <div className="flex flex-col gap-3">
                  {ppeChecks.map((c) => {
                    const nc_color =
                      c.compliance_pct >= 90
                        ? "var(--success)"
                        : c.compliance_pct >= 70
                        ? "var(--warning)"
                        : "var(--danger)";
                    return (
                      <div
                        key={c.id}
                        className="p-4 rounded-xl bg-card border border-border-custom"
                      >
                        <div className="flex justify-between items-center mb-2">
                          <div>
                            <div className="font-semibold text-sm text-foreground">Checked by {c.checked_by}</div>
                            <div className="text-xs text-muted mt-0.5">
                              {fmtDate(c.check_date)} · {c.total_workers} workers
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="text-2xl font-extrabold" style={{ color: nc_color }}>
                              {c.compliance_pct}%
                            </div>
                            <button
                              onClick={() => handleDeletePPE(c.id)}
                              className="p-2 rounded-lg text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                              title="Delete PPE check"
                            >
                              <Icon name="trash" className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                        <div className="h-1.5 rounded-full bg-border-custom overflow-hidden mb-2">
                          <div
                            style={{
                              height: "100%",
                              width: `${c.compliance_pct}%`,
                              background: nc_color,
                              borderRadius: 9999,
                              transition: "width 0.6s ease",
                            }}
                          />
                        </div>
                        {c.non_compliant_items.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {c.non_compliant_items.map((item, i) => (
                              <Badge key={i} tone="danger">
                                {item}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─── Modal: Report Incident ───────────────────────────────────────── */}
      {showIncidentModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border-custom rounded-2xl p-6 w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-base font-bold text-foreground mb-4">Report Safety Incident</h3>
            <div className="space-y-3.5">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">Incident Type</label>
                <select
                  value={incidentForm.incident_type}
                  onChange={(e) => setIncidentForm({ ...incidentForm, incident_type: e.target.value })}
                  className="w-full bg-elevated border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                >
                  {["Near Miss", "First Aid", "LTI", "Fatal"].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">Severity</label>
                <select
                  value={incidentForm.severity}
                  onChange={(e) => setIncidentForm({ ...incidentForm, severity: e.target.value })}
                  className="w-full bg-elevated border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                >
                  {["Low", "Medium", "High", "Critical"].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">Description *</label>
                <textarea
                  value={incidentForm.description}
                  onChange={(e) => setIncidentForm({ ...incidentForm, description: e.target.value })}
                  className="w-full h-20 bg-elevated border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary resize-none"
                  placeholder="Describe the incident…"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">Location</label>
                  <input
                    value={incidentForm.location}
                    onChange={(e) => setIncidentForm({ ...incidentForm, location: e.target.value })}
                    className="w-full bg-elevated border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                    placeholder="Block A, 2nd Floor"
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">Injured Person</label>
                  <input
                    value={incidentForm.injured_person}
                    onChange={(e) => setIncidentForm({ ...incidentForm, injured_person: e.target.value })}
                    className="w-full bg-elevated border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                    placeholder="Name (if any)"
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">Lost Time Days</label>
                  <input
                    type="number"
                    min={0}
                    value={incidentForm.lost_time_days}
                    onChange={(e) => setIncidentForm({ ...incidentForm, lost_time_days: +e.target.value })}
                    className="w-full bg-elevated border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">Reported By *</label>
                  <input
                    value={incidentForm.reported_by}
                    onChange={(e) => setIncidentForm({ ...incidentForm, reported_by: e.target.value })}
                    className="w-full bg-elevated border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                    placeholder="Supervisor / HSE Officer"
                  />
                </div>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">Date & Time *</label>
                <input
                  type="datetime-local"
                  value={incidentForm.reported_at}
                  onChange={(e) => setIncidentForm({ ...incidentForm, reported_at: e.target.value })}
                  className="w-full bg-elevated border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                />
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-6 border-t border-border-custom pt-4">
              <button
                onClick={() => setShowIncidentModal(false)}
                className="py-2 px-4 rounded-lg border border-border-custom text-muted hover:text-foreground text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={submitIncident}
                className="py-2 px-5 rounded-lg bg-danger text-white font-semibold text-xs hover:opacity-90 transition-opacity"
              >
                Report
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Modal: Close Incident ────────────────────────────────────────── */}
      {showCloseModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border-custom rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h3 className="text-base font-bold text-foreground mb-4">Close Incident</h3>
            <div className="space-y-3.5">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">Root Cause *</label>
                <textarea
                  value={closeForm.root_cause}
                  onChange={(e) => setCloseForm({ ...closeForm, root_cause: e.target.value })}
                  className="w-full h-20 bg-elevated border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary resize-none"
                  placeholder="Identified root cause…"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">Corrective Action *</label>
                <textarea
                  value={closeForm.corrective_action}
                  onChange={(e) => setCloseForm({ ...closeForm, corrective_action: e.target.value })}
                  className="w-full h-20 bg-elevated border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary resize-none"
                  placeholder="Actions taken to prevent recurrence…"
                />
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-6 border-t border-border-custom pt-4">
              <button
                onClick={() => setShowCloseModal(null)}
                className="py-2 px-4 rounded-lg border border-border-custom text-muted hover:text-foreground text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={submitClose}
                className="py-2 px-5 rounded-lg bg-success text-white font-semibold text-xs hover:opacity-90 transition-opacity"
              >
                Close Incident
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Modal: Toolbox Talk ──────────────────────────────────────────── */}
      {showTalkModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border-custom rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h3 className="text-base font-bold text-foreground mb-4">Log Toolbox Talk</h3>
            <div className="space-y-3.5">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">Topic *</label>
                <input
                  value={talkForm.topic}
                  onChange={(e) => setTalkForm({ ...talkForm, topic: e.target.value })}
                  className="w-full bg-elevated border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                  placeholder="e.g. Working at Height: Scaffolding Safety"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">Conducted By *</label>
                  <input
                    value={talkForm.conducted_by}
                    onChange={(e) => setTalkForm({ ...talkForm, conducted_by: e.target.value })}
                    className="w-full bg-elevated border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                    placeholder="HSE Manager"
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">Attendees</label>
                  <input
                    type="number"
                    min={0}
                    value={talkForm.attendee_count}
                    onChange={(e) => setTalkForm({ ...talkForm, attendee_count: +e.target.value })}
                    className="w-full bg-elevated border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                  />
                </div>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">Date & Time *</label>
                <input
                  type="datetime-local"
                  value={talkForm.conducted_at}
                  onChange={(e) => setTalkForm({ ...talkForm, conducted_at: e.target.value })}
                  className="w-full bg-elevated border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">Notes</label>
                <textarea
                  value={talkForm.notes}
                  onChange={(e) => setTalkForm({ ...talkForm, notes: e.target.value })}
                  className="w-full h-16 bg-elevated border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary resize-none"
                  placeholder="Any additional notes…"
                />
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-6 border-t border-border-custom pt-4">
              <button
                onClick={() => setShowTalkModal(false)}
                className="py-2 px-4 rounded-lg border border-border-custom text-muted hover:text-foreground text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={submitTalk}
                className="py-2 px-5 rounded-lg bg-primary text-white font-semibold text-xs hover:opacity-90 transition-opacity"
              >
                Log Talk
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Modal: PPE Check ─────────────────────────────────────────────── */}
      {showPPEModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border-custom rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h3 className="text-base font-bold text-foreground mb-4">Record PPE Compliance Check</h3>
            <div className="space-y-3.5">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">Checked By *</label>
                <input
                  value={ppeForm.checked_by}
                  onChange={(e) => setPpeForm({ ...ppeForm, checked_by: e.target.value })}
                  className="w-full bg-elevated border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                  placeholder="Site Engineer / HSE Officer"
                />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">Check Date *</label>
                <input
                  type="date"
                  value={ppeForm.check_date}
                  onChange={(e) => setPpeForm({ ...ppeForm, check_date: e.target.value })}
                  className="w-full bg-elevated border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">Total Workers</label>
                  <input
                    type="number"
                    min={0}
                    value={ppeForm.total_workers}
                    onChange={(e) => setPpeForm({ ...ppeForm, total_workers: +e.target.value })}
                    className="w-full bg-elevated border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                  />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">Compliant Workers</label>
                  <input
                    type="number"
                    min={0}
                    value={ppeForm.compliant_workers}
                    onChange={(e) => setPpeForm({ ...ppeForm, compliant_workers: +e.target.value })}
                    className="w-full bg-elevated border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                  />
                </div>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">Non-Compliant Items (comma-separated)</label>
                <input
                  value={ppeForm.non_compliant_items}
                  onChange={(e) => setPpeForm({ ...ppeForm, non_compliant_items: e.target.value })}
                  className="w-full bg-elevated border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary"
                  placeholder="No helmet, No safety vest, No boots"
                />
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-6 border-t border-border-custom pt-4">
              <button
                onClick={() => setShowPPEModal(false)}
                className="py-2 px-4 rounded-lg border border-border-custom text-muted hover:text-foreground text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                onClick={submitPPE}
                className="py-2 px-5 rounded-lg bg-info text-white font-semibold text-xs hover:opacity-90 transition-opacity"
              >
                Record
              </button>
            </div>
          </div>
        </div>
      )}
      </PageShell>
      </div>
    </div>
  );
}
