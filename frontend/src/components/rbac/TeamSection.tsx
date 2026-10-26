"use client";

import React, { useEffect, useState, useCallback } from "react";
import { getApi, authHeaders } from "@/lib/siteflow";
import { EmptyState } from "@/components/ui/EmptyState";
import { detailToMessage } from "@/lib/api";

interface TeamMember {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role_id: string | null;
  role_name: string | null;
  priority_type: string;
}

interface RoleOption {
  id: string;
  role_name: string;
}

interface Props {
  companyId: string;
}

export default function TeamSection({ companyId }: Props) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(
    null
  );

  const load = useCallback(() => {
    if (!companyId) return;
    setLoading(true);
    Promise.all([
      fetch(getApi(`/settings/team/${companyId}`), { headers: authHeaders() }).then(
        (r) => (r.ok ? r.json() : [])
      ),
      fetch(getApi(`/settings/roles/${companyId}`), { headers: authHeaders() }).then(
        (r) => (r.ok ? r.json() : [])
      ),
    ])
      .then(([m, r]) => {
        setMembers(Array.isArray(m) ? m : []);
        setRoles(Array.isArray(r) ? r.map((x: any) => ({ id: x.id, role_name: x.role_name })) : []);
      })
      .catch(() => {
        setMembers([]);
        setRoles([]);
      })
      .finally(() => setLoading(false));
  }, [companyId]);

  useEffect(() => {
    load();
  }, [load]);

  const assignRole = async (memberId: string, roleId: string | null) => {
    setBusyId(memberId);
    setMsg(null);
    try {
      const res = await fetch(getApi(`/settings/team/${memberId}/role`), {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ role_id: roleId }),
      });
      if (res.ok) {
        const updated = await res.json();
        setMembers((prev) =>
          prev.map((m) =>
            m.id === memberId
              ? {
                  ...m,
                  role_id: updated.role_id ?? null,
                  role_name: updated.role_name ?? null,
                }
              : m
          )
        );
        setMsg({ type: "ok", text: "Role updated" });
        setTimeout(() => setMsg(null), 2000);
      } else {
        const err = await res.json().catch(() => ({}));
        setMsg({ type: "err", text: detailToMessage(err.detail, "Failed to assign role") });
      }
    } catch {
      setMsg({ type: "err", text: "Failed to assign role" });
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="text-xs text-muted">Loading team members…</div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-foreground uppercase tracking-wider text-muted">
            Team Members &amp; Roles
          </h2>
          <p className="mt-1 text-xs text-muted">
            Assign a role to each member. The role determines which modules and
            actions they can access across the workspace.
          </p>
        </div>
      </div>

      {msg && (
        <div
          className={`p-3 text-xs rounded-lg border ${
            msg.type === "ok"
              ? "bg-success/10 border-success/20 text-success"
              : "bg-danger/10 border-danger/20 text-danger"
          }`}
        >
          {msg.text}
        </div>
      )}

      {members.length === 0 ? (
        <EmptyState
          title="No team members found"
          description="Invite staff and partners to your workspace and assign granular module roles."
          action={{
            label: "+ Add Team Member",
            href: `/c/${companyId}/d/hr`,
          }}
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border-custom">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-elevated text-muted">
                <th className="px-4 py-2.5 text-left font-bold uppercase tracking-wider text-[10px]">
                  Member
                </th>
                <th className="px-4 py-2.5 text-left font-bold uppercase tracking-wider text-[10px]">
                  Contact
                </th>
                <th className="px-4 py-2.5 text-left font-bold uppercase tracking-wider text-[10px] w-64">
                  Role
                </th>
              </tr>
            </thead>
            <tbody>
              {members.map((m, i) => (
                <tr
                  key={m.id}
                  className={i % 2 ? "bg-background/40" : ""}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="h-8 w-8 shrink-0 rounded-full bg-primary/15 text-primary font-bold flex items-center justify-center text-xs">
                        {(m.name || "?").charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="font-medium text-foreground">{m.name}</div>
                        {m.priority_type === "partner" && (
                          <span className="text-[9px] bg-primary/15 text-primary px-1.5 py-0.5 rounded-full font-bold uppercase">
                            Owner
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    <div>{m.email || "—"}</div>
                    <div>{m.phone || ""}</div>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={m.role_id ?? ""}
                      disabled={busyId === m.id}
                      onChange={(e) =>
                        assignRole(m.id, e.target.value || null)
                      }
                      className="w-full rounded-md border border-border-custom bg-elevated px-2.5 py-2 text-xs text-foreground focus:outline-none focus:border-primary cursor-pointer"
                    >
                      <option value="">No role (full access via failsafe)</option>
                      {roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.role_name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
