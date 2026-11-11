"use client";

import React from "react";
import { usePathname } from "next/navigation";
import { useProject } from "@/context/ProjectContext";

// Screens that only make sense on a site. The head office has no BOQ, daily
// reports, schedule, drawings or subcontractors, and the server refuses those
// records on it, so these screens ask for a site instead of opening empty.
export const SITE_ONLY_SCREENS = [
  "/d/dpr",
  "/d/planning",
  "/d/budgeting/boq",
  "/d/production",
  "/d/quality",
  "/d/safety",
  "/d/drawings",
  "/d/towers",
  "/d/wastage",
  "/d/labour",
  "/d/subcon",
];

// Company-wide views under a site-only path.
const COMPANY_WIDE = ["/d/subcon/scorecards"];

export function isSiteOnlyPath(pathname: string): boolean {
  const rest = pathname.replace(/^\/c\/[^/]+/, "");
  if (COMPANY_WIDE.some((p) => rest === p || rest.startsWith(`${p}/`))) return false;
  return SITE_ONLY_SCREENS.some((p) => rest === p || rest.startsWith(`${p}/`));
}

export default function SiteOnlyGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "";
  const { activeProjectId, projects, setActiveProjectId } = useProject();
  const active = projects.find((p) => p.id === activeProjectId);
  if (!active?.is_office || !isSiteOnlyPath(pathname)) return <>{children}</>;

  const sites = projects.filter((p) => p.id && !p.is_office);
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-xl mx-auto mt-10 rounded-xl border border-border-custom bg-card p-6 space-y-4">
        <h1 className="text-lg font-bold text-foreground">Head office is not a site</h1>
        <p className="text-sm text-muted">
          {active.name || "Your head office"} is where office staff, rent and admin costs are kept. Daily reports,
          BOQs, schedules, drawings and subcontractor work belong to a site. Pick the site you want to work on.
        </p>
        {sites.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {sites.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setActiveProjectId(s.id as string)}
                className="px-3 py-2 rounded-md border border-border-custom text-sm font-semibold text-foreground hover:border-primary hover:text-primary cursor-pointer"
              >
                {s.name || s.project_name}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">There is no site yet. Add one from Projects.</p>
        )}
      </div>
    </div>
  );
}
