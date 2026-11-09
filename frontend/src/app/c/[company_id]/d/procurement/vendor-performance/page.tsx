"use client";
import Badge, { type BadgeTone } from "@/components/ui/Badge";

import React, { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { useProject } from "@/context/ProjectContext";
import { getApiHost } from "@/lib/api";
import { authHeaders } from "@/lib/siteflow";
import Icon from "@/components/marketing/Icon";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";

interface VendorPerf {
  id: string;
  vendor_id: string;
  vendor_name: string;
  total_pos: number;
  total_grns: number;
  on_time_deliveries: number;
  overdue_orders?: number;
  quality_issues: number;
  avg_delay_days: number;
  last_updated: string;
}

export default function VendorPerformancePage() {
  const { company_id } = useParams();
  const companyId = company_id || "demo-company";
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;

  const [vendors, setVendors] = useState<VendorPerf[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/procurement/vendors/performance/${projectId}`, { headers: authHeaders() });
      if (res.ok) setVendors(await res.json());
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  useEffect(() => {
    if (projectId) {
      fetchData();
    } else {
      setLoading(false);
    }
  }, [projectId]);

  // Deliveries plus orders now overdue with goods still to come. With
  // neither there is nothing to judge, so no grade is shown.
  const judged = (v: VendorPerf) => v.total_grns + (v.overdue_orders || 0);
  const onTimePct = (v: VendorPerf) => judged(v) > 0 ? Math.round((v.on_time_deliveries / judged(v)) * 1000) / 10 : null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden font-sans">
      <div className="flex-1 flex flex-col overflow-hidden relative font-sans">
        <PageHeader
          title="Vendor Performance"
          subtitle="How often each supplier delivers on time, how late they run, and quality problems"
        >
          <button
            onClick={fetchData}
            disabled={loading}
            className="px-3.5 py-1.5 rounded-md border border-border-custom text-xs font-bold hover:bg-elevated cursor-pointer inline-flex items-center gap-1.5"
          >
            <Icon name="refresh" className="w-3.5 h-3.5" /> Refresh
          </button>
        </PageHeader>

        <div className="flex-1 overflow-y-auto z-10">
          <PageShell width="wide">
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
              <TableSkeleton rows={5} cols={8} />
            ) : vendors.length === 0 ? (
              <EmptyState
                title="No vendor performance data yet"
                description="Figures appear once purchase orders are raised for this project and goods are received against them."
              />
            ) : (
            <div className="bg-card border border-border-custom rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead>
                    <tr className="border-b border-border-custom text-muted">
                      <th className="px-5 py-3 font-bold">Vendor</th>
                      <th className="px-5 py-3 font-bold text-right">Orders</th>
                      <th className="px-5 py-3 font-bold text-right">Deliveries</th>
                      <th className="px-5 py-3 font-bold text-right">Overdue Orders</th>
                      <th className="px-5 py-3 font-bold text-right">On Time</th>
                      <th className="px-5 py-3 font-bold text-right">Avg Days Late</th>
                      <th className="px-5 py-3 font-bold text-right">Quality Problems</th>
                      <th className="px-5 py-3 font-bold text-center">Rating</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendors.map((v) => {
                      const otp = onTimePct(v);
                      return (
                        <tr key={v.id} className="border-b border-border-custom hover:bg-elevated transition-all">
                          <td className="px-5 py-3.5 text-foreground font-semibold">{v.vendor_name}</td>
                          <td className="px-5 py-3.5 text-right font-sans text-muted">{v.total_pos}</td>
                          <td className="px-5 py-3.5 text-right font-sans text-muted">{v.total_grns}</td>
                          <td className={`px-5 py-3.5 text-right font-sans ${(v.overdue_orders || 0) > 0 ? "text-danger font-bold" : "text-muted"}`}>{v.overdue_orders || 0}</td>
                          <td className="px-5 py-3.5 text-right font-sans text-primary">{otp === null ? "-" : `${otp}%`}</td>
                          <td className="px-5 py-3.5 text-right font-sans text-muted">{v.avg_delay_days.toFixed(1)}</td>
                          <td className="px-5 py-3.5 text-right font-sans text-danger">{v.quality_issues}</td>
                          <td className="px-5 py-3.5 text-center">
                            {otp === null ? (
                              <span className="text-muted" title="No deliveries yet and nothing overdue">Not yet</span>
                            ) : (
                              <Badge tone={otp >= 90 ? "success" : otp >= 70 ? "warning" : "danger"} className="font-bold">{otp >= 90 ? "A" : otp >= 70 ? "B" : "C"}</Badge>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          </PageShell>
        </div>
      </div>
    </div>
  );
}