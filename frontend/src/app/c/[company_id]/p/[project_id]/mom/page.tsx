"use client";
import { useEffect } from "react";
import { useParams } from "next/navigation";
import MomRegister from "@/components/MomRegister";

export default function ProjectMoMPage() {
  const params = useParams();
  const companyId = (params?.company_id as string) || "";
  const projectId = (params?.project_id as string) || "";

  useEffect(() => {
    if (!companyId || companyId === "e0000000-0000-0000-0000-000000000000") {
      if (typeof window !== "undefined") window.location.replace("/login");
    }
  }, [companyId]);

  return <MomRegister companyId={companyId} fixedProjectId={projectId} />;
}
