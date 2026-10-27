"use client";
import Badge, { type BadgeTone } from "@/components/ui/Badge";

import React, { useState, useRef, useCallback, useEffect } from "react";
import Link from "next/link";
import { useProject } from "@/context/ProjectContext";
import { useParams } from "next/navigation";
import { getApiHost, readErrorDetail, detailToMessage} from "@/lib/api";
import { authHeaders, formatDate, formatLabel, todayLocalISO } from "@/lib/siteflow";
import Icon, { type IconName } from "@/components/marketing/Icon";

import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import SegmentedTabs from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import AuthImage from "@/components/ui/AuthImage";

type PinCategory = "RFI" | "Clash" | "Observation" | "Approval";
type RevStatus = "current" | "superseded" | "locked";

interface RFIPin {
  id: string;
  seq: number;
  x: number;
  y: number;
  category: PinCategory;
  comment: string;
  photoAttached: boolean;
  user: string;
  date: string;
  resolved: boolean;
}

interface Revision {
  id: string;
  version: string;
  fileUrl: string;
  status: RevStatus;
  approvalStatus: string;
  comments: string;
  date: string;
  uploadedBy: string;
  pins: RFIPin[];
  approvedBy?: string;
}

interface Drawing {
  id: string;
  name: string;
  category: string;
  createdAt: string;
  revisions: Revision[];
}

const PIN_META: Record<PinCategory, { bg: string; text: string; ring: string; label: string }> = {
  RFI:         { bg: "bg-warning",   text: "text-black",  ring: "ring-warning/40",   label: "RFI" },
  Clash:       { bg: "bg-danger",     text: "text-white",  ring: "ring-danger/40",     label: "Clash" },
  Observation: { bg: "bg-info",    text: "text-white",  ring: "ring-info/40",    label: "Obs" },
  Approval:    { bg: "bg-success", text: "text-white",  ring: "ring-success/40", label: "Appr" },
};

const REV_META: Record<RevStatus, { label: string; badge: string; dot: string; iconName?: IconName }> = {
  current:    { label: "Current",    badge: "bg-success/10 border-success/20 text-success", dot: "bg-success", iconName: "check" },
  superseded: { label: "Superseded", badge: "bg-elevated/30 border-border-custom/20 text-muted",         dot: "bg-elevated",   iconName: "schedule" },
  locked:     { label: "Locked",     badge: "bg-warning/10 border-warning/20 text-warning",       dot: "bg-warning",  iconName: "lock" },
};

export default function DrawingsPage() {
  const { company_id } = useParams();
  const companyId = (company_id as string) || "demo";
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;

  const [tab, setTab] = useState<"drawings" | "files">("drawings");
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [activeDrawingId, setActiveDrawingId] = useState<string>("");
  const [activeRevId, setActiveRevId] = useState<string>("");
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  const [filterCat, setFilterCat] = useState<string>("All");
  const [imgLoaded, setImgLoaded] = useState(false);
  const [isOffline, setIsOffline] = useState(false);

  const [backingUpId, setBackingUpId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState("");

  // Add pin modal
  const [showPinModal, setShowPinModal] = useState(false);
  const [tempXY, setTempXY] = useState({ x: 0, y: 0 });
  const [newPinComment, setNewPinComment] = useState("");
  const [newPinCat, setNewPinCat] = useState<PinCategory>("RFI");
  const [newPinPhoto, setNewPinPhoto] = useState(false);
  const [newPinTaggedUserId, setNewPinTaggedUserId] = useState("");
  const [teamMembers, setTeamMembers] = useState<Array<{ id: string; name: string }>>([]);

  // Add revision modal
  const [showRevModal, setShowRevModal] = useState(false);
  const [newRevCode, setNewRevCode] = useState("");
  const [newRevComment, setNewRevComment] = useState("");
  const [newRevFile, setNewRevFile] = useState<File | null>(null);
  const [newDrawingName, setNewDrawingName] = useState("");
  const [newDrawingCategory, setNewDrawingCategory] = useState("2D Layout");

  const canvasRef = useRef<HTMLDivElement>(null);

  const fetchDrawings = async () => {
    if (!projectId) return;
    try {
      const apiHost = getApiHost();
      if (companyId) {
        fetch(`${apiHost}/apis/v3/crm/team-members/${companyId}`, { headers: authHeaders() })
          .then(r => r.ok ? r.json() : [])
          .then(data => setTeamMembers(data.map((m: any) => ({ id: m.id, name: m.name }))))
          .catch(() => {});
      }
      const res = await fetch(`${apiHost}/apis/v3/drawings?project_id=${projectId}`, { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        const mapped: Drawing[] = data.map((d: any) => ({
          id: d.id,
          name: d.name,
          category: d.category,
          createdAt: d.created_at ? d.created_at.split("T")[0] : "",
          revisions: (d.revisions || []).map((r: any) => ({
            id: r.id,
            version: r.version_code,
            fileUrl: r.file_url,
            status: r.approval_status === "approved" ? "current" : (r.approval_status === "rejected" ? "locked" : "superseded"),
            approvalStatus: r.approval_status || "pending",
            comments: r.comments || "",
            date: r.created_at ? r.created_at.split("T")[0] : "",
            uploadedBy: "Auto-synced",
            pins: (r.pins || []).map((p: any) => ({
              id: p.id,
              seq: 0,
              x: p.x_coordinate,
              y: p.y_coordinate,
              category: "Observation",
              comment: p.comment,
              photoAttached: false,
              user: "System",
              date: p.created_at ? p.created_at.split("T")[0] : "",
              resolved: p.resolved === true,
            })),
            approvedBy: r.approved_by ? "Approver" : undefined,
          })).sort((a: Revision, b: Revision) => {
            const numA = parseInt(a.version.replace(/\D/g, "")) || 0;
            const numB = parseInt(b.version.replace(/\D/g, "")) || 0;
            return numB - numA;
          }),
        }));
        setDrawings(mapped);
        if (mapped.length > 0 && !activeDrawingId) {
          const first = mapped[0];
          setActiveDrawingId(first.id);
          const cur = first.revisions.find((r: Revision) => r.status === "current") ?? first.revisions[0];
          setActiveRevId(cur.id);
        }
        setIsOffline(false);
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      console.error("Failed to fetch drawings from server", err);
      setIsOffline(true);
    }
  };

  useEffect(() => {
    fetchDrawings();
  }, [projectId]);

  const activeDrawing = drawings.find(d => d.id === activeDrawingId);
  const activeRev = activeDrawing?.revisions.find(r => r.id === activeRevId);
  const currentRev = activeDrawing?.revisions.find(r => r.status === "current");
  const registerActiveRev = currentRev ?? activeDrawing?.revisions[0];
  const isEditable = activeRev?.status === "current";

  const visiblePins = (activeRev?.pins ?? []).filter(p => filterCat === "All" || p.category === filterCat);
  const openCount = (activeRev?.pins ?? []).filter(p => !p.resolved).length;

  const getNextRevCode = useCallback(() => {
    if (!activeDrawing) return "V1";
    const latest = activeDrawing.revisions[0]?.version ?? "—";
    const num = parseInt(latest.replace(/\D/g, "")) || 0;
    return `V${num + 1}`;
  }, [activeDrawing]);

  const handleSelectDrawing = (id: string) => {
    const d = drawings.find(x => x.id === id);
    if (!d) return;
    setActiveDrawingId(id);
    const cur = d.revisions.find(r => r.status === "current") ?? d.revisions[0];
    setActiveRevId(cur.id);
    setSelectedPinId(null);
    setImgLoaded(false);
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canvasRef.current || !isEditable) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setTempXY({ x, y });
    setNewPinComment("");
    setNewPinCat("RFI");
    setNewPinPhoto(false);
    setShowPinModal(true);
  };

  const handleAddPin = async () => {
    if (!newPinComment.trim() || !activeRev) return;
    const nextSeq = (activeRev.pins.reduce((m, p) => Math.max(m, p.seq), 0)) + 1;

    try {
      const apiHost = getApiHost();
      // R2-435: created_by is derived server-side from the authenticated
      // caller, so the body carries geometry, text, and optional tagged user.
      const res = await fetch(`${apiHost}/apis/v3/drawings/revisions/${activeRev.id}/pins`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          x_coordinate: tempXY.x,
          y_coordinate: tempXY.y,
          comment: newPinComment,
          tagged_user_id: newPinTaggedUserId || null,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const saved = await res.json();
      const pinData = {
        id: saved.id, seq: nextSeq,
        x: tempXY.x, y: tempXY.y,
        category: newPinCat, comment: newPinComment,
        photoAttached: newPinPhoto,
        user: "Current User", date: formatDate(new Date()),
        resolved: false,
      };
      setDrawings(prev => prev.map(d => d.id !== activeDrawingId ? d : {
        ...d,
        revisions: d.revisions.map(r => r.id !== activeRevId ? r : { ...r, pins: [...r.pins, pinData] })
      }));
      setShowPinModal(false);
      setNewPinTaggedUserId("");
    } catch (err) {
      console.error("Failed to save pin", err);
      alert("Failed to save pin. Your change was not saved.");
    }
  };

  const handleToggleResolved = async (pinId: string) => {
    const pin = activeRev?.pins.find(p => p.id === pinId);
    if (!pin) return;
    const next = !pin.resolved;
    try {
      const apiHost = getApiHost();
      const res = await fetch(`${apiHost}/apis/v3/drawings/pins/${pinId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ resolved: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDrawings(prev => prev.map(d => d.id !== activeDrawingId ? d : {
        ...d,
        revisions: d.revisions.map(r => r.id !== activeRevId ? r : {
          ...r, pins: r.pins.map(p => p.id === pinId ? { ...p, resolved: next } : p)
        })
      }));
    } catch (err) {
      console.error("Failed to update pin resolution", err);
      alert("Failed to update pin. Your change was not saved.");
    }
  };

  const handleBackupFileToDrive = async (fileId: string, fileType: "project" | "company" = "project") => {
    if (!companyId || !fileId) return;
    setBackingUpId(fileId);
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/integrations/google-drive/companies/${companyId}/backup-file/${fileId}?file_type=${fileType}`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (res.ok) {
        setToastMessage("File successfully backed up to Google Drive!");
        setTimeout(() => setToastMessage(""), 3500);
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to backup file to Google Drive. Check if Google Drive is connected.");
      }
    } catch (e) {
      console.error("Backup to Google Drive error", e);
      alert("Failed to backup file to Google Drive. Please check your connection.");
    } finally {
      setBackingUpId(null);
    }
  };

  const handlePublishRevision = async () => {
    if (!newRevCode.trim() || !newRevFile || !projectId) return;
    let targetDrawingId = activeDrawingId;
    let newDrawing: Drawing | null = null;

    try {
      const apiHost = getApiHost();
      // R2-464: upload the actual sheet first, so the revision the server
      // stores points at its own file instead of reusing an older revision's.
      const fd = new FormData();
      fd.append("project_id", String(projectId));
      fd.append("file", newRevFile);
      const upRes = await fetch(`${apiHost}/apis/v3/files/upload`, {
        method: "POST",
        headers: authHeaders() || {},
        body: fd,
      });
      if (!upRes.ok) {
        const err = await upRes.json().catch(() => ({}));
        alert(`Failed to upload drawing file: ${err.detail || `HTTP ${upRes.status}`}`);
        return;
      }
      const up = await upRes.json();
      const fileUrl = `/apis/v3/files/file/${up.id}`;

      if (!targetDrawingId) {
        const dRes = await fetch(`${apiHost}/apis/v3/drawings`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
          body: JSON.stringify({
            project_id: projectId,
            name: newDrawingName.trim(),
            category: newDrawingCategory,
            file_url: fileUrl,
          }),
        });
        if (!dRes.ok) {
          const err = await dRes.json().catch(() => ({}));
          alert(`Failed to create drawing: ${detailToMessage(err.detail, "Failed to publish revision")}`);
          return;
        }
        const savedD = await dRes.json();
        targetDrawingId = savedD.id;
        newDrawing = {
          id: targetDrawingId,
          name: newDrawingName.trim(),
          category: newDrawingCategory,
          createdAt: todayLocalISO(),
          revisions: [],
        };
      }
      const res = await fetch(`${apiHost}/apis/v3/drawings/${targetDrawingId}/revisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          version_code: newRevCode.toUpperCase(),
          file_url: fileUrl,
          comments: newRevComment || "",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Failed to publish revision: ${detailToMessage(err.detail, "Failed to publish revision")}`);
        return;
      }

      // R2-464 + R2-465: mirror what the server stored, never a local guess.
      const saved = await res.json();
      const newRev: Revision = {
        id: saved.id,
        version: saved.version_code,
        fileUrl: saved.file_url,
        status: saved.approval_status === "approved" ? "current" : (saved.approval_status === "rejected" ? "locked" : "superseded"),
        approvalStatus: saved.approval_status || "pending",
        comments: saved.comments || "",
        date: saved.created_at ? saved.created_at.split("T")[0] : todayLocalISO(),
        uploadedBy: "Current User",
        pins: [],
      };

      setDrawings(prev => {
        if (newDrawing) {
          return [{ ...newDrawing, revisions: [newRev] }, ...prev];
        }
        // A pending upload does not dethrone the approved sheet; superseding
        // happens server-side when the new revision is approved (R2-365).
        return prev.map(d => d.id !== targetDrawingId ? d : { ...d, revisions: [newRev, ...d.revisions] });
      });
      setActiveDrawingId(targetDrawingId);
      setActiveRevId(newRev.id);
      setImgLoaded(false);
      setShowRevModal(false);
      setNewRevCode(""); setNewRevComment(""); setNewRevFile(null);
    } catch (e) {
      console.error("Failed to publish revision", e);
      alert("Failed to publish revision. Your change was not saved.");
      return;
    }
  };

  const handleToggleLock = async (revId: string) => {
    const newStatus = activeRev?.status === "locked" ? "superseded" : "locked";
    try {
      const apiHost = getApiHost();
      const res = await fetch(`${apiHost}/apis/v3/drawings/revisions/${revId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          approval_status: newStatus === "locked" ? "approved" : "rejected",
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const msg = typeof errData.detail === "string" ? errData.detail : `HTTP ${res.status}`;
        alert(`Approval failed: ${msg}`);
        return;
      }
    } catch (err) {
      console.error("Lock toggle error:", err);
      alert("Failed to update revision approval status.");
      return;
    }
    setDrawings(prev => prev.map(d => d.id !== activeDrawingId ? d : {
      ...d,
      revisions: d.revisions.map(r => {
        if (r.id !== revId) return r;
        if (r.status === "locked") return { ...r, status: "superseded" as RevStatus };
        if (r.status === "superseded") return { ...r, status: "locked" as RevStatus };
        return { ...r, status: "locked" as RevStatus };
      })
    }));
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title={tab === "drawings" ? "Blueprint & RFI System" : "Project Files Directory"}
        subtitle={tab === "drawings" ? "Versioned drawings · Revision locking · RFI pin overlay" : "Document storage"}
      >
        {tab === "drawings" && (
          <button onClick={() => { setNewRevCode(getNextRevCode()); setNewRevComment(""); setNewRevFile(null); setShowRevModal(true); }}
            className="px-3.5 py-1.5 bg-primary text-white text-xs font-bold rounded-lg hover:opacity-90 transition-all cursor-pointer inline-flex items-center gap-1.5">
            <Icon name="arrow_up" className="w-3.5 h-3.5" />
            Upload New Revision
          </button>
        )}
      </PageHeader>

      <div className="px-6 py-2 border-b border-border-custom bg-card shrink-0 overflow-x-auto">
        <SegmentedTabs
          tabs={[
            { id: "drawings", label: "Blueprints & RFI" },
            { id: "files", label: "Project Files" },
          ]}
          activeTab={tab}
          onChange={(t) => setTab(t as any)}
        />
      </div>

      {toastMessage && (
        <div className="mx-6 mt-4 p-3 bg-success/10 border border-success/20 text-success text-xs rounded-lg font-semibold flex items-center justify-between">
          <span>{toastMessage}</span>
          <button onClick={() => setToastMessage("")}><Icon name="close" className="w-4 h-4" /></button>
        </div>
      )}

      {isOffline && (
        <div className="fixed top-4 right-4 z-50 p-4 bg-warning/10 border border-warning/20 text-warning rounded-lg text-xs max-w-md">
          Could not load drawings from the server. Retry once the connection is restored.
        </div>
      )}

      {/* ── Main ── */}
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">

        {/* Content */}
        <div className={tab === "drawings" && activeDrawing ? "h-[calc(100vh-11rem)] min-h-[480px] overflow-hidden" : "flex-1 overflow-hidden"}>
          {/* ── DRAWINGS TAB ── */}
          {tab === "drawings" && activeDrawing && (
            <div className="flex h-full">
              {/* Canvas column */}
              <div className="flex-1 flex flex-col p-4 gap-3 min-w-0 overflow-hidden">
                {/* Drawing header bar */}
                <div className="flex items-center justify-between bg-input border border-border-custom rounded-md px-4 py-2.5 text-xs shrink-0">
                  <div>
                    <div className="font-bold text-foreground text-sm">{activeDrawing.name}</div>
                    <div className="text-[10px] text-muted mt-0.5">{activeDrawing.category} · Active: {registerActiveRev?.version ?? "—"} · {registerActiveRev?.date ?? "—"} · {registerActiveRev?.approvalStatus === "approved" ? "Approved" : registerActiveRev?.approvalStatus === "rejected" ? "Rejected" : "Pending"}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {openCount > 0 && (
                      <Badge tone="warning" className="font-bold">{openCount} Open {openCount === 1 ? "Item" : "Items"}</Badge>
                    )}
                    {/* Filter pills */}
                    <div className="flex gap-1">
                      {["All", "RFI", "Clash", "Observation", "Approval"].map(cat => (
                        <button key={cat} onClick={() => setFilterCat(cat)}
                          className={`px-2 py-0.5 text-[9px] font-bold rounded transition-all ${filterCat === cat ? "bg-primary text-white" : "bg-white/5 text-muted hover:text-foreground"}`}>
                          {cat}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Canvas */}
                <div ref={canvasRef} onClick={handleCanvasClick}
                  className={`flex-1 relative rounded-md border border-border-custom bg-black overflow-hidden min-h-0 ${isEditable ? "cursor-crosshair" : "cursor-default"}`}>
                  {/* Drawing image */}
                  {activeRev?.fileUrl && (
                    // Sheets are stored as API paths that need the login token; a
                    // plain <img> asked the website for them and showed nothing.
                    <AuthImage key={activeRev.id} src={activeRev.fileUrl} alt={activeDrawing.name}
                      onLoad={() => setImgLoaded(true)}
                      className={`absolute inset-0 w-full h-full object-contain transition-opacity duration-500 ${imgLoaded ? "opacity-60" : "opacity-0"}`} />
                  )}

                  {/* Blueprint grid overlay */}
                  <div className="absolute inset-0 pointer-events-none"
                    style={{ backgroundImage: "linear-gradient(var(--border-custom) 1px, transparent 1px), linear-gradient(90deg, var(--border-custom) 1px, transparent 1px)", backgroundSize: "40px 40px" }} />

                  {/* SUPERSEDED / LOCKED watermark */}
                  {activeRev && activeRev.status !== "current" && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
                      <div className={`text-5xl font-black uppercase tracking-[0.5em] rotate-[-28deg] ${activeRev.status === "locked" ? "text-warning/20" : "text-muted/15"}`}>
                        {activeRev.status === "locked" ? "LOCKED" : "SUPERSEDED"}
                      </div>
                    </div>
                  )}


                  {/* Hint */}
                  {isEditable && visiblePins.length === 0 && (
                    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[10px] text-muted bg-black/70 backdrop-blur-sm px-3 py-1.5 rounded-full pointer-events-none whitespace-nowrap">
                      Click on drawing to drop an RFI / Clash / Observation pin
                    </div>
                  )}
                  {!isEditable && (
                    <div className="absolute top-3 left-3 text-[10px] text-muted bg-black/60 px-2.5 py-1 rounded-full pointer-events-none">
                      Viewing {activeRev?.version} ({formatLabel(activeRev?.status)}): switch to Current revision to add pins
                    </div>
                  )}

                  {/* RFI Pins */}
                  {visiblePins.map(pin => {
                    const m = PIN_META[pin.category];
                    const isActive = selectedPinId === pin.id;
                    return (
                      <button key={pin.id}
                        onClick={e => { e.stopPropagation(); setSelectedPinId(isActive ? null : pin.id); }}
                        title={`${pin.category} #${pin.seq}: ${pin.comment}`}
                        className={`absolute z-10 flex items-center justify-center font-extrabold text-[11px] rounded-full border-2 border-white shadow-xl transition-all transform -translate-x-1/2 -translate-y-1/2 ${m.bg} ${m.text} ${isActive ? `w-10 h-10 ring-4 ${m.ring} scale-110` : "w-6 h-6"} ${pin.resolved ? "opacity-30" : ""}`}
                        style={{ left: `${pin.x}%`, top: `${pin.y}%` }}>
                        {pin.seq}
                      </button>
                    );
                  })}
                </div>

                {/* Selected pin detail */}
                {selectedPinId && (() => {
                  const pin = activeRev?.pins.find(p => p.id === selectedPinId);
                  if (!pin) return null;
                  const m = PIN_META[pin.category];
                  return (
                    <div className="shrink-0 bg-input border border-border-custom rounded-md p-4 space-y-2 text-xs">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge tone={pin.category === "RFI" ? "warning" : pin.category === "Clash" ? "danger" : pin.category === "Observation" ? "info" : "success"} className="font-bold">{pin.category} #{pin.seq}</Badge>
                          {pin.resolved && <span className="text-[9px] text-success font-bold bg-success/10 px-1.5 py-0.5 rounded inline-flex items-center gap-1"><Icon name="check" className="w-3 h-3" /> Resolved</span>}
                          {pin.photoAttached && <span className="text-[9px] text-info bg-info/10 px-1.5 py-0.5 rounded inline-flex items-center gap-1"><Icon name="camera" className="w-3 h-3" /> Photo</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          <button onClick={() => handleToggleResolved(pin.id)}
                            className={`text-[10px] px-2.5 py-1 font-bold rounded-lg border transition-all inline-flex items-center gap-1 cursor-pointer ${pin.resolved ? "bg-elevated/30 border-border-custom/20 text-muted hover:border-border-custom" : "bg-success/10 border-success/20 text-success hover:bg-success/10"}`}>
                            {pin.resolved ? "Re-open" : <><Icon name="check" className="w-3 h-3" /> Mark Resolved</>}
                          </button>
                          <button onClick={() => setSelectedPinId(null)} className="text-muted hover:text-foreground p-1 cursor-pointer"><Icon name="close" className="w-4 h-4" /></button>
                        </div>
                      </div>
                      <p className="text-foreground leading-relaxed">{pin.comment}</p>
                      <div className="text-[10px] text-muted">Logged by {pin.user} · {pin.date}</div>
                    </div>
                  );
                })()}
              </div>

              {/* ── Revision History Panel ── */}
              <div className="w-72 shrink-0 border-l border-border-custom bg-card flex flex-col overflow-hidden">
                <div className="px-4 py-3 border-b border-border-custom">
                  <div className="text-[10px] font-bold text-muted uppercase tracking-wider">Revision History</div>
                  <div className="text-[9px] text-muted mt-0.5">{activeDrawing.revisions.length} revisions · Click to compare</div>
                </div>

                <div className="flex-1 overflow-y-auto p-3 space-y-0">
                  {activeDrawing.revisions.map((rev, idx) => {
                    const m = REV_META[rev.status];
                    const isActive = rev.id === activeRevId;
                    const revOpenPins = rev.pins.filter(p => !p.resolved).length;
                    return (
                      <div key={rev.id} className="relative pl-6">
                        {idx < activeDrawing.revisions.length - 1 && (
                          <div className="absolute left-[9px] top-5 bottom-0 w-px bg-white/5" />
                        )}
                        <div className={`absolute left-1.5 top-3.5 h-3 w-3 rounded-full border-2 transition-all ${isActive ? "bg-primary border-primary" : `${m.dot} border-border-custom`}`} />
                        <div className={`mb-2 rounded-md p-3 border transition-all ${isActive ? "bg-elevated text-foreground font-semibold border-border-custom" : "border-transparent hover:bg-elevated"}`}>
                          <button onClick={() => { setActiveRevId(rev.id); setSelectedPinId(null); setImgLoaded(false); }} className="w-full text-left">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs font-extrabold text-foreground">{rev.version}</span>
                              <span className={`text-[8px] px-1.5 py-0.5 rounded border font-bold inline-flex items-center gap-1 ${m.badge}`}>
                                {m.iconName && <Icon name={m.iconName} className="w-2.5 h-2.5" />} {m.label}
                              </span>
                            </div>
                            <div className="text-[10px] text-muted line-clamp-2">{rev.comments}</div>
                            <div className="text-[9px] text-muted mt-1">{rev.date} · {rev.uploadedBy} · {rev.approvalStatus === "approved" ? "Approved" : rev.approvalStatus === "rejected" ? "Rejected" : "Pending"}</div>
                            {rev.pins.length > 0 && (
                              <div className="flex items-center gap-2 mt-1 text-[9px]">
                                <span className="text-muted">{rev.pins.length} pins</span>
                                {revOpenPins > 0 && <span className="text-warning font-bold">{revOpenPins} open</span>}
                              </div>
                            )}
                            {rev.approvedBy && <div className="text-[9px] text-success mt-0.5">Approved by {rev.approvedBy}</div>}
                          </button>
                          {/* Lock / Unlock for non-current revisions */}
                          {rev.status !== "current" && (
                            <button onClick={() => handleToggleLock(rev.id)}
                              className={`mt-2 w-full text-[9px] font-bold px-2 py-1 rounded border text-left transition-all ${rev.status === "locked" ? "bg-warning/10 border-warning/20 text-warning hover:bg-warning/10" : "bg-elevated/20 border-border-custom/20 text-muted hover:text-warning hover:border-warning/20"}`}>
                              {rev.status === "locked" ? (
                                <span className="inline-flex items-center gap-1"><Icon name="unlock" className="w-3 h-3" /> Unlock Revision</span>
                              ) : (
                                <span className="inline-flex items-center gap-1"><Icon name="lock" className="w-3 h-3" /> Lock Revision</span>
                              )}
                            </button>
                          )}
                          {/* Backup to Google Drive */}
                          <button
                            type="button"
                            onClick={() => handleBackupFileToDrive(rev.id)}
                            disabled={backingUpId === rev.id}
                            className="mt-1.5 w-full text-[9px] font-bold px-2 py-1 rounded border border-border-custom bg-elevated/30 hover:bg-card text-foreground transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                            title="Backup drawing revision to company Google Drive"
                          >
                            <Icon name="cloud_drive" className="w-3 h-3 text-primary" />
                            {backingUpId === rev.id ? "Backing up..." : "Backup to Drive"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Open items quick list */}
                {activeRev && activeRev.pins.filter(p => !p.resolved).length > 0 && (
                  <div className="border-t border-border-custom p-3">
                    <div className="text-[9px] font-bold text-muted uppercase tracking-wider mb-2">Open Items</div>
                    <div className="space-y-1.5 max-h-40 overflow-y-auto">
                      {activeRev.pins.filter(p => !p.resolved).map(pin => {
                        const m = PIN_META[pin.category];
                        return (
                          <button key={pin.id} onClick={() => setSelectedPinId(pin.id)}
                            className="w-full text-left p-2 rounded-lg bg-input hover:bg-elevated border border-border-custom transition-all">
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <Badge tone={pin.category === "RFI" ? "warning" : pin.category === "Clash" ? "danger" : pin.category === "Observation" ? "info" : "success"} className="font-bold">{pin.category} #{pin.seq}</Badge>
                            </div>
                            <p className="text-[10px] text-muted line-clamp-1">{pin.comment}</p>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === "drawings" && !activeDrawing && (
            <div className="flex-1 flex items-center justify-center p-8">
              <EmptyState
                title="No drawings found"
                description="Upload architectural, structural, and MEP blueprint sheets for this project."
                action={{ label: "Upload New Revision", onClick: () => { setNewRevCode(getNextRevCode()); setNewRevComment(""); setNewRevFile(null); setShowRevModal(true); } }}
              />
            </div>
          )}

          {/* ── FILES TAB ── */}
          {tab === "files" && (
            <div className="h-full overflow-y-auto p-5">
              <div className="flex-1 flex items-center justify-center p-8">
                <EmptyState
                  title="No project files found"
                  description="Files and site photos will appear here once uploaded."
                />
              </div>
            </div>
          )}
        </div>
        </PageShell>
      </div>

      {/* ── Add RFI Pin Modal ── */}
      {showPinModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-background border border-border-custom rounded-lg w-full max-w-sm shadow-2xl p-5 space-y-4 text-xs">
            <div className="flex justify-between items-start border-b border-border-custom pb-3">
              <div>
                <div className="text-sm font-extrabold text-foreground">Drop Pin on Drawing</div>
                <div className="text-[10px] text-muted mt-0.5">Position: {tempXY.x.toFixed(1)}% × {tempXY.y.toFixed(1)}%</div>
              </div>
              <button onClick={() => setShowPinModal(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>
            <div>
              <div className="text-muted mb-1.5">Pin Category</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
                {(["RFI", "Clash", "Observation", "Approval"] as PinCategory[]).map(cat => {
                  const m = PIN_META[cat];
                  return (
                    <button key={cat} onClick={() => setNewPinCat(cat)}
                      className={`py-2 px-3 rounded-lg font-bold text-[10px] border transition-all ${newPinCat === cat ? `${m.bg} ${m.text} border-white/20` : "bg-white/5 text-muted border-border-custom hover:text-foreground"}`}>
                      {cat}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="text-muted mb-1">Description / Query</div>
              <textarea rows={3} autoFocus value={newPinComment} onChange={e => setNewPinComment(e.target.value)}
                className="w-full bg-input border border-border-custom rounded-lg p-2.5 text-foreground resize-none text-xs"
                placeholder="Describe the issue, clash, or observation clearly..." />
            </div>
            <div>
              <div className="text-muted mb-1">Assign / Tag Team Member (Optional)</div>
              <select
                value={newPinTaggedUserId}
                onChange={e => setNewPinTaggedUserId(e.target.value)}
                className="w-full bg-input border border-border-custom rounded-lg p-2 text-foreground text-xs"
              >
                <option value="">Unassigned / General Observation</option>
                {teamMembers.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={newPinPhoto} onChange={e => setNewPinPhoto(e.target.checked)} className="accent-primary" />
              <span className="text-muted">Attach site photo proof</span>
            </label>
            <div className="flex gap-2 justify-end border-t border-border-custom pt-3">
              <button onClick={() => setShowPinModal(false)} className="px-4 py-2 bg-elevated text-muted hover:text-foreground rounded-md text-xs">Cancel</button>
              <button onClick={handleAddPin} disabled={!newPinComment.trim()}
                className="px-5 py-2 bg-primary text-white font-bold rounded-md text-xs hover:opacity-90 disabled:opacity-40 transition-all">
                Place Pin
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Upload Revision Modal ── */}
      {showRevModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-background border border-border-custom rounded-lg w-full max-w-md shadow-2xl p-5 space-y-4 text-xs">
            <div className="flex justify-between items-start border-b border-border-custom pb-3">
              <div>
                <div className="text-sm font-extrabold text-foreground">Upload New Revision</div>
                <div className="text-[10px] text-muted mt-0.5">{activeDrawing ? "Issued as Pending; approving it supersedes the current sheet" : "Creates the first drawing for this project"}</div>
              </div>
              <button onClick={() => setShowRevModal(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>
            {/* State transition preview */}
            {activeDrawing && (
            <div className="bg-input border border-border-custom rounded-md p-3 space-y-1.5">
              <div className="text-[9px] uppercase tracking-wider text-muted mb-2">What will happen</div>
              {activeDrawing?.revisions.slice(0, 3).map(r => (
                <div key={r.id} className="flex items-center gap-2 text-[10px]">
                  <span className="text-muted font-bold w-6 shrink-0">{r.version}</span>
                  <Icon name="arrow_forward" className="w-3 h-3 text-muted" />
                  <span className={`px-1.5 py-0.5 rounded text-[8px] font-bold border ${r.status === "current" ? "bg-warning/10 border-warning/20 text-warning" : REV_META[r.status].badge}`}>
                    {r.status === "current" ? "Superseded on approval" : REV_META[r.status].label}
                  </span>
                </div>
              ))}
              <div className="flex items-center gap-2 text-[10px] border-t border-border-custom pt-1.5">
                <span className="text-foreground font-bold w-6 shrink-0">{newRevCode}</span>
                <Icon name="arrow_forward" className="w-3 h-3 text-muted" />
                <span className="px-1.5 py-0.5 rounded text-[8px] font-bold border bg-success/10 border-success/20 text-success">New Current</span>
              </div>
            </div>
            )}
            {!activeDrawing && (
              <div className="space-y-3">
                <div>
                  <div className="text-muted mb-1">Drawing Name</div>
                  <input type="text" value={newDrawingName} onChange={e => setNewDrawingName(e.target.value)}
                    className="w-full bg-input border border-border-custom rounded-lg p-2.5 text-foreground font-sans font-bold" />
                </div>
                <div>
                  <div className="text-muted mb-1">Category</div>
                  <select value={newDrawingCategory} onChange={e => setNewDrawingCategory(e.target.value)}
                    className="w-full bg-input border border-border-custom rounded-lg p-2.5 text-foreground font-sans">
                    {["2D Layout", "3D Layout", "Production File"].map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
            <div>
              <div className="text-muted mb-1">Drawing File</div>
              <input type="file" onChange={e => setNewRevFile(e.target.files?.[0] ?? null)}
                className="w-full bg-input border border-border-custom rounded-lg p-2.5 text-foreground text-xs file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:bg-primary/10 file:text-primary file:text-xs file:font-bold" />
              {!newRevFile && (
                <div className="text-[10px] text-muted mt-1">Required. A revision must carry its own sheet; reusing a previous revision&apos;s file is rejected.</div>
              )}
            </div>
            <div>
              <div className="text-muted mb-1">Version Code</div>
              <input type="text" value={newRevCode} onChange={e => setNewRevCode(e.target.value)}
                className="w-full bg-input border border-border-custom rounded-lg p-2.5 text-foreground font-sans font-bold" />
            </div>
            <div>
              <div className="text-muted mb-1">Release Notes</div>
              <textarea rows={3} value={newRevComment} onChange={e => setNewRevComment(e.target.value)}
                className="w-full bg-input border border-border-custom rounded-lg p-2.5 text-foreground resize-none"
                placeholder="Incorporated RFI comments, updated column grid..." />
            </div>
            <div className="flex gap-2 justify-end border-t border-border-custom pt-3">
              <button onClick={() => setShowRevModal(false)} className="px-4 py-2 bg-elevated text-muted hover:text-foreground rounded-md">Cancel</button>
              <button onClick={handlePublishRevision} disabled={!newRevCode.trim() || !newRevFile || (!activeDrawing && !newDrawingName.trim())}
                className="px-5 py-2 bg-primary text-white font-bold rounded-md hover:opacity-90 disabled:opacity-40 transition-all">
                Publish {newRevCode}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}