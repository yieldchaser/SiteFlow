"use client";

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { getApiHost } from "@/lib/api";
import { useProject } from "@/context/ProjectContext";
import Icon, { type IconName } from "@/components/marketing/Icon";
import { usePermissions } from "@/context/PermissionsContext";
import { useSidebar } from "@/context/SidebarContext";
import CompanySwitcher from "@/components/CompanySwitcher";
import { isMissingOrDemoTenant, redirectToLogin } from "@/lib/company-guard";

const GROUPS_STORAGE_KEY = "siteflow_nav_groups_state";

interface NavItem {
  id: string;
  label: string;
  href: string;
  iconName: IconName;
  activePattern?: string;
  permission?: string;
  anyOf?: string[];
}

interface NavGroup {
  id: string;
  label: string;
  iconName: IconName;
  items: NavItem[];
}

export default function Sidebar() {
  const params = useParams();
  const pathname = usePathname();
  const companyId = params.company_id as string;

  useEffect(() => {
    if (isMissingOrDemoTenant(companyId)) {
      redirectToLogin();
    }
  }, [companyId]);

  const { activeProjectId, setActiveProjectId, projects, projectContext, projectsLoadingState } = useProject();
  const { can } = usePermissions();
  const {
    mobileOpen,
    closeMobile,
    desktopCollapsed,
    toggleDesktopCollapsed,
  } = useSidebar();

  const [companyName, setCompanyName] = useState("Loading Company...");
  const [hoveredFlyout, setHoveredFlyout] = useState<string | null>(null);

  // Define domain groups
  const domainGroups: NavGroup[] = useMemo(() => [
    {
      id: "overview",
      label: "Overview",
      iconName: "dashboard",
      items: [
        {
          id: "dashboard",
          label: "Dashboard",
          href: `/c/${companyId}/dashboard`,
          iconName: "dashboard",
          permission: "dashboard:view",
          activePattern: "/dashboard",
        },
        {
          id: "project-hub",
          label: "Project Hub",
          href: `/c/${companyId}/d/home`,
          iconName: "home",
          activePattern: "/d/home",
        },
        {
          id: "analytics",
          label: "Analytics",
          href: `/c/${companyId}/analytics`,
          iconName: "bar_chart",
          permission: "reports:view",
          activePattern: "/analytics",
        },
        {
          id: "reports",
          label: "Reports",
          href: `/c/${companyId}/reports`,
          iconName: "document",
          permission: "reports:view",
          activePattern: "/reports",
        },
      ],
    },
    {
      id: "projects",
      label: "Projects & Planning",
      iconName: "folder",
      items: [
        {
          id: "projects-list",
          label: "Projects",
          href: `/c/${companyId}/projects`,
          iconName: "folder",
          permission: "projects:view",
          activePattern: "/projects",
        },
        {
          id: "planning",
          label: "Planning",
          href: `/c/${companyId}/d/planning`,
          iconName: "calendar",
          permission: "planning:view",
          activePattern: "/d/planning",
        },
        {
          id: "drawings",
          label: "Drawings",
          href: `/c/${companyId}/d/drawings`,
          iconName: "blueprint",
          permission: "drawings:view",
          activePattern: "/d/drawings",
        },
        {
          id: "towers",
          label: "Towers & Phases",
          href: `/c/${companyId}/d/towers`,
          iconName: "location_pin",
          activePattern: "/d/towers",
        },
        {
          id: "team-action",
          label: "Team Schedule",
          href: `/c/${companyId}/d/team-action`,
          iconName: "schedule",
          permission: "planning:view",
          activePattern: "/d/team-action",
        },
      ],
    },
    {
      id: "site-operations",
      label: "Site Operations",
      iconName: "site",
      items: [
        {
          id: "dpr",
          label: "DPR (Daily Progress)",
          href: `/c/${companyId}/d/dpr`,
          iconName: "task_alt",
          permission: "planning:view",
          activePattern: "/d/dpr",
        },
        {
          id: "quality",
          label: "Quality & NCR",
          href: `/c/${companyId}/d/quality`,
          iconName: "check_circle",
          permission: "quality:view",
          activePattern: "/d/quality",
        },
        {
          id: "safety",
          label: "Safety",
          href: `/c/${companyId}/d/safety`,
          iconName: "shield",
          permission: "safety:view",
          activePattern: "/d/safety",
        },
        {
          id: "labour",
          label: "Labour Management",
          href: `/c/${companyId}/d/labour`,
          iconName: "group",
          permission: "attendance:view",
          activePattern: "/d/labour",
        },
        {
          id: "attendance",
          label: "Attendance",
          href: `/c/${companyId}/d/attendance`,
          iconName: "clock",
          permission: "attendance:view",
          activePattern: "/d/attendance",
        },
        {
          id: "biometric",
          label: "Biometric Devices",
          href: `/c/${companyId}/d/biometric`,
          iconName: "domain_verification",
          permission: "attendance:view",
          activePattern: "/d/biometric",
        },
        {
          id: "face-recognition",
          label: "Face Recognition",
          href: `/c/${companyId}/d/face-recognition`,
          iconName: "qr_code",
          permission: "attendance:view",
          activePattern: "/d/face-recognition",
        },
        {
          id: "equipment",
          label: "Equipment",
          href: `/c/${companyId}/d/equipment`,
          iconName: "truck",
          permission: "equipment:view",
          activePattern: "/d/equipment",
        },
        {
          id: "production",
          label: "Production",
          href: `/c/${companyId}/d/production`,
          iconName: "bolt",
          permission: "production:view",
          activePattern: "/d/production",
        },
        {
          id: "wastage",
          label: "Wastage Control",
          href: `/c/${companyId}/d/wastage`,
          iconName: "warning",
          activePattern: "/d/wastage",
        },
      ],
    },
    {
      id: "procurement-materials",
      label: "Procurement & Materials",
      iconName: "trolley",
      items: [
        {
          id: "procurement",
          label: "Procurement",
          href: `/c/${companyId}/d/procurement`,
          iconName: "trolley",
          permission: "procurement:view",
          activePattern: "/d/procurement",
        },
        {
          id: "three-way",
          label: "Three-Way Match",
          href: `/c/${companyId}/d/three-way`,
          iconName: "check",
          permission: "procurement:view",
          activePattern: "/d/three-way",
        },
        {
          id: "materials",
          label: "Materials & Stock",
          href: `/c/${companyId}/materials`,
          iconName: "cube",
          permission: "procurement:view",
          activePattern: "/materials",
        },
        {
          id: "subcon",
          label: "Subcontractors",
          href: `/c/${companyId}/d/subcon`,
          iconName: "handshake",
          permission: "subcontractor:view",
          activePattern: "/d/subcon",
        },
        {
          id: "cost-codes",
          label: "Cost Codes",
          href: `/c/${companyId}/cost-codes`,
          iconName: "tag",
          permission: "finance:view",
          activePattern: "/cost-codes",
        },
      ],
    },
    {
      id: "finance-billing",
      label: "Finance & Billing",
      iconName: "currency_rupee",
      items: [
        {
          id: "finance",
          label: "Finance",
          href: `/c/${companyId}/d/finance`,
          iconName: "ledger",
          permission: "finance:view",
          activePattern: "/d/finance",
        },
        {
          id: "billing",
          label: "Billing & Invoices",
          href: `/c/${companyId}/d/billing`,
          iconName: "currency_rupee",
          permission: "billing:view",
          activePattern: "/d/billing",
        },
        {
          id: "payroll",
          label: "Payroll",
          href: `/c/${companyId}/d/payroll-attendance`,
          iconName: "credit_card",
          permission: "payroll:view",
          activePattern: "/d/payroll-attendance",
        },
        {
          id: "hr",
          label: "HR & Staff",
          href: `/c/${companyId}/d/hr`,
          iconName: "group",
          permission: "payroll:view",
          activePattern: "/d/hr",
        },
        {
          id: "budget",
          label: "Budget",
          href: `/c/${companyId}/d/budget`,
          iconName: "bar_chart",
          permission: "budgeting:view",
          activePattern: "/d/budget",
        },
        {
          id: "depreciation",
          label: "Depreciation",
          href: `/c/${companyId}/d/depreciation`,
          iconName: "trending_down",
          permission: "finance:view",
          activePattern: "/d/depreciation",
        },
        {
          id: "statutory",
          label: "Statutory",
          href: `/c/${companyId}/d/statutory`,
          iconName: "shield",
          permission: "payroll:view",
          activePattern: "/d/statutory",
        },
      ],
    },
    {
      id: "sales-crm",
      label: "Sales & CRM",
      iconName: "sparkles",
      items: [
        {
          id: "crm",
          label: "CRM & Leads",
          href: `/c/${companyId}/d/crm`,
          iconName: "sparkles",
          permission: "crm:view",
          activePattern: "/d/crm",
        },
      ],
    },
    {
      id: "setup-workspace",
      label: "Setup & Config",
      iconName: "settings",
      items: [
        {
          id: "library",
          label: "Library",
          href: `/c/${companyId}/d/library`,
          iconName: "library",
          permission: "library:view",
          activePattern: "/d/library",
        },
        {
          id: "custom-fields",
          label: "Custom Fields",
          href: `/c/${companyId}/d/custom-fields`,
          iconName: "edit",
          anyOf: ["settings:manage"],
          activePattern: "/d/custom-fields",
        },
        {
          id: "services",
          label: "Services",
          href: `/c/${companyId}/d/services`,
          iconName: "tool",
          permission: "production:view",
          activePattern: "/d/services",
        },
        {
          id: "settings",
          label: "Settings",
          href: `/c/${companyId}/settings`,
          iconName: "settings",
          anyOf: ["settings:manage", "team:manage"],
          activePattern: "/settings",
        },
        {
          id: "enterprise",
          label: "Enterprise",
          href: `/c/${companyId}/enterprise`,
          iconName: "building",
          permission: "finance:view",
          activePattern: "/enterprise",
        },
        {
          id: "delete-logs",
          label: "Delete Logs",
          href: `/c/${companyId}/d/delete-logs`,
          iconName: "trash",
          permission: "data:delete",
          activePattern: "/d/delete-logs",
        },
        {
          id: "help",
          label: "Help & FAQ",
          href: `/c/${companyId}/d/help`,
          iconName: "help",
          activePattern: "/d/help",
        },
      ],
    },
  ], [companyId]);

  // Group accordion open/close state
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") {
      return { overview: true, projects: true };
    }
    try {
      const stored = localStorage.getItem(GROUPS_STORAGE_KEY);
      if (stored) return JSON.parse(stored);
    } catch {}
    return { overview: true, projects: true, "site-operations": true, "procurement-materials": true, "finance-billing": true, "sales-crm": true, "setup-workspace": true };
  });

  const toggleGroup = useCallback((groupId: string) => {
    setOpenGroups((prev) => {
      const next = { ...prev, [groupId]: !prev[groupId] };
      try {
        if (typeof window !== "undefined") {
          localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(next));
        }
      } catch (e) {
        console.warn("Failed to persist group state in localStorage", e);
      }
      return next;
    });
  }, []);

  // Automatically expand group containing the active path
  useEffect(() => {
    for (const group of domainGroups) {
      for (const item of group.items) {
        const isActive = item.activePattern
          ? pathname.includes(item.activePattern)
          : pathname === item.href;
        if (isActive && !openGroups[group.id]) {
          setOpenGroups((prev) => {
            const next = { ...prev, [group.id]: true };
            try {
              if (typeof window !== "undefined") {
                localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(next));
              }
            } catch {}
            return next;
          });
        }
      }
    }
  }, [pathname, domainGroups, openGroups]);

  // Company name fetch
  useEffect(() => {
    let isActive = true;
    if (!companyId) return;

    // Show the remembered name straight away, but only if it belongs to this
    // company, then always refresh it: companies get renamed and people switch.
    const cachedName = typeof window !== "undefined" ? localStorage.getItem("company_name") : null;
    const cachedFor = typeof window !== "undefined" ? localStorage.getItem("company_name_for") : null;
    if (cachedName && cachedFor === companyId) {
      setCompanyName(cachedName);
    }

    const load = async () => {
      try {
        const apiHost = getApiHost();
        const token = typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
        const res = await fetch(`${apiHost}/apis/v3/settings/company/${companyId}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (res.ok) {
          const data = await res.json();
          const resolvedCompanyName = data.name || "Workspace";
          if (isActive) setCompanyName(resolvedCompanyName);
          if (typeof window !== "undefined") {
            localStorage.setItem("company_name", resolvedCompanyName);
            localStorage.setItem("company_name_for", companyId);
          }
        } else if (isActive && !(cachedName && cachedFor === companyId)) {
          setCompanyName("Workspace");
        }
      } catch {
        if (isActive && !(cachedName && cachedFor === companyId)) setCompanyName("Workspace");
      }
    };
    load();

    return () => {
      isActive = false;
    };
  }, [companyId]);

  // Filter items by user role permissions
  const isItemVisible = useCallback((item: NavItem) => {
    if (!item.permission && !item.anyOf) return true;
    if (item.permission && can(item.permission)) return true;
    if (item.anyOf && item.anyOf.some((p) => can(p))) return true;
    return false;
  }, [can]);

  const [flyoutPos, setFlyoutPos] = useState<{ top: number; left: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const flyoutTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const openFlyout = useCallback((groupId: string, el: HTMLElement) => {
    if (flyoutTimerRef.current) clearTimeout(flyoutTimerRef.current);
    const rect = el.getBoundingClientRect();
    const top = Math.max(12, Math.min(rect.top, (typeof window !== "undefined" ? window.innerHeight : 800) - 340));
    setFlyoutPos({ top, left: rect.right + 6 });
    setHoveredFlyout(groupId);
  }, []);

  const closeFlyoutWithDelay = useCallback(() => {
    if (flyoutTimerRef.current) clearTimeout(flyoutTimerRef.current);
    flyoutTimerRef.current = setTimeout(() => {
      setHoveredFlyout(null);
      setFlyoutPos(null);
    }, 150);
  }, []);

  const closeFlyoutImmediate = useCallback(() => {
    if (flyoutTimerRef.current) clearTimeout(flyoutTimerRef.current);
    setHoveredFlyout(null);
    setFlyoutPos(null);
  }, []);

  useEffect(() => {
    if (!hoveredFlyout) return;
    const handleScrollOrResize = () => {
      closeFlyoutImmediate();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeFlyoutImmediate();
      }
    };
    window.addEventListener("scroll", handleScrollOrResize, { capture: true, passive: true });
    window.addEventListener("resize", handleScrollOrResize, { passive: true });
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("scroll", handleScrollOrResize, { capture: true });
      window.removeEventListener("resize", handleScrollOrResize);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [hoveredFlyout, closeFlyoutImmediate]);

  return (
    <>
      {/* Mobile Backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-xs lg:hidden"
          onClick={closeMobile}
          aria-hidden="true"
        />
      )}

      {/* Responsive Collapsible Sidebar Container */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 border-r border-border-custom bg-sidebar flex flex-col justify-between h-full shrink-0 transition-all duration-300 ${
          mobileOpen ? "translate-x-0 w-64" : "-translate-x-full"
        } lg:static lg:translate-x-0 lg:flex ${
          desktopCollapsed ? "lg:w-16" : "lg:w-64"
        }`}
      >
        <div className="flex flex-col overflow-y-auto flex-1 min-h-0">
          {/* Header */}
          <div className="p-3.5 flex items-center gap-3 border-b border-border-custom shrink-0">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary font-bold text-white text-sm">
              S
            </div>
            {(!desktopCollapsed || mobileOpen) && (
              <div className="min-w-0 flex-1 animate-fade-in">
                <CompanySwitcher currentCompanyId={companyId} fallbackName={companyName} />
                <span className="text-[10px] text-muted uppercase tracking-wider font-medium block truncate">
                  SiteFlow ERP
                </span>
              </div>
            )}
          </div>

          {/* Navigation Accordion Sections */}
          <nav className="p-2 space-y-3 flex-1 overflow-y-auto">
            {domainGroups.map((group) => {
              const visibleItems = group.items.filter(isItemVisible);
              if (visibleItems.length === 0) return null;

              const isGroupOpen = openGroups[group.id] !== false;
              const hasActiveChild = visibleItems.some((it) =>
                it.activePattern ? pathname.includes(it.activePattern) : pathname === it.href
              );

              // Collapsed Desktop State
              if (desktopCollapsed && !mobileOpen) {
                return (
                  <div
                    key={group.id}
                    className="relative flex flex-col items-center py-1"
                    onMouseEnter={(e) => openFlyout(group.id, e.currentTarget)}
                    onMouseLeave={closeFlyoutWithDelay}
                    onFocus={(e) => openFlyout(group.id, e.currentTarget)}
                    onBlur={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                        closeFlyoutWithDelay();
                      }
                    }}
                  >
                    <button
                      type="button"
                      className={`h-10 w-10 flex items-center justify-center rounded-lg transition-all ${
                        hasActiveChild
                          ? "bg-elevated text-foreground"
                          : "text-muted hover:text-foreground hover:bg-elevated"
                      }`}
                      title={group.label}
                      aria-label={group.label}
                      aria-haspopup="menu"
                      aria-expanded={hoveredFlyout === group.id}
                    >
                      <Icon
                        name={group.iconName}
                        className={`w-5 h-5 ${hasActiveChild ? "text-primary" : ""}`}
                      />
                    </button>
                  </div>
                );
              }

              // Expanded Full Sidebar State
              return (
                <div key={group.id} className="space-y-1">
                  {/* Group Header Button */}
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.id)}
                    className={`w-full flex items-center justify-between px-2.5 py-1.5 text-[11px] font-bold tracking-wider uppercase rounded-md transition-all cursor-pointer ${
                      hasActiveChild ? "text-foreground font-bold" : "text-muted hover:text-foreground hover:bg-elevated/60"
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <Icon
                        name={group.iconName}
                        className={`w-3.5 h-3.5 shrink-0 ${hasActiveChild ? "text-primary" : "opacity-80"}`}
                      />
                      <span className="truncate">{group.label}</span>
                    </div>
                    <Icon
                      name={isGroupOpen ? "chevron_down" : "chevron_right"}
                      className="w-3 h-3 text-muted shrink-0"
                    />
                  </button>

                  {/* Group Items */}
                  {isGroupOpen && (
                    <div className="pl-2 space-y-0.5 animate-fade-in border-l border-border-custom/50 ml-3 my-0.5">
                      {visibleItems.map((item) => {
                        const isActive = item.activePattern
                          ? pathname.includes(item.activePattern)
                          : pathname === item.href;

                        return (
                          <Link
                            key={item.id}
                            href={item.href}
                            prefetch={true}
                            className={`flex items-center gap-2.5 px-2.5 py-1.5 text-xs rounded-md transition-all block ${
                              isActive
                                ? "bg-elevated text-foreground font-semibold"
                                : "text-muted hover:text-foreground hover:bg-elevated font-medium"
                            }`}
                          >
                            <Icon
                              name={item.iconName}
                              className={`w-3.5 h-3.5 shrink-0 ${isActive ? "text-primary" : "text-muted"}`}
                            />
                            <span className="truncate">{item.label}</span>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
        </div>

        {/* Sidebar Footer */}
        <div className="p-2.5 border-t border-border-custom bg-background/30 shrink-0 space-y-2">
          {(!desktopCollapsed || mobileOpen) && (
            <>
              {/* Pinned Projects Selector */}
              <div>
                <label className="block text-[9px] font-bold uppercase tracking-wider text-muted mb-1 px-1">
                  Pinned Project
                </label>
                <select
                  value={activeProjectId}
                  onChange={(e) => setActiveProjectId(e.target.value)}
                  className="w-full rounded-md border border-border-custom bg-card px-2 py-1.5 text-xs text-foreground focus:outline-none focus:border-primary cursor-pointer truncate"
                >
                  {projects.length === 0 && (
                    <option value={activeProjectId}>
                      {projectsLoadingState === "failed"
                        ? "Failed to load projects"
                        : projectsLoadingState === "loaded"
                        ? "No projects yet (create in Projects)"
                        : projectContext.name && projectContext.name !== "Project Context"
                        ? `${projectContext.name}${projectContext.code ? ` (${projectContext.code})` : ""}`
                        : "Loading projects..."}
                    </option>
                  )}
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.project_name || p.name}
                      {p.project_code || p.code ? ` (${p.project_code || p.code})` : ""}
                    </option>
                  ))}
                </select>
              </div>

              {/* Quick Access: MOM, To Do, Chat */}
              <div className="grid grid-cols-3 gap-1">
                <Link
                  href={`/c/${companyId}/d/mom`}
                  prefetch={true}
                  className={`flex flex-col items-center justify-center py-1.5 border rounded-md text-[10px] font-medium transition-all ${
                    pathname.includes("/d/mom")
                      ? "bg-elevated text-foreground font-semibold border-border-custom"
                      : "bg-card hover:bg-elevated border-border-custom text-muted hover:text-foreground"
                  }`}
                >
                  <Icon
                    name="note"
                    className={`w-4 h-4 ${pathname.includes("/d/mom") ? "text-primary" : "text-muted"}`}
                  />
                  <span className="mt-0.5">MOM</span>
                </Link>
                <Link
                  href={`/c/${companyId}/d/todo`}
                  prefetch={true}
                  className={`flex flex-col items-center justify-center py-1.5 border rounded-md text-[10px] font-medium transition-all ${
                    pathname.includes("/d/todo")
                      ? "bg-elevated text-foreground font-semibold border-border-custom"
                      : "bg-card hover:bg-elevated border-border-custom text-muted hover:text-foreground"
                  }`}
                >
                  <Icon
                    name="check"
                    className={`w-4 h-4 ${pathname.includes("/d/todo") ? "text-primary" : "text-muted"}`}
                  />
                  <span className="mt-0.5">To Do</span>
                </Link>
                <Link
                  href={`/c/${companyId}/d/chat`}
                  prefetch={true}
                  className={`flex flex-col items-center justify-center py-1.5 border rounded-md text-[10px] font-medium transition-all ${
                    pathname.includes("/d/chat")
                      ? "bg-elevated text-foreground font-semibold border-border-custom"
                      : "bg-card hover:bg-elevated border-border-custom text-muted hover:text-foreground"
                  }`}
                >
                  <Icon
                    name="chat_bubble"
                    className={`w-4 h-4 ${pathname.includes("/d/chat") ? "text-primary" : "text-muted"}`}
                  />
                  <span className="mt-0.5">Chat</span>
                </Link>
              </div>
            </>
          )}

          {/* Desktop Collapse / Expand Toggle Button */}
          <div className="hidden lg:flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={toggleDesktopCollapsed}
              className="w-full flex items-center justify-center gap-2 py-1.5 px-2 rounded-md text-xs font-semibold text-muted hover:text-foreground hover:bg-elevated border border-border-custom/50 transition-all cursor-pointer"
              title={desktopCollapsed ? "Expand sidebar (Ctrl+B)" : "Collapse sidebar (Ctrl+B)"}
            >
              <Icon
                name={desktopCollapsed ? "chevron_right" : "chevron_left"}
                className="w-4 h-4 shrink-0"
              />
              {!desktopCollapsed && <span className="text-[11px]">Collapse Rail (Ctrl+B)</span>}
            </button>
          </div>
        </div>
      </aside>

      {/* Portaled Flyout Menu for Collapsed Rail */}
      {mounted && desktopCollapsed && !mobileOpen && hoveredFlyout && flyoutPos && typeof document !== "undefined" && (() => {
        const activeFlyoutGroup = domainGroups.find((g) => g.id === hoveredFlyout);
        if (!activeFlyoutGroup) return null;
        const visibleItems = activeFlyoutGroup.items.filter(isItemVisible);
        if (visibleItems.length === 0) return null;

        return createPortal(
          <div
            style={{
              position: "fixed",
              top: `${flyoutPos.top}px`,
              left: `${flyoutPos.left}px`,
              zIndex: 9999,
            }}
            className="w-56 bg-card border border-border-custom rounded-lg shadow-2xl py-2 animate-fade-in space-y-0.5"
            role="menu"
            onMouseEnter={() => {
              if (flyoutTimerRef.current) clearTimeout(flyoutTimerRef.current);
            }}
            onMouseLeave={closeFlyoutWithDelay}
          >
            <div className="px-3 py-1.5 border-b border-border-custom mb-1 flex items-center justify-between">
              <span className="text-[11px] font-bold text-foreground uppercase tracking-wider">
                {activeFlyoutGroup.label}
              </span>
            </div>
            {visibleItems.map((item) => {
              const isActive = item.activePattern
                ? pathname.includes(item.activePattern)
                : pathname === item.href;
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  prefetch={true}
                  role="menuitem"
                  onClick={closeFlyoutImmediate}
                  className={`flex items-center gap-2.5 px-3 py-1.5 text-xs rounded-md transition-all mx-1.5 ${
                    isActive
                      ? "bg-elevated text-foreground font-semibold"
                      : "text-muted hover:text-foreground hover:bg-elevated font-medium"
                  }`}
                >
                  <Icon
                    name={item.iconName}
                    className={`w-4 h-4 shrink-0 ${isActive ? "text-primary" : "text-muted"}`}
                  />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </div>,
          document.body
        );
      })()}
    </>
  );
}
