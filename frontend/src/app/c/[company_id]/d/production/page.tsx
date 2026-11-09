"use client";
import { getApiHost, readErrorDetail, detailToMessage} from "@/lib/api";
import UnitInput from "@/components/UnitInput";
import { authHeaders, formatLabel, formatDate } from "@/lib/siteflow";
import Icon from "@/components/marketing/Icon";
import SegmentedTabs from "@/components/ui/Tabs";
import { Badge } from "@/components/ui/Badge";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useProject } from "@/context/ProjectContext";
import { useCompanySettings } from "@/context/CompanySettingsContext";

type RecipeMaterial = {
  id: string;
  material_name: string;
  planned_qty: number;
  unit: string;
  is_optional: boolean;
};

type Recipe = {
  id: string;
  recipe_code: string;
  product_name: string;
  mix_type: string;
  unit: string;
  target_output_qty: number;
  wastage_pct: number;
  status: string;
  notes?: string | null;
  materials: RecipeMaterial[];
};

type BatchMaterial = {
  id: string;
  material_name: string;
  planned_qty: number;
  actual_qty: number;
  unit: string;
  variance_qty: number;
};

type Batch = {
  id: string;
  batch_number: string;
  recipe_code: string;
  product_name: string;
  mix_type: string;
  planned_output_qty: number;
  actual_output_qty: number;
  planned_material_qty: number;
  actual_material_qty: number;
  consumption_variance_qty: number;
  status: string;
  started_at?: string | null;
  completed_at?: string | null;
  notes?: string | null;
  materials: BatchMaterial[];
};

type InventoryAlert = {
  id: string;
  material_name: string;
  on_hand_qty: number;
  reserved_qty: number;
  available_qty: number;
  unit: string;
  needs_reorder: boolean;
};

type ProductionSummary = {
  project_id: string;
  project_name: string;
  recipe_count: number;
  batch_count: number;
  planned_output_qty: number;
  actual_output_qty: number;
  output_variance_qty: number;
  planned_material_qty: number;
  actual_material_qty: number;
  material_variance_qty: number;
  recipes: Recipe[];
  batches: Batch[];
  inventory_alerts: InventoryAlert[];
};

function formatQty(value: number, digits = 2) {
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: digits,
  }).format(value);
}

function MetricCard({
  label,
  value,
  accent,
  note,
}: {
  label: string;
  value: string;
  accent: string;
  note: string;
}) {
  return (
    <div className="rounded-lg border border-border-custom bg-elevated p-4">
      <div className="text-[10px] uppercase tracking-[0.26em] text-muted">{label}</div>
      <div className={`mt-2 text-3xl font-black ${accent}`}>{value}</div>
      <div className="mt-1 text-xs text-muted">{note}</div>
    </div>
  );
}

export default function ProductionPage() {
  const params = useParams();
  const companyId = params?.company_id as string;
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;
  const { quantityDecimalPlaces } = useCompanySettings();

  const formatQty = (value: number, digits = quantityDecimalPlaces) => {
    return new Intl.NumberFormat("en-IN", {
      maximumFractionDigits: digits,
    }).format(value);
  };

  const [tab, setTab] = useState<"overview" | "batches" | "recipes" | "inventory">("overview");
  const [data, setData] = useState<ProductionSummary | null>(null);
  const [loading, setLoading] = useState(true);

  // Modals state
  const [showNewRecipeModal, setShowNewRecipeModal] = useState(false);
  const [showLogBatchModal, setShowLogBatchModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  // Recipe form state
  const [recipeCode, setRecipeCode] = useState("");
  const [productName, setProductName] = useState("");
  const [mixType, setMixType] = useState("Ready Mix");
  const [recipeUnit, setRecipeUnit] = useState("m³");
  const [targetOutputQty, setTargetOutputQty] = useState("1.0");
  const [wastagePct, setWastagePct] = useState("5.0");
  const [recipeNotes, setRecipeNotes] = useState("");
  const [recipeMaterials, setRecipeMaterials] = useState<{ material_name: string; planned_qty: string; unit: string; is_optional: boolean }[]>([
    { material_name: "Cement", planned_qty: "50", unit: "bags", is_optional: false },
    { material_name: "Sand", planned_qty: "3.0", unit: "m³", is_optional: false },
  ]);

  // Batch form state
  const [selectedRecipeId, setSelectedRecipeId] = useState("");
  const [batchNumber, setBatchNumber] = useState("");
  const [plannedOutputQty, setPlannedOutputQty] = useState("10.0");
  const [actualOutputQty, setActualOutputQty] = useState("10.0");
  const [batchStatus, setBatchStatus] = useState("completed");
  const [batchNotes, setBatchNotes] = useState("");
  // Material actually used, per recipe material. Blank means "as per the
  // recipe for this output", which the API works out.
  const [matUsed, setMatUsed] = useState<Record<string, string>>({});
  // Completing a running batch: what came out and what went in.
  const [completing, setCompleting] = useState<Batch | null>(null);
  const [completeOutput, setCompleteOutput] = useState("");
  const [completeMats, setCompleteMats] = useState<Record<string, string>>({});
  const [completeError, setCompleteError] = useState("");

  const fetchSummary = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${getApiHost()}/apis/v3/production/summary?project_id=${projectId}`, { headers: authHeaders() });
      if (!response.ok) {
        throw new Error(`Production summary request failed: ${response.status}`);
      }
      const payload = (await response.json()) as ProductionSummary;
      setData(payload);
    } catch (error) {
      console.error("Failed to load production summary", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (projectId) {
      void fetchSummary();
    } else {
      setLoading(false);
    }
  }, [projectId]);

  const openComplete = (batch: Batch) => {
    setCompleting(batch);
    setCompleteOutput(String(batch.actual_output_qty ?? batch.planned_output_qty ?? ""));
    setCompleteMats({});
    setCompleteError("");
  };

  const handleCompleteBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!completing) return;
    setSubmitting(true);
    setCompleteError("");
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/production/batches/${completing.id}/complete`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          actual_output_qty: completeOutput === "" ? null : Number(completeOutput),
          materials: completing.materials
            .filter((m) => (completeMats[m.material_name] ?? "") !== "")
            .map((m) => ({ material_name: m.material_name, actual_qty: Number(completeMats[m.material_name]), unit: m.unit })),
        }),
      });
      if (res.ok) {
        setCompleting(null);
        void fetchSummary();
      } else {
        const err = await res.json().catch(() => ({}));
        setCompleteError(detailToMessage(err.detail, "Could not complete the batch"));
      }
    } catch (err) {
      console.error("Failed to complete batch", err);
      setCompleteError("Network error. The batch was not completed.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateRecipe = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError("");
    try {
      const payload = {
        company_id: companyId,
        project_id: projectId,
        recipe_code: recipeCode,
        product_name: productName,
        mix_type: mixType,
        unit: recipeUnit,
        target_output_qty: Number(targetOutputQty),
        wastage_pct: Number(wastagePct),
        notes: recipeNotes || null,
        materials: recipeMaterials.map(m => ({
          material_name: m.material_name,
          planned_qty: Number(m.planned_qty),
          unit: m.unit,
          is_optional: m.is_optional,
        })),
      };
      const res = await fetch(`${getApiHost()}/apis/v3/production/recipes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setShowNewRecipeModal(false);
        setRecipeCode("");
        setProductName("");
        setRecipeNotes("");
        void fetchSummary();
      } else {
        const err = await readErrorDetail(res);
        setSubmitError(err || "Failed to create recipe");
      }
    } catch (err) {
      console.error(err);
      setSubmitError("Network error creating recipe");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteRecipe = async (recipeId: string) => {
    if (!confirm("Are you sure you want to delete this concrete mix recipe?")) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/production/recipes/${recipeId}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (res.ok) {
        alert("Recipe deleted successfully");
        void fetchSummary();
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to delete recipe");
      }
    } catch (err) {
      console.error("Delete recipe error:", err);
      alert("Failed to delete recipe. Check your connection.");
    }
  };

  const handleCreateBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRecipeId) {
      setSubmitError("Please select a recipe");
      return;
    }
    setSubmitting(true);
    setSubmitError("");
    try {
      const payload = {
        company_id: companyId,
        project_id: projectId,
        recipe_id: selectedRecipeId,
        batch_number: batchNumber,
        planned_output_qty: Number(plannedOutputQty),
        actual_output_qty: Number(actualOutputQty),
        status: batchStatus,
        notes: batchNotes || null,
        materials: batchStatus === "completed"
          ? (data?.recipes.find((r) => r.id === selectedRecipeId)?.materials || [])
              .filter((m) => (matUsed[m.material_name] ?? "") !== "")
              .map((m) => ({ material_name: m.material_name, actual_qty: Number(matUsed[m.material_name]), unit: m.unit }))
          : [],
      };
      const res = await fetch(`${getApiHost()}/apis/v3/production/batches`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setShowLogBatchModal(false);
        setBatchNumber("");
        setBatchNotes("");
        setMatUsed({});
        void fetchSummary();
      } else {
        const err = await res.json();
        setSubmitError(detailToMessage(err.detail, "Failed to log batch"));
      }
    } catch (err) {
      console.error(err);
      setSubmitError("Network error logging batch");
    } finally {
      setSubmitting(false);
    }
  };

  // Material variance as a percentage: each material against its own plan,
  // then averaged. Adding bags of cement to cubic metres of sand gave totals
  // like "152.24" that meant nothing.
  const pctOf = (mats: { planned_qty: number; actual_qty: number }[]) => {
    const lines = mats.filter((m) => Number(m.planned_qty) > 0);
    if (lines.length === 0) return null;
    return (lines.reduce((s, m) => s + (Number(m.actual_qty) - Number(m.planned_qty)) / Number(m.planned_qty), 0) / lines.length) * 100;
  };
  const batchPct = (batch: Batch) => pctOf(batch.materials || []);

  // Stock of the materials production actually draws: anything on a recipe
  // or a logged batch. The project's whole store (steel, ready-mix, wire)
  // is the Materials module's job, not this tab's. For each, how much
  // output the stock still supports (stock / recipe need per unit, with
  // wastage), and whether it covers one more batch of the usual size.
  // There is no reorder level on stock, so "below one batch" is the
  // real-world trigger a site mixes by.
  const productionStock = useMemo(() => {
    const need = new Map<string, { perUnit: number; outUnit: string }>();
    for (const r of data?.recipes || []) {
      const target = Number(r.target_output_qty) || 1;
      const factor = 1 + (Number(r.wastage_pct) || 0) / 100;
      for (const m of r.materials) {
        const key = m.material_name.toLowerCase();
        const perUnit = (Number(m.planned_qty) / target) * factor;
        if (perUnit > 0 && perUnit > (need.get(key)?.perUnit ?? 0)) need.set(key, { perUnit, outUnit: r.unit });
      }
    }
    const used = new Set((data?.batches || []).flatMap((b) => (b.materials || []).map((m) => m.material_name.toLowerCase())));
    const batches = data?.batches || [];
    const nextBatch = batches.length
      ? batches.reduce((s, b) => s + Number(b.planned_output_qty || 0), 0) / batches.length
      : Number(data?.recipes?.[0]?.target_output_qty || 0);
    return (data?.inventory_alerts || [])
      .filter((ia) => need.has(ia.material_name.toLowerCase()) || used.has(ia.material_name.toLowerCase()))
      .map((ia) => {
        const n = need.get(ia.material_name.toLowerCase());
        const covers = n ? Math.max(ia.available_qty, 0) / n.perUnit : null;
        const short = ia.needs_reorder || (covers !== null && nextBatch > 0 && covers < nextBatch);
        return { ...ia, covers, outUnit: n?.outUnit || "", short, nextBatch };
      });
  }, [data]);

  const stockLine = (item: { covers: number | null; outUnit: string; nextBatch: number }) => {
    if (item.covers === null) return "Not on any recipe now";
    const batches = item.nextBatch > 0 ? Math.floor(item.covers / item.nextBatch) : null;
    return `Enough for ${formatQty(item.covers)} ${item.outUnit}`.trim() +
      (batches !== null ? ` · ${batches} ${batches === 1 ? "batch" : "batches"} of ${formatQty(item.nextBatch)}` : "");
  };

  const totals = useMemo(() => {
    const allLines = (data?.batches || []).flatMap((b) => b.materials || []);
    return {
      outputProgress: data && data.planned_output_qty > 0 ? ((data.actual_output_qty / data.planned_output_qty) * 100) : 0,
      materialVariancePct: pctOf(allLines) ?? 0,
      lowStockCount: productionStock.filter((item) => item.short).length,
    };
  }, [data, productionStock]);

  const getLowStockMaterialsForBatch = (batch: Batch) => {
    if (!productionStock.length) return [];
    const recipe = (data?.recipes || []).find(r => r.recipe_code === batch.recipe_code);
    const materialNames = new Set([
      ...batch.materials.map(m => m.material_name.toLowerCase()),
      ...(recipe?.materials.map(m => m.material_name.toLowerCase()) || [])
    ]);
    return productionStock
      .filter(ia => ia.short && materialNames.has(ia.material_name.toLowerCase()))
      .map(ia => ia.material_name);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background text-foreground">
      <main className="flex-1 flex flex-col overflow-hidden">
        <PageHeader
          title="Production Management"
          subtitle="Recipe standards, batch execution, consumption variance, and inventory pull-through"
        >
          <div className="flex items-center gap-2">
            <button onClick={() => setShowNewRecipeModal(true)} className="rounded-md border border-border-custom bg-elevated px-3.5 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-primary/10 cursor-pointer">
              + New Recipe
            </button>
            <button onClick={() => setShowLogBatchModal(true)} className="rounded-md bg-primary px-3.5 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 cursor-pointer">
              + Log Batch
            </button>
          </div>
        </PageHeader>

        <div className="px-6 py-2 border-b border-border-custom bg-card shrink-0 overflow-x-auto">
          <SegmentedTabs
            tabs={[
              { id: "overview", label: "Overview" },
              { id: "batches", label: "Batch Runs" },
              { id: "recipes", label: "Recipes" },
              { id: "inventory", label: "Inventory Watch" },
            ]}
            activeTab={tab}
            onChange={(t) => setTab(t as any)}
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          <PageShell width="wide">
            <div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Planned Output"
              value={loading ? "…" : formatQty(data?.planned_output_qty ?? 0)}
              accent="text-foreground"
              note="Standard output across all logged batches"
            />
            <MetricCard
              label="Actual Output"
              value={loading ? "…" : formatQty(data?.actual_output_qty ?? 0)}
              accent="text-success"
              note="Completed production volume after execution"
            />
            <MetricCard
              label="Material Variance"
              value={loading ? "…" : `${totals.materialVariancePct > 0 ? "+" : ""}${formatQty(totals.materialVariancePct, 1)}%`}
              accent={totals.materialVariancePct > 0 ? "text-warning" : "text-primary"}
              note="Material used against plan, averaged over every material"
            />
            <MetricCard
              label="Low Stock Alerts"
              value={loading ? "…" : String(totals.lowStockCount)}
              accent="text-danger"
              note="Recipe materials too low for one more batch"
            />
          </div>

          {tab === "overview" && (
            <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
              <section className="rounded-md border border-border-custom bg-elevated p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.24em] text-muted">Execution Health</div>
                    <h2 className="mt-1 text-lg font-bold text-foreground">Batch versus output and material drift</h2>
                  </div>
                  <Badge tone="neutral" className="uppercase tracking-[0.18em] font-semibold">{data?.batch_count ?? 0} batches</Badge>
                </div>

                <div className="mt-5 space-y-4">
                  <div>
                    <div className="mb-2 flex items-center justify-between text-xs">
                      <span className="text-muted">Output progress</span>
                      <span className="font-semibold text-success">{formatQty(totals.outputProgress, 1)}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-elevated">
                      <div className="h-2 rounded-full bg-success" style={{ width: `${Math.min(totals.outputProgress, 100)}%` }} />
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 flex items-center justify-between text-xs">
                      <span className="text-muted">Material variance</span>
                      <span className={totals.materialVariancePct > 0 ? "font-semibold text-warning" : "font-semibold text-primary"}>
                        {formatQty(totals.materialVariancePct, 1)}%
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-elevated">
                      <div
                        className={`h-2 rounded-full ${totals.materialVariancePct > 0 ? "bg-warning" : "bg-primary"}`}
                        style={{ width: `${Math.min(Math.abs(totals.materialVariancePct), 100)}%` }}
                      />
                    </div>
                  </div>
                </div>

                <div className="mt-6 grid gap-4 md:grid-cols-2">
                  {(data?.batches ?? []).slice(0, 4).map((batch) => (
                    <div key={batch.id} className="rounded-xl border border-border-custom bg-elevated p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold text-foreground">{batch.batch_number}</span>
                            {getLowStockMaterialsForBatch(batch).length > 0 && (
                              <Badge tone="warning" icon="warning">
                                Low Stock
                              </Badge>
                            )}
                          </div>
                          <div className="mt-1 text-xs text-muted">{batch.product_name}</div>
                        </div>
                        <Badge tone="neutral">
                          {formatLabel(batch.status)}
                        </Badge>
                      </div>
                      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 text-center text-xs">
                        <div className="rounded-md bg-elevated p-2">
                          <div className="text-muted">Plan</div>
                          <div className="mt-1 font-bold text-foreground">{formatQty(batch.planned_output_qty)}</div>
                        </div>
                        <div className="rounded-md bg-elevated p-2">
                          <div className="text-muted">Actual</div>
                          <div className="mt-1 font-bold text-success">{formatQty(batch.actual_output_qty)}</div>
                        </div>
                        <div className="rounded-md bg-elevated p-2">
                          <div className="text-muted">Var.</div>
                          <div className={`mt-1 font-bold ${(batchPct(batch) ?? 0) > 0 ? "text-warning" : "text-primary"}`}>
                            {batchPct(batch) === null ? "—" : `${(batchPct(batch) ?? 0) > 0 ? "+" : ""}${formatQty(batchPct(batch) ?? 0, 1)}%`}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              <div className="space-y-4">
                <div className="rounded-md border border-border-custom bg-elevated p-5">
                  <div className="text-[10px] uppercase tracking-[0.24em] text-muted">Recipe Library</div>
                  <div className="mt-2 text-lg font-bold text-foreground">{data?.recipe_count ?? 0} standards</div>
                  <div className="mt-4 space-y-3">
                    {(data?.recipes ?? []).slice(0, 3).map((recipe) => (
                      <div key={recipe.id} className="rounded-lg border border-border-custom bg-card p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-foreground">{recipe.product_name}</div>
                            <div className="mt-1 text-xs text-muted">
                              {recipe.recipe_code} · {recipe.mix_type}
                            </div>
                          </div>
                          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">{recipe.unit}</span>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {recipe.materials.slice(0, 4).map((material) => (
                            <Badge key={material.id} tone="neutral">{material.material_name} {formatQty(material.planned_qty, 3)} {material.unit}</Badge>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-md border border-border-custom bg-elevated p-5">
                  <div className="text-[10px] uppercase tracking-[0.24em] text-muted">Stock for Production</div>
                  <div className="mt-2 text-lg font-bold text-foreground">{productionStock.length} recipe {productionStock.length === 1 ? "material" : "materials"}</div>
                  <div className="mt-4 space-y-2">
                    {productionStock.length === 0 && (
                      <div className="text-xs text-muted">No stock recorded yet for the materials your recipes use.</div>
                    )}
                    {[...productionStock].sort((a, b) => (a.covers ?? Infinity) - (b.covers ?? Infinity)).slice(0, 4).map((item) => (
                      <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-border-custom bg-card px-4 py-3">
                        <div>
                          <div className="text-sm font-semibold text-foreground">{item.material_name}</div>
                          <div className="text-xs text-muted">{stockLine(item)}</div>
                        </div>
                        <Badge tone={item.short ? "danger" : "success"} className="whitespace-nowrap uppercase tracking-[0.18em] font-semibold">{item.short ? "Short" : "Enough"}</Badge>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === "batches" && (
            <section className="rounded-md border border-border-custom bg-elevated p-5">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.24em] text-muted">Batch Runs</div>
                  <h2 className="mt-1 text-lg font-bold text-foreground">Material consumption and output trace</h2>
                </div>
                <div className="text-xs text-muted">{data?.batches.length ?? 0} records</div>
              </div>
              <div className="mt-5 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border-custom text-muted">
                      <th className="px-4 py-3 font-semibold">Batch</th>
                      <th className="px-4 py-3 font-semibold">Recipe</th>
                      <th className="px-4 py-3 font-semibold">Status</th>
                      <th className="px-4 py-3 font-semibold">Plan</th>
                      <th className="px-4 py-3 font-semibold">Actual</th>
                      <th className="px-4 py-3 font-semibold">Variance</th>
                      <th className="px-4 py-3 font-semibold">Materials</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.batches ?? []).map((batch) => (
                      <tr key={batch.id} className="border-b border-border-custom hover:bg-elevated">
                        <td className="px-4 py-3 text-foreground">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold">{batch.batch_number}</span>
                            {getLowStockMaterialsForBatch(batch).length > 0 && (
                              <Badge tone="warning" icon="warning">
                                Low Stock
                              </Badge>
                            )}
                          </div>
                          <div className="mt-1 text-[10px] text-muted">{batch.started_at ? `${formatDate(batch.started_at)}, ${new Date(batch.started_at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}` : "No start time"}</div>
                        </td>
                        <td className="px-4 py-3 text-muted">
                          <div className="font-semibold text-foreground">{batch.product_name}</div>
                          <div className="mt-1 text-[10px] text-muted">{batch.recipe_code} · {batch.mix_type}</div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <Badge tone={batch.status === "completed" ? "success" : batch.status === "running" ? "primary" : "neutral"}>
                              {formatLabel(batch.status)}
                            </Badge>
                            {batch.status === "running" && (
                              <button
                                onClick={() => openComplete(batch)}
                                className="rounded bg-primary px-2 py-1 text-[10px] font-bold text-white hover:opacity-90"
                              >
                                Complete
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-muted">{formatQty(batch.planned_output_qty)}</td>
                        <td className="px-4 py-3 text-success">{formatQty(batch.actual_output_qty)}</td>
                        <td className={`px-4 py-3 font-semibold ${(batchPct(batch) ?? 0) > 0 ? "text-warning" : "text-primary"}`}>
                          {batchPct(batch) === null ? "—" : `${(batchPct(batch) ?? 0) > 0 ? "+" : ""}${formatQty(batchPct(batch) ?? 0, 1)}%`}
                        </td>
                        <td className="px-4 py-3 text-muted">{batch.materials.length}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {tab === "recipes" && (
            <div className="grid gap-4 lg:grid-cols-2">
              {(data?.recipes ?? []).map((recipe) => (
                <section key={recipe.id} className="rounded-md border border-border-custom bg-elevated p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.24em] text-muted">{recipe.recipe_code}</div>
                      <h2 className="mt-1 text-xl font-bold text-foreground">{recipe.product_name}</h2>
                      <p className="mt-2 text-sm text-muted">{recipe.mix_type} · Output target {formatQty(recipe.target_output_qty)} {recipe.unit}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone="primary" className="uppercase tracking-[0.18em] font-semibold">{recipe.wastage_pct}% wastage</Badge>
                      <button
                        type="button"
                        onClick={() => handleDeleteRecipe(recipe.id)}
                        className="px-2.5 py-1 bg-elevated hover:bg-danger/10 border border-border-custom text-muted hover:text-danger rounded text-xs font-semibold cursor-pointer inline-flex items-center gap-1"
                        title="Delete recipe"
                      >
                        <Icon name="trash" className="w-3.5 h-3.5" /> Delete
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-2 md:grid-cols-2">
                    {recipe.materials.map((material) => (
                      <div key={material.id} className="rounded-lg border border-border-custom bg-card p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-foreground">{material.material_name}</div>
                            <div className="mt-1 text-xs text-muted">
                              {formatQty(material.planned_qty, 3)} {material.unit}
                            </div>
                          </div>
                          <Badge tone={material.is_optional ? "neutral" : "success"} className="uppercase tracking-[0.18em]">{material.is_optional ? "Optional" : "Required"}</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                  {recipe.notes ? <p className="mt-4 text-xs text-muted">{recipe.notes}</p> : null}
                </section>
              ))}
            </div>
          )}

          {tab === "inventory" && (
            <section className="rounded-md border border-border-custom bg-elevated p-5">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.24em] text-muted">Inventory Watch</div>
                  <h2 className="mt-1 text-lg font-bold text-foreground">Stock of the materials your recipes use</h2>
                </div>
                <div className="text-xs text-muted">{productionStock.length} {productionStock.length === 1 ? "material" : "materials"}</div>
              </div>
              {productionStock.length === 0 && (
                <p className="mt-5 text-sm text-muted">No stock recorded yet for the materials your recipes use. Receive them through a GRN or add them in Materials.</p>
              )}

              <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {productionStock.map((item) => (
                  <div key={item.id} className="rounded-lg border border-border-custom bg-card p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-sm font-semibold text-foreground">{item.material_name}</div>
                        <div className="mt-1 text-xs text-muted">
                          {formatQty(item.available_qty)} {item.unit} available{item.reserved_qty > 0 ? ` · ${formatQty(item.reserved_qty)} reserved` : ""}
                        </div>
                      </div>
                      <Badge tone={item.short ? "danger" : "success"} className="whitespace-nowrap">
                        {item.short ? "Short" : "Enough"}
                      </Badge>
                    </div>
                    <div className={`mt-3 text-xs font-semibold ${item.short ? "text-danger" : "text-foreground"}`}>
                      {stockLine(item)}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
          </PageShell>
        </div>
      </main>

      {showNewRecipeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-xl border border-border-custom bg-card p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-border-custom pb-4">
              <h3 className="text-lg font-bold text-foreground">Create Production Recipe</h3>
              <button onClick={() => setShowNewRecipeModal(false)} className="text-muted hover:text-foreground text-lg">&times;</button>
            </div>
            <form onSubmit={handleCreateRecipe} className="mt-4 space-y-4">
              {submitError && <div className="rounded bg-danger/10 border border-danger/20 p-3 text-xs text-danger">{submitError}</div>}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] uppercase tracking-[0.2em] text-muted block mb-1">Recipe Code</label>
                  <input type="text" value={recipeCode} onChange={(e) => setRecipeCode(e.target.value)} required placeholder="e.g. MIX-M25" className="w-full bg-elevated border border-border-custom rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary" />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-[0.2em] text-muted block mb-1">Product Name</label>
                  <input type="text" value={productName} onChange={(e) => setProductName(e.target.value)} required placeholder="e.g. Concrete M25" className="w-full bg-elevated border border-border-custom rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary" />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div>
                  <label className="text-[10px] uppercase tracking-[0.2em] text-muted block mb-1">Mix Type</label>
                  <select value={mixType} onChange={(e) => setMixType(e.target.value)} className="w-full bg-elevated border border-border-custom rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary">
                    <option value="Ready Mix">Ready Mix</option>
                    <option value="Site Mix">Site Mix</option>
                    <option value="Concrete Batch">Concrete Batch</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-[0.2em] text-muted block mb-1">Unit</label>
                  <UnitInput type="text" autoComplete="off" value={recipeUnit} onChange={(e) => setRecipeUnit(e.target.value)} required className="w-full bg-elevated border border-border-custom rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary" />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-[0.2em] text-muted block mb-1">Wastage %</label>
                  <input type="number" step="0.1" value={wastagePct} onChange={(e) => setWastagePct(e.target.value)} required className="w-full bg-elevated border border-border-custom rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary" />
                </div>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-muted block mb-1 block mb-1">Materials (Planned Ingredients)</label>
                <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
                  {recipeMaterials.map((mat, idx) => (
                    <div key={idx} className="flex gap-2 items-center">
                      <input type="text" value={mat.material_name} onChange={(e) => {
                        const newMats = [...recipeMaterials];
                        newMats[idx].material_name = e.target.value;
                        setRecipeMaterials(newMats);
                      }} placeholder="Material name" required className="flex-1 bg-elevated border border-border-custom rounded px-2.5 py-1.5 text-xs text-foreground" />
                      <input type="number" value={mat.planned_qty} onChange={(e) => {
                        const newMats = [...recipeMaterials];
                        newMats[idx].planned_qty = e.target.value;
                        setRecipeMaterials(newMats);
                      }} placeholder="Qty" required className="w-20 bg-elevated border border-border-custom rounded px-2.5 py-1.5 text-xs text-foreground" />
                      <UnitInput type="text" autoComplete="off" value={mat.unit} onChange={(e) => {
                        const newMats = [...recipeMaterials];
                        newMats[idx].unit = e.target.value;
                        setRecipeMaterials(newMats);
                      }} placeholder="Unit" required className="w-16 bg-elevated border border-border-custom rounded px-2.5 py-1.5 text-xs text-foreground" />
                      <button type="button" onClick={() => {
                        setRecipeMaterials(recipeMaterials.filter((_, i) => i !== idx));
                      }} className="text-danger hover:text-danger text-xs px-1">&times;</button>
                    </div>
                  ))}
                </div>
                <button type="button" onClick={() => setRecipeMaterials([...recipeMaterials, { material_name: "", planned_qty: "", unit: "kg", is_optional: false }])} className="mt-2 text-xs text-primary font-semibold hover:underline">+ Add Material</button>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-muted block mb-1">Notes</label>
                <textarea value={recipeNotes} onChange={(e) => setRecipeNotes(e.target.value)} placeholder="Mix ratio design details..." className="w-full h-16 bg-elevated border border-border-custom rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary resize-none" />
              </div>
              <div className="flex justify-end gap-2 border-t border-border-custom pt-4">
                <button type="button" onClick={() => setShowNewRecipeModal(false)} className="rounded px-4 py-2 text-xs font-semibold text-muted hover:text-foreground">Cancel</button>
                <button type="submit" disabled={submitting} className="rounded bg-primary px-4 py-2 text-xs font-bold text-white hover:opacity-90 disabled:opacity-50">{submitting ? "Creating..." : "Save Recipe"}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showLogBatchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-xl border border-border-custom bg-card p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-border-custom pb-4">
              <h3 className="text-lg font-bold text-foreground">Log Production Batch</h3>
              <button onClick={() => setShowLogBatchModal(false)} className="text-muted hover:text-foreground text-lg">&times;</button>
            </div>
            <form onSubmit={handleCreateBatch} className="mt-4 space-y-4">
              {submitError && <div className="rounded bg-danger/10 border border-danger/20 p-3 text-xs text-danger">{submitError}</div>}
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-muted block mb-1">Select Recipe Standard</label>
                <select value={selectedRecipeId} onChange={(e) => {
                  setSelectedRecipeId(e.target.value);
                  setMatUsed({});
                  const selected = data?.recipes.find(r => r.id === e.target.value);
                  if (selected) {
                    setPlannedOutputQty(String(selected.target_output_qty));
                    setActualOutputQty(String(selected.target_output_qty));
                  }
                }} required className="w-full bg-elevated border border-border-custom rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary">
                  <option value="">Choose Recipe</option>
                  {(data?.recipes ?? []).map((r) => (
                    <option key={r.id} value={r.id}>{r.recipe_code} - {r.product_name} ({r.mix_type})</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] uppercase tracking-[0.2em] text-muted block mb-1">Batch Number</label>
                  <input type="text" value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} required placeholder="e.g. BATCH-2026-001" className="w-full bg-elevated border border-border-custom rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary" />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-[0.2em] text-muted block mb-1">Status</label>
                  <select value={batchStatus} onChange={(e) => setBatchStatus(e.target.value)} className="w-full bg-elevated border border-border-custom rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary">
                    <option value="completed">Completed, take stock out now</option>
                    <option value="running">Running, take stock out when it finishes</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-[10px] uppercase tracking-[0.2em] text-muted block mb-1">Planned Output Qty</label>
                  <input type="number" step="0.01" value={plannedOutputQty} onChange={(e) => setPlannedOutputQty(e.target.value)} required className="w-full bg-elevated border border-border-custom rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary" />
                </div>
                <div>
                  <label className="text-[10px] uppercase tracking-[0.2em] text-muted block mb-1">Actual Output Qty</label>
                  <input type="number" step="0.01" value={actualOutputQty} onChange={(e) => setActualOutputQty(e.target.value)} required className="w-full bg-elevated border border-border-custom rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary" />
                </div>
              </div>
              {batchStatus === "completed" && (() => {
                const recipe = data?.recipes.find((r) => r.id === selectedRecipeId);
                if (!recipe || recipe.materials.length === 0) return null;
                const factor = (1 + (Number(recipe.wastage_pct) || 0) / 100) / (Number(recipe.target_output_qty) || 1);
                return (
                  <div>
                    <label className="text-[10px] uppercase tracking-[0.2em] text-muted block mb-1">Material Used</label>
                    <p className="mb-2 text-[11px] text-muted">Leave a line blank if it went as per the recipe.</p>
                    <div className="space-y-2">
                      {recipe.materials.map((m) => (
                        <div key={m.id} className="flex items-center gap-3">
                          <span className="flex-1 text-xs text-foreground">{m.material_name}</span>
                          <input
                            type="number" min="0" step="any"
                            value={matUsed[m.material_name] ?? ""}
                            onChange={(e) => setMatUsed((prev) => ({ ...prev, [m.material_name]: e.target.value }))}
                            placeholder={formatQty(Number(m.planned_qty) * factor * (Number(actualOutputQty) || 0))}
                            className="w-28 bg-elevated border border-border-custom rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
                          />
                          <span className="w-10 text-[11px] text-muted">{m.unit}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-muted block mb-1">Notes</label>
                <textarea value={batchNotes} onChange={(e) => setBatchNotes(e.target.value)} placeholder="Pour location details, slump verification, grid lines..." className="w-full h-16 bg-elevated border border-border-custom rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary resize-none" />
              </div>
              <div className="flex justify-end gap-2 border-t border-border-custom pt-4">
                <button type="button" onClick={() => setShowLogBatchModal(false)} className="rounded px-4 py-2 text-xs font-semibold text-muted hover:text-foreground">Cancel</button>
                <button type="submit" disabled={submitting} className="rounded bg-primary px-4 py-2 text-xs font-bold text-white hover:opacity-90 disabled:opacity-50">{submitting ? "Logging..." : "Log Batch"}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {completing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-xl border border-border-custom bg-card p-6 shadow-2xl">
            <div className="flex items-center justify-between border-b border-border-custom pb-4">
              <h3 className="text-lg font-bold text-foreground">Complete {completing.batch_number}</h3>
              <button onClick={() => setCompleting(null)} className="text-muted hover:text-foreground text-lg">&times;</button>
            </div>
            <form onSubmit={handleCompleteBatch} className="mt-4 space-y-4">
              {completeError && <div className="rounded bg-danger/10 border border-danger/20 p-3 text-xs text-danger">{completeError}</div>}
              <p className="text-xs text-muted">Stock is taken out of the store when you complete the batch. Leave a material blank if it went as per the plan.</p>
              <div>
                <label className="text-[10px] uppercase tracking-[0.2em] text-muted block mb-1">Actual Output Qty</label>
                <input type="number" min="0" step="any" value={completeOutput} onChange={(e) => setCompleteOutput(e.target.value)} className="w-full bg-elevated border border-border-custom rounded px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary" />
              </div>
              {completing.materials.length > 0 && (
                <div>
                  <label className="text-[10px] uppercase tracking-[0.2em] text-muted block mb-1">Material Used</label>
                  <div className="space-y-2">
                    {completing.materials.map((m) => (
                      <div key={m.id} className="flex items-center gap-3">
                        <span className="flex-1 text-xs text-foreground">{m.material_name}<span className="ml-2 text-muted">plan {formatQty(m.planned_qty)}</span></span>
                        <input
                          type="number" min="0" step="any"
                          value={completeMats[m.material_name] ?? ""}
                          onChange={(e) => setCompleteMats((prev) => ({ ...prev, [m.material_name]: e.target.value }))}
                          placeholder={formatQty(m.actual_qty)}
                          className="w-28 bg-elevated border border-border-custom rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
                        />
                        <span className="w-10 text-[11px] text-muted">{m.unit}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2 border-t border-border-custom pt-4">
                <button type="button" onClick={() => setCompleting(null)} className="rounded px-4 py-2 text-xs font-semibold text-muted hover:text-foreground">Cancel</button>
                <button type="submit" disabled={submitting} className="rounded bg-primary px-4 py-2 text-xs font-bold text-white hover:opacity-90 disabled:opacity-50">{submitting ? "Completing..." : "Complete Batch"}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
