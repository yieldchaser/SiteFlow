"use client";
import React from "react";
import { useProject } from "@/context/ProjectContext";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import SubconPerformance from "@/components/SubconPerformance";

// This page used to save a fresh "scorecard" every time it was opened, built
// on numbers that measured the wrong things. It now shows live facts.
export default function SubconScorecardsPage() {
  const { activeProjectId } = useProject();
  return (
    <div className="flex-1 flex flex-col overflow-hidden font-sans">
      <PageHeader title="Subcontractor Performance" subtitle="Tasks finished on time, NCRs and billing for each subcontractor on this project" />
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">
          <SubconPerformance projectId={activeProjectId} />
        </PageShell>
      </div>
    </div>
  );
}
