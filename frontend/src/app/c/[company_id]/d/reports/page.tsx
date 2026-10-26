"use client";
import {  getApiHost , readErrorDetail } from "@/lib/api";
import { authHeaders, formatDate } from "@/lib/siteflow";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useProject } from "@/context/ProjectContext";
import { useParams } from "next/navigation";
import Icon from "@/components/marketing/Icon";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import Badge from "@/components/ui/Badge";

interface ClientReport {
  id: string;
  project_id: string;
  report_name: string;
  report_date: string;
  summary_markdown: string;
  pdf_url: string;
  is_approved: boolean;
  created_at: string;
}

export default function ClientReportsPage() {
  const params = useParams();
  const companyId = params?.company_id as string;
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;

  const [reports, setReports] = useState<ClientReport[]>([]);
  const [selectedReport, setSelectedReport] = useState<ClientReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [isOffline, setIsOffline] = useState(false);
  
  // Modal states
  const [isOpen, setIsOpen] = useState(false);
  const [reportName, setReportName] = useState("");
  const [summaryMarkdown, setSummaryMarkdown] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const fetchReports = async () => {
    try {
      setLoading(true);
      setIsOffline(false);
      const res = await fetch(`${getApiHost()}/apis/v3/reports/${projectId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setReports(data);
          if (data.length > 0 && !selectedReport) {
            setSelectedReport(data[0]);
          } else if (data.length === 0) {
            setSelectedReport(null);
          }
        } else {
          throw new Error("Invalid response format");
        }
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      console.error("Reports API unavailable", err);
      setIsOffline(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (projectId) {
      fetchReports();
    } else {
      setLoading(false);
    }
  }, [projectId]);

  const handleGenerateReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reportName.trim()) {
      setError("Report name is required");
      return;
    }
    try {
      setSubmitting(true);
      setError("");
      const res = await fetch(`${getApiHost()}/apis/v3/reports/generate/${projectId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          report_name: reportName,
          summary_markdown: summaryMarkdown,
        }),
      });
      if (res.ok) {
        const newReport = await res.json();
        setReports([newReport, ...reports]);
        setSelectedReport(newReport);
        setIsOpen(false);
        setReportName("");
        setSummaryMarkdown("");
      } else {
        const errText = await res.text();
        setError(`Failed to generate: ${errText}`);
      }
    } catch (err) {
      setError("Connection to backend failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleApproveReport = async (reportId: string) => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/reports/${reportId}/approve`, {
        method: "PATCH",
        headers: authHeaders(),
      });
      if (res.ok) {
        const updated = await res.json();
        setReports(reports.map(r => r.id === reportId ? updated : r));
        if (selectedReport?.id === reportId) {
          setSelectedReport(updated);
        }
      } else {
        const err = await readErrorDetail(res);
        setError(err || 'Action failed');
      }
    } catch (err) {
      console.error("Error approving report:", err);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Sidebar */}
      

      {/* Main Workspace */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <PageHeader
          title="Client Progress Reports"
          subtitle="Compile WBS milestones, subcontractor billing audits, and quality control indicators."
        >
          <button
            onClick={() => setIsOpen(true)}
            className="flex items-center gap-2 rounded-md bg-primary px-3.5 py-1.5 text-xs font-bold text-white hover:opacity-90 transition-all cursor-pointer"
          >
            + Generate Progress Report
          </button>
        </PageHeader>

        <PageShell width="full" className="p-0 space-y-0 h-full flex flex-col overflow-hidden">

        {isOffline && (
          <div className="px-6 py-2.5 bg-warning/10 border-b border-warning/20 text-warning text-xs">
            Offline mode: backend connection unavailable
          </div>
        )}

        {/* Workspace Layout */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Panel: Report Gallery */}
          <div className="w-80 border-r border-border-custom bg-card/50 p-4 overflow-y-auto space-y-3">
            <h2 className="text-[10px] uppercase font-bold text-muted tracking-wider px-1">
              Report Logs
            </h2>

            {loading ? (
              <CardSkeleton />
            ) : reports.length === 0 ? (
              <EmptyState
                title="No reports generated yet"
                description="Compile WBS milestones, subcontractor billing audits, and quality control indicators."
              />
            ) : (
              reports.map((report) => (
                <div
                  key={report.id}
                  onClick={() => setSelectedReport(report)}
                  className={`p-3.5 rounded-md border transition-all cursor-pointer ${
                    selectedReport?.id === report.id
                      ? "bg-primary/5 border-border-custom"
                      : "bg-elevated/40 border-border-custom hover:bg-elevated"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-semibold text-foreground line-clamp-2">
                      {report.report_name}
                    </span>
                    <Badge tone={report.is_approved ? "success" : "warning"}>
                      {report.is_approved ? "Approved" : "Draft"}
                    </Badge>
                  </div>
                  <div className="text-[10px] text-muted mt-2">
                    {formatDate(report.report_date)}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Right Panel: Report Details & Interactive PDF Frame */}
          <div className="flex-1 bg-background p-6 overflow-y-auto flex flex-col space-y-4">
            {selectedReport ? (
              <>
                {/* Details Header */}
                <div className="bg-card border border-border-custom rounded-lg p-5 rounded-lg border border-border-custom bg-input flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-bold text-foreground">{selectedReport.report_name}</h2>
                    <p className="text-[10px] text-muted mt-0.5">
                      Created: {new Date(selectedReport.report_date).toLocaleString("en-IN")}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {!selectedReport.is_approved && (
                      <button
                        onClick={() => handleApproveReport(selectedReport.id)}
                        className="rounded-md bg-success/10 hover:bg-success/20 text-success border border-success/20 px-4 py-2 text-xs font-bold transition-all inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <Icon name="check" className="w-3.5 h-3.5" /> Approve for Client Portal
                      </button>
                    )}
                    {selectedReport.pdf_url && selectedReport.pdf_url !== "#" && (
                      <a
                        href={`${getApiHost()}/apis/v3/reports/${selectedReport.id}/download`}
                        download
                        className="rounded-md bg-elevated hover:bg-sidebar text-foreground border border-border-custom px-4 py-2 text-xs font-bold transition-all text-center"
                      >
                        Download PDF
                      </a>
                    )}
                  </div>
                </div>

                {/* Summary remarks */}
                {selectedReport.summary_markdown && (
                  <div className="bg-card border border-border-custom rounded-lg p-4 bg-elevated">
                    <h3 className="text-[10px] font-bold text-muted uppercase tracking-wider">
                      Executive Summary Notes
                    </h3>
                    <p className="text-xs text-muted mt-1.5 leading-relaxed">
                      {selectedReport.summary_markdown}
                    </p>
                  </div>
                )}

                {/* Embedded PDF Viewer */}
                <div className="flex-1 bg-card border border-border-custom rounded-lg overflow-hidden bg-background flex flex-col min-h-[400px]">
                  <iframe
                    src={`${getApiHost()}/apis/v3/reports/${selectedReport.id}/download#toolbar=0`}
                    className="w-full h-full border-0"
                    title={selectedReport.report_name}
                  />
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-10 bg-elevated rounded-lg border border-border-custom">
                <Icon name="bar_chart" className="w-8 h-8 mb-3 text-muted" />
                <h2 className="text-sm font-bold text-foreground">No Report Selected</h2>
                <p className="text-xs text-muted max-w-xs mt-1">
                  Choose an existing progress report from the side log panel or click the generate button to compile a new one.
                </p>
              </div>
            )}
          </div>
        </div>
        </PageShell>
      </div>

      {/* Generate Report Dialog Modal */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-input border border-border-custom rounded-lg overflow-hidden shadow-2xl">
            <div className="px-5 py-4 border-b border-border-custom flex items-center justify-between">
              <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">
                Compile Progress Report
              </h3>
              <button
                onClick={() => setIsOpen(false)}
                className="text-muted hover:text-foreground cursor-pointer"
              >
                <Icon name="close" className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleGenerateReport} className="p-5 space-y-4">
              {error && (
                <div className="p-3 text-xs bg-danger/10 border border-danger/20 text-danger rounded-lg">
                  {error}
                </div>
              )}

              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">
                  Report Title
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Monthly Progress Report - June 2026"
                  value={reportName}
                  onChange={(e) => setReportName(e.target.value)}
                  className="w-full bg-elevated border border-border-custom rounded-md px-3 py-2 text-xs text-foreground placeholder-muted focus:outline-none focus:border-primary transition-all"
                />
              </div>

              <div>
                <label className="text-[10px] uppercase font-bold text-muted block mb-1">
                  Executive Remarks
                </label>
                <textarea
                  placeholder="Summarize engineering achievements, site issues, and milestone updates for the client."
                  value={summaryMarkdown}
                  onChange={(e) => setSummaryMarkdown(e.target.value)}
                  rows={4}
                  className="w-full bg-elevated border border-border-custom rounded-md px-3 py-2 text-xs text-foreground placeholder-muted focus:outline-none focus:border-primary transition-all resize-none"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="px-4 py-2 rounded-md text-xs font-bold text-muted hover:bg-elevated transition-all"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 rounded-md bg-primary text-xs font-bold text-white hover:opacity-90 transition-all"
                >
                  {submitting ? "Compiling PDF..." : "Generate & Save"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
