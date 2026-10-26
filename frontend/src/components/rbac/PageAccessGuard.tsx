"use client";

import React from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { usePermissions } from "@/context/PermissionsContext";
import { pageRule } from "@/lib/routeAccess";
import Icon from "@/components/marketing/Icon";

/**
 * Shows a plain "not part of your role" panel instead of a page the member's
 * role does not include. While permissions load it shows the page (the server
 * still refuses anything the role cannot do).
 */
export default function PageAccessGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const params = useParams();
  const companyId = params.company_id as string;
  const { can, role, loaded } = usePermissions();

  const rule = pageRule(pathname);
  if (!loaded || !rule || rule.anyOf.some((k) => can(k))) return <>{children}</>;

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-card border border-border-custom rounded-lg p-8 text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-elevated flex items-center justify-center text-muted">
          <Icon name="lock" className="w-6 h-6" />
        </div>
        <h1 className="mt-4 text-base font-bold text-foreground">{rule.label} is not part of your role</h1>
        <p className="mt-2 text-xs text-muted leading-relaxed">
          {role ? <>You are signed in as <span className="font-semibold text-foreground">{role}</span>. </> : null}
          If you need this page, ask your company owner or admin to change your role in Settings, Team.
        </p>
        <Link
          href={`/c/${companyId}/d/home`}
          className="mt-6 inline-block bg-primary text-white text-xs font-bold px-4 py-2.5 rounded-md"
        >
          Go to Home
        </Link>
      </div>
    </div>
  );
}
