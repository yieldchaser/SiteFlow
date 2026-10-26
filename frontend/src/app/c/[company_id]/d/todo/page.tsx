"use client";

import { useParams } from "next/navigation";
import TodoBoard from "@/components/TodoBoard";

export default function ToDoPage() {
  const params = useParams();
  return <TodoBoard companyId={params.company_id as string} />;
}
