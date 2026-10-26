import { getApiHost } from "@/lib/api";

export const getApi = (path: string): string =>
  `${getApiHost()}/apis/v3${path}`;

export const authHeaders = (): Record<string, string> | undefined => {
  if (typeof window === "undefined") return undefined;
  const token = localStorage.getItem("access_token");
  return token ? { Authorization: `Bearer ${token}` } : undefined;
};

// Document downloads must go through fetch with the bearer token (a plain
// <a href> navigation cannot attach it and the endpoints require one), then
// hand the blob to a programmatic anchor. Throws on non-2xx so callers can
// surface the failure instead of opening an empty tab.
export const downloadWithAuth = async (path: string, fallbackName: string = "document.pdf"): Promise<void> => {
  const res = await fetch(getApi(path), { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") || "";
  const filenameStarMatch = disposition.match(/filename\*=UTF-8''([^;\r\n]+)/i);
  const filenameMatch = disposition.match(/filename="?([^";\r\n]+)"?/i);
  const rawFilename = filenameStarMatch?.[1] || filenameMatch?.[1] || fallbackName;
  const filename = decodeURIComponent(rawFilename);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
};

// Persist a successful auth response (any method: phone, email OTP, Google,
// password) into localStorage the same way the app already reads it elsewhere.
// The token is stored client-side only; it is never placed in a URL.
export const persistAuth = (data: {
  access_token: string;
  user?: { id?: string; name?: string };
  company?: { id?: string } | null;
}): void => {
  if (typeof window === "undefined") return;
  localStorage.setItem("access_token", data.access_token);
  if (data.user?.id) localStorage.setItem("user_id", data.user.id);
  localStorage.setItem("user_name", data.user?.name || "");
  localStorage.setItem("creator_name", data.user?.name || "");
  if (data.company?.id) localStorage.setItem("company_id", data.company.id);
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const resolveCompanyId = async (slug: string): Promise<string> => {
  if (UUID_RE.test(slug)) return slug;
  if (typeof window !== "undefined") {
    const stored = localStorage.getItem("company_slug_mappings");
    const map = stored ? JSON.parse(stored) : {};
    if (map[slug]) return map[slug];
  }
  try {
    const res = await fetch(`${getApiHost()}/apis/v3/auth/resolve-company/${slug}`);
    if (res.ok) return (await res.json()).id;
  } catch {
    /* ignore */
  }
  return slug;
};

// decimalPlaces defaults to 0 to preserve the original rounded-integer
// behavior for the many call sites that don't pass a company's configured
// Company.currency_decimal_places (Settings -> Document & Fields -> Number
// Format). Callers that already have the company/settings object in scope
// can pass it explicitly, e.g. fmtINR(amount, company.currency_decimal_places).
export const fmtINR = (
  n: number | undefined | null,
  decimalPlaces: number = 0
): string => {
  const value = n || 0;
  // Sign goes before the rupee symbol: "-₹1,200", never "₹-1,200".
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (decimalPlaces <= 0) {
    const rounded = Math.round(abs);
    return `${rounded === 0 ? "" : sign}₹${rounded.toLocaleString("en-IN")}`;
  }
  return `${sign}₹${abs.toLocaleString("en-IN", {
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
  })}`;
};

export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || "")
    .join("");

export const toLocalISODate = (date: string | number | Date = new Date()): string => {
  const d = typeof date === "object" && date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return "";
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const todayLocalISO = (): string => toLocalISODate(new Date());

export const toLocalISODateTime = (date: string | number | Date = new Date()): string => {
  const d = typeof date === "object" && date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return "";
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

export const nowLocalISO = (): string => toLocalISODateTime(new Date());

/**
 * Convert a `datetime-local` input value ("2026-09-02T11:55", no zone) into an
 * absolute ISO instant for the wire.
 *
 * toLocalISODateTime / nowLocalISO are for DISPLAY: they answer "what does the
 * clock on this wall say", which is what a date or datetime-local input must be
 * given. Sending that naive string to the API is a different question, and
 * getting the two confused broke safety incident reporting: the backend attaches
 * the SERVER timezone to a naive datetime (safety.py reported_at_not_future),
 * Render runs UTC, so 11:55 IST arrived as 11:55 UTC and every incident was
 * rejected as 5.5 hours in the future.
 *
 * Always pass a datetime-local value through this before putting it in a body.
 */
export const localInputToInstantISO = (value: string): string | null => {
  if (!value) return null;
  // new Date("YYYY-MM-DDTHH:mm") is parsed as LOCAL time by spec, which is what
  // the input meant. toISOString then yields the correct absolute instant.
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
};

export const formatDate = (
  date: string | number | Date | null | undefined,
  fallback: string = "—"
): string => {
  if (!date) return fallback;
  const d = typeof date === "object" && date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return fallback;
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
};

export const formatDateTime = (
  date: string | number | Date | null | undefined,
  fallback: string = "—"
): string => {
  if (!date) return fallback;
  const d = typeof date === "object" && date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return fallback;
  return `${formatDate(d, fallback)} at ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
};

const ACRONYMS = new Set([
  "slm", "wdv", "gst", "igst", "cgst", "sgst", "tds", "pf", "esi", "bocw", "hsn", "sac",
  "po", "wo", "grn", "rfq", "boq", "ncr", "dpr", "ra", "mom", "lti", "ppe", "wbs", "cpm",
  "crm", "gstin", "pan", "tan", "cin", "llpin", "msme", "epf", "esic"
]);

export const formatLabel = (value: string | undefined | null): string => {
  if (!value) return "—";
  const map: Record<string, string> = {
    not_started: "Not Started",
    in_progress: "In Progress",
    under_review: "Under Review",
    partially_completed: "Partially Completed",
    on_hold: "On Hold",
    purchase_order: "Purchase Order",
    goods_receipt_note: "Goods Receipt Note",
    cash_voucher: "Cash Voucher",
    approval_rule: "Approval Rule",
    asset_type: "Asset Type",
    chat_group_member: "Chat Group Member",
    cost_code: "Cost Code",
    crm_lead: "CRM Lead",
    drawing_pin: "Drawing Pin",
    leave_template: "Leave Template",
    library_todo: "Library To Do",
    material_category: "Material Category",
    payment_request: "Payment Request",
    project_member: "Project Member",
    project_party: "Project Party",
    salary_template: "Salary Template",
  };
  const key = String(value).toLowerCase();
  if (map[key]) return map[key];
  return String(value)
    .split("_")
    .map((w) => {
      const lower = w.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");
};

