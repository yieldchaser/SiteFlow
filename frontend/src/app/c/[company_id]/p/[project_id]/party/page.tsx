"use client";
import Badge, { type BadgeTone } from "@/components/ui/Badge";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { getApi, authHeaders, resolveCompanyId, fmtINR, initials } from "@/lib/siteflow";
import { useCompanySettings } from "@/context/CompanySettingsContext";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import Icon from "@/components/marketing/Icon";

type Party = {
  party_id: string;
  name: string;
  party_type?: string | null;
  balance: number;
  advance_paid: number;
  to_pay: number;
  status?: string;
};

type CompanyParty = {
  id: string;
  name: string;
  party_type?: string | null;
};

const PARTY_TYPES = [
  "Client", "Staff", "Investor", "Worker",
  "Labour Contractor", "Material Supplier", "Equipment Supplier",
  "Other Vendor", "Contractor",
];

async function readErrorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.detail === "string" && body.detail) return body.detail;
  } catch {}
  return `HTTP ${res.status}`;
}

export default function PartyPage() {
  const { currencyDecimalPlaces } = useCompanySettings();
  const params = useParams();
  const companyId = params.company_id as string;
  const projectId = params.project_id as string;

  const [parties, setParties] = useState<Party[]>([]);
  const [balances, setBalances] = useState({ advance_paid: 0, to_pay: 0, to_receive: 0, advance_received: 0 });
  const [companyParties, setCompanyParties] = useState<CompanyParty[]>([]);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [loading, setLoading] = useState(true);
  const [newOpen, setNewOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pRes, bRes, cRes] = await Promise.all([
        fetch(getApi(`/projects/${projectId}/parties`), { headers: authHeaders() }),
        fetch(getApi(`/projects/${projectId}/parties/balances`), { headers: authHeaders() }),
        fetch(getApi(`/library/parties/${companyId}`), { headers: authHeaders() }),
      ]);
      if (pRes.ok) setParties(await pRes.json());
      if (bRes.ok) setBalances(await bRes.json());
      if (cRes.ok) setCompanyParties(await cRes.json());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [companyId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const types = useMemo(
    () => ["All", ...Array.from(new Set(parties.map((p) => p.party_type).filter(Boolean) as string[]))],
    [parties]
  );

  const filtered = parties.filter((p) => {
    if (typeFilter !== "All" && p.party_type !== typeFilter) return false;
    if (statusFilter !== "All" && (p.status || "—") !== statusFilter) return false;
    if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const removeParty = async (partyId: string) => {
    try {
      const res = await fetch(getApi(`/projects/${projectId}/parties/${partyId}`), {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(await readErrorDetail(res));
      load();
    } catch (e) {
      alert(
        `Failed to remove party from project: ${
          e instanceof Error ? e.message : "server unreachable"
        }`
      );
    }
  };

  const toggleStatus = async (p: Party) => {
    const next = (p.status || "—") === "Active" ? "Inactive" : "Active";
    try {
      const res = await fetch(getApi(`/projects/${projectId}/parties/${p.party_id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error(await readErrorDetail(res));
      load();
    } catch (e) {
      alert(
        `Failed to update party status: ${
          e instanceof Error ? e.message : "server unreachable"
        }`
      );
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title="Project Parties"
        subtitle="Vendor, client, subcontractor balances and party profiles for this project"
        action={
          <button
            onClick={() => setAddOpen(true)}
            className="flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary/95 text-white rounded-md text-xs font-semibold transition-all cursor-pointer"
          >
            + Add Party
          </button>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="rounded-lg border border-border-custom bg-card p-4">
          <div className="text-xs uppercase tracking-wider text-success">Advance Paid</div>
          <div className="mt-2 text-3xl font-bold text-success">{fmtINR(balances.advance_paid, currencyDecimalPlaces)}</div>
        </div>
        <div className="rounded-lg border border-border-custom bg-card p-4">
          <div className="text-xs uppercase tracking-wider text-danger">To Pay</div>
          <div className="mt-2 text-3xl font-bold text-danger">{fmtINR(balances.to_pay, currencyDecimalPlaces)}</div>
        </div>
        <div className="rounded-lg border border-border-custom bg-card p-4">
          <div className="text-xs uppercase tracking-wider text-warning">To Receive</div>
          <div className="mt-2 text-3xl font-bold text-warning">{fmtINR(balances.to_receive, currencyDecimalPlaces)}</div>
        </div>
        <div className="rounded-lg border border-border-custom bg-card p-4">
          <div className="text-xs uppercase tracking-wider text-muted">Advance Received</div>
          <div className="mt-2 text-3xl font-bold text-foreground">{fmtINR(balances.advance_received, currencyDecimalPlaces)}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="rounded-md border border-border-custom bg-card px-3 py-2 text-sm text-foreground"
        >
          {types.map((t) => (
            <option key={t} value={t}>{t === "All" ? "Type" : t}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-border-custom bg-card px-3 py-2 text-sm text-foreground"
        >
          {["All", "Active", "Inactive"].map((s) => (
            <option key={s} value={s}>{s === "All" ? "Status" : s}</option>
          ))}
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search Parties"
          className="flex-1 min-w-[180px] rounded-md border border-border-custom bg-card px-3 py-2 text-sm text-foreground"
        />
        <button onClick={() => setNewOpen(true)} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90">
          + New Party
        </button>
      </div>

      <div className="rounded-lg border border-border-custom overflow-hidden bg-card">
        <table className="w-full text-sm">
          <thead className="bg-elevated text-muted">
            <tr>
              <th className="text-left px-4 py-3 font-medium">Party Details</th>
              <th className="text-left px-4 py-3 font-medium">Type</th>
              <th className="text-right px-4 py-3 font-medium">Balance</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
              <th className="text-right px-4 py-3 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="p-4">
                  <TableSkeleton rows={4} cols={5} />
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="p-8">
                  <EmptyState
                    title="No parties linked to this project"
                    description="Link company parties or create a new party for this project."
                    action={{ label: "+ Add Party", onClick: () => setAddOpen(true) }}
                  />
                </td>
              </tr>
            )}
            {!loading && filtered.map((p) => (
              <tr key={p.party_id} className="border-t border-border-custom hover:bg-elevated/50">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-lg bg-primary/15 text-primary flex items-center justify-center font-semibold text-sm">
                      {initials(p.name)}
                    </div>
                    <span className="font-medium text-foreground">{p.name}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-muted">{p.party_type || "—"}</td>
                <td className="px-4 py-3 text-right text-foreground">{fmtINR(p.balance, currencyDecimalPlaces)}</td>
                <td className="px-4 py-3">
                  <button onClick={() => toggleStatus(p)} className="cursor-pointer">
                    <Badge tone={(p.status || "—") === "Active" ? "success" : "danger"}>{p.status || "—"}</Badge>
                  </button>
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => removeParty(p.party_id)} className="text-muted hover:text-danger">Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {newOpen && (
        <NewPartyModal
          companyId={companyId}
          projectId={projectId}
          onClose={() => setNewOpen(false)}
          onCreated={() => { setNewOpen(false); load(); }}
        />
      )}
      {addOpen && (
        <AddPartyModal
          projectId={projectId}
          companyParties={companyParties}
          linkedIds={parties.map((p) => p.party_id)}
          onClose={() => setAddOpen(false)}
          onAdded={() => { setAddOpen(false); load(); }}
        />
      )}
      </PageShell>
      </div>
    </div>
  );
}

function NewPartyModal({
  companyId, projectId, onClose, onCreated,
}: {
  companyId: string; projectId: string; onClose: () => void; onCreated: () => void;
}) {
  const [form, setForm] = useState({
    name: "", phone: "", email: "", party_type: "Client", address: "",
    party_id_custom: "", date_of_joining: "", aadhaar_number: "", pan_number: "",
  });
  const [direction, setDirection] = useState("will_receive");
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      const cid = await resolveCompanyId(companyId);
      const res = await fetch(getApi(`/library/parties`), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          company_id: cid,
          name: form.name,
          phone: form.phone || null,
          email: form.email || null,
          party_type: form.party_type,
          address: form.address || null,
          party_id_custom: form.party_id_custom || null,
          date_of_joining: form.date_of_joining || null,
          aadhaar_number: form.aadhaar_number || null,
          pan_number: form.pan_number || null,
          project_id: projectId,
          opening_balance_direction: amount ? direction : null,
          opening_balance_amount: amount ? parseFloat(amount) : 0,
        }),
      });
      if (res.ok) {
        onCreated();
      } else {
        const err = await res.json().catch(() => ({}));
        alert(`Failed to create party: ${typeof err.detail === "string" ? err.detail : `HTTP ${res.status}`}`);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="New Party" onClose={onClose}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Inp label="Party Name *" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
        <Inp label="Party ID" value={form.party_id_custom} onChange={(v) => setForm({ ...form, party_id_custom: v })} />
        <Inp label="Phone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
        <Inp label="Email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} />
        <div className="col-span-2">
          <Lbl>Party Type</Lbl>
          <select value={form.party_type} onChange={(e) => setForm({ ...form, party_type: e.target.value })} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground">
            {PARTY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <Inp label="Address" value={form.address} onChange={(v) => setForm({ ...form, address: v })} />
        <Inp label="Date of Joining" value={form.date_of_joining} onChange={(v) => setForm({ ...form, date_of_joining: v })} />
        <Inp label="Aadhaar" value={form.aadhaar_number} onChange={(v) => setForm({ ...form, aadhaar_number: v })} />
        <Inp label="PAN" value={form.pan_number} onChange={(v) => setForm({ ...form, pan_number: v })} />
      </div>
      <div className="mt-4 rounded-md border border-border-custom p-3">
        <Lbl>Opening Balance</Lbl>
        <div className="flex gap-3 mt-1">
          <select value={direction} onChange={(e) => setDirection(e.target.value)} className="rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground">
            <option value="will_receive">Party will receive (Advance Paid)</option>
            <option value="will_pay">Party will pay (To Pay)</option>
          </select>
          <input type="number" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} className="flex-1 rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
        </div>
      </div>
      <div className="flex justify-end mt-4">
        <button onClick={submit} disabled={!form.name || saving} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
          {saving ? "Saving…" : "Create Party"}
        </button>
      </div>
    </Modal>
  );
}

function AddPartyModal({
  projectId, companyParties, linkedIds, onClose, onAdded,
}: {
  projectId: string; companyParties: CompanyParty[]; linkedIds: string[]; onClose: () => void; onAdded: () => void;
}) {
  const [partyId, setPartyId] = useState("");
  const [direction, setDirection] = useState("will_receive");
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);

  const available = companyParties.filter((c) => !linkedIds.includes(c.id));

  const submit = async () => {
    if (!partyId) return;
    setSaving(true);
    try {
      const res = await fetch(getApi(`/projects/${projectId}/parties`), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          party_id: partyId,
          opening_balance_direction: amount ? direction : null,
          opening_balance_amount: amount ? parseFloat(amount) : 0,
        }),
      });
      if (res.ok) {
        onAdded();
      } else {
        const err = await res.json().catch(() => ({}));
        alert(`Failed to add party: ${typeof err.detail === "string" ? err.detail : `HTTP ${res.status}`}`);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Add Existing Party" onClose={onClose}>
      <Lbl>Select Party</Lbl>
      <select value={partyId} onChange={(e) => setPartyId(e.target.value)} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground">
        <option value="">Choose</option>
        {available.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.party_type || "—"})</option>)}
      </select>
      <div className="flex gap-3 mt-3">
        <select value={direction} onChange={(e) => setDirection(e.target.value)} className="rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground">
          <option value="will_receive">Party will receive</option>
          <option value="will_pay">Party will pay</option>
        </select>
        <input type="number" placeholder="Opening Amount" value={amount} onChange={(e) => setAmount(e.target.value)} className="flex-1 rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
      </div>
      <div className="flex justify-end mt-4">
        <button onClick={submit} disabled={!partyId || saving} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
          {saving ? "Adding…" : "Add to Project"}
        </button>
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-lg border border-border-custom bg-card p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-foreground">{title}</h3>
          <button onClick={onClose} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Lbl({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 text-xs font-medium text-muted">{children}</div>;
}

function Inp({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <Lbl>{label}</Lbl>
      <input value={value} onChange={(e) => onChange(e.target.value)} className="w-full rounded-md border border-border-custom bg-background px-3 py-2 text-sm text-foreground" />
    </div>
  );
}
