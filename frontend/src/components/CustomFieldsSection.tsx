"use client";

import React, { useEffect, useState } from "react";
import { getApi, authHeaders } from "@/lib/siteflow";

// ── Shapes matching backend/app/routers/custom_fields.py ────────────────────
export type CustomFieldDef = {
  id: string;
  company_id: string;
  entity_type: string;
  field_name: string;
  field_label: string;
  field_type: string; // text | number | date | select | multiselect | checkbox
  is_required: boolean;
  options: string[];
  display_order: number;
  is_active: boolean;
  default_value?: string | null;
  set_default?: boolean;
};

type StoredValue = {
  field_id: string;
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_json: unknown;
};

// CustomFieldValueInput on the backend — what gets submitted on create/update.
export type CustomFieldValuePayload = { field_id: string; value: unknown };

export type CustomFieldValues = Record<string, unknown>;

function initialValueFor(field: CustomFieldDef, stored?: StoredValue): unknown {
  if (stored) {
    switch (field.field_type) {
      case "number":
        return stored.value_number !== null && stored.value_number !== undefined
          ? String(stored.value_number)
          : "";
      case "date":
        return stored.value_date ? String(stored.value_date).slice(0, 10) : "";
      case "checkbox":
        return Boolean(stored.value_json);
      case "multiselect":
        return Array.isArray(stored.value_json) ? stored.value_json : [];
      case "select":
      case "text":
      default:
        return stored.value_text ?? "";
    }
  }
  // No stored value yet (new record) — pre-fill from default_value when configured.
  if (field.set_default && field.default_value) {
    if (field.field_type === "checkbox") return field.default_value === "true";
    if (field.field_type === "multiselect") return [field.default_value];
    return field.default_value;
  }
  if (field.field_type === "checkbox") return false;
  if (field.field_type === "multiselect") return [];
  return "";
}

/**
 * Loads the active CustomField definitions for `entityType` (company-scoped) and,
 * when `entityId` is supplied (edit mode), the already-stored CustomFieldValue rows
 * for that record — merging the two into an editable values map keyed by field id.
 */
export function useCustomFields(companyId: string | undefined, entityType: string, entityId?: string) {
  const [fields, setFields] = useState<CustomFieldDef[]>([]);
  const [values, setValues] = useState<CustomFieldValues>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!companyId) return;
    let alive = true;
    setLoaded(false);
    (async () => {
      try {
        const fRes = await fetch(
          getApi(`/custom-fields/fields/${companyId}?entity_type=${encodeURIComponent(entityType)}`),
          { headers: authHeaders() }
        );
        const defs: CustomFieldDef[] = fRes.ok ? await fRes.json() : [];

        let stored: StoredValue[] = [];
        if (entityId) {
          const vRes = await fetch(
            getApi(`/custom-fields/values/${encodeURIComponent(entityType)}/${entityId}`),
            { headers: authHeaders() }
          );
          stored = vRes.ok ? await vRes.json() : [];
        }

        if (!alive) return;
        const sorted = defs.slice().sort((a, b) => a.display_order - b.display_order);
        setFields(sorted);
        const init: CustomFieldValues = {};
        for (const f of sorted) {
          const match = stored.find((s) => s.field_id === f.id);
          init[f.id] = initialValueFor(f, match);
        }
        setValues(init);
      } catch (e) {
        console.error("Failed to load custom fields", e);
        if (alive) {
          setFields([]);
          setValues({});
        }
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [companyId, entityType, entityId]);

  const setValue = (fieldId: string, value: unknown) =>
    setValues((v) => ({ ...v, [fieldId]: value }));

  /** Returns an error message for the first missing required field, or null if valid. */
  const validate = (): string | null => {
    for (const f of fields) {
      if (!f.is_required) continue;
      const v = values[f.id];
      const empty =
        v === undefined ||
        v === null ||
        v === "" ||
        (Array.isArray(v) && v.length === 0);
      if (empty) return `"${f.field_label}" is required.`;
    }
    return null;
  };

  /** Serializes the current values into the {field_id, value}[] shape the backend expects. */
  const toPayload = (): CustomFieldValuePayload[] =>
    fields
      .filter((f) => {
        const v = values[f.id];
        if (f.field_type === "checkbox") return true;
        if (v === undefined || v === null || v === "") return false;
        if (Array.isArray(v) && v.length === 0) return false;
        return true;
      })
      .map((f) => ({ field_id: f.id, value: values[f.id] }));

  return { fields, values, setValue, validate, toPayload, loaded };
}

/** Renders a dynamic form section for whatever CustomField definitions were loaded. */
export function CustomFieldsSection({
  fields,
  values,
  setValue,
}: {
  fields: CustomFieldDef[];
  values: CustomFieldValues;
  setValue: (fieldId: string, value: unknown) => void;
}) {
  if (fields.length === 0) return null;

  return (
    <div className="col-span-2 rounded-md border border-border-custom p-3 space-y-3">
      <div className="text-xs font-medium text-muted">Custom Fields</div>
      {fields.map((f) => {
        if (f.field_type === "checkbox") {
          return (
            <label key={f.id} className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={Boolean(values[f.id])}
                onChange={(e) => setValue(f.id, e.target.checked)}
              />
              {f.field_label}
              {f.is_required && <span className="text-danger">*</span>}
            </label>
          );
        }

        return (
          <div key={f.id}>
            <div className="mb-1 text-xs font-medium text-muted">
              {f.field_label}
              {f.is_required && <span className="text-danger"> *</span>}
            </div>

            {f.field_type === "text" && (
              <input
                value={(values[f.id] as string) ?? ""}
                onChange={(e) => setValue(f.id, e.target.value)}
                className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground"
              />
            )}

            {f.field_type === "number" && (
              <input
                type="number"
                value={(values[f.id] as string) ?? ""}
                onChange={(e) => setValue(f.id, e.target.value)}
                className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground"
              />
            )}

            {f.field_type === "date" && (
              <input
                type="date"
                value={(values[f.id] as string) ?? ""}
                onChange={(e) => setValue(f.id, e.target.value)}
                className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground"
              />
            )}

            {f.field_type === "select" && (
              <select
                value={(values[f.id] as string) ?? ""}
                onChange={(e) => setValue(f.id, e.target.value)}
                className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground"
              >
                <option value="">Select</option>
                {f.options.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            )}

            {f.field_type === "multiselect" && (
              <div className="flex flex-wrap gap-2">
                {f.options.map((o) => {
                  const arr = Array.isArray(values[f.id]) ? (values[f.id] as string[]) : [];
                  const checked = arr.includes(o);
                  return (
                    <label
                      key={o}
                      className="flex items-center gap-1 rounded-md border border-border-custom px-2 py-1 text-xs text-muted"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setValue(f.id, checked ? arr.filter((x) => x !== o) : [...arr, o])
                        }
                      />
                      {o}
                    </label>
                  );
                })}
                {f.options.length === 0 && (
                  <span className="text-xs text-muted">No options configured.</span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
