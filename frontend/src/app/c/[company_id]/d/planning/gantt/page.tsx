"use client";
import {  getApiHost , readErrorDetail } from "@/lib/api";
import { authHeaders, formatLabel, toLocalISODate } from "@/lib/siteflow";

import React, { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { useProject } from "@/context/ProjectContext";
import Icon, { type IconName } from "@/components/marketing/Icon";

import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import SegmentedTabs from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import FieldHint from "@/components/ui/FieldHint";

interface Task {
  id: string;
  name: string;
  duration_days: number;
  start_date: string;
  end_date: string;
  status: string;
  priority: string;
  parent_id?: string;
  boq_item_id?: string;
  is_critical?: boolean;
  baseline_start?: string;
  baseline_end?: string;
  progress?: number;
}

interface TaskTreeNode extends Task {
  children?: TaskTreeNode[];
}

interface Milestone {
  id: string;
  name: string;
  milestone_date: string;
  type: "start" | "handover" | "inspection" | "payment" | "critical";
  status: "upcoming" | "achieved" | "delayed";
  description: string;
}

interface LookaheadTask {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
  priority: string;
  progress: number;
  is_critical: boolean;
  assigned_to_name?: string;
}

interface TodoItem {
  id: string;
  task_id: string;
  title: string;
  is_completed: boolean;
  created_at: string;
}

interface CommentItem {
  id: string;
  task_id: string;
  user_name: string;
  message_text?: string;
  media_url?: string;
  voice_note_url?: string;
  progress_qty_added?: number;
  created_at: string;
}

const fmtDate = (iso?: string): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d.getDate()).padStart(2, "0")} ${m[d.getMonth()]} ${d.getFullYear()}`;
};

// Safe evaluation of mathematical formulas typed by field workers (e.g. 2+3+6)
const evaluateFormula = (str: string): number => {
  try {
    if (!str || !str.trim()) return 0;
    const cleaned = str.replace(/[^0-9+\-*/().\s]/g, "").trim();
    if (!cleaned) return 0;
    const tokens = cleaned.split(/\s+/);
    const stack: number[] = [];
    const ops: string[] = [];
    const precedence: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };
    const applyOp = () => {
      if (stack.length < 2 || ops.length === 0) return;
      const op = ops.pop()!;
      const b = stack.pop()!;
      const a = stack.pop()!;
      let r = 0;
      switch (op) {
        case '+': r = a + b; break;
        case '-': r = a - b; break;
        case '*': r = a * b; break;
        case '/': r = b === 0 ? 0 : a / b; break;
      }
      stack.push(r);
    };
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '(') {
        ops.push(t);
      } else if (t === ')') {
        while (ops.length > 0 && ops[ops.length - 1] !== '(') applyOp();
        if (ops.length > 0) ops.pop();
      } else if (precedence[t] !== undefined) {
        while (ops.length > 0 && precedence[ops[ops.length - 1]] !== undefined && precedence[ops[ops.length - 1]] >= precedence[t]) {
          applyOp();
        }
        ops.push(t);
      } else {
        const n = parseFloat(t);
        if (!isNaN(n)) stack.push(n);
      }
    }
    while (ops.length > 0) applyOp();
    return stack.length > 0 && !isNaN(stack[0]) ? stack[0] : 0;
  } catch {
    return 0;
  }
};

export default function GanttSchedulerPage() {
  const params = useParams();
  const companyId = params?.company_id as string;
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setErrorState] = useState("");
  const [success, setSuccessState] = useState("");
  // Only the latest outcome shows: a new error replaces an old success and vice versa.
  const setError = (msg: string) => { setErrorState(msg); if (msg) setSuccessState(""); };
  const setSuccess = (msg: string) => { setSuccessState(msg); if (msg) setErrorState(""); };
  const [mainTab, setMainTab] = useState<"wbs" | "milestones" | "baseline" | "lookahead">("wbs");
  const [isOffline, setIsOffline] = useState(false);

  // Real data from the planning backend (no fabricated placeholders)
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [lookahead, setLookahead] = useState<LookaheadTask[]>([]);
  const [listLoading, setListLoading] = useState(false);

  // Milestone create and edit state
  const [msName, setMsName] = useState("");
  const [msDate, setMsDate] = useState("");
  const [msType, setMsType] = useState<Milestone["type"]>("start");
  const [msStatus, setMsStatus] = useState<Milestone["status"]>("upcoming");
  const [msDesc, setMsDesc] = useState("");
  const [editingMilestone, setEditingMilestone] = useState<Milestone | null>(null);
  const [baselineSaving, setBaselineSaving] = useState(false);

  // Hierarchy and view mode
  const [taskViewMode, setTaskViewMode] = useState<"flat" | "tree">("flat");
  const [hierarchy, setHierarchy] = useState<TaskTreeNode[]>([]);

  const handleSetBaseline = async () => {
    if (!projectId) return;
    setBaselineSaving(true);
    try {
      const apiHost = getApiHost();
      const res = await fetch(`${apiHost}/apis/v3/planning/projects/${projectId}/baseline`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const count = typeof data.tasks_updated === "number" ? data.tasks_updated : null;
        setSuccess(count !== null ? `Froze baseline for ${count} task${count === 1 ? "" : "s"}.` : "Baseline saved successfully");
        fetchTasks();
        fetchHierarchy();
      } else {
        const err = await readErrorDetail(res);
        setError(err || 'Action failed');
      }
    } catch (err) {
      console.error(err);
    } finally {
      setBaselineSaving(false);
    }
  };

  const handleSetTaskBaseline = async (taskId: string) => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/planning/tasks/${taskId}/set-baseline`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      });
      if (res.ok) {
        setSuccess("Task baseline frozen successfully!");
        fetchTasks();
        fetchHierarchy();
      } else {
        const err = await readErrorDetail(res);
        setError(err || "Failed to freeze task baseline.");
      }
    } catch {
      setError("Connection error.");
    }
  };

  // Form states for creating task
  const [taskName, setTaskName] = useState("");
  const [duration, setDuration] = useState(5);
  const [startDate, setStartDate] = useState("");
  const [priority, setPriority] = useState("medium");

  // Form states for adding predecessor
  const [selectedTaskForLink, setSelectedTaskForLink] = useState("");
  const [selectedPredecessor, setSelectedPredecessor] = useState("");

  // Task Details Drawer
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [comments, setComments] = useState<CommentItem[]>([]);
  
  // New subtask / checklist state
  const [newTodoTitle, setNewTodoTitle] = useState("");
  
  // New comment state
  const [newCommentText, setNewCommentText] = useState("");
  
  // Progress posting with simulated Measurement Book takeoff
  const [progressQty, setProgressQty] = useState<string>("");
  const [useTakeoff, setUseTakeoff] = useState(false);
  const [takeoffN, setTakeoffN] = useState<number>(1);
  const [takeoffL, setTakeoffL] = useState<number>(1);
  const [takeoffW, setTakeoffW] = useState<number>(1);
  const [takeoffH, setTakeoffH] = useState<number>(1);

  // Voice recording states
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);

  const fetchTasks = async () => {
    try {
      setLoading(true);
      setError("");
      setIsOffline(false);
      const res = await fetch(`${getApiHost()}/apis/v3/planning/tasks?project_id=${projectId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setTasks(data);
        } else {
          throw new Error("Invalid response format");
        }
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (e) {
      console.error("Tasks API unavailable", e);
      setIsOffline(true);
    } finally {
      setLoading(false);
    }
  };

  const fetchHierarchy = async () => {
    if (!projectId) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/planning/tasks/hierarchy/${projectId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setHierarchy(Array.isArray(data) ? data : []);
      } else {
        setHierarchy([]);
      }
    } catch {
      setHierarchy([]);
    }
  };

  useEffect(() => {
    if (projectId) {
      fetchTasks();
      fetchMilestones();
      fetchLookahead();
      fetchHierarchy();
    }
  }, [projectId]);

  const fetchMilestones = async () => {
    if (!projectId) return;
    try {
      setListLoading(true);
      const res = await fetch(`${getApiHost()}/apis/v3/planning/milestones?project_id=${projectId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setMilestones(Array.isArray(data) ? data : []);
      } else {
        setMilestones([]);
      }
    } catch {
      setMilestones([]);
    } finally {
      setListLoading(false);
    }
  };

  const fetchLookahead = async () => {
    if (!projectId) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/planning/tasks/lookahead?project_id=${projectId}&days=14`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setLookahead(Array.isArray(data) ? data : []);
      } else {
        setLookahead([]);
      }
    } catch {
      setLookahead([]);
    }
  };

  const handleCreateMilestone = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!msName.trim() || !msDate) {
      setError("Milestone name and date are required.");
      return;
    }
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/planning/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          project_id: projectId,
          name: msName,
          milestone_date: msDate,
          type: msType,
          status: msStatus,
          description: msDesc,
        }),
      });
      if (res.ok) {
        setMsName("");
        setMsDate("");
        setMsDesc("");
        setMsStatus("upcoming");
        setMsType("start");
        setSuccess("Milestone created successfully!");
        fetchMilestones();
      } else {
        setError("Failed to create milestone.");
      }
    } catch {
      setError("Connection error.");
    }
  };

  const handleUpdateMilestone = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMilestone) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/planning/milestones/${editingMilestone.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          name: editingMilestone.name,
          milestone_date: editingMilestone.milestone_date,
          type: editingMilestone.type,
          status: editingMilestone.status,
          description: editingMilestone.description,
        }),
      });
      if (res.ok) {
        setEditingMilestone(null);
        setSuccess("Milestone updated successfully!");
        fetchMilestones();
      } else {
        const err = await readErrorDetail(res);
        setError(err || "Failed to update milestone.");
      }
    } catch {
      setError("Connection error.");
    }
  };

  const handleDeleteMilestone = async (id: string) => {
    if (!confirm("Are you sure you want to delete this milestone?")) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/planning/milestones/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (res.ok) {
        setSuccess("Milestone deleted successfully!");
        fetchMilestones();
      } else {
        const err = await readErrorDetail(res);
        setError(err || "Failed to delete milestone.");
      }
    } catch {
      setError("Connection error.");
    }
  };

  // Load Task Details (checklists, feed/comments)
  const handleOpenDrawer = async (task: Task) => {
    setSelectedTask(task);
    setTodos([]);
    setComments([]);
    setProgressQty("");
    setUseTakeoff(false);

    // 1. Fetch Todos
    try {
      const todoRes = await fetch(`${getApiHost()}/apis/v3/planning/tasks/${task.id}/todos`, { headers: authHeaders() });
      if (todoRes.ok) {
        setTodos(await todoRes.json());
      } else {
        setTodos([]);
      }
    } catch {
      setTodos([]);
    }

    // 2. Fetch Comments
    try {
      const commRes = await fetch(`${getApiHost()}/apis/v3/planning/tasks/${task.id}/comments`, { headers: authHeaders() });
      if (commRes.ok) {
        setComments(await commRes.json());
      } else {
        setComments([]);
      }
    } catch {
      setComments([]);
    }
  };

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskName.trim() || !startDate) {
      setError("Task name and start date are required.");
      return;
    }

    try {
      const res = await fetch(`${getApiHost()}/apis/v3/planning/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          project_id: projectId,
          name: taskName,
          duration_days: duration,
          start_date: startDate,
          priority: priority,
          status: "pending"
        }),
      });

      if (res.ok) {
        setTaskName("");
        setStartDate("");
        setSuccess("Task created successfully!");
        fetchTasks();
      } else {
        setError("Failed to create task.");
      }
    } catch (e) {
      setError("Connection error.");
    }
  };

  const handleAddPredecessor = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTaskForLink || !selectedPredecessor) return;

    try {
      const res = await fetch(`${getApiHost()}/apis/v3/planning/tasks/${selectedTaskForLink}/predecessors`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          predecessor_id: selectedPredecessor
        }),
      });

      if (res.ok) {
        setSuccess("Task link recorded successfully!");
        setSelectedTaskForLink("");
        setSelectedPredecessor("");
        fetchTasks();
      } else {
        const err = await res.json().catch(() => ({}));
        const detail = typeof err.detail === "string" ? err.detail : `HTTP ${res.status}`;
        setError(detail.toLowerCase().includes("circular") ? "Link loop detected. Predecessor rejected." : `Failed to add task link: ${detail}`);
      }
    } catch (e) {
      setError("Connection error.");
    }
  };

  // Add todo subtask
  const handleAddTodo = async () => {
    if (!selectedTask || !newTodoTitle.trim()) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/planning/tasks/${selectedTask.id}/todos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ title: newTodoTitle.trim() }),
      });
      if (res.ok) {
        const added = await res.json();
        setTodos([...todos, added]);
        setNewTodoTitle("");
      } else {
        const err = await readErrorDetail(res);
        setError(err || 'Action failed');
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Toggle todo subtask
  const handleToggleTodo = async (todoId: string) => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/planning/tasks/todos/${todoId}/toggle`, {
        method: "PATCH",
        headers: authHeaders(),
      });
      if (res.ok) {
        const updated = await res.json();
        setTodos(todos.map(t => t.id === todoId ? updated : t));
      } else {
        const err = await readErrorDetail(res);
        setError(err || 'Action failed');
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Delete todo
  const handleDeleteTodo = async (todoId: string) => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/planning/tasks/todos/${todoId}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (res.ok) {
        setTodos(todos.filter(t => t.id !== todoId));
      } else {
        const err = await readErrorDetail(res);
        setError(err || 'Action failed');
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Delete task
  const handleDeleteTask = async (taskId: string) => {
    if (!confirm("Are you sure you want to delete this task? All subtask relationships and dependencies will be removed.")) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/planning/tasks/${taskId}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (res.ok) {
        if (selectedTask?.id === taskId) {
          setSelectedTask(null);
        }
        fetchTasks();
      } else {
        const err = await readErrorDetail(res);
        setError(err || 'Action failed');
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Save comment or progress log
  const handleSaveComment = async (customVoiceUrl?: string) => {
    if (!selectedTask) return;
    if (!newCommentText && !progressQty && !customVoiceUrl) return;

    try {
      const evaluatedQty = progressQty ? evaluateFormula(progressQty) : null;
      // No identity in the body: the server stamps the authenticated user as
      // the comment author, so the feed can never be signed by a fabricated name.
      const body = {
        message_text: newCommentText || (customVoiceUrl ? "Voice note logged" : `Logged progress takeoff: ${evaluatedQty}`),
        progress_qty_added: evaluatedQty,
        voice_note_url: customVoiceUrl || null
      };

      const res = await fetch(`${getApiHost()}/apis/v3/planning/tasks/${selectedTask.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const added = await res.json();
        setComments([...comments, added]);
        setNewCommentText("");
        setProgressQty("");
        setUseTakeoff(false);
      } else {
        const err = await readErrorDetail(res);
        setError(err || 'Action failed');
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Evaluate Takeoff dimension math
  useEffect(() => {
    if (useTakeoff) {
      const val = takeoffN * takeoffL * takeoffW * takeoffH;
      setProgressQty(val.toFixed(2));
    }
  }, [useTakeoff, takeoffN, takeoffL, takeoffW, takeoffH]);

  // Simulate Voice note recording
  const startRecording = () => {
    setIsRecording(true);
    setRecordingSeconds(0);
    const interval = setInterval(() => {
      setRecordingSeconds(prev => {
        if (prev >= 4) {
          clearInterval(interval);
          setIsRecording(false);
          // Auto save voice comment
          handleSaveComment("https://siteflow-voice-records.s3.amazonaws.com/rec-0051.mp3");
          return 0;
        }
        return prev + 1;
      });
    }, 1000);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title="Project Scheduler & WBS"
        subtitle="Work breakdown structure, milestone baselines and 14-day lookahead"
        action={
          mainTab === "milestones" ? (
            <button
              onClick={() => {
                document.getElementById("milestone-form")?.scrollIntoView({ behavior: "smooth" });
                document.getElementById("ms-name-input")?.focus();
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-primary hover:bg-primary/95 text-white rounded-md text-xs font-semibold transition-all cursor-pointer"
            >
              <Icon name="flag_checkered" className="w-3.5 h-3.5" />
              Add Milestone
            </button>
          ) : mainTab === "wbs" ? (
            <button
              onClick={() => {
                document.getElementById("task-form")?.scrollIntoView({ behavior: "smooth" });
                document.getElementById("task-title-input")?.focus();
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-primary hover:bg-primary/95 text-white rounded-md text-xs font-semibold transition-all cursor-pointer"
            >
              <Icon name="clipboard" className="w-3.5 h-3.5" />
              Create WBS Task
            </button>
          ) : null
        }
      />

      {/* Top bar with Navigation */}
      <div className="px-6 py-2 border-b border-border-custom bg-card shrink-0 overflow-x-auto">
        <SegmentedTabs
          tabs={[
            { id: "wbs", label: "WBS Tasks", icon: <Icon name="clipboard" className="w-3.5 h-3.5" /> },
            { id: "milestones", label: "Milestones", icon: <Icon name="flag_checkered" className="w-3.5 h-3.5" /> },
            { id: "baseline", label: "Baseline", icon: <Icon name="bar_chart" className="w-3.5 h-3.5" /> },
            { id: "lookahead", label: "14-Day Lookahead", icon: <Icon name="calendar" className="w-3.5 h-3.5" /> },
          ]}
          activeTab={mainTab}
          onChange={(t) => setMainTab(t as any)}
        />
      </div>

      {/* Content Workspace */}
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">
          <div className="p-6 space-y-6">
          {error && <div className="bg-danger/10 border border-danger/20 text-danger text-xs p-3 rounded-md">{error}</div>}
          {success && <div className="bg-success/10 border border-success/20 text-success text-xs p-3 rounded-md">{success}</div>}

          {/* ── MILESTONES TAB ── */}
          {mainTab === "milestones" && (
            <div className="space-y-3">
              <div className="text-xs text-muted mb-4">Project milestone tracker: key deliverables, inspections, and payment events.</div>

              {milestones.map(m => {
                const colors = {
                  start: "border-info/20 bg-info/5",
                  handover: "border-success/20 bg-success/5",
                  inspection: "border-warning/20 bg-warning/5",
                  payment: "border-primary/30 bg-primary/5",
                  critical: "border-danger/20 bg-danger/5",
                };
                const statusCls = m.status === "achieved" ? "bg-success/10 border-success/20 text-success" : m.status === "delayed" ? "bg-danger/10 border-danger/20 text-danger" : "bg-elevated/30 border-border-custom/20 text-muted";
                const icon: Record<Milestone["type"], IconName> = { start: "rocket", handover: "flag_checkered", inspection: "search", payment: "money_bag", critical: "warning" };
                return (
                  <div key={m.id} className={`flex items-start gap-4 p-4 rounded-md border ${colors[m.type]}`}>
                    <div className="flex flex-col items-center gap-1 shrink-0">
                      <div className="w-8 h-8 rounded-lg bg-elevated border border-border-custom flex items-center justify-center"><Icon name={icon[m.type]} className="w-4 h-4" /></div>
                      <div className="text-[9px] font-sans text-muted">{fmtDate(m.milestone_date)}</div>
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-bold text-foreground text-xs">{m.name}</span>
                        <span className={`text-[8px] px-1.5 py-0.5 rounded border font-bold ${statusCls}`}>{m.status.toUpperCase()}</span>
                      </div>
                      <p className="text-[11px] text-muted">{m.description}</p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => setEditingMilestone(m)}
                        className="px-2.5 py-1 bg-elevated hover:bg-card border border-border-custom text-foreground rounded text-[10px] font-semibold cursor-pointer"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteMilestone(m.id)}
                        className="px-2.5 py-1 bg-elevated hover:bg-danger/10 border border-border-custom text-muted hover:text-danger rounded text-[10px] font-semibold cursor-pointer"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })}

              {!listLoading && milestones.length === 0 && (
                <EmptyState
                  title="No milestones logged for this project yet"
                  description="Add key stage gates and contractual completion milestones below."
                />
              )}

              {/* Create Milestone */}
              <form id="milestone-form" onSubmit={handleCreateMilestone} className="mt-4 bg-card border border-border-custom rounded-lg p-4 space-y-3">
                <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">Add Milestone</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                  <div className="col-span-2 space-y-1">
                    <label className="text-muted font-semibold">Milestone Name</label>
                    <input
                      id="ms-name-input"
                      type="text"
                      value={msName}
                      onChange={(e) => setMsName(e.target.value)}
                      placeholder="Foundation complete, RA Bill #3..."
                      className="w-full bg-elevated border border-border-custom rounded-lg p-2 text-foreground focus:outline-none focus:border-primary/50"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-muted font-semibold">Date</label>
                    <input
                      type="date"
                      value={msDate}
                      onChange={(e) => setMsDate(e.target.value)}
                      className="w-full bg-elevated border border-border-custom rounded-lg p-2 text-foreground focus:outline-none"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-muted font-semibold">Type</label>
                    <select
                      value={msType}
                      onChange={(e) => setMsType(e.target.value as Milestone["type"])}
                      className="w-full bg-elevated border border-border-custom rounded-lg p-2 text-foreground"
                    >
                      <option value="start">Start</option>
                      <option value="inspection">Inspection</option>
                      <option value="critical">Critical</option>
                      <option value="payment">Payment</option>
                      <option value="handover">Handover</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-muted font-semibold">Status</label>
                    <select
                      value={msStatus}
                      onChange={(e) => setMsStatus(e.target.value as Milestone["status"])}
                      className="w-full bg-elevated border border-border-custom rounded-lg p-2 text-foreground"
                    >
                      <option value="pending">Pending</option>
                      <option value="achieved">Achieved</option>
                      <option value="delayed">Delayed</option>
                    </select>
                  </div>
                  <div className="col-span-2 space-y-1">
                    <label className="text-muted font-semibold">Scope & Description</label>
                    <input
                      type="text"
                      value={msDesc}
                      onChange={(e) => setMsDesc(e.target.value)}
                      placeholder="Optional details, sign-off criteria..."
                      className="w-full bg-input border border-border-custom rounded px-3 py-1.5 text-foreground"
                    />
                  </div>
                </div>
                <div className="flex justify-end">
                  <button type="submit" className="px-4 py-2 bg-primary text-white font-bold rounded-lg text-xs hover:opacity-90">
                    Save Milestone
                  </button>
                </div>
              </form>

              {/* Edit Milestone Modal */}
              {editingMilestone && (
                <div className="fixed inset-0 bg-background/80 flex items-center justify-center z-50 p-4">
                  <div className="w-full max-w-md bg-card border border-border-custom rounded-lg overflow-hidden shadow-lg animate-in fade-in zoom-in-95 duration-150">
                    <div className="p-4 border-b border-border-custom flex justify-between items-center">
                      <h3 className="text-xs font-semibold text-foreground uppercase tracking-wider">Edit Milestone</h3>
                      <button onClick={() => setEditingMilestone(null)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-4 h-4" /></button>
                    </div>
                    <form onSubmit={handleUpdateMilestone} className="p-4 space-y-3 text-xs">
                      <div className="space-y-1">
                        <label className="text-muted font-semibold">Milestone Name *</label>
                        <input
                          type="text"
                          required
                          value={editingMilestone.name}
                          onChange={(e) => setEditingMilestone({ ...editingMilestone, name: e.target.value })}
                          className="w-full bg-elevated border border-border-custom rounded-lg p-2 text-foreground focus:outline-none"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-muted font-semibold">Date *</label>
                        <input
                          type="date"
                          required
                          value={editingMilestone.milestone_date ? toLocalISODate(editingMilestone.milestone_date) : ""}
                          onChange={(e) => setEditingMilestone({ ...editingMilestone, milestone_date: e.target.value })}
                          className="w-full bg-elevated border border-border-custom rounded-lg p-2 text-foreground focus:outline-none"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <label className="text-muted font-semibold">Type</label>
                          <select
                            value={editingMilestone.type}
                            onChange={(e) => setEditingMilestone({ ...editingMilestone, type: e.target.value as Milestone["type"] })}
                            className="w-full bg-elevated border border-border-custom rounded-lg p-2 text-foreground"
                          >
                            <option value="start">Start</option>
                            <option value="inspection">Inspection</option>
                            <option value="payment">Payment</option>
                            <option value="handover">Handover</option>
                            <option value="critical">Critical</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="text-muted font-semibold">Status</label>
                          <select
                            value={editingMilestone.status}
                            onChange={(e) => setEditingMilestone({ ...editingMilestone, status: e.target.value as Milestone["status"] })}
                            className="w-full bg-elevated border border-border-custom rounded-lg p-2 text-foreground"
                          >
                            <option value="upcoming">Upcoming</option>
                            <option value="achieved">Achieved</option>
                            <option value="delayed">Delayed</option>
                          </select>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <label className="text-muted font-semibold">Description</label>
                        <textarea
                          value={editingMilestone.description || ""}
                          onChange={(e) => setEditingMilestone({ ...editingMilestone, description: e.target.value })}
                          className="w-full bg-elevated border border-border-custom rounded-lg p-2 text-foreground text-xs focus:outline-none"
                          rows={2}
                        />
                      </div>
                      <div className="flex gap-2 justify-end pt-2">
                        <button
                          type="button"
                          onClick={() => setEditingMilestone(null)}
                          className="px-3 py-1.5 bg-elevated hover:bg-elevated/80 border border-border-custom text-muted rounded-md font-semibold cursor-pointer"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          className="px-4 py-1.5 bg-primary hover:bg-primary/90 text-white rounded-md font-semibold cursor-pointer"
                        >
                          Save Changes
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── BASELINE TAB ── */}
          {mainTab === "baseline" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-bold text-foreground">Active Schedule vs. Approved Baseline</h3>
                  <p className="text-[10px] text-muted mt-0.5">Tracking schedule variance (SV) and critical path slippage against target dates</p>
                </div>
                <button
                  onClick={handleSetBaseline}
                  disabled={baselineSaving}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 bg-primary/10 hover:bg-primary/20 border border-primary/20 text-primary rounded-lg text-xs font-bold transition-all disabled:opacity-50"
                >
                  <Icon name="camera" className="w-3.5 h-3.5" />
                  {baselineSaving ? "Freezing..." : "Freeze New Baseline"}
                </button>
              </div>

              {tasks.map(t => {
                const bStart = t.baseline_start ? new Date(t.baseline_start).getTime() : null;
                const pStart = new Date(t.start_date).getTime();
                const diffDays = bStart ? Math.round((pStart - bStart) / (1000 * 60 * 60 * 24)) : 0;
                return (
                  <div key={t.id} className="bg-input border border-border-custom rounded-md p-4 flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-foreground">{t.name}</span>
                        {t.is_critical && <span className="text-[8px] bg-danger/10 border border-danger/20 text-danger px-1.5 py-0.5 rounded font-bold">CRITICAL</span>}
                      </div>
                      <div className="text-[10px] text-muted mt-1 space-x-3 font-sans">
                        <span>Planned: {fmtDate(t.start_date)} → {fmtDate(t.end_date)}</span>
                        {t.baseline_start && (
                          <span className="text-muted">Baseline: {fmtDate(t.baseline_start)} → {fmtDate(t.baseline_end)}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div>
                        {bStart ? (
                          diffDays === 0 ? (
                            <span className="text-[10px] text-success font-bold font-sans">ON TARGET</span>
                          ) : diffDays > 0 ? (
                            <span className="text-[10px] text-danger font-bold font-sans">+{diffDays}d DELAY</span>
                          ) : (
                            <span className="text-[10px] text-info font-bold font-sans">{diffDays}d AHEAD</span>
                          )
                        ) : (
                          <span className="text-[9px] text-muted italic">No baseline set</span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleSetTaskBaseline(t.id)}
                        className="px-2.5 py-1 bg-elevated hover:bg-card border border-border-custom text-foreground rounded text-[10px] font-semibold cursor-pointer whitespace-nowrap"
                        title="Snapshot baseline for this task"
                      >
                        Set Baseline
                      </button>
                    </div>
                  </div>
                );
              })}
              {tasks.length === 0 && (
                <EmptyState
                  title="No WBS tasks yet"
                  description="Create tasks in the WBS tab to see planned vs actual and freeze schedule baselines."
                  action={{
                    label: "Go to WBS Tasks",
                    onClick: () => setMainTab("wbs"),
                  }}
                />
              )}
            </div>
          )}

          {/* ── LOOKAHEAD TAB ── */}
          {mainTab === "lookahead" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xs font-bold text-foreground">14-Day Lookahead Schedule</h3>
                  <p className="text-[10px] text-muted mt-0.5">Rolling 2-week plan derived from real scheduled tasks</p>
                </div>
                <div className="text-[10px] text-muted">Next 14 days</div>
              </div>
              {lookahead.map(t => {
                const pct = t.progress ?? 0;
                const statusCls = t.status === "in_progress" ? "bg-info/10 border-info/20 text-info" : t.status === "completed" ? "bg-success/10 border-success/20 text-success" : "bg-elevated/20 border-border-custom/20 text-muted";
                return (
                  <div key={t.id} className="bg-input border border-border-custom rounded-md p-4 flex items-start gap-4">
                    <div className="shrink-0 text-[9px] font-sans text-muted w-20">{fmtDate(t.start_date)}<br/>→ {fmtDate(t.end_date)}</div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-semibold text-foreground">{t.name}</span>
                        {t.is_critical && <span className="text-[8px] bg-danger/10 border border-danger/20 text-danger px-1.5 py-0.5 rounded font-bold">CRITICAL</span>}
                        <span className={`text-[8px] px-1.5 py-0.5 rounded border font-bold ${statusCls}`}>{t.status.replace("_"," ").toUpperCase()}</span>
                      </div>
                      {t.assigned_to_name && <div className="text-[10px] text-muted">Responsible: {t.assigned_to_name}</div>}
                      {pct > 0 && <div className="text-[10px] text-muted mt-0.5">{pct}% complete</div>}
                    </div>
                  </div>
                );
              })}
              {!listLoading && lookahead.length === 0 && (
                <EmptyState
                  title="No tasks scheduled in next 14 days"
                  description="No project tasks have planned execution dates within the upcoming 14-day rolling window."
                />
              )}
            </div>
          )}

          {/* ── WBS TAB ── */}
          {mainTab === "wbs" && <>
          {/* Quick Creator Forms */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            {/* Create Task Form */}
            <div id="task-form" className="bg-card border border-border-custom rounded-lg p-6 rounded-lg border border-border-custom bg-input space-y-4">
              <h2 className="text-xs font-bold text-foreground uppercase tracking-wider">
                Create WBS Task
              </h2>
              <form onSubmit={handleCreateTask} className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="col-span-2 space-y-1">
                  <label className="text-muted font-semibold">Task Name</label>
                  <input
                    id="task-title-input"
                    type="text"
                    value={taskName}
                    onChange={(e) => setTaskName(e.target.value)}
                    placeholder="Slab casting, foundation excav..."
                    className="w-full bg-elevated border border-border-custom rounded-lg p-2 text-foreground focus:outline-none focus:border-primary/50"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-muted font-semibold">Duration (Days)</label>
                  <input
                    type="number"
                    value={duration}
                    onChange={(e) => setDuration(parseInt(e.target.value) || 1)}
                    className="w-full bg-elevated border border-border-custom rounded-lg p-2 text-foreground focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-muted font-semibold">Start Date</label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full bg-elevated border border-border-custom rounded-lg p-2 text-foreground focus:outline-none"
                  />
                </div>
                <div className="space-y-1 col-span-2">
                  <label className="text-muted font-semibold">Priority</label>
                  <select
                    value={priority}
                    onChange={(e) => setPriority(e.target.value)}
                    className="w-full bg-elevated border border-border-custom rounded-lg p-2 text-foreground"
                  >
                    <option value="high">High Priority</option>
                    <option value="medium">Medium Priority</option>
                    <option value="low">Low Priority</option>
                  </select>
                </div>
                <button
                  type="submit"
                  className="col-span-2 mt-2 bg-primary rounded-md py-2.5 font-bold text-white hover:opacity-90 transition-all text-xs"
                >
                  Save WBS Task
                </button>
              </form>
            </div>

            {/* Predecessors / Linker Form */}
            <div className="bg-card border border-border-custom rounded-lg p-6 rounded-lg border border-border-custom bg-input space-y-4">
              <h2 className="text-xs font-bold text-foreground uppercase tracking-wider">
                Link CPM Predecessors
              </h2>
              <form onSubmit={handleAddPredecessor} className="space-y-3 text-xs">
                <div className="space-y-1">
                  <label className="text-muted font-semibold">Target WBS Task</label>
                  <select
                    value={selectedTaskForLink}
                    onChange={(e) => setSelectedTaskForLink(e.target.value)}
                    className="w-full bg-elevated border border-border-custom rounded-lg p-2 text-foreground"
                  >
                    <option value="">Choose Task</option>
                    {tasks.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                  {tasks.length === 0 && (
                    <FieldHint text="No tasks created yet. Create a task in the form above." />
                  )}
                </div>
                <div className="space-y-1">
                  <label className="text-muted font-semibold">Requires Completion of Predecessor</label>
                  <select
                    value={selectedPredecessor}
                    onChange={(e) => setSelectedPredecessor(e.target.value)}
                    className="w-full bg-elevated border border-border-custom rounded-lg p-2 text-foreground"
                  >
                    <option value="">Choose Predecessor</option>
                    {tasks
                      .filter(t => t.id !== selectedTaskForLink)
                      .map(t => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))
                    }
                  </select>
                </div>
                <button
                  type="submit"
                  className="w-full bg-elevated hover:bg-elevated border border-border-custom rounded-md py-2.5 font-bold text-foreground transition-all text-xs inline-flex items-center justify-center gap-1.5"
                >
                  <Icon name="link" className="w-3.5 h-3.5" /> Establish Link Dependency
                </button>
              </form>
            </div>
          </div>

          {/* WBS Task Gantt List */}
          <div className="bg-card border border-border-custom rounded-lg p-6 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <h2 className="text-xs font-bold text-foreground uppercase tracking-wider">WBS Execution Nodes</h2>
                <p className="text-[10px] text-muted">Click a task card below to open its real-time collaboration feed, subtasks and progress takeoff book.</p>
              </div>
              <div className="flex items-center gap-1.5 bg-input border border-border-custom rounded-lg p-1">
                <button
                  type="button"
                  onClick={() => setTaskViewMode("flat")}
                  className={`px-2.5 py-1 rounded text-[10px] font-bold cursor-pointer transition-all ${
                    taskViewMode === "flat" ? "bg-primary text-white" : "text-muted hover:text-foreground"
                  }`}
                >
                  Flat View
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTaskViewMode("tree");
                    fetchHierarchy();
                  }}
                  className={`px-2.5 py-1 rounded text-[10px] font-bold cursor-pointer transition-all ${
                    taskViewMode === "tree" ? "bg-primary text-white" : "text-muted hover:text-foreground"
                  }`}
                >
                  Tree Hierarchy
                </button>
              </div>
            </div>

            <div className="space-y-3">
              {loading ? (
                <div className="text-center py-10 text-xs text-muted">Loading WBS Node levels...</div>
              ) : taskViewMode === "tree" ? (
                hierarchy.length === 0 ? (
                  <div className="text-center py-8 text-xs text-muted">No hierarchy data available.</div>
                ) : (
                  (function renderTree(nodes: TaskTreeNode[], depth = 0): React.ReactNode {
                    return nodes.map((node) => {
                      const pct = Math.min(100, Math.max(0, node.progress ?? 0));
                      const overdue =
                        node.status !== "completed" && !!node.end_date && new Date(node.end_date) < new Date();
                      return (
                        <div key={node.id} className="space-y-2">
                          <div
                            onClick={() => handleOpenDrawer(node)}
                            style={{ marginLeft: `${depth * 20}px` }}
                            className="p-4 rounded-md border border-border-custom bg-input hover:border-primary/20 transition-all flex items-center justify-between cursor-pointer group"
                          >
                            <div className="space-y-1.5 w-full">
                              <div className="flex items-center gap-2 flex-wrap">
                                {depth > 0 && <span className="text-muted text-xs font-bold">↳</span>}
                                <strong className="text-foreground text-xs group-hover:text-primary transition-all">
                                  {node.name}
                                </strong>
                                {node.is_critical && (
                                  <span className="text-[8px] bg-danger/10 border border-danger/20 text-danger px-1.5 py-0.5 rounded font-bold">CRITICAL</span>
                                )}
                                {overdue && (
                                  <span className="text-[8px] bg-warning/10 border border-warning/20 text-warning px-1.5 py-0.5 rounded font-bold">OVERDUE</span>
                                )}
                                <span className={`text-[9px] px-2 py-0.5 rounded font-bold uppercase ${
                                  node.priority === "high" ? "bg-danger/10 text-danger" : "bg-elevated text-muted"
                                }`}>{formatLabel(node.priority)}</span>
                                <span className={`text-[8px] px-1.5 py-0.5 rounded border font-bold uppercase ${
                                  node.status === "completed"
                                    ? "bg-success/10 border-success/20 text-success"
                                    : node.status === "not_started"
                                      ? "bg-elevated/20 border-border-custom/20 text-muted"
                                      : "bg-info/10 border-info/20 text-info"
                                }`}>{formatLabel(node.status)}</span>
                              </div>
                              <div className="text-[10px] text-muted">
                                Start: {fmtDate(node.start_date)} · End: {fmtDate(node.end_date)} · Duration: {node.duration_days} Days
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="h-1.5 flex-1 max-w-[240px] bg-elevated rounded-full overflow-hidden">
                                  <div
                                    className={`h-full rounded-full ${overdue ? "bg-warning/10" : "bg-success/10"}`}
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                                <span className="text-[9px] font-bold text-muted">{Math.round(pct)}%</span>
                              </div>
                            </div>

                            <div className="flex items-center gap-2 ml-3">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleSetTaskBaseline(node.id);
                                }}
                                className="px-2 py-1 bg-elevated hover:bg-card border border-border-custom text-foreground rounded text-[10px] font-semibold cursor-pointer whitespace-nowrap"
                                title="Snapshot baseline for this task"
                              >
                                Set Baseline
                              </button>
                              <Icon name="arrow_forward" className="w-3.5 h-3.5 text-muted group-hover:text-foreground transition-all" />
                            </div>
                          </div>
                          {node.children && node.children.length > 0 && renderTree(node.children, depth + 1)}
                        </div>
                      );
                    });
                  })(hierarchy)
                )
              ) : (
                tasks.map((task) => {
                  const pct = Math.min(100, Math.max(0, task.progress ?? 0));
                  const overdue =
                    task.status !== "completed" && !!task.end_date && new Date(task.end_date) < new Date();
                  return (
                  <div
                    key={task.id}
                    onClick={() => handleOpenDrawer(task)}
                    className="p-4 rounded-md border border-border-custom bg-input hover:border-primary/20 transition-all flex items-center justify-between cursor-pointer group"
                  >
                    <div className="space-y-1.5 w-full">
                      <div className="flex items-center gap-2 flex-wrap">
                        <strong className="text-foreground text-xs group-hover:text-primary transition-all">
                          {task.name}
                        </strong>
                        {task.is_critical && (
                          <span className="text-[8px] bg-danger/10 border border-danger/20 text-danger px-1.5 py-0.5 rounded font-bold">CRITICAL</span>
                        )}
                        {overdue && (
                          <span className="text-[8px] bg-warning/10 border border-warning/20 text-warning px-1.5 py-0.5 rounded font-bold">OVERDUE</span>
                        )}
                        <span className={`text-[9px] px-2 py-0.5 rounded font-bold uppercase ${
                          task.priority === "high" ? "bg-danger/10 text-danger" : "bg-elevated text-muted"
                        }`}>{formatLabel(task.priority)}</span>
                        <span className={`text-[8px] px-1.5 py-0.5 rounded border font-bold uppercase ${
                          task.status === "completed"
                            ? "bg-success/10 border-success/20 text-success"
                            : task.status === "not_started"
                              ? "bg-elevated/20 border-border-custom/20 text-muted"
                              : "bg-info/10 border-info/20 text-info"
                        }`}>{formatLabel(task.status)}</span>
                      </div>
                      <div className="text-[10px] text-muted">
                        Start: {fmtDate(task.start_date)} · End: {fmtDate(task.end_date)} · Duration: {task.duration_days} Days
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 max-w-[240px] bg-elevated rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${overdue ? "bg-warning/10" : "bg-success/10"}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-[9px] font-bold text-muted">{Math.round(pct)}%</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 ml-3">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSetTaskBaseline(task.id);
                        }}
                        className="px-2 py-1 bg-elevated hover:bg-card border border-border-custom text-foreground rounded text-[10px] font-semibold cursor-pointer whitespace-nowrap"
                        title="Snapshot baseline for this task"
                      >
                        Set Baseline
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteTask(task.id);
                        }}
                        className="p-1 bg-elevated hover:bg-danger/10 hover:text-danger hover:border-danger/20 border border-border-custom text-muted rounded text-[10px] cursor-pointer"
                        title="Delete task"
                      >
                        <Icon name="trash" className="w-3 h-3" />
                      </button>
                      <Icon name="arrow_forward" className="w-3.5 h-3.5 text-muted group-hover:text-foreground transition-all" />
                    </div>
                  </div>
                  );
                })
              )}
            </div>
          </div>
          </> }
          </div>
        </PageShell>
      </div>

      {/* Task detail Drawer overlay */}
      {selectedTask && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-end">
          <div className="bg-background border-l border-border-custom w-full max-w-lg h-full shadow-2xl flex flex-col overflow-hidden text-xs">
            
            {/* Header */}
            <div className="px-6 py-4 border-b border-border-custom flex items-center justify-between bg-background">
              <div>
                <span className="text-[9px] uppercase tracking-wider font-extrabold text-primary">WBS Task details</span>
                <h2 className="text-base font-extrabold text-foreground mt-1">{selectedTask.name}</h2>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleDeleteTask(selectedTask.id)}
                  className="px-2.5 py-1 rounded bg-danger/10 hover:bg-danger/20 border border-danger/20 text-danger text-xs font-bold transition-all cursor-pointer inline-flex items-center gap-1"
                  title="Delete task"
                >
                  <Icon name="trash" className="w-3.5 h-3.5" /> Delete
                </button>
                <button onClick={() => setSelectedTask(null)} className="text-muted hover:text-foreground cursor-pointer inline-flex items-center gap-1"><Icon name="close" className="w-3.5 h-3.5" /> Close</button>
              </div>
            </div>

            {/* Content body */}
            <div className="flex-1 p-6 overflow-y-auto space-y-6">
              
              {/* 1. Subtask checklist */}
              <div className="space-y-3">
                <h3 className="text-xs font-bold text-muted uppercase tracking-wider">Subtask Checklist</h3>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="e.g. Verify rebar cover blocks..."
                    value={newTodoTitle}
                    onChange={(e) => setNewTodoTitle(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleAddTodo())}
                    className="flex-1 bg-input border border-border-custom rounded px-3 py-1.5 text-xs text-foreground placeholder:text-muted"
                  />
                  <button
                    onClick={handleAddTodo}
                    className="px-3 py-1.5 bg-primary text-white rounded font-bold text-xs hover:opacity-90"
                  >
                    Add
                  </button>
                </div>
                <div className="space-y-1.5 mt-2">
                  {todos.map((todo) => (
                    <div key={todo.id} className="flex items-center justify-between p-2 rounded bg-elevated border border-border-custom">
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={todo.is_completed}
                          onChange={() => handleToggleTodo(todo.id)}
                          className="accent-primary h-3.5 w-3.5 rounded cursor-pointer"
                        />
                        <span className={`text-xs ${todo.is_completed ? "line-through text-muted" : "text-muted"}`}>
                          {todo.title}
                        </span>
                      </div>
                      <button onClick={() => handleDeleteTodo(todo.id)} className="text-muted hover:text-danger cursor-pointer"><Icon name="close" className="w-3.5 h-3.5" /></button>
                    </div>
                  ))}
                  {todos.length === 0 && (
                    <EmptyState
                      title="No sub-task checklist items"
                      description="Break down this activity into actionable field checklist items."
                    />
                  )}
                </div>
              </div>

              {/* 2. Progress posting with evaluated inputs (like 2+3+6) */}
              <div className="space-y-3 border-t border-border-custom pt-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-bold text-muted uppercase tracking-wider">Progress entry & Measurement Book</h3>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="useTakeoffCheck"
                      checked={useTakeoff}
                      onChange={(e) => setUseTakeoff(e.target.checked)}
                      className="accent-primary h-3.5 w-3.5 rounded cursor-pointer"
                    />
                    <label htmlFor="useTakeoffCheck" className="text-xs text-muted select-none cursor-pointer">
                      Use Takeoff (N x L x W x H)
                    </label>
                  </div>
                </div>

                {useTakeoff && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 bg-input p-3 rounded-lg border border-border-custom text-xs">
                    <div className="space-y-1">
                      <span className="text-[10px] text-muted block">No. (N)</span>
                      <input type="number" value={takeoffN} onChange={(e) => setTakeoffN(parseFloat(e.target.value) || 1)} className="w-full bg-elevated border border-border-custom rounded p-1 text-foreground text-center" />
                    </div>
                    <div className="space-y-1">
                      <span className="text-[10px] text-muted block">Length (L)</span>
                      <input type="number" value={takeoffL} onChange={(e) => setTakeoffL(parseFloat(e.target.value) || 1)} className="w-full bg-elevated border border-border-custom rounded p-1 text-foreground text-center" />
                    </div>
                    <div className="space-y-1">
                      <span className="text-[10px] text-muted block">Width (W)</span>
                      <input type="number" value={takeoffW} onChange={(e) => setTakeoffW(parseFloat(e.target.value) || 1)} className="w-full bg-elevated border border-border-custom rounded p-1 text-foreground text-center" />
                    </div>
                    <div className="space-y-1">
                      <span className="text-[10px] text-muted block">Height (H)</span>
                      <input type="number" value={takeoffH} onChange={(e) => setTakeoffH(parseFloat(e.target.value) || 1)} className="w-full bg-elevated border border-border-custom rounded p-1 text-foreground text-center" />
                    </div>
                  </div>
                )}

                <div className="space-y-1">
                  <div className="text-[10px] text-muted flex items-center gap-2">
                    <span>
                      Current progress:{" "}
                      <strong className="text-foreground font-sans">
                        {Math.round(Math.min(100, Math.max(0, selectedTask.progress ?? 0)))}%
                      </strong>
                    </span>
                    <span className={`text-[8px] px-1.5 py-0.5 rounded border font-bold uppercase ${
                      selectedTask.status === "completed"
                        ? "bg-success/10 border-success/20 text-success"
                        : selectedTask.status === "not_started"
                          ? "bg-elevated/20 border-border-custom/20 text-muted"
                          : "bg-info/10 border-info/20 text-info"
                    }`}>{formatLabel(selectedTask.status)}</span>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Enter qty or formula (e.g. 2+3+6)..."
                      value={progressQty}
                      onChange={(e) => setProgressQty(e.target.value)}
                      disabled={useTakeoff}
                      className="flex-1 bg-input border border-border-custom rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none disabled:opacity-70 disabled:text-success disabled:font-bold"
                    />
                    <button
                      onClick={() => handleSaveComment()}
                      className="px-4 py-2 bg-primary text-white text-xs font-bold rounded-lg hover:opacity-90 transition-all"
                    >
                      Log Progress
                    </button>
                  </div>

                  {/* Expression evaluation preview (Screen 5794) */}
                  {!useTakeoff && progressQty && isNaN(Number(progressQty)) && (
                    <div className="text-[10px] text-muted mt-1 pl-1">
                      Evaluated Output: <strong className="text-foreground font-sans">{evaluateFormula(progressQty)}</strong>
                    </div>
                  )}
                </div>
              </div>

              {/* 3. Feed activity Timeline */}
              <div className="space-y-3 border-t border-border-custom pt-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-xs font-bold text-muted uppercase tracking-wider font-sans">Task Activity Chat Feed</h3>
                  
                  {/* Microphone simulated trigger */}
                  <button
                    onClick={startRecording}
                    disabled={isRecording}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-[10px] transition-all font-semibold ${
                      isRecording
                        ? "bg-danger/10 text-danger border-danger/20 font-bold"
                        : "bg-elevated border-border-custom text-muted hover:text-foreground"
                    }`}
                  >
                    <Icon name="microphone" className="w-3.5 h-3.5" /> {isRecording ? `Recording (${4 - recordingSeconds}s)...` : "Audio Memo"}
                  </button>
                </div>

                <div className="space-y-3 max-h-60 overflow-y-auto pr-1">
                  {comments.map(comm => (
                    <div key={comm.id} className="p-3 rounded-lg bg-input border border-border-custom space-y-1.5">
                      <div className="flex justify-between items-center text-[9px] text-muted">
                        <strong className="text-muted font-bold">{comm.user_name}</strong>
                        <span>{new Date(comm.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                      </div>
                      <p className="text-muted text-xs">{comm.message_text}</p>
                      
                      {comm.voice_note_url && (
                        <div className="flex items-center gap-2 p-1.5 rounded bg-elevated border border-border-custom text-[9px] text-muted font-sans">
                          <span className="inline-flex items-center gap-1"><Icon name="speaker" className="w-3 h-3" /> Audio Note:</span>
                          <span className="text-primary underline cursor-pointer truncate max-w-[150px]">{comm.voice_note_url}</span>
                        </div>
                      )}
                    </div>
                  ))}
                  {comments.length === 0 && (
                    <EmptyState
                      title="No activity updates posted yet"
                      description="Post progress notes, site observations, or record voice memos for this task."
                    />
                  )}
                </div>

                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Post progress comments..."
                    value={newCommentText}
                    onChange={(e) => setNewCommentText(e.target.value)}
                    className="flex-1 bg-input border border-border-custom rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none"
                  />
                  <button onClick={() => handleSaveComment()} className="px-4 py-2 bg-elevated border border-border-custom hover:bg-elevated text-muted hover:text-foreground rounded-lg text-xs font-bold">
                    Send
                  </button>
                </div>
              </div>

            </div>
          </div>
        </div>
      )}
    </div>
  );
}