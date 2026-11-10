"use client";
import { getApiHost, readErrorDetail } from "@/lib/api";
import { authHeaders } from "@/lib/siteflow";
import React, { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import Icon from "@/components/marketing/Icon";

// Custom fields are extra boxes a company adds to its own forms, for example
// "Client PO number" on sales invoices. They are filled in on the form itself.
//
// This page used to fill values in by typing a record's internal ID, had no
// box at all for pick-list or tick-box fields, offered task, lead and vendor
// fields that no form shows, and could not mark a field as must-fill.

interface Field {
  id: string;
  entity_type: string;
  field_name: string;
  field_label: string;
  field_type: string;
  is_required: boolean;
  options: string[];
  display_order: number;
  default_value?: string | null;
  set_default?: boolean;
}

// The forms that show custom fields, and the server's name for each.
const WHERE: { id: string; label: string; form: string }[] = [
  { id: "project", label: "Projects", form: "the New Project and Edit Project forms" },
  { id: "invoice", label: "Sales invoices", form: "the Sales Invoice form in a project's Transactions" },
  { id: "bill", label: "Subcontractor bills", form: "the subcontractor bill form on the Billing page" },
];

const TYPES: { id: string; label: string }[] = [
  { id: "text", label: "Text" },
  { id: "number", label: "Number" },
  { id: "date", label: "Date" },
  { id: "select", label: "Pick one from a list" },
  { id: "multiselect", label: "Pick several from a list" },
  { id: "checkbox", label: "Tick box" },
];
const typeLabel = (t: string) => TYPES.find((x) => x.id === t)?.label || t;

const blankForm = { entity_type: "project", field_label: "", field_type: "text", is_required: false, options: "", default_value: "" };

export default function CustomFieldsPage() {
  const params = useParams();
  const companyId = params?.company_id as string;

  const [fields, setFields] = useState<Field[] | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<Field | "new" | null>(null);
  const [form, setForm] = useState(blankForm);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const fetchFields = useCallback(async () => {
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/custom-fields/fields/${companyId}`, { headers: authHeaders() });
      setFields(res.ok ? await res.json() : []);
    } catch {
      setFields([]);
    }
  }, [companyId]);

  useEffect(() => {
    const id = setTimeout(() => { fetchFields(); }, 0);
    return () => clearTimeout(id);
  }, [fetchFields]);

  const openNew = (entity = "project") => {
    setForm({ ...blankForm, entity_type: entity });
    setFormError("");
    setEditing("new");
  };

  const openEdit = (f: Field) => {
    setForm({
      entity_type: f.entity_type,
      field_label: f.field_label,
      field_type: f.field_type,
      is_required: f.is_required,
      options: (f.options || []).join(", "),
      default_value: f.set_default ? f.default_value || "" : "",
    });
    setFormError("");
    setEditing(f);
  };

  const choices = form.options.split(",").map((s) => s.trim()).filter(Boolean);
  const isPick = form.field_type === "select" || form.field_type === "multiselect";

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.field_label.trim()) return setFormError("Give the field a name");
    if (isPick && choices.length === 0) return setFormError("Add the choices people can pick from, separated by commas");
    const def = form.field_type === "checkbox" ? "" : form.default_value.trim();
    if (def && isPick && !choices.includes(def)) return setFormError("The starting value must be one of the choices");
    setSaving(true);
    setFormError("");
    try {
      const common = {
        field_label: form.field_label.trim(),
        is_required: form.is_required,
        options: isPick ? choices : [],
        default_value: def || null,
        set_default: !!def,
      };
      const res =
        editing === "new"
          ? await fetch(`${getApiHost()}/apis/v3/custom-fields/fields`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
              body: JSON.stringify({
                ...common,
                company_id: companyId,
                entity_type: form.entity_type,
                field_name: form.field_label.trim(),
                field_type: form.field_type,
                display_order: (fields || []).filter((f) => f.entity_type === form.entity_type).length,
              }),
            })
          : await fetch(`${getApiHost()}/apis/v3/custom-fields/fields/${(editing as Field).id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
              body: JSON.stringify(common),
            });
      if (res.ok) {
        setMessage({ ok: true, text: editing === "new" ? `"${common.field_label}" added` : `"${common.field_label}" saved` });
        setEditing(null);
        fetchFields();
      } else {
        setFormError((await readErrorDetail(res)) || "Could not save. Try again.");
      }
    } catch {
      setFormError("Could not reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (f: Field) => {
    if (!confirm(`Delete "${f.field_label}"? What was filled in for it on every record is deleted too.`)) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/custom-fields/fields/${f.id}`, { method: "DELETE", headers: authHeaders() || {} });
      if (res.ok) {
        setFields((prev) => (prev || []).filter((x) => x.id !== f.id));
        setMessage({ ok: true, text: `"${f.field_label}" deleted` });
      } else {
        setMessage({ ok: false, text: (await readErrorDetail(res)) || "Could not delete. Try again." });
      }
    } catch {
      setMessage({ ok: false, text: "Could not reach the server. Try again." });
    }
  };

  const row = (f: Field, shown: boolean) => (
    <div key={f.id} className="grid grid-cols-[2fr_1.5fr_1fr_auto] gap-4 px-5 py-3 items-center border-b border-border-custom last:border-0 text-xs">
      <div>
        <p className="font-semibold text-foreground">{f.field_label}</p>
        {f.options?.length > 0 && <p className="text-muted mt-0.5 truncate">Choices: {f.options.join(", ")}</p>}
        {f.set_default && f.default_value && <p className="text-muted mt-0.5">Starts as: {f.default_value}</p>}
      </div>
      <div className="text-muted">{typeLabel(f.field_type)}</div>
      <div>{f.is_required ? <span className="text-danger font-semibold">Must fill</span> : <span className="text-muted">Optional</span>}</div>
      <div className="flex items-center gap-1">
        {shown && (
          <button onClick={() => openEdit(f)} className="p-1.5 text-muted hover:text-foreground rounded hover:bg-elevated cursor-pointer" title="Edit">
            <Icon name="pencil" className="w-3.5 h-3.5" />
          </button>
        )}
        <button onClick={() => remove(f)} className="p-1.5 text-muted hover:text-danger rounded hover:bg-elevated cursor-pointer" title="Delete">
          <Icon name="trash" className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );

  const unused = (fields || []).filter((f) => !WHERE.some((w) => w.id === f.entity_type));

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader title="Custom Fields" subtitle="Extra boxes on your own forms, such as a client PO number on sales invoices">
        <button onClick={() => openNew()} className="px-3.5 py-1.5 bg-primary hover:bg-primary/90 text-white rounded-md text-xs font-semibold cursor-pointer">
          New Field
        </button>
      </PageHeader>
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">
          {message && (
            <div className={`mb-4 p-3 rounded-md text-xs ${message.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger"}`}>{message.text}</div>
          )}

          {fields === null ? (
            <p className="text-xs text-muted">Loading...</p>
          ) : (
            <div className="space-y-6">
              {WHERE.map((w) => {
                const list = fields.filter((f) => f.entity_type === w.id);
                return (
                  <div key={w.id} className="bg-card border border-border-custom rounded-lg overflow-hidden">
                    <div className="px-5 py-3 border-b border-border-custom flex items-center justify-between gap-3">
                      <div>
                        <h2 className="text-sm font-bold text-foreground">{w.label}</h2>
                        <p className="text-[11px] text-muted">Filled in on {w.form}.</p>
                      </div>
                      <button onClick={() => openNew(w.id)} className="text-xs font-semibold text-primary hover:underline cursor-pointer">Add field</button>
                    </div>
                    {list.length === 0 ? <p className="px-5 py-4 text-xs text-muted">No extra fields.</p> : list.map((f) => row(f, true))}
                  </div>
                );
              })}

              {unused.length > 0 && (
                <div className="bg-card border border-warning/30 rounded-lg overflow-hidden">
                  <div className="px-5 py-3 border-b border-border-custom">
                    <h2 className="text-sm font-bold text-foreground">Not on any form</h2>
                    <p className="text-[11px] text-muted">
                      These were made for tasks, leads or vendors, whose forms do not show extra fields, so nobody can fill them in. Delete them, or make them again under one of the forms above.
                    </p>
                  </div>
                  {unused.map((f) => row(f, false))}
                </div>
              )}

              {fields.length === 0 && (
                <EmptyState
                  title="No custom fields yet"
                  description="Add a field when your forms need a box they do not have, for example a client PO number on sales invoices."
                  action={{ label: "New Field", onClick: () => openNew() }}
                />
              )}
            </div>
          )}

          {editing && (
            <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
              <form onSubmit={save} className="bg-elevated border border-border-custom rounded-lg p-6 w-full max-w-lg space-y-4">
                <h2 className="text-base font-bold text-foreground">{editing === "new" ? "New Custom Field" : `Edit "${(editing as Field).field_label}"`}</h2>
                {formError && <div className="p-3 rounded-md bg-danger/10 text-danger text-xs">{formError}</div>}

                {editing === "new" && (
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">Which form</label>
                    <select
                      className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-sm text-foreground"
                      value={form.entity_type}
                      onChange={(e) => setForm({ ...form, entity_type: e.target.value })}
                    >
                      {WHERE.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Field name, as people will see it</label>
                  <input
                    type="text"
                    className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-sm text-foreground"
                    placeholder="e.g. Client PO number"
                    value={form.field_label}
                    onChange={(e) => setForm({ ...form, field_label: e.target.value })}
                  />
                </div>
                {editing === "new" ? (
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">What goes in it</label>
                    <select
                      className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-sm text-foreground"
                      value={form.field_type}
                      onChange={(e) => setForm({ ...form, field_type: e.target.value })}
                    >
                      {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                  </div>
                ) : (
                  <p className="text-xs text-muted">Type: {typeLabel(form.field_type)} (cannot be changed once made, so filled-in values stay readable)</p>
                )}
                {isPick && (
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">Choices, separated by commas</label>
                    <input
                      type="text"
                      className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-sm text-foreground"
                      placeholder="e.g. Cash, Cheque, NEFT"
                      value={form.options}
                      onChange={(e) => setForm({ ...form, options: e.target.value })}
                    />
                  </div>
                )}
                {form.field_type !== "checkbox" && (
                  <div>
                    <label className="block text-xs font-medium text-muted mb-1">Starting value (optional)</label>
                    <input
                      type={form.field_type === "number" ? "number" : form.field_type === "date" ? "date" : "text"}
                      className="w-full bg-input border border-border-custom rounded-md px-3 py-2 text-sm text-foreground"
                      value={form.default_value}
                      onChange={(e) => setForm({ ...form, default_value: e.target.value })}
                    />
                  </div>
                )}
                <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                  <input type="checkbox" checked={form.is_required} onChange={(e) => setForm({ ...form, is_required: e.target.checked })} className="h-4 w-4 accent-primary" />
                  Must be filled in before the form can be saved
                </label>
                <div className="flex gap-3 pt-2 justify-end">
                  <button type="button" onClick={() => setEditing(null)} className="px-4 py-2 border border-border-custom text-foreground rounded-md text-sm font-semibold cursor-pointer">Cancel</button>
                  <button type="submit" disabled={saving} className="px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded-md text-sm font-semibold disabled:opacity-50 cursor-pointer">
                    {saving ? "Saving..." : "Save"}
                  </button>
                </div>
              </form>
            </div>
          )}
        </PageShell>
      </div>
    </div>
  );
}
