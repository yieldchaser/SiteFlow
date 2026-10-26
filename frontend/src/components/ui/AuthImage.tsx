"use client";
import React, { useEffect, useState } from "react";
import { getApiHost } from "@/lib/api";
import { authHeaders } from "@/lib/siteflow";

/** Full URL for a stored path such as "/apis/v3/files/file/{id}". */
export const apiFileUrl = (src: string) => (src.startsWith("/") ? `${getApiHost()}${src}` : src);

const isApiFile = (src: string) => src.startsWith("/apis/") || src.startsWith(`${getApiHost()}/apis/`);

/**
 * An <img> for files the API serves only to signed-in users. A plain <img src>
 * cannot send the login token, so those files are fetched with it and shown
 * from a local copy. Any other address renders as a normal image.
 */
export default function AuthImage({
  src,
  alt,
  className,
  fallback = null,
  onClick,
}: {
  src: string;
  alt: string;
  className?: string;
  fallback?: React.ReactNode;
  onClick?: (objectUrl: string) => void;
}) {
  const needsAuth = isApiFile(src);
  // Result is tagged with the src it belongs to, so a new src never shows the old picture.
  const [loaded, setLoaded] = useState<{ src: string; url: string | null; failed: boolean } | null>(null);

  useEffect(() => {
    if (!needsAuth) return;
    let revoked = false;
    let created: string | null = null;
    fetch(apiFileUrl(src), { headers: authHeaders() })
      .then((res) => (res.ok ? res.blob() : Promise.reject(res.status)))
      .then((blob) => {
        if (revoked) return;
        created = URL.createObjectURL(blob);
        setLoaded({ src, url: created, failed: false });
      })
      .catch(() => !revoked && setLoaded({ src, url: null, failed: true }));
    return () => {
      revoked = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [src, needsAuth]);

  const current = loaded?.src === src ? loaded : null;
  if (current?.failed) return <>{fallback}</>;
  const shown = needsAuth ? current?.url ?? null : src;
  if (!shown) return <div className={`${className ?? ""} animate-pulse bg-elevated`} aria-label={alt} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={shown} alt={alt} className={className} onClick={onClick ? () => onClick(shown) : undefined} />
  );
}

/**
 * Upload an image into the project's "Chat Photos" folder and return the
 * stored path to save on the record.
 */
export async function uploadProjectImage(projectId: string, file: File): Promise<string> {
  const host = getApiHost();
  const headers = authHeaders() || {};
  const FOLDER = "Chat Photos";
  let folderId: string | undefined;
  try {
    const res = await fetch(`${host}/apis/v3/files/folders?project_id=${projectId}`, { headers });
    const folders: Array<{ id: string; name: string }> = res.ok ? await res.json() : [];
    folderId = folders.find((f) => f.name === FOLDER)?.id;
    if (!folderId) {
      const made = await fetch(`${host}/apis/v3/files/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ project_id: projectId, name: FOLDER }),
      });
      if (made.ok) folderId = (await made.json()).id;
    }
  } catch {
    // No folder is fine: the file then lands in the project's root folder.
  }
  const fd = new FormData();
  fd.append("project_id", projectId);
  if (folderId) fd.append("folder_id", folderId);
  fd.append("file", file);
  const res = await fetch(`${host}/apis/v3/files/upload`, { method: "POST", headers, body: fd });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : "Upload failed");
  }
  const meta = await res.json();
  return `/apis/v3/files/file/${meta.id}`;
}
