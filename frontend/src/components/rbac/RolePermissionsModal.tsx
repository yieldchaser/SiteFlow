"use client";

import React, { useEffect, useMemo, useState } from "react";
import Icon from "@/components/marketing/Icon";
import { getApi, authHeaders } from "@/lib/siteflow";
import { detailToMessage } from "@/lib/api";
import {
  MODULES,
  MODULE_LABELS,
  ACTION_LABELS,
  WORKFLOW_MODULES,
  GLOBAL_CAPABILITY_KEYS,
  GLOBAL_CAPABILITY_LABELS,
  LOCKED_ROLES,
  ALL_PERMISSION_KEYS,
  PermissionDict,
} from "@/lib/rbac";

export interface RoleForEditor {
  id: string;
  role_name: string;
  permissions?: PermissionDict | null;
}

interface Props {
  role: RoleForEditor | null;
  onClose: () => void;
  onSaved: (role: RoleForEditor) => void;
}

function buildInitialDraft(perms?: PermissionDict | null): PermissionDict {
  // R2-757: preserve any out-of-taxonomy or legacy permission keys stored on the role
  // so opening and saving a role never silently revokes them.
  const draft: PermissionDict = perms ? { ...perms } : {};
  if ("all" in draft) delete draft["all"];
  for (const key of ALL_PERMISSION_KEYS) {
    if (key === "all") continue;
    if (!(key in draft)) {
      draft[key] = false;
    }
  }
  return draft;
}

export default function RolePermissionsModal({ role, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState<PermissionDict>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(
    null
  );

  const locked = !!role && LOCKED_ROLES.has(role.role_name);

  useEffect(() => {
    if (role) setDraft(buildInitialDraft(role.permissions));
    setMsg(null);
  }, [role]);

  const unrecognisedKeys = useMemo(() => {
    const canonicalSet = new Set<string>(ALL_PERMISSION_KEYS);
    canonicalSet.add("all");
    return Object.keys(draft).filter((k) => !canonicalSet.has(k) && draft[k]);
  }, [draft]);

  const grouped = useMemo(() => {
    return MODULES.map((m) => ({
      module: m,
      label: MODULE_LABELS[m] ?? m,
      view: `${m}:view`,
      edit: `${m}:edit`,
      approve: WORKFLOW_MODULES.has(m) ? `${m}:approve` : null,
    }));
  }, []);

  if (!role) return null;

  const toggle = (key: string) =>
    setDraft((d) => ({ ...d, [key]: !d[key] }));

  const setAll = (value: boolean) => {
    setDraft((prev) => {
      const next: PermissionDict = { ...prev };
      for (const key of ALL_PERMISSION_KEYS) {
        if (key === "all") continue;
        next[key] = value;
      }
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch(getApi(`/settings/roles/${role.id}/permissions`), {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ permissions: draft }),
      });
      if (res.ok) {
        const updated = await res.json();
        setMsg({ type: "ok", text: "Permissions saved" });
        onSaved({ id: role.id, role_name: role.role_name, permissions: updated.permissions });
        setTimeout(onClose, 700);
      } else {
        const err = await res.json().catch(() => ({}));
        setMsg({
          type: "err",
          text: detailToMessage(err.detail, "Failed to save permissions"),
        });
      }
    } catch {
      setMsg({ type: "err", text: "Failed to save permissions" });
    } finally {
      setSaving(false);
    }
  };

  const Checkbox = ({
    checked,
    onChange,
    label,
    disabled,
  }: {
    checked: boolean;
    onChange?: () => void;
    label: string;
    disabled?: boolean;
  }) => (
    <label
      className={`flex items-center gap-1.5 text-xs select-none ${
        disabled ? "opacity-60" : "cursor-pointer hover:text-foreground"
      } ${checked ? "text-primary font-semibold" : "text-muted"}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="h-3.5 w-3.5 accent-primary rounded border-border-custom"
      />
      {label}
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-3xl max-h-[88vh] overflow-y-auto rounded-lg border border-border-custom bg-card shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-custom px-6 py-4">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-foreground">
              Permissions: {role.role_name}
            </h2>
            <p className="mt-0.5 text-[11px] text-muted">
              {locked
                ? "This role has full access and is locked. It cannot be restricted."
                : "Tick what people with this role can see, change and approve."}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-foreground p-1 cursor-pointer"
            aria-label="Close"
          >
            <Icon name="close" className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-6 px-6 py-5">
          {locked ? (
            <div className="rounded-md border border-success/30 bg-success/10 p-4 text-xs text-success">
              <span className="font-bold">{role.role_name}</span> can see and change everything
              in the company. To give someone less, pick a different role for them in the Team tab.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-muted font-bold">
                  Module Access
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setAll(true)}
                    className="text-[10px] bg-primary/10 text-primary border border-primary/20 px-2.5 py-1 rounded-md hover:bg-primary/20"
                  >
                    Grant All
                  </button>
                  <button
                    onClick={() => setAll(false)}
                    className="text-[10px] bg-elevated text-muted border border-border-custom px-2.5 py-1 rounded-md hover:text-foreground"
                  >
                    Clear All
                  </button>
                </div>
              </div>

              {/* Matrix: module × action */}
              <div className="overflow-hidden rounded-md border border-border-custom">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-elevated text-muted">
                      <th className="px-3 py-2 text-left font-bold uppercase tracking-wider text-[10px]">
                        Module
                      </th>
                      <th className="px-3 py-2 text-center font-bold uppercase tracking-wider text-[10px]">
                        {ACTION_LABELS.view}
                      </th>
                      <th className="px-3 py-2 text-center font-bold uppercase tracking-wider text-[10px]">
                        {ACTION_LABELS.edit}
                      </th>
                      <th className="px-3 py-2 text-center font-bold uppercase tracking-wider text-[10px]">
                        {ACTION_LABELS.approve}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {grouped.map((row, i) => (
                      <tr
                        key={row.module}
                        className={i % 2 ? "bg-background/40" : ""}
                      >
                        <td className="px-3 py-2 font-medium text-foreground">
                          {row.label}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <Checkbox
                            checked={!!draft[row.view]}
                            onChange={() => toggle(row.view)}
                            label=""
                          />
                        </td>
                        <td className="px-3 py-2 text-center">
                          <Checkbox
                            checked={!!draft[row.edit]}
                            onChange={() => toggle(row.edit)}
                            label=""
                          />
                        </td>
                        <td className="px-3 py-2 text-center">
                          {row.approve ? (
                            <Checkbox
                              checked={!!draft[row.approve]}
                              onChange={() => row.approve && toggle(row.approve)}
                              label=""
                            />
                          ) : (
                            <span className="text-muted/40">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Global capabilities */}
              <div>
                <span className="text-[10px] uppercase tracking-wider text-muted font-bold">
                  Global Capabilities
                </span>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {GLOBAL_CAPABILITY_KEYS.map((g) => (
                    <div
                      key={g}
                      className="rounded-md border border-border-custom bg-background/40 px-3 py-2"
                    >
                      <Checkbox
                        checked={!!draft[g]}
                        onChange={() => toggle(g)}
                        label={GLOBAL_CAPABILITY_LABELS[g] ?? g}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Preserved Legacy / Out-of-Taxonomy Permissions */}
              {unrecognisedKeys.length > 0 && (
                <div className="rounded-md border border-warning/30 bg-warning/10 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] uppercase tracking-wider text-warning font-bold">
                      Preserved Legacy Permissions ({unrecognisedKeys.length})
                    </span>
                    <span className="text-[10px] text-muted">
                      Retained automatically on save
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {unrecognisedKeys.map((k) => (
                      <span
                        key={k}
                        className="inline-flex items-center gap-1 rounded bg-warning/20 px-2 py-0.5 text-[11px] font-mono text-warning border border-warning/40"
                      >
                        <code>{k}</code>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border-custom px-6 py-4">
          <div>
            {msg && (
              <span
                className={`text-xs ${
                  msg.type === "ok" ? "text-success" : "text-danger"
                }`}
              >
                {msg.text}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="text-muted hover:text-foreground text-xs font-bold px-4 py-2"
            >
              Cancel
            </button>
            {!locked && (
              <button
                onClick={save}
                disabled={saving}
                className="bg-primary text-white text-xs font-bold px-5 py-2 rounded-md disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save Permissions"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
