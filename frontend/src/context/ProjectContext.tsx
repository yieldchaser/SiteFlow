"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { getApiHost } from "@/lib/api";

if (typeof window !== "undefined") {
  if (!(window as any).__originalFetch) {
    (window as any).__originalFetch = window.fetch;
    window.fetch = function (input, init) {
      let url =
        typeof input === "string"
          ? input
          : input instanceof URL
          ? input.toString()
          : (input as Request).url;

      const isApiCall = url.includes("/apis/") || url.includes("localhost:8000") || url.includes("onrender.com");
      if (isApiCall && !url.includes("/resolve-company/")) {
        const stored = localStorage.getItem("company_slug_mappings");
        const slugMap = stored
          ? JSON.parse(stored)
          : { "demo-construction": "e0000000-0000-0000-0000-000000000000" };

        if (!slugMap["demo-construction"]) {
          slugMap["demo-construction"] = "e0000000-0000-0000-0000-000000000000";
        }

        for (const [slug, uuid] of Object.entries(slugMap)) {
          if (url.includes(slug)) {
            url = url.replaceAll(slug, uuid as string);
          }
        }
      }

      if (typeof input === "object" && !(input instanceof URL)) {
        const newRequest = new Request(url, input as Request);
        return (window as any).__originalFetch(newRequest, init);
      }
      return (window as any).__originalFetch(url, init);
    };
  }
}

const isValidUuid = (id: string | null | undefined): boolean =>
  typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim());

export type ProjectRecord = {
  id?: string;
  name?: string;
  project_name?: string;
  code?: string;
  project_code?: string;
};

export type ProjectContextValue = {
  activeProjectId: string;
  setActiveProjectId: (id: string) => void;
  projects: ProjectRecord[];
  projectContext: { name: string; code: string };
  loading: boolean;
  projectsLoadingState: "loading" | "loaded" | "failed";
};

const ProjectContext = createContext<ProjectContextValue | null>(null);

const FALLBACK_PROJECT_ID = "d0000000-0000-0000-0000-000000000001";

function getStoredProjectForCompany(compId: string): string {
  if (typeof window === "undefined" || !compId) return "";

  // 1. Check direct company-scoped key
  const scopedKey = `last_project_id_${compId}`;
  const scopedVal = localStorage.getItem(scopedKey);
  if (scopedVal && isValidUuid(scopedVal) && scopedVal !== FALLBACK_PROJECT_ID) {
    return scopedVal;
  }

  // 2. Check if compId is a slug and has a mapped UUID key
  try {
    const slugMapRaw = localStorage.getItem("company_slug_mappings");
    if (slugMapRaw) {
      const slugMap = JSON.parse(slugMapRaw);
      const uuid = slugMap[compId];
      if (uuid && uuid !== compId) {
        const mappedVal = localStorage.getItem(`last_project_id_${uuid}`);
        if (mappedVal && isValidUuid(mappedVal) && mappedVal !== FALLBACK_PROJECT_ID) {
          return mappedVal;
        }
      }
    }
  } catch {}

  // 3. Check legacy pair: last_project_company_id === compId
  const pairComp = localStorage.getItem("last_project_company_id");
  const pairProj = localStorage.getItem("last_project_id");
  if (pairComp === compId && pairProj && isValidUuid(pairProj) && pairProj !== FALLBACK_PROJECT_ID) {
    return pairProj;
  }

  return "";
}

function setStoredProjectForCompany(compId: string, projId: string, companyUuid?: string) {
  if (typeof window === "undefined" || !compId) return;

  if (projId && isValidUuid(projId) && projId !== FALLBACK_PROJECT_ID) {
    localStorage.setItem(`last_project_id_${compId}`, projId);
    if (companyUuid && companyUuid !== compId) {
      localStorage.setItem(`last_project_id_${companyUuid}`, projId);
    }
    localStorage.setItem("last_project_company_id", compId);
    localStorage.setItem("last_project_id", projId);
  } else {
    localStorage.removeItem(`last_project_id_${compId}`);
    if (companyUuid) {
      localStorage.removeItem(`last_project_id_${companyUuid}`);
    }
    const currentPairComp = localStorage.getItem("last_project_company_id");
    if (currentPairComp === compId || (companyUuid && currentPairComp === companyUuid)) {
      localStorage.removeItem("last_project_company_id");
      localStorage.removeItem("last_project_id");
    }
  }
}

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const searchParams = useSearchParams();

  const urlCompanyId = (params?.company_id as string) || "";

  const [activeProjectId, setActiveProjectIdState] = useState<string>(() => {
    if (typeof window === "undefined" || !urlCompanyId) return "";
    return getStoredProjectForCompany(urlCompanyId);
  });
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectContext, setProjectContext] = useState<{ name: string; code: string }>({
    name: "Project Context",
    code: "",
  });
  const [loading, setLoading] = useState(true);
  const [projectsLoadingState, setProjectsLoadingState] = useState<"loading" | "loaded" | "failed">("loading");

  // Project-module redirects carry the originating project as ?project=<id>.
  // Prefer it over the persisted selection so a screen opened from inside a
  // project scopes to that project instead of whatever was last active.
  // Only well-formed ids are accepted; anything else falls through.
  const rawQueryProjectId = searchParams.get("project") || "";
  const queryProjectId = isValidUuid(rawQueryProjectId) ? rawQueryProjectId : "";

  useEffect(() => {
    let isActive = true;

    const companyId =
      (params.company_id as string) || "e0000000-0000-0000-0000-000000000000";
    const routeProjectId = (params.project_id as string) || "";
    const validRouteProjectId = isValidUuid(routeProjectId) ? routeProjectId : "";

    // Clear active project immediately on company switch if stored ID belongs to another company
    if (typeof window !== "undefined" && companyId) {
      const storedCompany = localStorage.getItem("company_id");
      if (storedCompany && storedCompany !== companyId) {
        localStorage.setItem("company_id", companyId);
        const scopedId = getStoredProjectForCompany(companyId);
        if (!scopedId && !validRouteProjectId && !queryProjectId) {
          setActiveProjectIdState("");
          setProjectContext({ name: "Project Context", code: "" });
        }
      } else if (!storedCompany) {
        localStorage.setItem("company_id", companyId);
      }
    }

    const token =
      typeof window !== "undefined" ? localStorage.getItem("access_token") : null;
    const authHeaders = token ? { Authorization: `Bearer ${token}` } : undefined;
    const apiHost = getApiHost();

    const applyProject = (project: ProjectRecord) => {
      if (!isActive || !project) return;
      const resolvedName = project.name || project.project_name || "Active Project";
      const resolvedCode = project.code || project.project_code || "";
      setProjectContext({ name: resolvedName, code: resolvedCode });
      setActiveProjectIdState(project.id || "");
    };

    const resolve = async () => {
      if (isActive) setProjectsLoadingState("loading");
      let activeCompanyUuid = companyId;
      const isUuid = isValidUuid(companyId);
      if (!isUuid) {
        const stored = localStorage.getItem("company_slug_mappings");
        const slugMap = stored ? JSON.parse(stored) : {};
        if (slugMap[companyId] && isValidUuid(slugMap[companyId])) {
          activeCompanyUuid = slugMap[companyId];
        } else {
          try {
            const res = await (window as any).__originalFetch(`${apiHost}/apis/v3/auth/resolve-company/${companyId}`);
            if (res.ok) {
              const data = await res.json();
              if (isValidUuid(data.id)) {
                activeCompanyUuid = data.id;
                slugMap[companyId] = activeCompanyUuid;
                localStorage.setItem("company_slug_mappings", JSON.stringify(slugMap));
              }
            }
          } catch (e) {
            console.error("Failed to resolve slug", e);
          }
        }
      }

      // Fetch the full project list for the company to validate ownership
      if (isValidUuid(activeCompanyUuid)) {
        try {
          const res = await fetch(
            `${apiHost}/apis/v3/planning/projects?company_id=${activeCompanyUuid}`,
            { headers: authHeaders }
          );
          if (res.ok) {
            const data: unknown = await res.json();
            const payload = data as { data?: unknown; projects?: unknown };
            const list: ProjectRecord[] = Array.isArray(data)
              ? (data as ProjectRecord[])
              : Array.isArray(payload.data)
                ? (payload.data as ProjectRecord[])
                : Array.isArray(payload.projects)
                  ? (payload.projects as ProjectRecord[])
                  : [];
            if (isActive) {
              setProjects(list);
              setProjectsLoadingState("loaded");
            }

            // Determine candidate: route parameter, query parameter, or company-scoped stored selection
            const storedCandidate = getStoredProjectForCompany(activeCompanyUuid) || getStoredProjectForCompany(companyId);
            const candidateProjectId = validRouteProjectId || queryProjectId || storedCandidate || "";

            // Validate ownership: candidate MUST belong to this company's project list.
            // With nothing remembered (a new device, a newly added member) pick the
            // first project, which is also what the sidebar picker shows; otherwise
            // project-scoped screens such as Attendance open with no project at all.
            const matched =
              (candidateProjectId ? list.find((p) => p?.id === candidateProjectId) : undefined) ||
              list.find((p) => isValidUuid(p?.id));

            if (matched && matched.id) {
              setStoredProjectForCompany(companyId, matched.id, activeCompanyUuid);
              applyProject(matched);
            } else {
              // Failed ownership check or no project selected -> clear selection
              setStoredProjectForCompany(companyId, "", activeCompanyUuid);
              if (isActive) {
                setActiveProjectIdState("");
                setProjectContext({ name: "Project Context", code: "Unavailable" });
              }
            }
          } else if (isActive) {
            setProjectsLoadingState("failed");
            setActiveProjectIdState("");
            setProjectContext({ name: "Project Context", code: "Unavailable" });
          }
        } catch {
          if (isActive) {
            setProjectsLoadingState("failed");
            setActiveProjectIdState("");
            setProjectContext({ name: "Project Context", code: "Unavailable" });
          }
        } finally {
          if (isActive) setLoading(false);
        }
      } else {
        if (isActive) {
          setProjectsLoadingState("failed");
          setActiveProjectIdState("");
          setLoading(false);
        }
      }
    };

    resolve();

    return () => {
      isActive = false;
    };
  }, [params.company_id, params.project_id, queryProjectId]);

  const setActiveProjectId = (id: string) => {
    const compId = (params.company_id as string) || "";
    const chosen = projects.find((p) => p.id === id);
    if (chosen && chosen.id) {
      setActiveProjectIdState(chosen.id);
      setStoredProjectForCompany(compId, chosen.id);
      setProjectContext({
        name: chosen.name || chosen.project_name || "Active Project",
        code: chosen.code || chosen.project_code || "",
      });
    } else if (!id) {
      setActiveProjectIdState("");
      setStoredProjectForCompany(compId, "");
      setProjectContext({
        name: "Project Context",
        code: "Unavailable",
      });
    }
  };

  return (
    <ProjectContext.Provider
      value={{ activeProjectId, setActiveProjectId, projects, projectContext, loading, projectsLoadingState }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error("useProject must be used within a ProjectProvider");
  }
  return ctx;
}
