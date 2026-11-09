"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { getApi, authHeaders, downloadWithAuth, formatDate } from "@/lib/siteflow";
import Icon from "@/components/marketing/Icon";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";

// ─── Types ────────────────────────────────────────────────────────────────────
type Folder = { id: string; project_id: string; parent_id: string | null; name: string };
type FileMeta = {
  id: string;
  project_id: string;
  folder_id: string | null;
  name: string;
  original_filename: string;
  content_type: string | null;
  size: number;
  uploaded_at: string;
};

type Crumb = { id: string | null; name: string };

const fmtSize = (n: number) => {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

const ext = (name: string) => (name.includes(".") ? name.split(".").pop()!.toUpperCase().slice(0, 4) : "FILE");

export default function FilesTab() {
  const params = useParams();
  const companyId = params.company_id as string;
  const projectId = params.project_id as string;

  const [path, setPath] = useState<Crumb[]>([{ id: null, name: "Root" }]);
  const currentFolderId = path[path.length - 1].id;

  const [folders, setFolders] = useState<Folder[]>([]);
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [savingFolder, setSavingFolder] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [preview, setPreview] = useState<FileMeta | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [fRes, fiRes] = await Promise.all([
        fetch(getApi(`/files/folders?project_id=${projectId}${currentFolderId ? `&parent_id=${currentFolderId}` : ""}`), {
          headers: authHeaders(),
        }),
        fetch(getApi(`/files/files?project_id=${projectId}${currentFolderId ? `&folder_id=${currentFolderId}` : ""}`), {
          headers: authHeaders(),
        }),
      ]);
      if (!fRes.ok) throw new Error(`Folders ${fRes.status}`);
      if (!fiRes.ok) throw new Error(`Files ${fiRes.status}`);
      setFolders(await fRes.json());
      setFiles(await fiRes.json());
    } catch (e: any) {
      setError(e?.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [projectId, currentFolderId]);

  useEffect(() => {
    load();
  }, [load]);

  const navigate = (folder: Folder) => setPath((p) => [...p, { id: folder.id, name: folder.name }]);
  const jumpTo = (idx: number) => setPath((p) => p.slice(0, idx + 1));

  const createFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    setSavingFolder(true);
    setError(null);
    try {
      const res = await fetch(getApi("/files/folders"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ project_id: projectId, parent_id: currentFolderId, name }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `Error ${res.status}`);
      }
      setShowNewFolder(false);
      setNewFolderName("");
      await load();
    } catch (e: any) {
      setError(e?.message || "Failed to create folder");
    } finally {
      setSavingFolder(false);
    }
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list || list.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const f of Array.from(list)) {
        const body = new FormData();
        body.append("project_id", projectId);
        if (currentFolderId) body.append("folder_id", currentFolderId);
        body.append("file", f);
        const res = await fetch(getApi("/files/upload"), { method: "POST", body, headers: authHeaders() });
        if (!res.ok) {
          const t = await res.text();
          throw new Error(t || `Upload failed ${res.status}`);
        }
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
      await load();
    } catch (e: any) {
      setError(e?.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const deleteFolder = async (folderId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this folder?")) return;
    try {
      const res = await fetch(getApi(`/files/folders/${folderId}`), {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `Error ${res.status}`);
      }
      await load();
    } catch (err: any) {
      setError(err?.message || "Failed to delete folder");
    }
  };

  const kindOf = (f: FileMeta) => {
    const t = (f.content_type || "").toLowerCase();
    const e = ext(f.name).toLowerCase();
    if (t.includes("pdf") || e === "pdf") return "pdf";
    if (t.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(e)) return "image";
    return "other";
  };

  // The file endpoint needs the login token, which a plain link, <img> or
  // <iframe> cannot send: Download used to open a "Could not validate
  // credentials" page and PDFs never previewed. Fetch with the token and show
  // a local copy instead.
  // The result is tagged with the file it belongs to, so opening another file
  // never shows the previous one.
  const [loaded, setLoaded] = useState<{ id: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!preview || kindOf(preview) === "other") return;
    let url: string | null = null;
    let cancelled = false;
    fetch(getApi(`/files/file/${preview.id}`), { headers: authHeaders() })
      .then((res) => (res.ok ? res.blob() : Promise.reject(res.status)))
      .then((blob) => {
        if (cancelled) return;
        // Stored copies sometimes come back as octet-stream; give the browser the real type.
        const type = preview.content_type || blob.type;
        url = URL.createObjectURL(type && type !== blob.type ? new Blob([blob], { type }) : blob);
        setLoaded({ id: preview.id, url });
      })
      .catch(() => !cancelled && setLoaded({ id: preview.id, url: null }));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [preview]);
  const mine = preview && loaded?.id === preview.id ? loaded : null;
  const previewUrl = mine?.url || null;
  const previewState: "idle" | "loading" | "failed" =
    !preview || kindOf(preview) === "other" ? "idle" : !mine ? "loading" : mine.url ? "idle" : "failed";

  const [downloading, setDownloading] = useState(false);
  const download = async (f: FileMeta) => {
    setDownloading(true);
    try {
      await downloadWithAuth(`/files/file/${f.id}?download=1`, f.original_filename || f.name);
    } catch {
      alert("Could not download this file. Check your connection and try again.");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader title="Documents" subtitle="Drawings, contracts and site file repository">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowNewFolder(true)}
            className="px-3.5 py-1.5 bg-elevated text-muted text-xs font-bold rounded-lg hover:bg-elevated transition-all border border-border-custom cursor-pointer"
          >
            + New Folder
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="px-3.5 py-1.5 bg-primary text-white text-xs font-bold rounded-lg hover:opacity-90 transition-all disabled:opacity-40 cursor-pointer"
          >
            {uploading ? "Uploading…" : "Upload"}
          </button>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onUpload} />
        </div>
      </PageHeader>

      <div className="px-5 py-2 border-b border-border-custom shrink-0 flex items-center gap-1 text-[11px] text-muted">
        {path.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-muted">/</span>}
            <button
              onClick={() => jumpTo(i)}
              className={i === path.length - 1 ? "text-primary font-semibold" : "hover:text-foreground"}
            >
              {c.name}
            </button>
          </span>
        ))}
      </div>

      <div className="flex-1 overflow-auto">
        <PageShell width="wide">
          {loading && <CardSkeleton />}
          {error && !loading && <div className="p-10 text-center text-danger text-xs">{error}</div>}
          {!loading && !error && folders.length === 0 && files.length === 0 && (
            <EmptyState
              title="This folder is empty"
              description="Create a new folder or upload a document."
              action={{ label: "Upload", onClick: () => fileInputRef.current?.click() }}
            />
          )}

        {!loading && !error && (folders.length > 0 || files.length > 0) && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {folders.map((f) => (
              <button
                key={f.id}
                onClick={() => navigate(f)}
                className="group relative rounded-lg border border-border-custom bg-card p-3 text-left hover:border-primary/50 transition-colors"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="text-2xl inline-flex"><Icon name="folder" className="w-6 h-6" /></div>
                  <button
                    type="button"
                    onClick={(e) => deleteFolder(f.id, e)}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:text-danger text-muted transition-opacity cursor-pointer"
                    title="Delete Folder"
                  >
                    <Icon name="trash" className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="text-xs text-foreground font-medium truncate">{f.name}</div>
                <div className="text-[9px] text-muted mt-0.5">Folder</div>
              </button>
            ))}
            {files.map((f) => (
              <button
                key={f.id}
                onClick={() => setPreview(f)}
                className="group rounded-lg border border-border-custom bg-card p-3 text-left hover:border-primary/50 transition-colors"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-2xl inline-flex"><Icon name="description" className="w-6 h-6" /></span>
                  <span className="text-[8px] uppercase px-1 py-0.5 rounded bg-elevated text-muted">
                    {ext(f.name)}
                  </span>
                </div>
                <div className="text-xs text-foreground font-medium truncate">{f.name}</div>
                <div className="text-[9px] text-muted mt-0.5">{fmtSize(f.size)} · {formatDate(f.uploaded_at)}</div>
              </button>
            ))}
          </div>
        )}
        </PageShell>
      </div>

      {showNewFolder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-lg border border-border-custom bg-card p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-foreground">New Folder</h3>
              <button onClick={() => setShowNewFolder(false)} className="text-muted hover:text-foreground cursor-pointer">
                <Icon name="close" className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={createFolder} className="space-y-4">
              <div>
                <label className="text-xs font-medium text-muted">Folder Name</label>
                <input
                  autoFocus
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="e.g. Structural Drawings"
                  className="mt-1 w-full bg-input border border-border-custom rounded-lg px-3 py-2 text-sm text-foreground placeholder-muted"
                />
              </div>
              {error && <div className="text-[11px] text-danger">{error}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowNewFolder(false)}
                  className="px-4 py-2 bg-elevated text-muted text-sm rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingFolder}
                  className="px-4 py-2 bg-primary text-white text-sm font-bold rounded-lg disabled:opacity-40"
                >
                  {savingFolder ? "Creating…" : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-4xl h-[88vh] rounded-lg border border-border-custom bg-card flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border-custom">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground truncate">{preview.name}</div>
                <div className="text-[10px] text-muted">{fmtSize(preview.size)} · Uploaded {formatDate(preview.uploaded_at)}</div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => download(preview)}
                  disabled={downloading}
                  className="px-3 py-1.5 bg-primary text-white text-xs font-bold rounded-lg hover:opacity-90 disabled:opacity-50 cursor-pointer"
                >
                  {downloading ? "Downloading…" : "Download"}
                </button>
                <button onClick={() => setPreview(null)} className="text-muted hover:text-foreground cursor-pointer">
                  <Icon name="close" className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 bg-elevated overflow-hidden">
              {previewUrl && kindOf(preview) === "pdf" ? (
                <iframe src={previewUrl} title={preview.name} className="w-full h-full border-0" />
              ) : previewUrl && kindOf(preview) === "image" ? (
                <div className="h-full overflow-auto flex items-center justify-center p-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={previewUrl} alt={preview.name} className="max-w-full max-h-full object-contain" />
                </div>
              ) : previewState === "loading" ? (
                <div className="h-full flex items-center justify-center text-sm text-muted">Loading preview…</div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center gap-3 text-center p-6">
                  <div className="text-5xl inline-flex"><Icon name="description" className="w-12 h-12" /></div>
                  <div className="text-sm text-muted">
                    {previewState === "failed" ? "Could not load the preview." : "This type of file cannot be previewed here."}
                  </div>
                  <button
                    onClick={() => download(preview)}
                    disabled={downloading}
                    className="px-4 py-2 bg-primary text-white text-xs font-bold rounded-lg hover:opacity-90 disabled:opacity-50 cursor-pointer"
                  >
                    Download {ext(preview.name)}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
