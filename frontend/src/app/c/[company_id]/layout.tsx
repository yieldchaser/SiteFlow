"use client";

import React from "react";
import { usePathname, useRouter, useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ProjectProvider } from "@/context/ProjectContext";
import { CompanySettingsProvider } from "@/context/CompanySettingsContext";
import { PermissionsProvider } from "@/context/PermissionsContext";
import Sidebar from "@/components/Sidebar";
import PageAccessGuard from "@/components/rbac/PageAccessGuard";
import { SidebarProvider } from "@/context/SidebarContext";
import { isMissingOrDemoTenant } from "@/lib/company-guard";

export default function CompanyLayout({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const pathname = usePathname();
  // null = still verifying (renders the shell-free loader), true = session present.
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    // Reuse the app's established auth signal: the session JWT is stored as
    // `access_token` in localStorage (see lib/siteflow.ts persistAuth / authHeaders
    // and the same guard used in app/onboarding/page.tsx). No token means no
    // session, so bounce to /login before the console shell is ever shown.
    if (typeof window !== "undefined" && !localStorage.getItem("access_token")) {
      window.location.href = "/login";
      return;
    }
    setAuthed(true);
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== "access_token" || e.oldValue === e.newValue) return;
      if (!e.newValue) {
        window.location.href = "/login";
        return;
      }
      window.location.reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // D-V1: a missing company id (malformed route) or the removed demo tenant id
  // must never resolve into console data. Both bounce to /login.
  if (isMissingOrDemoTenant(params?.company_id as string | undefined)) {
    if (typeof window !== "undefined") {
      window.location.replace("/login");
    }
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-background text-foreground font-sans">
        <div className="flex flex-col items-center gap-3">
          <svg className="animate-spin h-8 w-8 text-primary" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span className="text-[10px] text-muted uppercase tracking-widest font-extrabold">Resolving Workspace...</span>
        </div>
      </div>
    );
  }

  if (authed !== true) {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-background text-foreground font-sans">
        <div className="flex flex-col items-center gap-3">
          <svg className="animate-spin h-8 w-8 text-primary" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span className="text-[10px] text-muted uppercase tracking-widest font-extrabold">Verifying Session...</span>
        </div>
      </div>
    );
  }

  return (
    <ProjectProvider>
      <CompanySettingsProvider>
        <PermissionsProvider>
          <SidebarProvider>
            <div className="flex h-screen bg-background text-foreground overflow-hidden font-sans">
              {/* Single persistent global Sidebar */}
              <Sidebar />

              {/* Main Workspace Area */}
              <main className="flex-1 flex flex-col h-full overflow-hidden relative">
                <PageAccessGuard>{children}</PageAccessGuard>
              </main>
            </div>
          </SidebarProvider>
        </PermissionsProvider>
      </CompanySettingsProvider>
    </ProjectProvider>
  );
}
