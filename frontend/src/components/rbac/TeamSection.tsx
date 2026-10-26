"use client";

import React, { useEffect, useState, useCallback } from "react";
import { getApi, authHeaders } from "@/lib/siteflow";
import { detailToMessage } from "@/lib/api";
import { usePermissions } from "@/context/PermissionsContext";
import Badge from "@/components/ui/Badge";

interface TeamMember {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role_id: string | null;
  role_name: string | null;
  priority_type: string;
  invite_pending?: boolean;
  is_me?: boolean;
}

interface RoleOption {
  id: string;
  role_name: string;
  permissions: Record<string, boolean> | null;
}

interface Props {
  companyId: string;
}

// What each standard role is for, in the words a site office uses.
export const ROLE_SUMMARIES: Record<string, string> = {
  Owner: "Everything, including billing the company and every setting.",
  Admin: "Everything, same as the owner.",
  Manager: "Runs projects end to end, approves, and adds people. Can see payroll but not run it.",
  "Project partner": "Same as Manager, except adding people.",
  Accountant: "Accounts, bills and budgets, with approvals. Can look at everything else.",
  "Site Engineer": "Site work: progress, quality, safety, drawings, attendance, materials. Sees BOQ and bills, not accounts or payroll.",
  Supervisor: "Marks attendance, logs progress, quality and safety. No money pages.",
  "Associate HR": "Staff records, attendance and payroll.",
  Client: "Sees projects, reports and bills. Changes nothing.",
  "Sub Contractor": "Sees projects, drawings and their own work. Changes nothing.",
  Viewer: "Can look at everything, change nothing.",
};

const fullAccess = (r?: RoleOption | null) => !!r?.permissions && r.permissions.all === true;

const inputCls =
  "w-full rounded-md border border-border-custom bg-elevated px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary";

export default function TeamSection({ companyId }: Props) {
  const { isPartner, isSuperuser } = usePermissions();
  const canGrantFullAccess = isPartner || isSuperuser;

  const [members, setMembers] = useState<TeamMember[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const [showInvite, setShowInvite] = useState(false);
  const [invite, setInvite] = useState({ name: "", email: "", role_id: "" });
  const [inviting, setInviting] = useState(false);

  const load = useCallback(() => {
    if (!companyId) return;
    setLoading(true);
    Promise.all([
      fetch(getApi(`/settings/team/${companyId}`), { headers: authHeaders() }).then((r) => (r.ok ? r.json() : [])),
      fetch(getApi(`/settings/roles/${companyId}`), { headers: authHeaders() }).then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([m, r]) => {
        setMembers(Array.isArray(m) ? m : []);
        setRoles(
          Array.isArray(r)
            ? r.map((x: RoleOption) => ({ id: x.id, role_name: x.role_name, permissions: x.permissions }))
            : []
        );
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

  // Roles this person may hand out: full-access roles only for the owner or an admin.
  // "Owner" stays with the company's owner; give others Admin for full access.
  const assignable = roles.filter((r) => r.role_name.trim().toLowerCase() !== "owner" && (canGrantFullAccess || !fullAccess(r)));
  const onlyOwnerRole = roles.length > 0 && roles.every((r) => r.role_name === "Owner");

  const flash = (type: "ok" | "err", text: string) => {
    setMsg({ type, text });
    if (type === "ok") setTimeout(() => setMsg(null), 4000);
  };

  const assignRole = async (memberId: string, roleId: string) => {
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
          prev.map((m) => (m.id === memberId ? { ...m, role_id: updated.role_id ?? null, role_name: updated.role_name ?? null } : m))
        );
        flash("ok", `Role changed to ${updated.role_name}. It applies the next time they open a page.`);
      } else {
        const err = await res.json().catch(() => ({}));
        flash("err", detailToMessage(err.detail, "Could not change the role"));
      }
    } catch {
      flash("err", "Could not change the role");
    } finally {
      setBusyId(null);
    }
  };

  const sendInvite = async (body: { name: string; email: string; role_id: string }) => {
    const res = await fetch(getApi("/auth/team/invite"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
      body: JSON.stringify({ ...body, company_id: companyId }),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };

  const submitInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviting(true);
    setMsg(null);
    try {
      const { res, data } = await sendInvite({
        name: invite.name.trim(),
        email: invite.email.trim(),
        role_id: invite.role_id,
      });
      if (!res.ok) {
        flash("err", detailToMessage(data.detail, "Could not add this person"));
        return;
      }
      const demo = data.mock_code ? ` (Demo server: the code is ${data.mock_code}.)` : "";
      flash(
        "ok",
        data.status === "attached"
          ? `${invite.name || invite.email} already has a SiteFlow login and can open this company now.`
          : `Invite emailed to ${data.email}. They open the sign-in page, choose "Have an invite code?", and set a password.${demo}`
      );
      setInvite({ name: "", email: "", role_id: "" });
      setShowInvite(false);
      load();
    } catch {
      flash("err", "Could not add this person");
    } finally {
      setInviting(false);
    }
  };

  const resend = async (m: TeamMember) => {
    if (!m.email || !m.role_id) return;
    setBusyId(m.id);
    setMsg(null);
    try {
      const { res, data } = await sendInvite({ name: m.name, email: m.email, role_id: m.role_id });
      if (res.ok) {
        const demo = data.mock_code ? ` (Demo server: the code is ${data.mock_code}.)` : "";
        flash("ok", `A new invite code has been emailed to ${m.email}.${demo}`);
      } else {
        flash("err", detailToMessage(data.detail, "Could not resend the invite"));
      }
    } catch {
      flash("err", "Could not resend the invite");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (m: TeamMember) => {
    if (!confirm(`Remove ${m.name} from the company? They will no longer be able to open it. What they recorded stays.`)) return;
    setBusyId(m.id);
    setMsg(null);
    try {
      const res = await fetch(getApi(`/settings/team/${m.id}`), { method: "DELETE", headers: authHeaders() });
      if (res.ok) {
        setMembers((prev) => prev.filter((x) => x.id !== m.id));
        flash("ok", `${m.name} has been removed.`);
      } else {
        const err = await res.json().catch(() => ({}));
        flash("err", detailToMessage(err.detail, "Could not remove this person"));
      }
    } catch {
      flash("err", "Could not remove this person");
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return <div className="text-xs text-muted">Loading team members…</div>;
  }

  const inviteRole = roles.find((r) => r.id === invite.role_id);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wider text-muted">Team Members &amp; Roles</h2>
          <p className="mt-1 text-xs text-muted max-w-xl">
            Everyone who can sign in to this company. Their role decides which pages they see and what they can change.
            Every member sees every project.
          </p>
        </div>
        {!showInvite && (
          <button
            onClick={() => setShowInvite(true)}
            disabled={onlyOwnerRole}
            title={onlyOwnerRole ? "Add the standard roles first, in Roles & Access" : undefined}
            className="shrink-0 bg-primary text-white text-xs font-bold px-4 py-2.5 rounded-md disabled:opacity-50"
          >
            + Add person
          </button>
        )}
      </div>

      {onlyOwnerRole && (
        <div className="p-3 text-xs rounded-lg border bg-warning/10 border-warning/20 text-warning">
          This company only has the Owner role so far. Open Roles &amp; Access and press &quot;Add standard roles&quot;
          to get Supervisor, Site Engineer, Accountant and the rest, then come back to add people.
        </div>
      )}

      {msg && (
        <div
          className={`p-3 text-xs rounded-lg border ${
            msg.type === "ok" ? "bg-success/10 border-success/20 text-success" : "bg-danger/10 border-danger/20 text-danger"
          }`}
        >
          {msg.text}
        </div>
      )}

      {showInvite && (
        <form onSubmit={submitInvite} className="bg-card border border-border-custom rounded-lg p-5 space-y-4 max-w-2xl">
          <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">Add a person</h3>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted">Full name</span>
              <input required value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })}
                placeholder="Sunil Patil" className={inputCls} />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted">Email</span>
              <input required type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })}
                placeholder="sunil@yourcompany.in" className={inputCls} />
            </label>
            <label className="space-y-1 md:col-span-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted">Role</span>
              <select required value={invite.role_id} onChange={(e) => setInvite({ ...invite, role_id: e.target.value })} className={inputCls}>
                <option value="">Choose what they will do</option>
                {assignable.map((r) => (
                  <option key={r.id} value={r.id}>{r.role_name}</option>
                ))}
              </select>
              {inviteRole && (
                <span className="block text-[11px] text-muted">
                  {ROLE_SUMMARIES[inviteRole.role_name] || "A custom role. Its pages are set in Roles & Access."}
                </span>
              )}
            </label>
          </div>
          <p className="text-[11px] text-muted">
            We email them a code that works for 7 days. If they already use SiteFlow, they get this company straight away.
          </p>
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => setShowInvite(false)} className="text-muted hover:text-foreground text-xs font-bold px-4 py-2">
              Cancel
            </button>
            <button type="submit" disabled={inviting} className="bg-primary text-white text-xs font-bold px-4 py-2 rounded-md disabled:opacity-50">
              {inviting ? "Sending…" : "Send invite"}
            </button>
          </div>
        </form>
      )}

      <div className="overflow-x-auto rounded-lg border border-border-custom">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-elevated text-muted">
              <th className="px-4 py-2.5 text-left font-bold uppercase tracking-wider text-[10px]">Member</th>
              <th className="px-4 py-2.5 text-left font-bold uppercase tracking-wider text-[10px]">Contact</th>
              <th className="px-4 py-2.5 text-left font-bold uppercase tracking-wider text-[10px] w-72">Role</th>
              <th className="px-4 py-2.5 text-right font-bold uppercase tracking-wider text-[10px]">Action</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m, i) => {
              const current = roles.find((r) => r.id === m.role_id);
              const isOwner = m.priority_type === "partner";
              // The owner's seat, and anyone with full access when you lack it, is not yours to change.
              const locked = isOwner || (fullAccess(current) && !canGrantFullAccess);
              const options = current && !assignable.some((r) => r.id === current.id) ? [current, ...assignable] : assignable;
              return (
                <tr key={m.id} className={i % 2 ? "bg-background/40" : ""}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="h-8 w-8 shrink-0 rounded-full bg-primary/15 text-primary font-bold flex items-center justify-center text-xs">
                        {(m.name || "?").charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="font-medium text-foreground">
                          {m.name}
                          {m.is_me && <span className="ml-1.5 text-muted font-normal">(you)</span>}
                        </div>
                        <div className="mt-0.5 flex gap-1">
                          {isOwner && <Badge tone="info">Owner</Badge>}
                          {m.invite_pending && <span className="whitespace-nowrap"><Badge tone="warning">Invite pending</Badge></span>}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    <div>{m.email || "No email"}</div>
                    {m.phone && <div>{m.phone}</div>}
                  </td>
                  <td className="px-4 py-3">
                    {locked ? (
                      <div className="text-foreground font-semibold">{m.role_name || (isOwner ? "Owner" : "No role")}</div>
                    ) : (
                      <select
                        value={m.role_id ?? ""}
                        disabled={busyId === m.id}
                        onChange={(e) => e.target.value && assignRole(m.id, e.target.value)}
                        className="w-full rounded-md border border-border-custom bg-elevated px-2.5 py-2 text-xs text-foreground focus:outline-none focus:border-primary cursor-pointer"
                      >
                        {!m.role_id && <option value="">Pick a role</option>}
                        {options.map((r) => (
                          <option key={r.id} value={r.id}>{r.role_name}</option>
                        ))}
                      </select>
                    )}
                    {m.role_name && ROLE_SUMMARIES[m.role_name] && (
                      <div className="mt-1 text-[10px] text-muted leading-snug">{ROLE_SUMMARIES[m.role_name]}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap space-x-2">
                    {m.invite_pending && (
                      <button onClick={() => resend(m)} disabled={busyId === m.id}
                        className="px-3 py-1.5 rounded-lg bg-primary/10 text-primary text-[10px] font-bold border border-primary/20 hover:bg-primary/20 disabled:opacity-50">
                        Resend invite
                      </button>
                    )}
                    {!isOwner && !m.is_me && !locked && (
                      <button onClick={() => remove(m)} disabled={busyId === m.id}
                        className="px-3 py-1.5 rounded-lg bg-danger/10 text-danger text-[10px] font-bold border border-danger/20 hover:bg-danger/20 disabled:opacity-50">
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
