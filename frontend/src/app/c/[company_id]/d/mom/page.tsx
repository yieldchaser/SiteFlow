"use client";
import { useEffect } from "react";
import { useParams } from "next/navigation";
import { useProject } from "@/context/ProjectContext";
import MomRegister from "@/components/MomRegister";

export default function MoMPage() {
  const params = useParams();
  const companyId = (params?.company_id as string) || "";
  const { activeProjectId } = useProject();

  useEffect(() => {
    if (!companyId || companyId === "e0000000-0000-0000-0000-000000000000") {
      if (typeof window !== "undefined") window.location.replace("/login");
    }
  }, [companyId]);

  return <MomRegister companyId={companyId} defaultProjectId={activeProjectId} />;
}
