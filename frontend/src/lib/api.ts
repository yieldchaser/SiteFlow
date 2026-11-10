export const getApiHost = (): string => {
  // Prefer an explicit, deploy-time environment variable so the backend host can
  // be changed without a code change + redeploy. Falls back to the previously
  // hardcoded production host when the var is unset, and keeps the localhost dev
  // fallback for local development.
  const envHost = process.env.NEXT_PUBLIC_API_URL;
  if (envHost && envHost.trim().length > 0) {
    return envHost.trim();
  }
  if (typeof window !== "undefined") {
    const hostname = window.location.hostname;
    if (hostname !== "localhost" && hostname !== "127.0.0.1" && !hostname.startsWith("192.168.")) {
      return "https://construction-erp-backend-73vm.onrender.com";
    }
  }
  return "http://localhost:8000";
};

/**
 * Always read an API error through this. Never put `body.detail` into state
 * directly: FastAPI returns a plain string for HTTPException but an ARRAY OF
 * OBJECTS for request validation errors, and rendering that array as a React
 * child throws "Objects are not valid as a React child" and blanks the route.
 * That is exactly how the wastage screen turned a 422 into a white page.
 */
/**
 * Same normalisation as readErrorDetail, for the many call sites that have
 * already parsed the body for other reasons and only hold `body.detail`.
 */
export function detailToMessage(detail: unknown, fallback: string): string {
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((d: unknown) => {
        if (typeof d === "string") return d;
        if (!d || typeof d !== "object") return "";
        const row = d as { loc?: unknown[]; msg?: string };
        const field = Array.isArray(row.loc)
          ? row.loc.filter((p) => p !== "body" && p !== "query").join(".")
          : "";
        // Pydantic prefixes a check's own message with "Value error, ".
        const msg = (row.msg || "").replace(/^Value error, /, "");
        return field && msg ? `${field}: ${msg}` : msg;
      })
      .filter(Boolean);
    if (parts.length) return parts.join("; ");
  }
  return fallback;
}

export async function readErrorDetail(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data?.detail === "string") return data.detail;
    if (Array.isArray(data?.detail)) {
      // Name the offending field, and list every error rather than only the
      // first, so a multi-field 422 is actionable instead of cryptic.
      const parts = data.detail
        .map((d: unknown) => {
          if (typeof d === "string") return d;
          if (!d || typeof d !== "object") return "";
          const row = d as { loc?: unknown[]; msg?: string };
          const field = Array.isArray(row.loc)
            ? row.loc.filter((p) => p !== "body" && p !== "query").join(".")
            : "";
          // Pydantic prefixes a check's own message with "Value error, ".
          const msg = (row.msg || "").replace(/^Value error, /, "");
          return field && msg ? `${field}: ${msg}` : msg;
        })
        .filter(Boolean);
      if (parts.length) return parts.join("; ");
    }
    return res.statusText || `HTTP ${res.status}`;
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
}

