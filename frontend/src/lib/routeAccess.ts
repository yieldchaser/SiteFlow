// Which permission opens which page. The sidebar hides links a role cannot use;
// this stops the same pages opening from a bookmark or a typed address.
// Any one of the listed keys is enough. Pages not listed are open to every member
// (home, help, chat, minutes, to-do, files).

import { MODULE_LABELS } from "@/lib/rbac";

type Rule = { anyOf: string[]; label: string };

const view = (module: string): Rule => ({ anyOf: [`${module}:view`], label: MODULE_LABELS[module] || module });

// Company-level pages: /c/{company}/{segment} and /c/{company}/d/{segment}.
const COMPANY_PAGES: Record<string, Rule> = {
  dashboard: view("dashboard"),
  analytics: view("reports"),
  reports: view("reports"),
  projects: view("projects"),
  materials: view("procurement"),
  "cost-codes": view("finance"),
  enterprise: view("finance"),
  settings: { anyOf: ["settings:manage", "team:manage"], label: "Settings" },
};

const D_PAGES: Record<string, Rule> = {
  planning: view("planning"),
  "team-action": view("planning"),
  dpr: view("planning"),
  drawings: view("drawings"),
  quality: view("quality"),
  safety: view("safety"),
  labour: view("attendance"),
  attendance: view("attendance"),
  biometric: view("attendance"),
  "face-recognition": view("attendance"),
  equipment: view("equipment"),
  production: view("production"),
  services: view("production"),
  procurement: view("procurement"),
  "three-way": view("procurement"),
  subcon: view("subcontractor"),
  finance: view("finance"),
  depreciation: view("finance"),
  "payment-approval": view("finance"),
  billing: view("billing"),
  budget: view("budgeting"),
  budgeting: view("budgeting"),
  "payroll-attendance": view("payroll"),
  hr: view("payroll"),
  statutory: view("payroll"),
  crm: view("crm"),
  library: view("library"),
  reports: view("reports"),
  "custom-fields": { anyOf: ["settings:manage"], label: "Custom Fields" },
  integrations: { anyOf: ["settings:manage"], label: "Integrations" },
  "delete-logs": { anyOf: ["data:delete"], label: "Delete Logs" },
};

// Project tabs: /c/{company}/p/{project}/{segment}.
const P_PAGES: Record<string, Rule> = {
  boq: view("budgeting"),
  budget: view("budgeting"),
  budgeting: view("budgeting"),
  party: view("finance"),
  transaction: view("finance"),
  finance: view("finance"),
  depreciation: view("finance"),
  billing: view("billing"),
  task: view("planning"),
  planning: view("planning"),
  dpr: view("planning"),
  attendance: view("attendance"),
  labour: view("attendance"),
  "face-recognition": view("attendance"),
  material: view("procurement"),
  procurement: view("procurement"),
  "three-way": view("procurement"),
  subcon: view("subcontractor"),
  equipment: view("equipment"),
  quality: view("quality"),
  safety: view("safety"),
  drawings: view("drawings"),
  production: view("production"),
  hr: view("payroll"),
  statutory: view("payroll"),
  crm: view("crm"),
  reports: view("reports"),
  "custom-fields": { anyOf: ["settings:manage"], label: "Custom Fields" },
};

/** The rule guarding `pathname`, or null when every member may open it. */
export function pageRule(pathname: string): Rule | null {
  const parts = pathname.split("?")[0].split("/").filter(Boolean);
  // ["c", company, section, ...]
  if (parts[0] !== "c" || parts.length < 3) return null;
  const section = parts[2];
  if (section === "d") return D_PAGES[parts[3] ?? ""] ?? null;
  if (section === "p") return P_PAGES[parts[4] ?? ""] ?? null;
  return COMPANY_PAGES[section] ?? null;
}

/** True when a path (link target) is open to someone with these checks. */
export function canOpen(pathname: string, can: (key: string) => boolean): boolean {
  const rule = pageRule(pathname);
  return !rule || rule.anyOf.some((k) => can(k));
}
