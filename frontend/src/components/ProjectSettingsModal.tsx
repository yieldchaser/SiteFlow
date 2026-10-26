"use client";

import React, { useCallback, useEffect, useState } from "react";
import { getApi, authHeaders, fmtINR, initials } from "@/lib/siteflow";
import Icon from "@/components/marketing/Icon";
import { EmptyState } from "@/components/ui/EmptyState";
import { GST_STATES, PROJECT_STAGES, PROJECT_CATEGORIES } from "@/lib/gstStates";

export type ProjectSettingsData = {
  id: string;
  name: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  location?: string | null;
  stage?: string | null;
  category?: string | null;
  project_value?: number;
  orientation?: string | null;
  dimension?: string | null;
  scope_of_work?: string | null;
  attendance_radius_meters?: number;
  project_avatar?: string | null;
};

type Member = {
  company_team_id: string;
  name: string;
  role?: string | null;
  mobile?: string | null;
};

type Location = { id: string; name: string; parent_id: string | null };

async function readErrorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.detail === "string" && body.detail) return body.detail;
  } catch {}
  return `HTTP ${res.status}`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted">{label}</div>
      {children}
    </div>
  );
}

export default function ProjectSettingsModal({
  project,
  companyId,
  onClose,
  onSaved,
}: {
  project: ProjectSettingsData;
  companyId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = getApi;
  const auth = authHeaders;
  const [tab, setTab] = useState<"details" | "members" | "locations">("details");
  const [form, setForm] = useState({
    name: project.name,
    address: project.address || "",
    city: project.city || "",
    // Without state the project cannot be invoiced at all: billing and
    // quotation conversion both refuse, because place of supply derives from
    // the site. Projects created before this field existed have state null and
    // this modal is how they get corrected.
    state: project.state || "",
    location: project.location || "",
    stage: project.stage || "",
    category: project.category || "",
    project_value: String(project.project_value || 0),
    orientation: project.orientation || "",
    dimension: project.dimension || "",
    scope_of_work: project.scope_of_work || "",
    attendance_radius_meters: project.attendance_radius_meters || 500,
    project_avatar: project.project_avatar || "",
  });
  const [locations, setLocations] = useState<Location[]>([]);
  const [newLoc, setNewLoc] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [saving, setSaving] = useState(false);

  const loadLocations = useCallback(() => {
    fetch(api(`/projects/${project.id}/locations`), { headers: auth() })
      .then((r) => (r.ok ? r.json() : []))
      .then(setLocations)
      .catch(() => setLocations([]));
  }, [project.id]);

  useEffect(() => {
    loadLocations();
    fetch(api(`/projects/${project.id}/members`), { headers: auth() })
      .then((r) => (r.ok ? r.json() : []))
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [project.id, loadLocations]);

  const removeMember = async (memberId: string) => {
    if (!confirm("Are you sure you want to remove this member from the project?")) return;
    try {
      const res = await fetch(api(`/projects/${project.id}/members/${memberId}`), {
        method: "DELETE",
        headers: auth(),
      });
      if (res.ok) {
        setMembers((prev) => prev.filter((m) => m.company_team_id !== memberId));
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to remove member");
      }
    } catch (e) {
      console.error(e);
      alert("Failed to remove member. Check your connection.");
    }
  };

  const saveDetails = async () => {
    setSaving(true);
    try {
      const res = await fetch(api(`/projects/${project.id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(auth() || {}) },
        body: JSON.stringify({
          name: form.name,
          address: form.address,
          city: form.city,
          state: form.state || null,
          location: form.location.trim() || null,
          stage: form.stage,
          category: form.category,
          // Left out for roles that cannot see the accounts, so a save never zeroes it.
          ...(project.project_value == null ? {} : { project_value: parseFloat(form.project_value) || 0 }),
          orientation: form.orientation,
          dimension: form.dimension,
          scope_of_work: form.scope_of_work,
          attendance_radius_meters: form.attendance_radius_meters,
          project_avatar: form.project_avatar || null,
        }),
      });
      if (!res.ok) throw new Error(await readErrorDetail(res));
      onSaved();
    } catch (e) {
      alert(
        `Failed to save project settings: ${
          e instanceof Error ? e.message : "server unreachable"
        }`
      );
    } finally {
      setSaving(false);
    }
  };

  const addLocation = async () => {
    if (!newLoc.trim()) return;
    const res = await fetch(api(`/projects/${project.id}/locations`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(auth() || {}) },
      body: JSON.stringify({ name: newLoc.trim() }),
    });
    if (res.ok) {
      setNewLoc("");
      loadLocations();
    } else {
      const err = await readErrorDetail(res);
      alert(`Failed to add location: ${err}`);
    }
  };

  const deleteLocation = async (id: string) => {
    try {
      const res = await fetch(api(`/projects/${project.id}/locations/${id}`), {
        method: "DELETE",
        headers: auth(),
      });
      if (!res.ok) throw new Error(await readErrorDetail(res));
      loadLocations();
    } catch (e) {
      alert(
        `Failed to delete location: ${e instanceof Error ? e.message : "server unreachable"}`
      );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-lg border border-border-custom bg-card">
        <div className="flex items-center justify-between border-b border-border-custom px-6 py-4">
          <h3 className="text-lg font-semibold text-foreground">Project Settings</h3>
          <button
            onClick={onClose}
            className="text-muted hover:text-foreground p-1 cursor-pointer"
            aria-label="Close modal"
          >
            <Icon name="close" className="w-4 h-4" />
          </button>
        </div>

        <div className="flex gap-1 px-6 py-2.5 border-b border-border-custom bg-elevated/40">
          {(["details", "members", "locations"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-md capitalize transition-all cursor-pointer ${
                tab === t
                  ? "bg-card text-foreground font-semibold"
                  : "text-muted hover:text-foreground hover:bg-card/40 font-medium"
              }`}
            >
              {t === "details" ? "Project Details" : t === "members" ? "Members" : "Location Structure"}
            </button>
          ))}
        </div>

        <div className="p-6 max-h-[60vh] overflow-y-auto">
          {tab === "details" && (
            <div className="space-y-3">
              <Field label="Project Name">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Stage">
                  <select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground">
                    <option value="">Select stage</option>
                    {PROJECT_STAGES.map((st) => (<option key={st} value={st}>{st}</option>))}
                    {form.stage && !PROJECT_STAGES.includes(form.stage as (typeof PROJECT_STAGES)[number]) && (
                      <option value={form.stage}>{form.stage}</option>
                    )}
                  </select>
                </Field>
                <Field label="Category">
                  <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground">
                    <option value="">Select category</option>
                    {PROJECT_CATEGORIES.map((c) => (<option key={c} value={c}>{c}</option>))}
                    {form.category && !PROJECT_CATEGORIES.includes(form.category as (typeof PROJECT_CATEGORIES)[number]) && (
                      <option value={form.category}>{form.category}</option>
                    )}
                  </select>
                </Field>
              </div>
              <Field label="Address">
                <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="City">
                  <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
                </Field>
                <Field label="State (required for invoicing)">
                  <select value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground">
                    <option value="">Select state</option>
                    {GST_STATES.map((st) => (
                      <option key={st.code} value={st.name}>{st.code} - {st.name}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Site Coordinates">
                  <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="28.6280, 77.3649" className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
                </Field>
                {project.project_value != null && (
                  <Field label="Project Value">
                    <input type="number" value={form.project_value} onChange={(e) => setForm({ ...form, project_value: e.target.value })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
                  </Field>
                )}
              </div>
              <Field label="Orientation"><input value={form.orientation} onChange={(e) => setForm({ ...form, orientation: e.target.value })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" /></Field>
              <Field label="Dimension"><input value={form.dimension} onChange={(e) => setForm({ ...form, dimension: e.target.value })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" /></Field>
              <Field label="Scope of Work"><textarea value={form.scope_of_work} onChange={(e) => setForm({ ...form, scope_of_work: e.target.value })} rows={3} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" /></Field>
              <Field label="Project Avatar / Cover Image URL"><input value={form.project_avatar} onChange={(e) => setForm({ ...form, project_avatar: e.target.value })} placeholder="https://... or /images/..." className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" /></Field>
              <Field label="Attendance Radius (meters)"><input type="number" value={form.attendance_radius_meters} onChange={(e) => setForm({ ...form, attendance_radius_meters: parseInt(e.target.value) || 500 })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" /></Field>
              <div className="flex justify-end pt-2">
                <button onClick={saveDetails} disabled={saving} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          )}

          {tab === "members" && (
            <div className="space-y-1">
              {members.map((m) => (
                <div key={m.company_team_id} className="flex items-center justify-between px-3 py-2 rounded-md hover:bg-elevated">
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-semibold">{initials(m.name)}</div>
                    <div>
                      <div className="text-sm text-foreground">{m.name}</div>
                      <div className="text-xs text-muted">{m.role || "Member"}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs rounded-full bg-elevated px-2 py-0.5 text-muted">{m.mobile || ""}</span>
                    <button
                      type="button"
                      onClick={() => removeMember(m.company_team_id)}
                      className="p-1.5 hover:bg-danger/10 text-muted hover:text-danger rounded cursor-pointer transition-all"
                      title="Remove member from project"
                    >
                      <Icon name="trash" className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
              {members.length === 0 && <div className="text-sm text-muted">No members.</div>}
            </div>
          )}

          {tab === "locations" && (
            <div className="space-y-3">
              <div className="flex gap-2">
                <input value={newLoc} onChange={(e) => setNewLoc(e.target.value)} placeholder="Location Name (e.g. Tower A)" className="flex-1 rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
                <button onClick={addLocation} className="rounded-md bg-primary px-4 py-2 text-sm text-white">+ Location</button>
              </div>
              <div className="divide-y divide-border-custom rounded-md border border-border-custom">
                {locations.map((l) => (
                  <div key={l.id} className="flex items-center justify-between px-3 py-2">
                    <span className="text-sm text-foreground">{l.name}</span>
                    <button onClick={() => deleteLocation(l.id)} className="text-xs text-muted hover:text-danger">Delete</button>
                  </div>
                ))}
                {locations.length === 0 && (
                  <div className="p-4">
                    <EmptyState
                      title="No locations yet"
                      description="Add project site locations, zones, or tower areas."
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
