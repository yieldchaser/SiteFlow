"use client";

import React, { useCallback, useEffect, useState } from "react";
import { getApiHost, readErrorDetail } from "@/lib/api";
import { authHeaders } from "@/lib/siteflow";
import { ASSET_CATEGORIES, isCompanyAsset } from "@/lib/equipmentCategories";
import { EmptyState } from "@/components/ui/EmptyState";
import Icon from "@/components/marketing/Icon";

// Laptops, phones, vehicles and other things the company owns and hands to a
// person. Kept in the equipment register so one list shows everything owned,
// but they are not deployed to sites or refuelled, so they get their own tab.
interface Asset {
  id: string;
  name: string;
  code: string;
  category: string;
  ownership_type: string;
  serial_number?: string | null;
  assigned_to?: string | null;
}

const blank = { name: "", code: "", category: ASSET_CATEGORIES[0], ownership_type: "Owned", serial_number: "", assigned_to: "" };

export default function CompanyAssets({ companyId }: { companyId: string }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/equipment/${companyId}`, { headers: authHeaders() });
      if (res.ok) {
        const all: Asset[] = await res.json();
        setAssets(all.filter((a) => isCompanyAsset(a.category)));
      }
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  const startAdd = () => { setForm(blank); setEditingId(null); setError(""); setOpen(true); };
  const startEdit = (a: Asset) => {
    setForm({
      name: a.name, code: a.code, category: a.category, ownership_type: a.ownership_type || "Owned",
      serial_number: a.serial_number || "", assigned_to: a.assigned_to || "",
    });
    setEditingId(a.id);
    setError("");
    setOpen(true);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.code.trim()) {
      setError("Give the asset a name and a code (for example LAP-01).");
      return;
    }
    const body = {
      company_id: companyId,
      name: form.name.trim(),
      code: form.code.trim(),
      category: form.category,
      ownership_type: form.ownership_type,
      hourly_rate: 0,
      serial_number: form.serial_number.trim() || null,
      assigned_to: form.assigned_to.trim() || null,
    };
    setSaving(true);
    const res = await fetch(
      editingId ? `${getApiHost()}/apis/v3/equipment/${editingId}` : `${getApiHost()}/apis/v3/equipment`,
      { method: editingId ? "PUT" : "POST", headers: { "Content-Type": "application/json", ...(authHeaders() || {}) }, body: JSON.stringify(body) },
    ).finally(() => setSaving(false));
    if (!res.ok) {
      setError((await readErrorDetail(res)) || "Could not save the asset");
      return;
    }
    setOpen(false);
    load();
  };

  const q = search.trim().toLowerCase();
  const shown = assets.filter((a) =>
    !q || [a.name, a.code, a.category, a.serial_number, a.assigned_to].some((v) => (v || "").toLowerCase().includes(q)));

  const box = "w-full bg-input border border-border-custom rounded-lg p-2 text-foreground";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted">Laptops, phones, vehicles and other things the company owns, and who has each one.</p>
        <div className="flex gap-2">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, serial or person"
            className="bg-input border border-border-custom rounded-lg px-3 py-1.5 text-xs text-foreground" />
          <button onClick={startAdd} className="px-3 py-1.5 bg-primary text-white font-bold rounded-md text-xs">+ Add Asset</button>
        </div>
      </div>

      {loading ? null : assets.length === 0 ? (
        <EmptyState title="No company assets yet" description="Add laptops, phones and vehicles to see who has what."
          action={{ label: "+ Add Asset", onClick: startAdd }} />
      ) : (
        <div className="bg-card border border-border-custom rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-elevated border-b border-border-custom">
              <tr>
                {["Asset", "Code", "Type", "Serial no.", "Given to", "Owned / Hired", ""].map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 text-[10px] font-bold text-muted uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-custom">
              {shown.map((a) => (
                <tr key={a.id}>
                  <td className="px-4 py-2.5 font-semibold text-foreground">{a.name}</td>
                  <td className="px-4 py-2.5 text-muted">{a.code}</td>
                  <td className="px-4 py-2.5 text-muted">{a.category}</td>
                  <td className="px-4 py-2.5 text-muted">{a.serial_number || "-"}</td>
                  <td className="px-4 py-2.5 text-foreground">{a.assigned_to || <span className="text-muted">In office</span>}</td>
                  <td className="px-4 py-2.5 text-muted">{a.ownership_type}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={() => startEdit(a)} className="text-[10px] bg-primary/10 border border-primary/20 text-primary px-2.5 py-1 rounded-md inline-flex items-center gap-1">
                      <Icon name="edit" className="w-3 h-3" />Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-background border border-border-custom rounded-lg w-full max-w-md shadow-2xl p-6 space-y-4">
            <div className="flex justify-between items-center border-b border-border-custom pb-2">
              <h3 className="text-xs font-extrabold text-foreground">{editingId ? "Edit Asset" : "Add Company Asset"}</h3>
              <button onClick={() => setOpen(false)} className="text-muted hover:text-foreground"><Icon name="close" className="w-5 h-5" /></button>
            </div>
            <form onSubmit={save} className="space-y-3 text-xs">
              {error && <div className="p-2 bg-danger/10 border border-danger/20 text-danger rounded">{error}</div>}
              <div className="space-y-1">
                <label className="text-muted">Asset name</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={box} placeholder="Dell Latitude 5440" />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-muted">Code</label>
                  <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className={box} placeholder="LAP-01" />
                </div>
                <div className="space-y-1">
                  <label className="text-muted">Type</label>
                  <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={box}>
                    {ASSET_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-muted">Serial no.</label>
                  <input value={form.serial_number} onChange={(e) => setForm({ ...form, serial_number: e.target.value })} className={box} placeholder="Optional" />
                </div>
                <div className="space-y-1">
                  <label className="text-muted">Owned / Hired</label>
                  <select value={form.ownership_type} onChange={(e) => setForm({ ...form, ownership_type: e.target.value })} className={box}>
                    <option value="Owned">Owned</option>
                    <option value="Hired">Hired / Leased</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-muted">Given to</label>
                <input value={form.assigned_to} onChange={(e) => setForm({ ...form, assigned_to: e.target.value })} className={box} placeholder="Person's name, or leave empty if in office" />
              </div>
              <div className="flex gap-2 justify-end border-t border-border-custom pt-4">
                <button type="button" onClick={() => setOpen(false)} className="px-4 py-2 bg-elevated text-muted hover:text-foreground rounded-md">Cancel</button>
                <button type="submit" disabled={saving} className="px-5 py-2.5 bg-primary text-white font-bold rounded-md disabled:opacity-60">{saving ? "Saving..." : editingId ? "Update Asset" : "Save Asset"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
