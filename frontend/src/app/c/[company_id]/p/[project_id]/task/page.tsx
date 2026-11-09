"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { getApi, authHeaders, formatLabel, formatDate } from "@/lib/siteflow";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";

type Task = {
  id: string;
  name: string;
  duration_days: number;
  start_date: string;
  end_date: string;
  status: string;
  progress: number;
  priority?: string;
};

const DAY = 86400000;
const daysBetween = (a: Date, b: Date) => Math.floor((b.getTime() - a.getTime()) / DAY);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Real schedule math — no faked values.
function compute(task: Task, today: Date) {
  const start = new Date(task.start_date);
  const end = new Date(task.end_date);
  const totalDays = Math.max(1, daysBetween(start, end));
  const elapsed = daysBetween(start, today);
  const actualPct = Number(task.progress) || 0;

  // Forecast End: extrapolate remaining % at the realized progress rate.
  let forecast: string;
  let forecastEnd: Date | null = null;
  if (task.status === "completed") {
    forecast = formatDate(end);
  } else if (elapsed <= 0) {
    forecast = "Not started yet";
  } else if (actualPct <= 0) {
    forecast = "No progress logged";
  } else {
    const ratePerDay = actualPct / elapsed; // % per elapsed day
    if (ratePerDay <= 0) {
      forecast = "Insufficient data";
    } else {
      const remainingDays = (100 - actualPct) / ratePerDay;
      forecastEnd = new Date(today.getTime() + remainingDays * DAY);
      forecast = formatDate(forecastEnd);
    }
  }

  // Delay (days), shown only while incomplete: the worst of
  //  - overdue: today past the planned end,
  //  - forecast slip: forecast end past the planned end,
  //  - missed start: planned start passed with no progress.
  // Counting only "overdue" showed "On track" for a task forecast to finish
  // weeks late, beside the forecast column that said so.
  let delayDays = 0;
  if (task.status !== "completed") {
    const overdue = daysBetween(end, today);
    const slip = forecastEnd ? daysBetween(end, forecastEnd) : 0;
    const missedStart = actualPct <= 0 && elapsed > 0 ? elapsed : 0;
    delayDays = Math.max(0, overdue, slip, missedStart);
  }

  return { start, end, totalDays, elapsed, actualPct, delayDays, forecast, forecastEnd };
}

export default function TaskPage() {
  const params = useParams();
  const companyId = params.company_id as string;
  const projectId = params.project_id as string;

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(getApi(`/planning/tasks?project_id=${projectId}`), { headers: authHeaders() });
      if (res.ok) setTasks(await res.json());
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const today = useMemo(() => new Date(), []);

  // In schedule order, so the chart reads top to bottom like a programme.
  const rows = useMemo(
    () => tasks.map((t) => ({ task: t, ...compute(t, today) })).sort((a, b) => a.start.getTime() - b.start.getTime()),
    [tasks, today]
  );

  // Gantt timeline span
  const span = useMemo(() => {
    if (rows.length === 0) return { min: today, max: today, days: 1 };
    let min = rows[0].start, max = rows[0].end;
    for (const r of rows) {
      if (r.start < min) min = r.start;
      if (r.end > max) max = r.end;
    }
    if (today < min) min = today;
    if (today > max) max = today;
    const days = Math.max(1, daysBetween(min, max));
    return { min, max, days };
  }, [rows, today]);

  // Position from the left edge of the track. Bars used to be placed by
  // their start date measured from the right, so each bar ended where it
  // should have begun.
  const posPct = useCallback(
    (d: Date) => {
      const range = span.max.getTime() - span.min.getTime();
      return range > 0 ? clamp(((d.getTime() - span.min.getTime()) / range) * 100, 0, 100) : 0;
    },
    [span]
  );
  const todayPct = useMemo(() => posPct(today), [posPct, today]);

  // Month labels along the track, at most about ten of them.
  const monthTicks = useMemo(() => {
    const ticks: { pct: number; label: string }[] = [];
    if (rows.length === 0) return ticks;
    const first = new Date(span.min.getFullYear(), span.min.getMonth() + 1, 1);
    const months = Math.max(1, (span.max.getFullYear() - first.getFullYear()) * 12 + span.max.getMonth() - first.getMonth() + 1);
    const step = Math.max(1, Math.ceil(months / 10));
    for (let i = 0; i < months; i += step) {
      const d = new Date(first.getFullYear(), first.getMonth() + i, 1);
      if (d > span.max) break;
      ticks.push({ pct: posPct(d), label: d.toLocaleDateString("en-IN", { month: "short", year: "2-digit" }) });
    }
    return ticks;
  }, [rows.length, span, posPct]);

  const updateProgress = async (id: string, value: number) => {
    setSavingId(id);
    try {
      const res = await fetch(getApi(`/planning/tasks/${id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ progress: clamp(value, 0, 100) }),
      });
      if (res.ok) {
        setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, progress: clamp(value, 0, 100) } : t)));
      } else {
        const err = await res.json().catch(() => ({}));
        alert(`Failed to save progress: ${err.detail || `HTTP ${res.status}`}`);
      }
    } catch (e) {
      console.error("Failed to update progress", e);
      alert("Failed to save progress. Your change was not saved.");
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title="Tasks & Schedule"
        subtitle="Delay and Forecast End are worked out from the planned dates and the progress logged."
        action={
          <a href={`/c/${companyId}/d/planning/gantt?project=${projectId}`} className="rounded-md bg-primary px-3.5 py-1.5 text-xs font-bold text-white hover:opacity-90">
            + Add or plan tasks
          </a>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">

      {/* Gantt timeline */}
      <div className="rounded-lg border border-border-custom bg-card p-4">
        {rows.length === 0 && (
          <EmptyState
            title="No tasks scheduled yet"
            description="Create project activities, assign responsible engineers, and set planned start and end dates."
            action={{
              label: "Go to Project Plan",
              href: `/c/${companyId}/d/planning/gantt`,
            }}
          />
        )}
        {rows.map((r) => {
          const left = posPct(r.start);
          const width = clamp((r.totalDays / span.days) * 100, 1, 100 - left);
          return (
            <div key={r.task.id} className="flex items-center gap-3 mb-2">
              <div className="w-40 shrink-0 truncate text-sm text-foreground" title={r.task.name}>{r.task.name}</div>
              <div className="relative flex-1 h-6 rounded bg-elevated overflow-hidden">
                <div
                  className="absolute top-0 h-full rounded bg-primary/30"
                  style={{ left: `${left}%`, width: `${width}%` }}
                >
                  <div
                    className="h-full bg-primary/70"
                    style={{ width: `${clamp(r.actualPct, 0, 100)}%` }}
                  />
                </div>
              </div>
              <div className="w-12 text-right text-xs text-muted">{Math.round(r.actualPct)}%</div>
            </div>
          );
        })}
        {rows.length > 0 && (
          // Same columns as the rows above, so the axis lines up with the bars.
          <div className="flex items-start gap-3 mt-1">
            <div className="w-40 shrink-0" />
            <div className="relative flex-1 h-8 border-t border-border-custom">
              {monthTicks.map((t) => (
                <div key={t.label} className="absolute top-0 -translate-x-1/2 text-[10px] text-muted whitespace-nowrap" style={{ left: `${t.pct}%` }}>
                  <div className="mx-auto h-1.5 w-px bg-border-custom" />
                  {t.label}
                </div>
              ))}
              <div className="absolute -top-2 h-4 w-0.5 bg-danger" style={{ left: `${todayPct}%` }} title="Today" />
            </div>
            <div className="w-12" />
          </div>
        )}
      </div>

      {/* Task table with real Delay / Forecast End */}
      <div className="rounded-lg border border-border-custom overflow-hidden bg-card">
        <table className="w-full text-sm">
          <thead className="bg-elevated text-muted">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Task</th>
              <th className="text-left px-4 py-3 font-medium">Scheduled</th>
              <th className="text-left px-4 py-3 font-medium">Progress %</th>
              <th className="text-right px-4 py-3 font-medium">Delay</th>
              <th className="text-left px-4 py-3 font-medium">Forecast End</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="p-4">
                  <TableSkeleton rows={5} cols={6} />
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="p-8">
                  <EmptyState
                    title="No tasks for this project"
                    description="Create tasks and milestones in project planning to see which tasks are running late."
                  />
                </td>
              </tr>
            )}
            {!loading && rows.map((r) => (
              <tr key={r.task.id} className="border-t border-border-custom hover:bg-elevated/50">
                <td className="px-4 py-3 text-foreground font-medium">{r.task.name}</td>
                <td className="px-4 py-3 text-muted whitespace-nowrap">{formatDate(r.start)} → {formatDate(r.end)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      defaultValue={Math.round(r.actualPct)}
                      disabled={savingId === r.task.id}
                      onBlur={(e) => updateProgress(r.task.id, parseFloat(e.target.value) || 0)}
                      className="w-16 rounded-md border border-border-custom bg-background px-2 py-1 text-sm text-foreground"
                    />
                  </div>
                </td>
                <td className={`px-4 py-3 text-right font-semibold ${r.delayDays > 0 ? "text-danger" : "text-success"}`}>
                  {r.delayDays > 0 ? `${r.delayDays}d behind` : r.task.status === "completed" ? "—" : "On track"}
                </td>
                <td className={`px-4 py-3 whitespace-nowrap ${r.forecastEnd === null && r.task.status !== "completed" ? "text-warning italic" : "text-foreground"}`}>
                  {r.forecast}
                </td>
                <td className="px-4 py-3 text-muted">{formatLabel(r.task.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </PageShell>
      </div>
    </div>
  );
}
