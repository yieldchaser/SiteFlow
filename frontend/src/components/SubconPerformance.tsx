"use client";

import React, { useCallback, useEffect, useState } from "react";
import { getApiHost } from "@/lib/api";
import { authHeaders, todayLocalISO } from "@/lib/siteflow";

// How each subcontractor on a project is doing, worked out live from their
// tasks, NCRs, bills and work order changes. Plain counts, no made-up scores.
// Shown on Subcontractor Performance, the Subcontractors page and Labour.

type Row = {
  subcontractor_id: string;
  subcontractor_name: string;
  work_orders: number;
  wo_value: number;
  tasks_finished: number;
  tasks_judged: number;
  finished_on_time: number;
  running_late: number;
  ncrs_raised: number;
  ncrs_open: number;
  billed: number;
  billed_to_date: number;
  amendments: number;
};

type Period = "month" | "last_month" | "all";

const inr = (n: number) => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

function range(p: Period): { start?: string; end?: string; label: string } {
  const today = todayLocalISO();
  const [y, m] = today.split("-").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (p === "month") return { start: `${y}-${pad(m)}-01`, end: today, label: "this month" };
  if (p === "last_month") {
    const ly = m === 1 ? y - 1 : y;
    const lm = m === 1 ? 12 : m - 1;
    const last = new Date(Date.UTC(ly, lm, 0)).getUTCDate();
    return { start: `${ly}-${pad(lm)}-01`, end: `${ly}-${pad(lm)}-${pad(last)}`, label: "last month" };
  }
  return { label: "since the project started" };
}

export default function SubconPerformance({ projectId }: { projectId: string | null | undefined }) {
  const [period, setPeriod] = useState<Period>("all");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setRows(null);
    setFailed(false);
    const r = range(period);
    const q = new URLSearchParams();
    if (r.start) q.set("start", r.start);
    if (r.end) q.set("end", r.end);
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/subcon/performance/${projectId}?${q.toString()}`, { headers: authHeaders() });
      if (res.ok) setRows(await res.json());
      else setFailed(true);
    } catch {
      setFailed(true);
    }
  }, [projectId, period]);

  useEffect(() => {
    const id = setTimeout(() => { load(); }, 0);
    return () => clearTimeout(id);
  }, [load]);

  if (!projectId) return <p className="text-xs text-muted">Pick a project at the top to see its subcontractors.</p>;

  const label = range(period).label;

  return (
    <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
      <div className="px-5 py-3 border-b border-border-custom flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] text-muted max-w-2xl">
          Tasks are the ones on each subcontractor&apos;s work orders. On time means finished on or before the task&apos;s original plan.
          NCRs are the ones raised naming them. Billed is the work value of their bills.
        </p>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as Period)}
          className="bg-input border border-border-custom rounded-md px-2.5 py-1.5 text-xs text-foreground"
        >
          <option value="all">Since the project started</option>
          <option value="month">This month</option>
          <option value="last_month">Last month</option>
        </select>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs text-left">
          <thead>
            <tr className="border-b border-border-custom text-muted">
              <th className="px-4 py-3 font-bold">Subcontractor</th>
              <th className="px-4 py-3 font-bold text-right">Tasks finished</th>
              <th className="px-4 py-3 font-bold text-right">Finished on time</th>
              <th className="px-4 py-3 font-bold text-right">Running late</th>
              <th className="px-4 py-3 font-bold text-right">NCRs (open)</th>
              <th className="px-4 py-3 font-bold text-right">Billed</th>
              <th className="px-4 py-3 font-bold text-right">Billed so far of work order</th>
              <th className="px-4 py-3 font-bold text-right">Work order changes</th>
            </tr>
          </thead>
          <tbody>
            {failed ? (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-muted">Could not load. <button onClick={load} className="text-primary underline cursor-pointer">Try again</button></td></tr>
            ) : rows === null ? (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-muted">Loading...</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-muted">No subcontractor has a work order on this project yet.</td></tr>
            ) : (
              rows.map((r) => {
                const pct = r.tasks_judged ? Math.round((r.finished_on_time / r.tasks_judged) * 100) : null;
                const over = r.wo_value > 0 && r.billed_to_date > r.wo_value + 0.5;
                return (
                  <tr key={r.subcontractor_id} className="border-b border-border-custom last:border-0">
                    <td className="px-4 py-3 font-semibold text-foreground">
                      {r.subcontractor_name}
                      <span className="block text-[10px] font-normal text-muted">{r.work_orders} work order{r.work_orders === 1 ? "" : "s"}</span>
                    </td>
                    <td className="px-4 py-3 text-right">{r.tasks_finished}</td>
                    <td className="px-4 py-3 text-right">
                      {pct === null ? <span className="text-muted">-</span> : (
                        <span className={pct >= 80 ? "text-success font-semibold" : pct >= 50 ? "text-warning font-semibold" : "text-danger font-semibold"}>
                          {r.finished_on_time} of {r.tasks_judged} ({pct}%)
                        </span>
                      )}
                    </td>
                    <td className={`px-4 py-3 text-right ${r.running_late ? "text-danger font-semibold" : ""}`}>{r.running_late}</td>
                    <td className={`px-4 py-3 text-right ${r.ncrs_open ? "text-danger font-semibold" : ""}`}>
                      {r.ncrs_raised} ({r.ncrs_open} open)
                    </td>
                    <td className="px-4 py-3 text-right">{inr(r.billed)}</td>
                    <td className={`px-4 py-3 text-right ${over ? "text-danger font-semibold" : ""}`}>
                      {inr(r.billed_to_date)} of {inr(r.wo_value)}
                      {over && <span className="block text-[10px]">Billed more than the work order</span>}
                    </td>
                    <td className="px-4 py-3 text-right">{r.amendments}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <p className="px-5 py-2 text-[10px] text-muted border-t border-border-custom">Showing {label}. Billed so far is for the whole project.</p>
    </div>
  );
}
