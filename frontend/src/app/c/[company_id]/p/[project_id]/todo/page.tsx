"use client";

import { useParams } from "next/navigation";
import TodoBoard from "@/components/TodoBoard";

export default function ProjectTodoPage() {
  const params = useParams();
  return <TodoBoard companyId={params.company_id as string} fixedProjectId={params.project_id as string} />;
}
