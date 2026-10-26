"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { getApiHost, readErrorDetail } from "@/lib/api";
import { getApi, authHeaders, resolveCompanyId, fmtINR, formatLabel, toLocalISODate, todayLocalISO, formatDate } from "@/lib/siteflow";
import { useProject } from "@/context/ProjectContext";
import { useCompanySettings } from "@/context/CompanySettingsContext";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton, TableSkeleton } from "@/components/ui/Skeleton";
import SegmentedTabs from "@/components/ui/Tabs";
import Icon from "@/components/marketing/Icon";
import FieldHint from "@/components/ui/FieldHint";

// ─── Types ────────────────────────────────────────────────────────────────────

type Emp = {
  id: string;
  name: string;
  employee_code: string | null;
  designation: string | null;
  department: string | null;
  mobile: string | null;
  uan: string | null;
  basic_salary: number;
  hra: number;
  other_allowances: number;
  tds_monthly: number;
  status: string;
  project_id: string | null;
  date_of_joining: string | null;
  created_at: string;
};

type Profile = {
  id?: string;
  employee_id: string;
  company_id?: string;
  salary_amount: number;
  shift_start: string | null;
  shift_end: string | null;
  shift_hours: number;
  overtime_rate: number;
  cost_code: string | null;
  leave_template_id: string | null;
  salary_breakup: string | null;
  updated_at?: string;
};

type Designation = { id: string; company_id: string; name: string; created_at: string };
type LeaveTemplate = {
  id: string;
  company_id: string;
  name: string;
  casual_leave_days: number;
  sick_leave_days: number;
  earned_leave_days: number;
  created_at: string;
};
type Holiday = { id: string; company_id: string; name: string; date: string; created_at: string };
type Leave = {
  id: string;
  company_id: string;
  project_id: string | null;
  employee_name: string;
  leave_type: string;
  start_date: string;
  end_date: string;
  days_count: number;
  status: string;
  applied_on: string;
};
type Party = { id: string; name: string; party_type: string | null; phone: string | null };
type CostCode = { id: string; code: string; name: string; sub_cost_code?: string | null };
type Workforce = { id: string; name: string };
type Att = {
  employee_id: string;
  employee_name: string;
  attendance_date: string;
  punch_in: string | null;
  punch_out: string | null;
  status: string;
  hours_worked: number | null;
  overtime_hours: number;
  is_within_geofence: boolean;
  marked_manually?: boolean;
  marked_by?: string | null;
};

type Breakup = {
  monthly_ctc: number;
  day_off: string;
  basic_pct: number;
  basic: number;
  allowances: { name: string; amount: number }[];
  gross: number;
  deductions: { name: string; amount: number }[];
  net: number;
};

// ─── API helpers ──────────────────────────────────────────────────────────────

const jget = async (p: string) => {
  const r = await fetch(getApi(p), { headers: authHeaders() || undefined });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
};
const jpost = async (p: string, body: any) => {
  const r = await fetch(getApi(p), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
};
const jput = async (p: string, body: any) => {
  const r = await fetch(getApi(p), {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
};
const jdel = async (p: string) => {
  const r = await fetch(getApi(p), { method: "DELETE", headers: authHeaders() || undefined });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const todayStr = () => todayLocalISO();
const dayName = (d: string) => WEEKDAYS[new Date(d + "T00:00:00").getDay()];
const isoDateTime = (d: string) => d.includes("T") ? d : `${d}T00:00:00Z`;

// ─── Small UI primitives ──────────────────────────────────────────────────────

function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className={`max-h-[90vh] w-full ${wide ? "max-w-3xl" : "max-w-lg"} overflow-y-auto rounded-lg border border-border-custom bg-background p-5 shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-foreground">{title}</h3>
          <button className="text-muted hover:text-foreground cursor-pointer" onClick={onClose}>
            <Icon name="close" className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Drawer({
  title,
  onClose,
  children,
  width = "max-w-md",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className={`h-full w-full ${width} overflow-y-auto border-l border-border-custom bg-background p-5 shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-foreground">{title}</h3>
          <button className="text-muted hover:text-foreground cursor-pointer" onClick={onClose}>
            <Icon name="close" className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary";
const btnPrimary = "rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";
const btnGhost = "rounded-md border border-border-custom px-3 py-2 text-sm text-foreground hover:bg-elevated";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">{label}</label>
      {children}
    </div>
  );
}

// ─── Picker (select with creatable option) ─────────────────────────────────────

function CreatablePicker<T extends { id: string; name: string }>({
  label,
  items,
  value,
  onPick,
  onCreate,
  placeholder,
}: {
  label: string;
  items: T[];
  value: string | null;
  onPick: (id: string | null, name: string) => void;
  onCreate: (name: string) => Promise<void>;
  placeholder: string;
}) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const selected = items.find((i) => i.id === value);
  return (
    <Field label={label}>
      <div className="flex gap-2">
        <select
          className={inputCls}
          value={value ?? ""}
          onChange={(e) => {
            const id = e.target.value || null;
            const it = items.find((i) => i.id === id);
            onPick(id, it?.name ?? "");
          }}
        >
          <option value="">{placeholder}</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        <button type="button" className={btnGhost} onClick={() => setAdding((a) => !a)}>
          +
        </button>
      </div>
      {adding && (
        <div className="mt-2 flex gap-2">
          <input
            className={inputCls}
            placeholder="New name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button
            type="button"
            className={btnPrimary}
            disabled={!newName.trim()}
            onClick={async () => {
              await onCreate(newName.trim());
              setNewName("");
              setAdding(false);
            }}
          >
            Add
          </button>
        </div>
      )}
      {selected && <div className="mt-1 text-xs text-muted">Selected: {selected.name}</div>}
    </Field>
  );
}

// ─── Salary Breakup Modal ──────────────────────────────────────────────────────

function SalaryBreakupModal({
  initial,
  salaryAmount,
  companyId,
  onClose,
  onSave,
}: {
  initial: Breakup | null;
  salaryAmount: number;
  companyId: string;
  onClose: () => void;
  onSave: (b: Breakup) => void;
}) {
  const { currencyDecimalPlaces } = useCompanySettings();
  const [ctc, setCtc] = useState<number>(initial?.monthly_ctc ?? salaryAmount ?? 0);
  const [dayOff, setDayOff] = useState<string>(initial?.day_off ?? "—");
  const [basicPct, setBasicPct] = useState<number>(initial?.basic_pct ?? 40);
  const [allowances, setAllowances] = useState<{ name: string; amount: number }[]>(
    initial?.allowances ?? []
  );
  const [deductions, setDeductions] = useState<{ name: string; amount: number }[]>(
    initial?.deductions ?? []
  );
  const [templates, setTemplates] = useState<{ id: string; name: string; breakup: any }[]>([]);

  useEffect(() => {
    if (!companyId) return;
    jget(`/settings/salary-templates/${companyId}`)
      .then((d) => setTemplates(Array.isArray(d) ? d : []))
      .catch(() => setTemplates([]));
  }, [companyId]);

  const loadTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    const b = t.breakup;
    setCtc(b.monthly_ctc ?? 0);
    setDayOff(b.day_off ?? "—");
    setBasicPct(b.basic_pct ?? 40);
    setAllowances(b.allowances ?? []);
    setDeductions(b.deductions ?? []);
  };

  const { basic, fixedAllowance, gross, totalDed, net } = React.useMemo(() => {
    const b = Math.round(ctc * (basicPct / 100) * 100) / 100;
    const fa = Math.round(allowances.reduce((s, a) => s + (a.amount || 0), 0) * 100) / 100;
    const g = Math.round((b + fa) * 100) / 100;
    const td = Math.round(deductions.reduce((s, d) => s + (d.amount || 0), 0) * 100) / 100;
    const n = Math.round((g - td) * 100) / 100;
    return { basic: b, fixedAllowance: fa, gross: g, totalDed: td, net: n };
  }, [ctc, basicPct, allowances, deductions]);

  const editLine = (
    list: { name: string; amount: number }[],
    set: (v: { name: string; amount: number }[]) => void,
    idx: number,
    key: "name" | "amount",
    val: any
  ) => {
    const next = list.slice();
    next[idx] = { ...next[idx], [key]: val };
    set(next);
  };

  return (
    <Modal title="Salary Breakup" onClose={onClose} wide>
      <Field label="Load Template">
        {templates.length > 0 ? (
          <select
            className={inputCls}
            value=""
            onChange={(e) => e.target.value && loadTemplate(e.target.value)}
          >
            <option value="">Select a saved template</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        ) : (
          <FieldHint text="No salary templates yet. Create templates in Settings." href={`/c/${companyId}/settings`} linkLabel="Go to Settings" />
        )}
      </Field>
      <Field label="Monthly CTC">
        <div className="flex gap-2">
          <input
            type="number"
            className={inputCls}
            value={ctc}
            onChange={(e) => setCtc(parseFloat(e.target.value) || 0)}
          />
          <select className={inputCls} value="Monthly" disabled>
            <option>Monthly</option>
          </select>
        </div>
      </Field>

      <Field label="Day Off">
        <div className="flex gap-2">
          <input className={inputCls} value={dayOff} onChange={(e) => setDayOff(e.target.value)} />
          <select className={inputCls} value={dayOff} onChange={(e) => setDayOff(e.target.value)}>
            {WEEKDAYS.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </div>
      </Field>

      <div className="mt-4 rounded-md border border-border-custom p-3">
        <div className="mb-2 text-sm font-semibold text-foreground">Salary Components</div>
        <Field label="Basic">
          <div className="flex items-center gap-2">
            <input
              type="number"
              className={inputCls}
              value={basicPct}
              onChange={(e) => setBasicPct(parseFloat(e.target.value) || 0)}
            />
            <select className={inputCls} value="% of CTC" disabled>
              <option>% of CTC</option>
            </select>
            <div className="whitespace-nowrap text-sm text-muted">= {fmtINR(basic, currencyDecimalPlaces)}</div>
          </div>
        </Field>

        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">Allowances</span>
          <button
            className={btnGhost}
            onClick={() => setAllowances([...allowances, { name: "", amount: 0 }])}
          >
            + New Allowance
          </button>
        </div>
        {allowances.map((a, i) => (
          <div key={i} className="mb-2 flex gap-2">
            <input
              className={inputCls}
              placeholder="Allowance name"
              value={a.name}
              onChange={(e) => editLine(allowances, setAllowances, i, "name", e.target.value)}
            />
            <input
              type="number"
              className={inputCls}
              placeholder="Amount"
              value={a.amount}
              onChange={(e) =>
                editLine(allowances, setAllowances, i, "amount", parseFloat(e.target.value) || 0)
              }
            />
            <button className="text-muted hover:text-danger cursor-pointer p-1" onClick={() => setAllowances(allowances.filter((_, j) => j !== i))}>
              <Icon name="close" className="w-4 h-4" />
            </button>
          </div>
        ))}
        <div className="text-right text-sm text-muted">Fixed Allowance: {fmtINR(fixedAllowance, currencyDecimalPlaces)}</div>

        <div className="mt-3 border-t border-border-custom pt-3 text-sm font-semibold text-foreground">
          Gross Salary: {fmtINR(gross, currencyDecimalPlaces)}
        </div>
      </div>

      <div className="mt-4 rounded-md border border-border-custom p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">Deductions</span>
          <button
            className={btnGhost}
            onClick={() => setDeductions([...deductions, { name: "", amount: 0 }])}
          >
            + New Deduction
          </button>
        </div>
        {deductions.map((d, i) => (
          <div key={i} className="mb-2 flex gap-2">
            <input
              className={inputCls}
              placeholder="Deduction name"
              value={d.name}
              onChange={(e) => editLine(deductions, setDeductions, i, "name", e.target.value)}
            />
            <input
              type="number"
              className={inputCls}
              placeholder="Amount"
              value={d.amount}
              onChange={(e) =>
                editLine(deductions, setDeductions, i, "amount", parseFloat(e.target.value) || 0)
              }
            />
            <button className="text-muted hover:text-danger cursor-pointer p-1" onClick={() => setDeductions(deductions.filter((_, j) => j !== i))}>
              <Icon name="close" className="w-4 h-4" />
            </button>
          </div>
        ))}
        <div className="mt-3 border-t border-border-custom pt-3 text-sm font-semibold text-foreground">
          Net Amount (Per Month): {fmtINR(net, currencyDecimalPlaces)}
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button className={btnGhost} onClick={onClose}>
          Cancel
        </button>
        <button
          className={btnPrimary}
          onClick={() =>
            onSave({
              monthly_ctc: ctc,
              day_off: dayOff,
              basic_pct: basicPct,
              basic,
              allowances,
              gross,
              deductions,
              net,
            })
          }
        >
          Save Breakup
        </button>
      </div>
    </Modal>
  );
}

// ─── Party Picker Drawer ───────────────────────────────────────────────────────

function PartyPickerDrawer({
  companyId,
  parties,
  onParties,
  onSelect,
  onClose,
}: {
  companyId: string;
  parties: Party[];
  onParties: (p: Party[]) => void;
  onSelect: (p: Party) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState("Staff");
  const filtered = parties.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  const addParty = async () => {
    if (!newName.trim()) return;
    const p = await jpost("/library/parties", {
      company_id: companyId,
      name: newName.trim(),
      party_type: newType,
    });
    onParties([...parties, p]);
    setNewName("");
  };
  return (
    <Drawer title="Select Party" onClose={onClose} width="max-w-md">
      <input className={inputCls + " mb-3"} placeholder="Search party…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">Add New Party</div>
      <div className="mb-3 flex gap-2">
        <input className={inputCls} placeholder="Party name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <select className={inputCls} value={newType} onChange={(e) => setNewType(e.target.value)}>
          <option>Staff</option>
          <option>Subcontractor</option>
          <option>Supplier</option>
          <option>Client</option>
        </select>
        <button className={btnPrimary} onClick={addParty}>
          Add
        </button>
      </div>
      <div className="space-y-1">
        {filtered.map((p) => (
          <button
            key={p.id}
            className="flex w-full items-center justify-between rounded-md border border-border-custom px-3 py-2 text-left text-sm hover:bg-elevated"
            onClick={() => onSelect(p)}
          >
            <span className="text-foreground">{p.name}</span>
            <span className="text-xs text-muted">{p.party_type || "—"}</span>
          </button>
        ))}
        {filtered.length === 0 && (
          <EmptyState
            title="No parties found"
            description="No parties match your search query."
            className="py-6"
          />
        )}
      </div>
    </Drawer>
  );
}

// ─── New Payroll Modal ─────────────────────────────────────────────────────────

function NewPayrollModal({
  staffType,
  companyId,
  projectId,
  designations,
  onClose,
  onCreated,
}: {
  staffType: "office" | "site";
  companyId: string;
  projectId: string;
  designations: Designation[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [party, setParty] = useState<Party | null>(null);
  const [designation, setDesignation] = useState("");
  const [department, setDepartment] = useState("");
  const [mobile, setMobile] = useState("");
  const [uan, setUan] = useState("");
  const [basic, setBasic] = useState(0);
  const [hra, setHra] = useState(0);
  const [allow, setAllow] = useState(0);
  const [parties, setParties] = useState<Party[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    jget(`/library/parties/${companyId}`).then(setParties).catch(() => {});
  }, [companyId]);

  const submit = async () => {
    const finalName = name.trim() || party?.name || "";
    if (!finalName) return;
    setSaving(true);
    try {
      await jpost("/hr/employees", {
        company_id: companyId,
        project_id: staffType === "site" ? projectId || null : null,
        name: finalName,
        designation: designation || null,
        department: department || null,
        mobile: mobile || null,
        uan: uan.trim() || null,
        basic_salary: basic,
        hra,
        other_allowances: allow,
        status: "active",
      });
      onCreated();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={staffType === "site" ? "New Project-Assigned Staff" : "New Unassigned Staff"} onClose={onClose}>
      <Field label="Select Party">
        <div className="flex gap-2">
          <input className={inputCls} disabled value={party?.name || name} placeholder="Party name" onChange={(e) => setName(e.target.value)} />
          <button className={btnGhost} onClick={() => setPickerOpen(true)}>
            Select Party
          </button>
        </div>
      </Field>
      <Field label="Name / Designation">
        <input className={inputCls} placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <Field label="Designation">
          <input className={inputCls} value={designation} onChange={(e) => setDesignation(e.target.value)} list="desig-list" />
          <datalist id="desig-list">
            {designations.map((d) => (
              <option key={d.id} value={d.name} />
            ))}
          </datalist>
        </Field>
        <Field label="Department">
          <input className={inputCls} value={department} onChange={(e) => setDepartment(e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <Field label="Mobile">
          <input className={inputCls} value={mobile} onChange={(e) => setMobile(e.target.value)} />
        </Field>
        <Field label="UAN (12 digits)">
          <input className={inputCls} placeholder="12-digit UAN" maxLength={12} value={uan} onChange={(e) => setUan(e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
        <Field label="Basic Salary">
          <input type="number" className={inputCls} value={basic} onChange={(e) => setBasic(parseFloat(e.target.value) || 0)} />
        </Field>
        <Field label="HRA">
          <input type="number" className={inputCls} value={hra} onChange={(e) => setHra(parseFloat(e.target.value) || 0)} />
        </Field>
        <Field label="Other Allowances">
          <input type="number" className={inputCls} value={allow} onChange={(e) => setAllow(parseFloat(e.target.value) || 0)} />
        </Field>
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <button className={btnGhost} onClick={onClose}>
          Cancel
        </button>
        <button className={btnPrimary} disabled={saving} onClick={submit}>
          Save
        </button>
      </div>
      {pickerOpen && (
        <PartyPickerDrawer
          companyId={companyId}
          parties={parties}
          onParties={setParties}
          onSelect={(p) => {
            setParty(p);
            setName(p.name);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </Modal>
  );
}

// ─── Upload CSV Modal ──────────────────────────────────────────────────────────

function UploadCsvModal({ companyId, projectId, onClose, onDone }: { companyId: string; projectId: string; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("company_id", companyId);
      if (projectId) fd.append("project_id", projectId);
      fd.append("file", file);
      const r = await fetch(getApi("/hr/payroll/upload"), { method: "POST", headers: authHeaders() || undefined, body: fd });
      if (!r.ok) throw new Error(await r.text());
      onDone();
      onClose();
    } catch (e: any) {
      alert("Upload failed: " + e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Upload Payroll CSV" onClose={onClose}>
      <p className="mb-3 text-sm text-muted">
        CSV requires a <code>Name</code> column. Optional: Basic, Fixed Allowance, Allowance Name (A1/A2/A3),
        Deduction Name (D1/D2), Designation, Cost Code.
      </p>
      <input type="file" accept=".csv" className={inputCls} onChange={(e) => setFile(e.target.files?.[0] || null)} />
      <div className="mt-4 flex justify-end gap-2">
        <button className={btnGhost} onClick={onClose}>
          Cancel
        </button>
        <button className={btnPrimary} disabled={busy || !file} onClick={submit}>
          Upload
        </button>
      </div>
    </Modal>
  );
}

// ─── Payroll Details Drawer ────────────────────────────────────────────────────

function PayrollDetailsDrawer({
  emp,
  profile,
  companyId,
  designations,
  leaveTemplates,
  costCodes,
  onClose,
  onSaved,
  onDesignationCreate,
  onLeaveTemplateCreate,
  onBreakupSave,
}: {
  emp: Emp;
  profile: Profile | null;
  companyId: string;
  designations: Designation[];
  leaveTemplates: LeaveTemplate[];
  costCodes: CostCode[];
  onClose: () => void;
  onSaved: () => void;
  onDesignationCreate: (name: string) => Promise<void>;
  onLeaveTemplateCreate: (name: string) => Promise<void>;
  onBreakupSave: (b: Breakup) => void;
}) {
  const [designationName, setDesignationName] = useState<string>(emp.designation || "");
  const [salaryAmount, setSalaryAmount] = useState<number>(profile?.salary_amount ?? emp.basic_salary ?? 0);
  const [shiftStart, setShiftStart] = useState<string>(profile?.shift_start ?? "");
  const [shiftEnd, setShiftEnd] = useState<string>(profile?.shift_end ?? "");
  const [shiftHours, setShiftHours] = useState<number>(profile?.shift_hours ?? 8);
  const [otRate, setOtRate] = useState<number>(profile?.overtime_rate ?? 0);
  const [designationId, setDesignationId] = useState<string | null>(null);
  const [leaveTemplateId, setLeaveTemplateId] = useState<string | null>(profile?.leave_template_id ?? null);
  const [costCode, setCostCode] = useState<string | null>(profile?.cost_code ?? null);
  const [breakupOpen, setBreakupOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const { currencyDecimalPlaces } = useCompanySettings();

  useEffect(() => {
    setSalaryAmount(profile?.salary_amount ?? emp.basic_salary ?? 0);
    setShiftStart(profile?.shift_start ?? "");
    setShiftEnd(profile?.shift_end ?? "");
    setShiftHours(profile?.shift_hours ?? 8);
    setOtRate(profile?.overtime_rate ?? 0);
    setLeaveTemplateId(profile?.leave_template_id ?? null);
    setCostCode(profile?.cost_code ?? null);
  }, [profile, emp]);

  const currentBreakup: Breakup | null = profile?.salary_breakup ? JSON.parse(profile.salary_breakup) : null;

  const save = async () => {
    setSaving(true);
    try {
      await jput(`/hr/employees/${emp.id}`, { designation: designationName || null });
      await jput(`/hr/payroll-profiles/${emp.id}`, {
        salary_amount: salaryAmount,
        shift_start: shiftStart,
        shift_end: shiftEnd,
        shift_hours: shiftHours,
        overtime_rate: otRate,
        cost_code: costCode,
        leave_template_id: leaveTemplateId,
      });
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer title={emp.name} onClose={onClose}>
      <Field label="Salary Amount">
        <div className="flex gap-2">
          <input type="number" className={inputCls} value={salaryAmount} onChange={(e) => setSalaryAmount(parseFloat(e.target.value) || 0)} />
          <select className={inputCls} value="per month" disabled>
            <option>per month</option>
          </select>
        </div>
      </Field>

      <button className="mb-3 text-sm font-medium text-primary hover:underline" onClick={() => setBreakupOpen(true)}>
        Add Salary Breakup
      </button>
      {currentBreakup && (
        <div className="mb-3 rounded-md border border-border-custom p-2 text-xs text-muted">
          CTC {fmtINR(currentBreakup.monthly_ctc, currencyDecimalPlaces)} · Basic {currentBreakup.basic_pct}% · Net {fmtINR(currentBreakup.net, currencyDecimalPlaces)}
        </div>
      )}

      <Field label="Shift Timing">
        <div className="flex items-center gap-2">
          <input type="time" className={inputCls} value={shiftStart} onChange={(e) => setShiftStart(e.target.value)} />
          <span className="text-muted">–</span>
          <input type="time" className={inputCls} value={shiftEnd} onChange={(e) => setShiftEnd(e.target.value)} />
        </div>
      </Field>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <Field label="Shift Hours">
          <div className="flex gap-2">
            <input type="number" className={inputCls} value={shiftHours} onChange={(e) => setShiftHours(parseFloat(e.target.value) || 0)} />
            <select className={inputCls} value="per shift" disabled>
              <option>per shift</option>
            </select>
          </div>
        </Field>
        <Field label="Overtime">
          <div className="flex gap-2">
            <input type="number" className={inputCls} value={otRate} onChange={(e) => setOtRate(parseFloat(e.target.value) || 0)} />
            <select className={inputCls} value="per hour" disabled>
              <option>per hour</option>
            </select>
          </div>
        </Field>
      </div>

      <CreatablePicker
        label="Designation"
        items={designations}
        value={designationId}
        onPick={(id, name) => {
          setDesignationId(id);
          setDesignationName(name);
        }}
        onCreate={onDesignationCreate}
        placeholder="Select Designation"
      />
      <CreatablePicker
        label="Leave Template"
        items={leaveTemplates}
        value={leaveTemplateId}
        onPick={(id) => setLeaveTemplateId(id)}
        onCreate={onLeaveTemplateCreate}
        placeholder="Select Leave Template"
      />

      <Field label="Cost Code">
        <select className={inputCls} value={costCode ?? ""} onChange={(e) => setCostCode(e.target.value || null)}>
          <option value="">Select Cost Code</option>
          {costCodes.map((c) => (
            <option key={c.id} value={c.code}>
              {c.code} — {c.name}
            </option>
          ))}
        </select>
        {costCodes.length === 0 && (
          <FieldHint text="No cost codes yet. Define cost codes in Cost Codes." href={`/c/${companyId}/cost-codes`} linkLabel="Go to Cost Codes" />
        )}
      </Field>

      <div className="mt-4 flex justify-end gap-2">
        <button className={btnGhost} onClick={onClose}>
          Cancel
        </button>
        <button className={btnPrimary} disabled={saving} onClick={save}>
          Save
        </button>
      </div>

      {breakupOpen && (
        <SalaryBreakupModal
          initial={currentBreakup}
          salaryAmount={salaryAmount}
          companyId={companyId}
          onClose={() => setBreakupOpen(false)}
          onSave={(b) => {
            onBreakupSave(b);
            setBreakupOpen(false);
          }}
        />
      )}
    </Drawer>
  );
}

// ─── People Tab ────────────────────────────────────────────────────────────────

function PeopleTab({
  companyId,
  projectId,
  employees,
  designations,
  leaveTemplates,
  costCodes,
  reload,
  toast,
  newOpen,
  setNewOpen,
}: {
  companyId: string;
  projectId: string;
  employees: Emp[];
  designations: Designation[];
  leaveTemplates: LeaveTemplate[];
  costCodes: CostCode[];
  reload: () => void;
  toast: (m: string) => void;
  newOpen: null | "office" | "site";
  setNewOpen: (v: null | "office" | "site") => void;
}) {
  const { currencyDecimalPlaces } = useCompanySettings();
  const [staffType, setStaffType] = useState<"office" | "site">("office");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("Active");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [drawerEmp, setDrawerEmp] = useState<Emp | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profLoading, setProfLoading] = useState(false);

  const projectName = (id: string | null) => {
    if (!id) return "—";
    const p = (window as any).__projectsMap?.[id];
    return p || id.slice(0, 8);
  };

  const rows = useMemo(() => {
    return employees.filter((e) => {
      const isSite = !!e.project_id;
      if (staffType === "office" && isSite) return false;
      if (staffType === "site" && !isSite) return false;
      if (statusFilter === "Active" && e.status !== "active") return false;
      if (search && !e.name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [employees, staffType, statusFilter, search]);

  const openDrawer = async (e: Emp) => {
    setDrawerEmp(e);
    setProfLoading(true);
    setProfile(null);
    try {
      const p = await jget(`/hr/payroll-profiles/${e.id}`);
      setProfile(p);
    } catch {
      setProfile(null);
    } finally {
      setProfLoading(false);
    }
  };

  const createDesignation = async (name: string) => {
    try {
      await jpost(`/hr/designations/${companyId}`, { name });
      reload();
      toast("Designation added");
    } catch (e: any) {
      toast(`Could not add designation: ${e?.message ?? "unknown error"}`);
    }
  };
  const createLeaveTemplate = async (name: string) => {
    try {
      await jpost(`/hr/leave-templates/${companyId}`, { name });
      reload();
      toast("Leave template added");
    } catch (e: any) {
      toast(`Could not add leave template: ${e?.message ?? "unknown error"}`);
    }
  };
  const saveBreakup = (b: Breakup) => {
    if (!drawerEmp) return;
    (async () => {
      try {
        await jput(`/hr/payroll-profiles/${drawerEmp.id}`, {
          salary_amount: b.net,
          salary_breakup: JSON.stringify(b),
        });
        toast("Salary breakup saved");
        reload();
      } catch (e: any) {
        toast(`Could not save salary breakup: ${e?.message ?? "unknown error"}`);
      }
    })();
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-border-custom">
          <button
            className={`px-3 py-2 text-sm ${staffType === "office" ? "bg-primary text-white" : "text-foreground hover:bg-elevated"}`}
            onClick={() => setStaffType("office")}
          >
            Unassigned
          </button>
          <button
            className={`px-3 py-2 text-sm ${staffType === "site" ? "bg-primary text-white" : "text-foreground hover:bg-elevated"}`}
            onClick={() => setStaffType("site")}
          >
            Assigned to Project
          </button>
        </div>
        <span className="text-xs text-muted">
          Grouped by project assignment only. Payroll runs include every active employee.
        </span>
        <input className={inputCls + " max-w-xs"} placeholder="Search Payroll" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className={inputCls + " max-w-[140px]"} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option>Active</option>
          <option>All</option>
        </select>
        <div className="ml-auto flex gap-2">
          <button
            className="rounded-md border border-border-custom px-3 py-2 text-sm text-foreground hover:bg-elevated"
            onClick={() => setUploadOpen(true)}
          >
            Upload Payroll CSV
          </button>
          <button className={btnPrimary} onClick={() => setNewOpen(staffType)}>
            + New Payroll
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border border-border-custom">
        <table className="w-full text-sm">
          <thead className="bg-elevated text-left text-xs uppercase text-muted">
            <tr>
              <th className="px-3 py-2">{staffType === "site" ? "Party" : "Party"}</th>
              <th className="px-3 py-2">Code</th>
              {staffType === "site" && <th className="px-3 py-2">Associated Projects</th>}
              <th className="px-3 py-2">Designation</th>
              <th className="px-3 py-2">Department</th>
              <th className="px-3 py-2">Mobile</th>
              <th className="px-3 py-2 text-right">Salary</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className="cursor-pointer border-t border-border-custom hover:bg-elevated" onClick={() => openDrawer(e)}>
                <td className="px-3 py-2 font-medium text-foreground">{e.name}</td>
                <td className="px-3 py-2 text-muted">{e.employee_code || e.id.slice(0, 8).toUpperCase()}</td>
                {staffType === "site" && <td className="px-3 py-2 text-muted">{projectName(e.project_id)}</td>}
                <td className="px-3 py-2 text-muted">{e.designation || "—"}</td>
                <td className="px-3 py-2 text-muted">{e.department || "—"}</td>
                <td className="px-3 py-2 text-muted">{e.mobile || "—"}</td>
                <td className="px-3 py-2 text-right text-foreground">{fmtINR(e.basic_salary + e.hra + e.other_allowances, currencyDecimalPlaces)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={staffType === "site" ? 7 : 6} className="px-3 py-6 text-center text-muted">
                  {staffType === "site" ? "No project-assigned staff yet." : "No unassigned staff yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {drawerEmp && (
        <PayrollDetailsDrawer
          emp={drawerEmp}
          profile={profLoading ? null : profile}
          companyId={companyId}
          designations={designations}
          leaveTemplates={leaveTemplates}
          costCodes={costCodes}
          onClose={() => setDrawerEmp(null)}
          onSaved={reload}
          onDesignationCreate={createDesignation}
          onLeaveTemplateCreate={createLeaveTemplate}
          onBreakupSave={saveBreakup}
        />
      )}
      {newOpen && (
        <NewPayrollModal
          staffType={newOpen}
          companyId={companyId}
          projectId={projectId}
          designations={designations}
          onClose={() => setNewOpen(null)}
          onCreated={reload}
        />
      )}
      {uploadOpen && (
        <UploadCsvModal companyId={companyId} projectId={projectId} onClose={() => setUploadOpen(false)} onDone={reload} />
      )}
    </div>
  );
}

// ─── Attendance Tab ────────────────────────────────────────────────────────────

function AttendanceTab({
  companyId,
  employees,
  holidays,
}: {
  companyId: string;
  employees: Emp[];
  holidays: Holiday[];
}) {
  const [staffType, setStaffType] = useState<"office" | "site">("office");
  const [statusFilter, setStatusFilter] = useState("All");
  const [date, setDate] = useState(todayStr());
  const [logs, setLogs] = useState<Att[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      // R2-431: a failed attendance fetch must resolve to an error state,
      // never to [], which rendered every unlogged employee as "Absent".
      const att = await jget(`/hr/attendance/company/${companyId}/${date}`);
      const lv = await jget(`/hr/leaves/${companyId}`).catch(() => []);
      setLogs(att);
      setLeaves(lv);
    } catch {
      setLogs([]);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [companyId, date]);

  useEffect(() => {
    load();
  }, [load]);

  const markAttendance = async (emp: Emp, status: string) => {
    if (!emp.project_id) {
      alert(`${emp.name} is not assigned to a project. Assign them first, since attendance is recorded against a project.`);
      return;
    }
    setSavingId(emp.id);
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/hr/attendance/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          employee_id: emp.id,
          project_id: emp.project_id,
          attendance_date: date,
          status,
        }),
      });
      if (!res.ok) {
        alert(`Could not mark attendance: ${await readErrorDetail(res)}`);
        return;
      }
      await load();
    } finally {
      setSavingId(null);
    }
  };

  const presentMap = useMemo(() => {
    const m: Record<string, Att> = {};
    logs.forEach((l) => (m[l.employee_id] = l));
    return m;
  }, [logs]);

  const holidaySet = useMemo(() => new Set(holidays.map((h) => h.date.slice(0, 10))), [holidays]);

  const rows = useMemo(() => {
    const d = employees.filter((e) => {
      const isSite = !!e.project_id;
      if (staffType === "office" && isSite) return false;
      if (staffType === "site" && !isSite) return false;
      if (e.status !== "active") return false;
      return true;
    });
    return d.map((e) => {
      const log = presentMap[e.id];
      const onLeave = leaves.some(
        (l) =>
          l.employee_name === e.name &&
          l.status === "Approved" &&
          date >= l.start_date.slice(0, 10) &&
          date <= l.end_date.slice(0, 10)
      );
      let status = "Absent";
      if (log) status = log.status;
      else if (onLeave) status = "Paid Leave";
      else if (holidaySet.has(date)) status = "Week Off";
      return { emp: e, status, log };
    });
  }, [employees, presentMap, leaves, staffType, holidaySet, date]);

  const counts = useMemo(() => {
    const c = { present: 0, absent: 0, paid: 0, weekoff: 0 };
    rows.forEach((r) => {
      if (r.status === "Present" || r.status === "Present (Off-Site)") c.present++;
      else if (r.status === "Paid Leave") c.paid++;
      else if (r.status === "Week Off") c.weekoff++;
      else c.absent++;
    });
    return c;
  }, [rows]);

  const shift = (n: number) => {
    const d = new Date(date + "T00:00:00");
    d.setDate(d.getDate() + n);
    setDate(toLocalISODate(d));
  };

  const filtered = rows.filter((r) => statusFilter === "All" || r.status === statusFilter);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-md border border-border-custom">
          <button className={`px-3 py-2 text-sm ${staffType === "office" ? "bg-primary text-white" : "text-foreground hover:bg-elevated"}`} onClick={() => setStaffType("office")}>
            Office Staff
          </button>
          <button className={`px-3 py-2 text-sm ${staffType === "site" ? "bg-primary text-white" : "text-foreground hover:bg-elevated"}`} onClick={() => setStaffType("site")}>
            Site Staff
          </button>
        </div>
        <select className={inputCls + " max-w-[140px]"} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option>All</option>
          <option>Present</option>
          <option>Absent</option>
          <option>Paid Leave</option>
          <option>Week Off</option>
        </select>
        <div className="flex items-center gap-1">
          <button className={btnGhost} onClick={() => shift(-1)} aria-label="Previous day">
            <Icon name="chevron_left" className="w-4 h-4" />
          </button>
          <div className="whitespace-nowrap rounded-md border border-border-custom px-3 py-2 text-sm text-foreground">{date}</div>
          <button className={btnGhost} onClick={() => shift(1)} aria-label="Next day">
            <Icon name="chevron_right" className="w-4 h-4" />
          </button>
          <input type="date" className={inputCls + " max-w-[160px]"} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        {!loadError && (
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-success" /> {counts.present} Present</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-danger" /> {counts.absent} Absent</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-warning" /> {counts.paid} Paid Leave</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-primary" /> {counts.weekoff} Week Off</span>
          </div>
        )}
      </div>

      <div className="overflow-x-auto rounded-md border border-border-custom">
        <table className="w-full text-sm">
          <thead className="bg-elevated text-left text-xs uppercase text-muted">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Attendance Status</th>
              <th className="px-3 py-2">Mark</th>
            </tr>
          </thead>
          <tbody>
            {loadError ? (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-danger">
                  Attendance could not be loaded for this day: no statuses are shown rather than marking everyone absent.
                </td>
              </tr>
            ) : (
              <>
                {filtered.map((r) => (
                  <tr key={r.emp.id} className="border-t border-border-custom">
                    <td className="px-3 py-2 font-medium text-foreground">{r.emp.name}</td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          r.status === "Present" || r.status === "Present (Off-Site)"
                            ? "text-success"
                            : r.status === "Paid Leave"
                            ? "text-warning"
                            : r.status === "Week Off"
                            ? "text-primary"
                            : "text-danger"
                        }
                      >
                        {formatLabel(r.status)}
                      </span>
                      {r.log?.marked_manually && (
                        <span className="ml-2 text-[10px] text-muted" title={`Marked by ${r.log.marked_by || "a supervisor"}, not GPS verified`}>
                          (marked{r.log.marked_by ? ` by ${r.log.marked_by}` : ""})
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {/* The status column is derived from punches, leaves and
                          holidays. Without this control the filter chips promised
                          statuses nothing could set, and a crew with no
                          smartphones could not be marked present at all. */}
                      <select
                        className={inputCls + " max-w-[150px]"}
                        value=""
                        disabled={savingId === r.emp.id}
                        onChange={(e) => e.target.value && markAttendance(r.emp, e.target.value)}
                      >
                        <option value="">{savingId === r.emp.id ? "Saving…" : "Mark…"}</option>
                        <option value="Present">Present</option>
                        <option value="Half Day">Half Day</option>
                        <option value="Absent">Absent</option>
                        <option value="Paid Leave">Paid Leave</option>
                        <option value="Week Off">Week Off</option>
                      </select>
                    </td>
                  </tr>
                ))}
                {!loading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-6 text-center text-muted">
                      No records for this day.
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Team Leaves Tab ───────────────────────────────────────────────────────────

function TeamLeavesTab({ companyId }: { companyId: string }) {
  const year = new Date().getFullYear();
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLeaves(await jget(`/hr/leaves/${companyId}`).catch(() => []));
    } finally {
      setLoading(false);
    }
  }, [companyId]);
  useEffect(() => {
    load();
  }, [load]);

  const yearLeaves = leaves.filter((l) => l.start_date.slice(0, 4) === String(year));
  const decide = async (id: string, status: string) => {
    await jput(`/hr/leaves/approve/${id}`, { status });
    load();
  };

  return (
    <div>
      <div className="mb-3">
        <h3 className="text-base font-semibold text-foreground">Team Leaves</h3>
        <p className="text-sm text-muted">Year: {year}</p>
      </div>
      <div className="overflow-x-auto rounded-md border border-border-custom">
        <table className="w-full text-sm">
          <thead className="bg-elevated text-left text-xs uppercase text-muted">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Leave Type</th>
              <th className="px-3 py-2">From</th>
              <th className="px-3 py-2">To</th>
              <th className="px-3 py-2">Days</th>
              <th className="px-3 py-2">Applied On</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {yearLeaves.map((l) => (
              <tr key={l.id} className="border-t border-border-custom">
                <td className="px-3 py-2 font-medium text-foreground">{l.employee_name}</td>
                <td className="px-3 py-2 text-muted">{formatLabel(l.leave_type)}</td>
                <td className="px-3 py-2 text-muted">{formatDate(l.start_date)}</td>
                <td className="px-3 py-2 text-muted">{formatDate(l.end_date)}</td>
                <td className="px-3 py-2 text-muted">{l.days_count}</td>
                <td className="px-3 py-2 text-muted">{formatDate(l.applied_on)}</td>
                <td className="px-3 py-2 text-muted">{formatLabel(l.status)}</td>
                <td className="px-3 py-2">
                  {l.status === "Pending" && (
                    <div className="flex gap-1">
                      <button className="text-xs text-success hover:underline" onClick={() => decide(l.id, "Approved")}>
                        Approve
                      </button>
                      <button className="text-xs text-danger hover:underline" onClick={() => decide(l.id, "Rejected")}>
                        Reject
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {!loading && yearLeaves.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-muted">
                  No leave applications for this year.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── My Leaves Tab ─────────────────────────────────────────────────────────────

function MyLeavesTab({
  companyId,
  employees,
  leaveTemplates,
}: {
  companyId: string;
  employees: Emp[];
  leaveTemplates: LeaveTemplate[];
}) {
  const userName = typeof window !== "undefined" ? localStorage.getItem("user_name") || "" : "";
  const [myLeaves, setMyLeaves] = useState<Leave[]>([]);
  const [type, setType] = useState("Casual");
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(todayStr());
  const [days, setDays] = useState(1);
  const [reason, setReason] = useState("");

  const me = employees.find((e) => e.name === userName);

  const load = useCallback(async () => {
    const all = await jget(`/hr/leaves/${companyId}`).catch(() => []);
    setMyLeaves(all.filter((l: Leave) => l.employee_name === userName));
  }, [companyId, userName]);
  useEffect(() => {
    load();
  }, [load]);

  // Resolve this user's assigned leave template via their payroll profile.
  // templateLoading starts true so the "no template assigned" warning is not
  // shown while the profile fetch is still in flight. Without it a user who
  // does have a template sees that warning first, then the form.
  const [assignedTemplate, setAssignedTemplate] = useState<LeaveTemplate | null>(null);
  const [templateLoading, setTemplateLoading] = useState(true);
  useEffect(() => {
    let active = true;
    if (!me) {
      setTemplateLoading(false);
      return;
    }
    setTemplateLoading(true);
    jget(`/hr/payroll-profiles/${me.id}`)
      .then((p) => {
        if (!active) return;
        const t = leaveTemplates.find((x) => x.id === p.leave_template_id);
        setAssignedTemplate(t || null);
      })
      .catch(() => active && setAssignedTemplate(null))
      .finally(() => active && setTemplateLoading(false));
    return () => {
      active = false;
    };
  }, [me, leaveTemplates]);

  const apply = async () => {
    if (!me?.id) {
      alert("No linked employee staff record found for your user account. Please contact HR to link your profile before applying for leave.");
      return;
    }
    await jpost(`/hr/leaves/${companyId}`, {
      employee_id: me.id,
      employee_name: me.name || userName,
      leave_type: type,
      start_date: isoDateTime(from),
      end_date: isoDateTime(to),
      days_count: days,
      reason: reason.trim() || null,
    });
    setReason("");
    load();
  };

  return (
    <div>
      <h3 className="mb-1 text-base font-semibold text-foreground">My Leaves</h3>
      {!me ? (
        <div className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
          No employee staff record linked to your user account ({userName || "current user"}). Please register in Employee Directory first.
        </div>
      ) : templateLoading ? (
        <div className="mb-4 h-24 animate-pulse rounded-md border border-border-custom bg-elevated" />
      ) : !assignedTemplate ? (
        <div className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
          No leave template assigned for your account this year.
        </div>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted">
            Template: {assignedTemplate.name} · Casual {assignedTemplate.casual_leave_days} · Sick{" "}
            {assignedTemplate.sick_leave_days} · Earned {assignedTemplate.earned_leave_days}
          </p>
          <div className="mb-4 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-2 rounded-md border border-border-custom p-3">
            <Field label="Leave Type">
              <select className={inputCls} value={type} onChange={(e) => setType(e.target.value)}>
                <option>Casual</option>
                <option>Sick</option>
                <option>Earned</option>
              </select>
            </Field>
            <Field label="From">
              <input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To">
              <input type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field label="Days">
              <input type="number" className={inputCls} value={days} onChange={(e) => setDays(parseFloat(e.target.value) || 0)} />
            </Field>
            <Field label="Reason">
              <input type="text" placeholder="Reason for leave" className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
          <button className={btnPrimary} onClick={apply}>
            Apply for Leave
          </button>
        </>
      )}

      <div className="mt-6 overflow-x-auto rounded-md border border-border-custom">
        <table className="w-full text-sm">
          <thead className="bg-elevated text-left text-xs uppercase text-muted">
            <tr>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">From</th>
              <th className="px-3 py-2">To</th>
              <th className="px-3 py-2">Days</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {myLeaves.map((l) => (
              <tr key={l.id} className="border-t border-border-custom">
                <td className="px-3 py-2 text-foreground">{formatLabel(l.leave_type)}</td>
                <td className="px-3 py-2 text-muted">{formatDate(l.start_date)}</td>
                <td className="px-3 py-2 text-muted">{formatDate(l.end_date)}</td>
                <td className="px-3 py-2 text-muted">{l.days_count}</td>
                <td className="px-3 py-2 text-muted">{formatLabel(l.status)}</td>
              </tr>
            ))}
            {myLeaves.length === 0 && (
              <tr>
                <td colSpan={5} className="p-8">
                  <EmptyState
                    title="No leave requests yet"
                    description="Submit a leave application using the form above to track time-off approvals."
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Holidays Tab ──────────────────────────────────────────────────────────────

function HolidaysTab({ companyId }: { companyId: string }) {
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [date, setDate] = useState(todayStr());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setHolidays(await jget(`/hr/holidays/${companyId}`).catch(() => []));
    } finally {
      setLoading(false);
    }
  }, [companyId]);
  useEffect(() => {
    load();
  }, [load]);

  const add = async () => {
    if (!name.trim()) return;
    await jpost(`/hr/holidays/${companyId}`, { name: name.trim(), date: isoDateTime(date) });
    setName("");
    setOpen(false);
    load();
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-foreground">Holiday Calendar</h3>
          <p className="text-sm text-muted">Create your own Holiday Calendar for your company.</p>
        </div>
        <button className={btnPrimary} onClick={() => setOpen(true)}>
          + Add Holiday
        </button>
      </div>
      <div className="overflow-x-auto rounded-md border border-border-custom">
        <table className="w-full text-sm">
          <thead className="bg-elevated text-left text-xs uppercase text-muted">
            <tr>
              <th className="px-3 py-2">Holiday</th>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Day</th>
            </tr>
          </thead>
          <tbody>
            {holidays.map((h) => (
              <tr key={h.id} className="border-t border-border-custom">
                <td className="px-3 py-2 font-medium text-foreground">{h.name}</td>
                <td className="px-3 py-2 text-muted">{formatDate(h.date)}</td>
                <td className="px-3 py-2 text-muted">{dayName(h.date.slice(0, 10))}</td>
              </tr>
            ))}
            {!loading && holidays.length === 0 && (
              <tr>
                <td colSpan={3} className="p-8">
                  <EmptyState
                    title="No holidays added yet"
                    description="Configure annual holidays and company-wide time off for accurate payroll processing."
                    action={{
                      label: "Go to Holiday Settings",
                      href: `/c/${companyId}/settings`,
                    }}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {open && (
        <Modal title="Add Holiday" onClose={() => setOpen(false)}>
          <Field label="Holiday Name">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Date">
            <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <button className={btnGhost} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className={btnPrimary} onClick={add}>
              Save
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

const TABS = ["People", "Attendance", "Team Leaves", "My Leaves", "Holidays"] as const;
type Tab = (typeof TABS)[number];

export default function PayrollPage() {
  const params = useParams();
  const companyId = params.company_id as string;
  const { activeProjectId, projects } = useProject();

  const [tab, setTab] = useState<Tab>("People");
  const [cid, setCid] = useState(companyId);
  const [employees, setEmployees] = useState<Emp[]>([]);
  const [designations, setDesignations] = useState<Designation[]>([]);
  const [leaveTemplates, setLeaveTemplates] = useState<LeaveTemplate[]>([]);
  const [costCodes, setCostCodes] = useState<CostCode[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3000);
  }, []);
  const [loading, setLoading] = useState(false);

  const reloadAll = useCallback(async () => {
    setLoading(true);
    const id = await resolveCompanyId(companyId);
    setCid(id);
    const [emps, des, lts, ccs, pts, hls] = await Promise.all([
      jget(`/hr/company/employees/${id}`).catch(() => []),
      jget(`/hr/designations/${id}`).catch(() => []),
      jget(`/hr/leave-templates/${id}`).catch(() => []),
      jget(`/library/cost-codes/${id}`).catch(() => []),
      jget(`/library/parties/${id}`).catch(() => []),
      jget(`/hr/holidays/${id}`).catch(() => []),
    ]);
    setEmployees(emps);
    setDesignations(des);
    setLeaveTemplates(lts);
    setCostCodes(ccs);
    setParties(pts);
    setHolidays(hls);
    setLoading(false);
  }, [companyId]);

  const [newOpen, setNewOpen] = useState<null | "office" | "site">(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      (window as any).__projectsMap = Object.fromEntries(projects.map((p) => [p.id, p.name || p.project_name]));
    }
    reloadAll();
  }, [reloadAll, projects]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title="Payroll & Attendance"
        subtitle="Staff management, daily logs, leaves and holiday calendar"
        action={
          <button
            onClick={() => setNewOpen("site")}
            className="flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary/95 text-white rounded-md text-xs font-semibold transition-all cursor-pointer"
          >
            + New Allowance / Staff
          </button>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">

        <div className="mb-5">
          <SegmentedTabs
            tabs={TABS}
            activeTab={tab}
            onChange={(t) => setTab(t as any)}
          />
        </div>

        {tab === "People" && (
          <PeopleTab
            companyId={cid}
            projectId={activeProjectId}
            employees={employees}
            designations={designations}
            leaveTemplates={leaveTemplates}
            costCodes={costCodes}
            reload={reloadAll}
            toast={toast}
            newOpen={newOpen}
            setNewOpen={setNewOpen}
          />
        )}
        {tab === "Attendance" && <AttendanceTab companyId={cid} employees={employees} holidays={holidays} />}
        {tab === "Team Leaves" && <TeamLeavesTab companyId={cid} />}
        {tab === "My Leaves" && <MyLeavesTab companyId={cid} employees={employees} leaveTemplates={leaveTemplates} />}
        {tab === "Holidays" && <HolidaysTab companyId={cid} />}

        {toastMsg && (
          <div className="fixed bottom-4 right-4 z-50 rounded-md bg-primary px-4 py-2 text-sm text-white shadow-lg">
            {toastMsg}
          </div>
        )}
      </PageShell>
      </div>
    </div>
  );
}
