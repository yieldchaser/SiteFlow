"use client";

import React, { useState, useEffect } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useProject } from "@/context/ProjectContext";
import { getApiHost, readErrorDetail } from "@/lib/api";
import { formatDate, fmtINR } from "@/lib/siteflow";
import { UNITS } from "@/lib/units";
import Badge from "@/components/ui/Badge";
import Icon, { type IconName } from "@/components/marketing/Icon";
import SegmentedTabs from "@/components/ui/Tabs";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";

type LibraryType =
  | "party"
  | "party-balances"
  | "asset-type"
  | "cost-code"
  | "deduction"
  | "progress"
  | "workforce"
  | "material"
  | "rate"
  | "retention"
  | "material-category"
  | "todo";

const LIBRARY_TABS: LibraryType[] = [
  "party", "party-balances", "asset-type", "cost-code", "deduction", "progress", "workforce",
  "material", "rate", "retention", "material-category", "todo",
];

const TAB_TITLES: Record<LibraryType, string> = {
  party: "Party",
  "party-balances": "Party Balances",
  "asset-type": "Asset Type",
  "cost-code": "Cost Code",
  deduction: "Deduction",
  progress: "Progress",
  workforce: "Workforce",
  material: "Material",
  rate: "Rate",
  retention: "Retention",
  "material-category": "Material Category",
  todo: "To Do",
};

/** One vocabulary for both the filter and the create form. They used to
 *  disagree, so four filter values could never match anything. */
const PARTY_TYPES = [
  "Supplier",
  "Subcontractor",
  "Client",
  "Contractor",
  "Material Supplier",
  "Equipment Supplier",
  "Labour Contractor",
] as const;

export default function LibraryHubPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const companyId = params.company_id as string;
  const { activeProjectId } = useProject();
  const projectId = activeProjectId;
  const accessToken = typeof window !== "undefined" ? localStorage.getItem("access_token") : "";

  const initialTab = ((): LibraryType => {
    const t = searchParams.get("tab");
    return t && (LIBRARY_TABS as string[]).includes(t) ? (t as LibraryType) : "party";
  })();

  const [activeTab, setActiveTab] = useState<LibraryType>(initialTab);
  const [libraryData, setLibraryData] = useState<any[]>([]);
  const [partyBalancesSummary, setPartyBalancesSummary] = useState<{ advance_paid: number; to_pay: number } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [partyTypeFilter, setPartyTypeFilter] = useState("");
  const [toastMessage, setToastMessage] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  // Drawers
  const [isPartyDrawerOpen, setIsPartyDrawerOpen] = useState(false);
  const [isMaterialDrawerOpen, setIsMaterialDrawerOpen] = useState(false);
  const [isRateDrawerOpen, setIsRateDrawerOpen] = useState(false);
  const [isSimpleDrawerOpen, setIsSimpleDrawerOpen] = useState(false);

  // Form Fields: Party
  const [partyName, setPartyName] = useState("");
  const [partyPhone, setPartyPhone] = useState("");
  const [partyEmail, setPartyEmail] = useState("");
  const [partyType, setPartyType] = useState("Supplier");
  const [partyAddress, setPartyAddress] = useState("");
  const [partyBankName, setPartyBankName] = useState("");
  const [partyAccountName, setPartyAccountName] = useState("");
  const [partyAccountNumber, setPartyAccountNumber] = useState("");
  const [partyIfscCode, setPartyIfscCode] = useState("");
  const [partyTaxNo, setPartyTaxNo] = useState("");
  const [partyJoiningDate, setPartyJoiningDate] = useState("");
  const [partyAadhaar, setPartyAadhaar] = useState("");
  const [partyPan, setPartyPan] = useState("");
  const [partyEsiNumber, setPartyEsiNumber] = useState("");
  const [partyPfNumber, setPartyPfNumber] = useState("");
  const [partyFatherName, setPartyFatherName] = useState("");
  const [partyPassportNo, setPartyPassportNo] = useState("");
  const [partyPassportExpiryDate, setPartyPassportExpiryDate] = useState("");
  const [partyAadhaarFile, setPartyAadhaarFile] = useState<string | null>(null);
  const [partyPanFile, setPartyPanFile] = useState<string | null>(null);
  const [uploadingKyc, setUploadingKyc] = useState<string | null>(null);
  const [kycError, setKycError] = useState<string | null>(null);
  const [revealedAadhaar, setRevealedAadhaar] = useState<Record<string, string>>({});
  const [revealingAadhaarId, setRevealingAadhaarId] = useState<string | null>(null);

  const maskAadhaar = (num?: string | null) => {
    if (!num) return "—";
    const clean = num.replace(/\s+/g, "");
    if (clean.length < 4) return "XXXX XXXX " + clean;
    return `XXXX XXXX ${clean.slice(-4)}`;
  };

  // Form Fields: Material
  const [matName, setMatName] = useState("");
  const [matUnit, setMatUnit] = useState("Bag");
  const [matGst, setMatGst] = useState(18.0);
  const [matCategory, setMatCategory] = useState("Cement");
  const [matCost, setMatCost] = useState(420.0);
  const [matLeadTime, setMatLeadTime] = useState(2);
  const [matHsn, setMatHsn] = useState("");
  const [matCode, setMatCode] = useState("");
  const [matSpecs, setMatSpecs] = useState("");
  const [matAltUnit, setMatAltUnit] = useState("");

  // Form Fields: Rate
  const [rateName, setRateName] = useState("");
  const [rateCode, setRateCode] = useState("");
  const [rateUnit, setRateUnit] = useState("sqft");
  const [rateGst, setRateGst] = useState(12.0);
  const [rateCategory, setRateCategory] = useState("Civil Works");
  const [rateCost, setRateCost] = useState(180.0);
  const [rateMarkup, setRateMarkup] = useState(15.0);
  const [rateMarkupType, setRateMarkupType] = useState("percent");
  const [rateSalePrice, setRateSalePrice] = useState(207.0);
  const [rateNote, setRateNote] = useState("");
  const [rateCostCode, setRateCostCode] = useState("");
  const [rateHsn, setRateHsn] = useState("");

  // Simple Item (Asset Type, Cost Code, Deduction, Progress, Workforce)
  const [simpleName, setSimpleName] = useState("");
  const [simpleCode, setSimpleCode] = useState(""); // used for Cost Code
  const [simpleSubCode, setSimpleSubCode] = useState("");
  const [wfRateType, setWfRateType] = useState("Per Shift");
  const [wfSalary, setWfSalary] = useState("");
  const [wfShiftHours, setWfShiftHours] = useState("");
  const [wfCostCode, setWfCostCode] = useState("");

  const apiHost = getApiHost();
  const getStoredCreatorName = () => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem("creator_name") || localStorage.getItem("user_name") || "";
  };

  const resetPartyForm = () => {
    setPartyName("");
    setPartyPhone("");
    setPartyEmail("");
    setPartyType("Supplier");
    setPartyAddress("");
    setPartyBankName("");
    setPartyAccountName("");
    setPartyAccountNumber("");
    setPartyIfscCode("");
    setPartyTaxNo("");
    setPartyJoiningDate("");
    setPartyAadhaar("");
    setPartyPan("");
    setPartyEsiNumber("");
    setPartyPfNumber("");
    setPartyFatherName("");
    setPartyPassportNo("");
    setPartyPassportExpiryDate("");
    setPartyAadhaarFile(null);
    setPartyPanFile(null);
    setKycError(null);
  };

  const handleRevealAadhaar = async (partyId: string) => {
    if (revealedAadhaar[partyId]) {
      setRevealedAadhaar((prev) => {
        const next = { ...prev };
        delete next[partyId];
        return next;
      });
      return;
    }
    setRevealingAadhaarId(partyId);
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/library/parties/${partyId}/aadhaar-reveal`, {
        headers: { "Authorization": `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setRevealedAadhaar((prev) => ({ ...prev, [partyId]: data.aadhaar_number || "—" }));
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to reveal Aadhaar number");
      }
    } catch {
      alert("Failed to reveal Aadhaar number. Check connection.");
    } finally {
      setRevealingAadhaarId(null);
    }
  };

  const handleUploadKyc = async (docType: "aadhaar_file" | "pan_file", file: File) => {
    if (!editingId) {
      alert("Please register the party first before uploading identity documents.");
      return;
    }
    setUploadingKyc(docType);
    setKycError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${getApiHost()}/apis/v3/library/parties/${editingId}/kyc/${docType}`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}` },
        body: fd,
      });
      if (res.ok) {
        const data = await res.json();
        if (docType === "aadhaar_file") setPartyAadhaarFile(data.storage_path);
        if (docType === "pan_file") setPartyPanFile(data.storage_path);
        fetchLibraryData();
      } else {
        const err = await readErrorDetail(res);
        setKycError(err || "Upload failed");
      }
    } catch (e: any) {
      setKycError(e?.message || "Upload failed");
    } finally {
      setUploadingKyc(null);
    }
  };

  const handleViewKyc = async (docType: "aadhaar_file" | "pan_file") => {
    if (!editingId) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/library/parties/${editingId}/kyc/${docType}`, {
        headers: { "Authorization": `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.url) {
          window.open(data.url, "_blank", "noopener,noreferrer");
        }
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to retrieve document");
      }
    } catch {
      alert("Failed to view document");
    }
  };

  const handleDeleteKyc = async (docType: "aadhaar_file" | "pan_file") => {
    if (!editingId || !confirm("Are you sure you want to remove this document?")) return;
    try {
      const res = await fetch(`${getApiHost()}/apis/v3/library/parties/${editingId}/kyc/${docType}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${accessToken}` },
      });
      if (res.ok) {
        if (docType === "aadhaar_file") setPartyAadhaarFile(null);
        if (docType === "pan_file") setPartyPanFile(null);
        fetchLibraryData();
      } else {
        const err = await readErrorDetail(res);
        alert(err || "Failed to remove document");
      }
    } catch {
      alert("Failed to remove document");
    }
  };

  // Compute sale price automatically
  useEffect(() => {
    let cost = Number(rateCost) || 0;
    let markup = Number(rateMarkup) || 0;
    if (rateMarkupType === "percent") {
      setRateSalePrice(Number((cost * (1 + markup / 100)).toFixed(2)));
    } else {
      setRateSalePrice(cost + markup);
    }
  }, [rateCost, rateMarkup, rateMarkupType]);

  const getEndpoint = (tab: LibraryType) => {
    switch (tab) {
      case "party": return "parties";
      case "party-balances": return "parties";
      case "asset-type": return "asset-types";
      case "cost-code": return "cost-codes";
      case "deduction": return "deductions";
      case "progress": return "progresses";
      case "workforce": return "workforces";
      case "material": return "materials";
      case "rate": return "rates";
      case "retention": return "retentions";
      case "material-category": return "material-categories";
      case "todo": return "todos";
    }
  };

  const fetchLibraryData = async () => {
    if (!companyId || !accessToken) return;
    try {
      if (activeTab === "party-balances") {
        const partyRes = await fetch(`${apiHost}/apis/v3/library/parties/${companyId}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (partyRes.ok) {
          const data = await partyRes.json();
          setLibraryData(data);
        }
        if (projectId) {
          const balRes = await fetch(`${apiHost}/apis/v3/library/parties/${companyId}/balances?project_id=${projectId}`, {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          if (balRes.ok) {
            setPartyBalancesSummary(await balRes.json());
          }
        }
        return;
      }
      const endpoint = getEndpoint(activeTab);
      let url = `${apiHost}/apis/v3/library/${endpoint}/${companyId}`;
      if (activeTab === "party" && partyTypeFilter) {
        url += `?party_type=${encodeURIComponent(partyTypeFilter)}`;
      }
      const res = await fetch(url, {
        headers: { "Authorization": `Bearer ${accessToken}` }
      });
      if (res.ok) {
        const data = await res.json();
        setLibraryData(data);
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchLibraryData();
  }, [activeTab, companyId, accessToken, partyTypeFilter]);

  const handleDeleteItem = async (itemId: string) => {
    try {
      const endpoint = getEndpoint(activeTab);
      const res = await fetch(`${apiHost}/apis/v3/library/${endpoint}/${itemId}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${accessToken}` }
      });
      if (res.ok) {
        setToastMessage("Library item deleted successfully.");
        setTimeout(() => setToastMessage(""), 3000);
        fetchLibraryData();
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleCreateParty = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!partyName.trim()) return;
    const creatorName = getStoredCreatorName();

    try {
      const url = editingId ? `${apiHost}/apis/v3/library/parties/${editingId}` : `${apiHost}/apis/v3/library/parties`;
      const res = await fetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          company_id: companyId,
          name: partyName,
          phone: partyPhone,
          email: partyEmail,
          party_type: partyType,
          address: partyAddress,
          bank_name: partyBankName,
          account_name: partyAccountName,
          account_number: partyAccountNumber,
          ifsc_code: partyIfscCode,
          tax_no: partyTaxNo,
          date_of_joining: partyJoiningDate || null,
          aadhaar_number: partyAadhaar,
          pan_number: partyPan,
          esi_number: partyEsiNumber,
          pf_number: partyPfNumber,
          father_name: partyFatherName,
          passport_no: partyPassportNo,
          passport_expiry_date: partyPassportExpiryDate || null,
          creator_name: creatorName || null
        })
      });

      if (res.ok) {
        setIsPartyDrawerOpen(false);
        resetPartyForm();
        setToastMessage("Party added to library!");
        setTimeout(() => setToastMessage(""), 3000);
        fetchLibraryData();
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleCreateMaterial = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!matName.trim()) return;

    try {
      const url = editingId ? `${apiHost}/apis/v3/library/materials/${editingId}` : `${apiHost}/apis/v3/library/materials`;
      const res = await fetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`
        },
          body: JSON.stringify({
          company_id: companyId,
          name: matName,
          unit: matUnit,
          alternate_unit: matAltUnit || null,
          gst_rate: Number(matGst),
          category: matCategory,
          unit_cost: Number(matCost),
          lead_time_days: Number(matLeadTime),
          hsn_sac: matHsn,
          item_code: matCode,
          specifications: matSpecs
        })
      });

      if (res.ok) {
        setIsMaterialDrawerOpen(false);
        setMatName("");
        setMatHsn("");
        setMatCode("");
        setMatSpecs("");
        setMatAltUnit("");
        setToastMessage("Material item saved to library!");
        setTimeout(() => setToastMessage(""), 3000);
        fetchLibraryData();
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleCreateRate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rateName.trim()) return;

    try {
      const url = editingId ? `${apiHost}/apis/v3/library/rates/${editingId}` : `${apiHost}/apis/v3/library/rates`;
      const res = await fetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          company_id: companyId,
          name: rateName,
          item_code: rateCode,
          unit: rateUnit,
          gst_rate: Number(rateGst),
          category: rateCategory,
          unit_cost: Number(rateCost),
          markup_value: Number(rateMarkup),
          markup_type: rateMarkupType,
          unit_sale_price: Number(rateSalePrice),
          note: rateNote,
          cost_code: rateCostCode,
          hsn_sac: rateHsn
        })
      });

      if (res.ok) {
        setIsRateDrawerOpen(false);
        setRateName("");
        setRateCode("");
        setRateNote("");
        setRateCostCode("");
        setRateHsn("");
        setToastMessage("Rate card item saved to library!");
        setTimeout(() => setToastMessage(""), 3000);
        fetchLibraryData();
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleCreateSimple = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!simpleName.trim()) return;

    try {
      const endpoint = getEndpoint(activeTab);
      const payload: any = {
        company_id: companyId,
        name: simpleName
      };
      if (activeTab === "cost-code") {
        payload.code = simpleCode;
        payload.sub_cost_code = simpleSubCode || null;
      }
      if (activeTab === "workforce") {
        payload.rate_type = wfRateType || null;
        payload.salary_per_shift = wfSalary ? parseFloat(wfSalary) : null;
        payload.shift_hours = wfShiftHours ? parseFloat(wfShiftHours) : null;
        payload.cost_code = wfCostCode || null;
      }

      const url = editingId ? `${apiHost}/apis/v3/library/${endpoint}/${editingId}` : `${apiHost}/apis/v3/library/${endpoint}`;
      const res = await fetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`
        },
        body: JSON.stringify(payload)
      });

      if (res.ok) {
        setIsSimpleDrawerOpen(false);
        setSimpleName("");
        setSimpleCode("");
        setSimpleSubCode("");
        setWfRateType("Per Shift");
        setWfSalary("");
        setWfShiftHours("");
        setWfCostCode("");
        setToastMessage("Library item created!");
        setTimeout(() => setToastMessage(""), 3000);
        fetchLibraryData();
      } else {
        const err = await readErrorDetail(res);
        alert(err || 'Action failed');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleEditParty = (item: any) => {
    setEditingId(item.id);
    setPartyName(item.name || "");
    setPartyPhone(item.phone || "");
    setPartyEmail(item.email || "");
    setPartyType(item.party_type || "Supplier");
    setPartyAddress(item.address || "");
    setPartyBankName(item.bank_name || "");
    setPartyAccountName(item.account_name || "");
    setPartyAccountNumber(item.account_number || "");
    setPartyIfscCode(item.ifsc_code || "");
    setPartyTaxNo(item.tax_no || "");
    setPartyJoiningDate(item.date_of_joining ? item.date_of_joining.split("T")[0] : "");
    setPartyAadhaar(item.aadhaar_number || "");
    setPartyPan(item.pan_number || "");
    setPartyEsiNumber(item.esi_number || "");
    setPartyPfNumber(item.pf_number || "");
    setPartyFatherName(item.father_name || "");
    setPartyPassportNo(item.passport_no || "");
    setPartyPassportExpiryDate(item.passport_expiry_date ? item.passport_expiry_date.split("T")[0] : "");
    setPartyAadhaarFile(item.aadhaar_file || null);
    setPartyPanFile(item.pan_file || null);
    setKycError(null);
    setIsPartyDrawerOpen(true);
  };

  const handleEditMaterial = (item: any) => {
    setEditingId(item.id);
    setMatName(item.name || "");
    setMatUnit(item.unit || "Bag");
    setMatAltUnit(item.alternate_unit || "");
    setMatGst(item.gst_rate ?? 18.0);
    setMatCategory(item.category || "Cement");
    setMatCost(item.unit_cost ?? 420.0);
    setMatLeadTime(item.lead_time_days ?? 2);
    setMatHsn(item.hsn_sac || "");
    setMatCode(item.item_code || "");
    setMatSpecs(item.specifications || "");
    setIsMaterialDrawerOpen(true);
  };

  const handleEditRate = (item: any) => {
    setEditingId(item.id);
    setRateName(item.name || "");
    setRateCode(item.item_code || "");
    setRateUnit(item.unit || "sqft");
    setRateGst(item.gst_rate ?? 12.0);
    setRateCategory(item.category || "Civil Works");
    setRateCost(item.unit_cost ?? 180.0);
    setRateMarkup(item.markup_value ?? 15.0);
    setRateMarkupType(item.markup_type || "percent");
    setRateSalePrice(item.unit_sale_price ?? 207.0);
    setRateNote(item.note || "");
    setRateCostCode(item.cost_code || "");
    setRateHsn(item.hsn_sac || "");
    setIsRateDrawerOpen(true);
  };

  const handleEditSimple = (item: any) => {
    setEditingId(item.id);
    setSimpleName(item.name || "");
    setSimpleCode(item.code || "");
    setSimpleSubCode(item.sub_cost_code || "");
    setWfRateType(item.rate_type || "Per Shift");
    setWfSalary(item.salary_per_shift != null ? String(item.salary_per_shift) : "");
    setWfShiftHours(item.shift_hours != null ? String(item.shift_hours) : "");
    setWfCostCode(item.cost_code || "");
    setIsSimpleDrawerOpen(true);
  };

  const filteredData = libraryData.filter((item) => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return true;

    const matchesQuery = (value: unknown) =>
      value !== null && value !== undefined && String(value).toLowerCase().includes(query);

    if (activeTab === "party") {
      return [
        item.party_id_custom,
        item.name,
        item.party_type,
        item.phone,
        item.email,
        item.address,
        item.bank_name,
        item.account_name,
        item.account_number,
        item.ifsc_code,
        item.tax_no,
        item.date_of_joining,
        maskAadhaar(item.aadhaar_number),
        item.pan_number,
        item.esi_number,
        item.pf_number,
        item.father_name,
        item.passport_no,
        item.passport_expiry_date,
        item.creator_name,
        item.created_at
      ].some(matchesQuery);
    }

    if (activeTab === "cost-code") {
      return [item.code, item.sub_cost_code, item.name].some(matchesQuery);
    }

    const nameMatches = matchesQuery(item.name);
    const codeMatches = matchesQuery(item.code) || matchesQuery(item.item_code) || matchesQuery(item.cost_code);
    const customPidMatches = matchesQuery(item.party_id_custom);
    return nameMatches || codeMatches || customPidMatches;
  });

  const formatLibraryCell = (value: unknown) => {
    if (value === null || value === undefined || value === "") return "-";
    return String(value);
  };

  const formatDateCell = (value: unknown) => {
    if (value === null || value === undefined || value === "") return "-";
    const parsedDate = new Date(String(value));
    if (Number.isNaN(parsedDate.getTime()) || parsedDate.getFullYear() <= 1) return "-";
    return formatDate(parsedDate, "-");
  };

  const openNewItemDrawer = (tab?: LibraryType) => {
    const targetTab = tab || activeTab;
    setEditingId(null);
    if (targetTab === "party" || targetTab === "party-balances") {
      resetPartyForm();
      setIsPartyDrawerOpen(true);
    } else if (targetTab === "material") {
      setMatName("");
      setMatHsn("");
      setMatCode("");
      setMatSpecs("");
      setMatAltUnit("");
      setIsMaterialDrawerOpen(true);
    } else if (targetTab === "rate") {
      setRateName("");
      setRateCode("");
      setRateNote("");
      setRateCostCode("");
      setRateHsn("");
      setIsRateDrawerOpen(true);
    } else {
      setSimpleName("");
      setSimpleCode("");
      setSimpleSubCode("");
      setIsSimpleDrawerOpen(true);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <PageHeader
        title={`${TAB_TITLES[activeTab] || activeTab} Library`}
        subtitle="Manage global templates and codes shared across all project locations."
      >
        <button
          onClick={() => openNewItemDrawer()}
          className="px-3.5 py-1.5 bg-primary hover:bg-primary/95 text-white rounded-lg text-xs font-bold transition-all cursor-pointer"
        >
          {activeTab === "todo" ? "+ Add To Do" : "+ Add to Library"}
        </button>
      </PageHeader>

      <div className="flex-1 flex flex-col overflow-y-auto relative bg-background">
        <PageShell width="full">
        {/* Library sub-tab bar */}
        <div className="-mx-8 px-8 pt-4 pb-2 mb-6 border-b border-border-custom bg-card overflow-x-auto shrink-0">
          <SegmentedTabs
            tabs={[
              { id: "party", label: "Party Library", icon: <Icon name="group" className="w-3.5 h-3.5" /> },
              { id: "party-balances", label: "Party Balances", icon: <Icon name="payments" className="w-3.5 h-3.5" /> },
              { id: "asset-type", label: "Asset Type Library", icon: <Icon name="tractor" className="w-3.5 h-3.5" /> },
              { id: "cost-code", label: "Cost Code Library", icon: <Icon name="tag" className="w-3.5 h-3.5" /> },
              { id: "deduction", label: "Deduction Library", icon: <Icon name="minus" className="w-3.5 h-3.5" /> },
              { id: "progress", label: "Progress Library", icon: <Icon name="trending_up" className="w-3.5 h-3.5" /> },
              { id: "workforce", label: "Workforce Library", icon: <Icon name="worker" className="w-3.5 h-3.5" /> },
              { id: "material", label: "Material Library", icon: <Icon name="brick" className="w-3.5 h-3.5" /> },
              { id: "rate", label: "Rate Library", icon: <Icon name="money_wings" className="w-3.5 h-3.5" /> },
              { id: "retention", label: "Retention Library", icon: <Icon name="lock" className="w-3.5 h-3.5" /> },
              { id: "material-category", label: "Material Category Library", icon: <Icon name="folder" className="w-3.5 h-3.5" /> },
              { id: "todo", label: "To Do Library", icon: <Icon name="check_circle" className="w-3.5 h-3.5" /> },
            ]}
            activeTab={activeTab}
            onChange={(t) => {
              setActiveTab(t as LibraryType);
              setSearchQuery("");
            }}
          />
        </div>

        {/* Search & Filter Toolbar */}
        <div className="mb-6 shrink-0 flex items-center gap-3 flex-wrap">
          <div className="max-w-md flex-1 min-w-[200px]">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={activeTab === "todo" ? "Search To Do" : `Search ${activeTab.replace("-", " ")} items...`}
              className="input-field px-4 py-2 text-xs font-semibold focus:outline-none placeholder-muted w-full"
            />
          </div>
          {activeTab === "party" && (
            <select
              value={partyTypeFilter}
              onChange={(e) => setPartyTypeFilter(e.target.value)}
              className="input-field px-3 py-2 text-xs font-semibold bg-input border border-border-custom text-foreground rounded-md focus:outline-none"
              title="Filter by Party Type"
            >
              <option value="">All Party Types</option>
              {PARTY_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          )}
        </div>

        {/* Dynamic Tables Grid */}
        <div className="flex-1 overflow-auto rounded-md border border-border-custom bg-sidebar">
          {/* Party Library Table */}
          {activeTab === "party" && (
            <table className="min-w-[2200px] w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-border-custom text-muted font-semibold uppercase tracking-wider bg-background/50">
                  <th className="px-5 py-3">Party ID</th>
                  <th className="px-5 py-3">Party Name</th>
                  <th className="px-5 py-3">Party Type</th>
                  <th className="px-5 py-3">Bank Name</th>
                  <th className="px-5 py-3">Account Name</th>
                  <th className="px-5 py-3">Account Number</th>
                  <th className="px-5 py-3">IFSC Code</th>
                  <th className="px-5 py-3">Tax No.</th>
                  <th className="px-5 py-3">Billing Address</th>
                  <th className="px-5 py-3">Aadhaar Number</th>
                  <th className="px-5 py-3">PAN Card Number</th>
                  <th className="px-5 py-3">ESI Number</th>
                  <th className="px-5 py-3">PF Number</th>
                  <th className="px-5 py-3">Father Name</th>
                  <th className="px-5 py-3">Passport No.</th>
                  <th className="px-5 py-3">Passport Expiry Date</th>
                  <th className="px-5 py-3">Joining Date</th>
                  <th className="px-5 py-3">Created Date</th>
                  <th className="px-5 py-3">Creator Name</th>
                  <th className="px-6 py-4 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-custom">
                {filteredData.length === 0 ? (
                  <tr>
                    <td colSpan={20} className="p-8">
                      <EmptyState
                        title="No parties registered"
                        description="Add vendors, clients, contractors, and suppliers to your central party directory."
                        action={{
                          label: "Add Party",
                          onClick: () => openNewItemDrawer("party"),
                        }}
                      />
                    </td>
                  </tr>
                ) : (
                  filteredData.map((item) => (
                    <tr key={item.id} className="hover:bg-elevated/20 transition-colors border-b border-border-custom last:border-b-0">
                      <td className="px-6 py-4 text-muted font-bold whitespace-nowrap">{formatLibraryCell(item.party_id_custom)}</td>
                      <td className="px-6 py-4 font-semibold text-foreground whitespace-nowrap">{formatLibraryCell(item.name)}</td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        <span className="bg-elevated text-[10px] px-2 py-0.5 rounded font-bold uppercase tracking-wider text-muted">
                          {formatLibraryCell(item.party_type)}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-muted whitespace-nowrap">{formatLibraryCell(item.bank_name)}</td>
                      <td className="px-6 py-4 text-muted whitespace-nowrap">{formatLibraryCell(item.account_name)}</td>
                      <td className="px-6 py-4 text-muted font-sans whitespace-nowrap">{formatLibraryCell(item.account_number)}</td>
                      <td className="px-6 py-4 text-muted font-sans whitespace-nowrap">{formatLibraryCell(item.ifsc_code)}</td>
                      <td className="px-6 py-4 text-muted whitespace-nowrap">{formatLibraryCell(item.tax_no)}</td>
                      <td className="px-6 py-4 text-muted whitespace-nowrap">{formatLibraryCell(item.address)}</td>
                      <td className="px-6 py-4 text-muted font-sans whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <span>{revealedAadhaar[item.id] || maskAadhaar(item.aadhaar_number)}</span>
                          {item.aadhaar_number && (
                            <button
                              type="button"
                              onClick={() => handleRevealAadhaar(item.id)}
                              disabled={revealingAadhaarId === item.id}
                              className="text-[10px] text-primary hover:underline cursor-pointer font-medium"
                              title={revealedAadhaar[item.id] ? "Hide full number" : "Reveal full Aadhaar number"}
                            >
                              {revealingAadhaarId === item.id ? "…" : revealedAadhaar[item.id] ? "Hide" : "Reveal"}
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-muted font-sans whitespace-nowrap">{formatLibraryCell(item.pan_number)}</td>
                      <td className="px-6 py-4 text-muted font-sans whitespace-nowrap">{formatLibraryCell(item.esi_number)}</td>
                      <td className="px-6 py-4 text-muted font-sans whitespace-nowrap">{formatLibraryCell(item.pf_number)}</td>
                      <td className="px-6 py-4 text-muted whitespace-nowrap">{formatLibraryCell(item.father_name)}</td>
                      <td className="px-6 py-4 text-muted font-sans whitespace-nowrap">{formatLibraryCell(item.passport_no)}</td>
                      <td className="px-6 py-4 text-muted whitespace-nowrap">{formatDateCell(item.passport_expiry_date)}</td>
                      <td className="px-6 py-4 text-muted whitespace-nowrap">{formatDateCell(item.date_of_joining)}</td>
                      <td className="px-6 py-4 text-muted whitespace-nowrap">{formatDateCell(item.created_at)}</td>
                      <td className="px-6 py-4 text-muted whitespace-nowrap">{formatLibraryCell(item.creator_name)}</td>
                      <td className="px-6 py-4 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            onClick={() => handleEditParty(item)}
                            className="px-2.5 py-1 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-medium rounded transition-all cursor-pointer"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteItem(item.id)}
                            className="px-2.5 py-1 bg-elevated hover:bg-elevated/80 border border-border-custom text-foreground text-xs font-medium rounded transition-all cursor-pointer"
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}

          {/* Simple Tables (Asset Types, Deductions, Progresses, Retentions, Material Categories, Todos) */}
          {(activeTab === "asset-type" || activeTab === "deduction" || activeTab === "progress" || activeTab === "retention" || activeTab === "material-category" || activeTab === "todo") && (
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-border-custom text-muted font-semibold uppercase tracking-wider bg-background/50">
                  <th className="px-5 py-3">Name</th>
                  <th className="px-5 py-3">Created Date</th>
                  <th className="px-6 py-4 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-custom">
                {filteredData.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="p-8">
                      <EmptyState
                        title={`No ${activeTab === "todo" ? "to-dos" : activeTab === "asset-type" ? "asset types" : activeTab === "material-category" ? "material categories" : `${activeTab}s`} registered`}
                        description={
                          activeTab === "asset-type"
                            ? "Define equipment and asset categories to organize company assets."
                            : activeTab === "deduction"
                            ? "Configure standard deduction types applicable to subcontractor and client billing."
                            : activeTab === "progress"
                            ? "Set up milestone progress tracking categories for your projects."
                            : activeTab === "retention"
                            ? "Configure retention percentages and release conditions for contracts."
                            : activeTab === "material-category"
                            ? "Group materials into structured categories for streamlined procurement."
                            : "Create recurring checklist templates and task presets for project teams."
                        }
                        action={{
                          label: activeTab === "todo" ? "Add To Do" : activeTab === "material-category" ? "Add Category" : `Add ${TAB_TITLES[activeTab] || "Item"}`,
                          onClick: () => openNewItemDrawer(activeTab),
                        }}
                      />
                    </td>
                  </tr>
                ) : (
                  filteredData.map((item) => (
                    <tr key={item.id} className="hover:bg-elevated/20 transition-colors border-b border-border-custom last:border-b-0">
                      <td className="px-6 py-4 font-semibold text-foreground">{item.name}</td>
                      <td className="px-6 py-4 text-muted">
                        {formatDate(item.created_at)}
                      </td>
                      <td className="px-6 py-4 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            onClick={() => handleEditSimple(item)}
                            className="px-2.5 py-1 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-medium rounded transition-all cursor-pointer"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteItem(item.id)}
                            className="px-2.5 py-1 bg-elevated hover:bg-elevated/80 border border-border-custom text-foreground text-xs font-medium rounded transition-all cursor-pointer"
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}

          {/* Workforce Library Table */}
          {activeTab === "workforce" && (
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-border-custom text-muted font-semibold uppercase tracking-wider bg-background/50">
                  <th className="px-5 py-3">Workforce Name</th>
                  <th className="px-5 py-3">Cost Code</th>
                  <th className="px-5 py-3">Salary Per Shift</th>
                  <th className="px-5 py-3">Shift Hours</th>
                  <th className="px-6 py-4 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-custom">
                {filteredData.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-8">
                      <EmptyState
                        title="No workforces registered"
                        description="Add standard workforce categories, shift durations, and shift salary rates."
                        action={{
                          label: "Add Workforce",
                          onClick: () => openNewItemDrawer("workforce"),
                        }}
                      />
                    </td>
                  </tr>
                ) : (
                  filteredData.map((item) => (
                    <tr key={item.id} className="hover:bg-elevated/20 transition-colors border-b border-border-custom last:border-b-0">
                      <td className="px-6 py-4 font-semibold text-foreground">{formatLibraryCell(item.name)}</td>
                      <td className="px-6 py-4 text-muted">{formatLibraryCell(item.cost_code ?? item.costCode)}</td>
                      <td className="px-6 py-4 text-muted">{formatLibraryCell(item.salary_per_shift ?? item.salaryPerShift)}</td>
                      <td className="px-6 py-4 text-muted">{formatLibraryCell(item.shift_hours ?? item.shiftHours)}</td>
                      <td className="px-6 py-4 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            onClick={() => handleEditSimple(item)}
                            className="px-2.5 py-1 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-medium rounded transition-all cursor-pointer"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteItem(item.id)}
                            className="px-2.5 py-1 bg-elevated hover:bg-elevated/80 border border-border-custom text-foreground text-xs font-medium rounded transition-all cursor-pointer"
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}

          {activeTab === "cost-code" && (
            <table className="w-full min-w-[760px] text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-border-custom text-muted font-semibold uppercase tracking-wider bg-background/50">
                  <th className="px-5 py-3">Cost Code</th>
                  <th className="px-5 py-3">Sub Cost Code</th>
                  <th className="px-5 py-3">Description</th>
                  <th className="px-5 py-3">Created Date</th>
                  <th className="px-6 py-4 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-custom">
                {filteredData.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-8">
                      <EmptyState
                        title="No cost codes registered"
                        description="Add standard cost codes and sub cost codes to track project expenditures."
                        action={{
                          label: "Add Cost Code",
                          onClick: () => openNewItemDrawer("cost-code"),
                        }}
                      />
                    </td>
                  </tr>
                ) : (
                  filteredData.map((item) => (
                    <tr key={item.id} className="hover:bg-elevated/20 transition-colors border-b border-border-custom last:border-b-0">
                      <td className="px-6 py-4 text-primary font-semibold font-sans">{formatLibraryCell(item.code)}</td>
                      <td className="px-6 py-4 text-muted font-sans">{formatLibraryCell(item.sub_cost_code)}</td>
                      <td className="px-6 py-4 font-semibold text-foreground">{formatLibraryCell(item.name)}</td>
                      <td className="px-6 py-4 text-muted">{formatDateCell(item.created_at)}</td>
                      <td className="px-6 py-4 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            onClick={() => handleEditSimple(item)}
                            className="px-2.5 py-1 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-medium rounded transition-all cursor-pointer"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteItem(item.id)}
                            className="px-2.5 py-1 bg-elevated hover:bg-elevated/80 border border-border-custom text-foreground text-xs font-medium rounded transition-all cursor-pointer"
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}

          {/* Material Library Table */}
          {activeTab === "material" && (
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-border-custom text-muted font-semibold uppercase tracking-wider bg-background/50">
                  <th className="px-5 py-3">Item Code</th>
                  <th className="px-5 py-3">Material Name</th>
                  <th className="px-5 py-3">Specifications</th>
                  <th className="px-5 py-3">Unit</th>
                  <th className="px-5 py-3">Alternate UOM</th>
                  <th className="px-5 py-3">Material Category</th>
                  <th className="px-5 py-3">HSN/SAC</th>
                  <th className="px-5 py-3 text-right">GST %</th>
                  <th className="px-5 py-3 text-right">Std. Cost</th>
                  <th className="px-5 py-3 text-right">Lead Time</th>
                  <th className="px-5 py-3">Created Date</th>
                  <th className="px-5 py-3">Creator Name</th>
                  <th className="px-6 py-4 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-custom">
                {filteredData.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="p-8">
                      <EmptyState
                        title="No materials registered"
                        description="Add standard materials with units, categories, and HSN codes to your central library."
                        action={{
                          label: "Add Material",
                          onClick: () => setIsMaterialDrawerOpen(true),
                        }}
                      />
                    </td>
                  </tr>
                ) : (
                  filteredData.map((item) => (
                    <tr key={item.id} className="hover:bg-elevated/20 transition-colors border-b border-border-custom last:border-b-0">
                      <td className="px-6 py-4 text-muted font-sans">{formatLibraryCell(item.item_code)}</td>
                      <td className="px-6 py-4 font-semibold text-foreground">{formatLibraryCell(item.name)}</td>
                      <td className="px-6 py-4 text-muted">{formatLibraryCell(item.specifications)}</td>
                      <td className="px-6 py-4 text-muted">{formatLibraryCell(item.unit)}</td>
                      <td className="px-6 py-4 text-muted">{formatLibraryCell(item.alternate_unit)}</td>
                      <td className="px-6 py-4 text-muted">{formatLibraryCell(item.category)}</td>
                      <td className="px-6 py-4 text-muted">{formatLibraryCell(item.hsn_sac)}</td>
                      <td className="px-6 py-4 text-muted text-right">
                        {item.gst_rate != null ? `${item.gst_rate}%` : "-"}
                      </td>
                      <td className="px-6 py-4 text-muted text-right">
                        {item.unit_cost != null ? fmtINR(Number(item.unit_cost)) : "-"}
                      </td>
                      <td className="px-6 py-4 text-muted text-right">
                        {item.lead_time_days != null ? `${item.lead_time_days}d` : "-"}
                      </td>
                      <td className="px-6 py-4 text-muted">
                        {formatDate(item.created_at, "-")}
                      </td>
                      <td className="px-6 py-4 text-muted">{formatLibraryCell(item.creator_name)}</td>
                      <td className="px-6 py-4 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            onClick={() => handleEditMaterial(item)}
                            className="px-2.5 py-1 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-medium rounded transition-all cursor-pointer"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteItem(item.id)}
                            className="px-2.5 py-1 bg-elevated hover:bg-elevated/80 border border-border-custom text-foreground text-xs font-medium rounded transition-all cursor-pointer"
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}

          {/* Rate Library Table */}
          {activeTab === "rate" && (
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-border-custom text-muted font-semibold uppercase tracking-wider bg-background/50">
                  <th className="px-5 py-3">Description</th>
                  <th className="px-5 py-3">Item Code</th>
                  <th className="px-5 py-3">Cost Code</th>
                  <th className="px-5 py-3">Unit</th>
                  <th className="px-5 py-3">Components</th>
                  <th className="px-5 py-3 text-right">Unit Cost Price</th>
                  <th className="px-5 py-3 text-right">Markup Amount</th>
                  <th className="px-5 py-3 text-right">Markup %</th>
                  <th className="px-5 py-3 text-right">Selling Price</th>
                  <th className="px-5 py-3">Created Date</th>
                  <th className="px-5 py-3">HSN/SAC</th>
                  <th className="px-6 py-4 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-custom">
                {filteredData.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="p-8">
                      <EmptyState
                        title="No rate card items found"
                        description="Build your central rate card library with standardized rates, units, and markup configurations."
                        action={{
                          label: "Add Item",
                          onClick: () => setIsRateDrawerOpen(true),
                        }}
                      />
                    </td>
                  </tr>
                ) : (
                  filteredData.map((item) => {
                    const hasMarkupValue = item.markup_value !== null && item.markup_value !== undefined && item.markup_value !== "";
                    return (
                      <tr key={item.id} className="hover:bg-elevated/20 transition-colors border-b border-border-custom last:border-b-0">
                        <td className="px-6 py-4 font-semibold text-foreground">{formatLibraryCell(item.name)}</td>
                        <td className="px-6 py-4 text-muted font-sans">{formatLibraryCell(item.item_code)}</td>
                        <td className="px-6 py-4 text-muted">{formatLibraryCell(item.cost_code)}</td>
                        <td className="px-6 py-4 text-muted">{formatLibraryCell(item.unit)}</td>
                        <td className="px-6 py-4 text-muted">{formatLibraryCell(item.components)}</td>
                        <td className="px-6 py-4 text-right text-muted font-semibold">
                          {item.unit_cost === null || item.unit_cost === undefined || item.unit_cost === ""
                            ? "-"
                            : floatVal(item.unit_cost).toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                        </td>
                        <td className="px-6 py-4 text-right text-muted">
                          {hasMarkupValue ? floatVal(item.markup_value).toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "-"}
                        </td>
                        <td className="px-6 py-4 text-right text-muted">{formatLibraryCell(item.markup_type)}</td>
                        <td className="px-6 py-4 text-right text-sm font-bold text-success">
                          {item.unit_sale_price === null || item.unit_sale_price === undefined || item.unit_sale_price === ""
                            ? "-"
                            : floatVal(item.unit_sale_price).toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                        </td>
                        <td className="px-6 py-4 text-muted">
                          {formatDate(item.created_at, "-")}
                        </td>
                        <td className="px-6 py-4 text-muted">{formatLibraryCell(item.hsn_sac)}</td>
                        <td className="px-6 py-4 text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              onClick={() => handleEditRate(item)}
                              className="px-2.5 py-1 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 text-xs font-medium rounded transition-all cursor-pointer"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => handleDeleteItem(item.id)}
                              className="px-2.5 py-1 bg-elevated hover:bg-elevated/80 border border-border-custom text-foreground text-xs font-medium rounded transition-all cursor-pointer"
                            >
                              Remove
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          )}

          {/* Party Balances Table */}
          {activeTab === "party-balances" && (
            <div className="space-y-4">
              {partyBalancesSummary && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 bg-card border-b border-border-custom">
                  <div className="p-3 bg-elevated rounded-md border border-border-custom">
                    <span className="text-[10px] uppercase font-bold text-muted block">Total Advance Paid</span>
                    <span className="text-sm font-bold text-foreground font-sans">₹{partyBalancesSummary.advance_paid.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                  </div>
                  <div className="p-3 bg-elevated rounded-md border border-border-custom">
                    <span className="text-[10px] uppercase font-bold text-muted block">Total To Pay</span>
                    <span className="text-sm font-bold text-foreground font-sans">₹{partyBalancesSummary.to_pay.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                  </div>
                </div>
              )}
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-border-custom text-muted font-semibold uppercase tracking-wider bg-background/50">
                    <th className="px-5 py-3">Party Name</th>
                    <th className="px-5 py-3">Party Type</th>
                    <th className="px-5 py-3 text-right">Opening Balance</th>
                    <th className="px-5 py-3">Balance Direction</th>
                    <th className="px-5 py-3">Contact</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-custom">
                  {filteredData.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="p-8">
                        <EmptyState
                          title="No party balances recorded"
                          description="Track advance payments and pending balances across all registered parties."
                          action={{
                            label: "Add Party",
                            onClick: () => openNewItemDrawer("party"),
                          }}
                        />
                      </td>
                    </tr>
                  ) : (
                    filteredData.map((item) => (
                      <tr key={item.id} className="hover:bg-elevated/20 transition-colors border-b border-border-custom last:border-b-0">
                        <td className="px-6 py-4 font-semibold text-foreground">{item.name}</td>
                        <td className="px-5 py-3">
                          <span className="bg-elevated text-[10px] px-2 py-0.5 rounded font-bold uppercase tracking-wider text-muted">
                            {item.party_type || "Party"}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right font-bold text-foreground font-sans">
                          ₹{(item.opening_balance || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                        </td>
                        <td className="px-5 py-3">
                          <Badge
                            tone={item.opening_balance_type === "pay" || item.opening_balance_direction === "will_pay" ? "warning" : "info"}
                            className="text-[10px]"
                          >
                            {item.opening_balance_type === "pay" || item.opening_balance_direction === "will_pay" ? "Will Pay" : "Will Receive"}
                          </Badge>
                        </td>
                        <td className="px-6 py-4 text-muted">
                          {item.phone || item.email || "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
        </PageShell>
      </div>

      {/* Reusable Simple Item Add Modal */}
      {isSimpleDrawerOpen && (
        <div className="fixed inset-0 bg-background/80 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-md bg-card border border-border-custom rounded-lg overflow-hidden shadow-lg animate-in fade-in zoom-in-95 duration-150">
            <div className="p-6 border-b border-border-custom flex justify-between items-center">
              <h3 className="text-xs font-semibold text-foreground uppercase tracking-wider">{editingId ? `Edit ${activeTab.replace("-", " ")}` : (activeTab === "todo" ? "Add To Do" : `Add ${activeTab.replace("-", " ")}`)}</h3>
              <button onClick={() => setIsSimpleDrawerOpen(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>

            <form onSubmit={handleCreateSimple} className="p-6 space-y-4">
              {activeTab === "cost-code" && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Cost Code *</label>
                  <input
                    type="text"
                    required
                    value={simpleCode}
                    onChange={(e) => setSimpleCode(e.target.value)}
                    placeholder="e.g. CC-101"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none font-sans"
                  />
                </div>
              )}

              {activeTab === "cost-code" && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Sub Cost Code</label>
                  <input
                    type="text"
                    value={simpleSubCode}
                    onChange={(e) => setSimpleSubCode(e.target.value)}
                    placeholder="e.g. SCC-101"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none font-sans"
                  />
                </div>
              )}

              {activeTab === "workforce" && (
                <>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Cost Code</label>
                    <input
                      type="text"
                      value={wfCostCode}
                      onChange={(e) => setWfCostCode(e.target.value)}
                      placeholder="e.g. LAB-01"
                      className="input-field w-full px-3 py-2 text-xs focus:outline-none font-sans"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Salary Per Shift (₹)</label>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={wfSalary}
                        onChange={(e) => setWfSalary(e.target.value)}
                        placeholder="e.g. 850"
                        className="input-field w-full px-3 py-2 text-xs focus:outline-none font-sans"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Shift Hours</label>
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={wfShiftHours}
                        onChange={(e) => setWfShiftHours(e.target.value)}
                        placeholder="e.g. 8"
                        className="input-field w-full px-3 py-2 text-xs focus:outline-none font-sans"
                      />
                    </div>
                  </div>
                </>
              )}

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">{activeTab === "workforce" ? "Workforce Category Name *" : "Item Description / Name *"}</label>
                <input
                  type="text"
                  required
                  value={simpleName}
                  onChange={(e) => setSimpleName(e.target.value)}
                  placeholder={activeTab === "workforce" ? "e.g. Mason / Carpenter" : "e.g. Earthworks excavation"}
                  className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                />
              </div>

              <button
                type="submit"
                className="w-full py-2 bg-primary hover:bg-primary-hover text-white font-medium rounded-md text-sm transition-all mt-4 cursor-pointer"
              >
                Create Item
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Add Party Drawer Modal */}
      {isPartyDrawerOpen && (
        <div className="fixed inset-0 bg-background/80 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-md bg-card border border-border-custom rounded-lg overflow-hidden shadow-lg animate-in fade-in zoom-in-95 duration-150">
            <div className="p-6 border-b border-border-custom flex justify-between items-center">
              <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">{editingId ? "Edit Library Party" : "Register Library Party"}</h3>
              <button onClick={() => setIsPartyDrawerOpen(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>

            <form onSubmit={handleCreateParty} className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-1 md:col-span-2">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Party Name *</label>
                  <input
                    type="text"
                    required
                    value={partyName}
                    onChange={(e) => setPartyName(e.target.value)}
                    placeholder="e.g. Sai Steel Traders"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Party Type</label>
                  <select
                    value={partyType}
                    onChange={(e) => setPartyType(e.target.value)}
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  >
                    {/* Must match the filter above. The create form offered three
                        of the seven values the filter can select, so Contractor,
                        Material Supplier, Equipment Supplier and Labour Contractor
                        were filter options nothing could ever match. */}
                    {PARTY_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Phone</label>
                  <input
                    type="tel"
                    value={partyPhone}
                    onChange={(e) => setPartyPhone(e.target.value)}
                    placeholder="9876543210"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>

                <div className="space-y-1 md:col-span-2">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Email Address</label>
                  <input
                    type="email"
                    value={partyEmail}
                    onChange={(e) => setPartyEmail(e.target.value)}
                    placeholder="vendor@siteflow.co"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>

                <div className="space-y-1 md:col-span-2">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Billing Address</label>
                  <textarea
                    value={partyAddress}
                    onChange={(e) => setPartyAddress(e.target.value)}
                    placeholder="Commercial Market Sector 12"
                    rows={2}
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none resize-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Joining Date</label>
                  <input
                    type="date"
                    value={partyJoiningDate}
                    onChange={(e) => setPartyJoiningDate(e.target.value)}
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Creator Name</label>
                  <input
                    type="text"
                    value={getStoredCreatorName()}
                    readOnly
                    placeholder="Auto-filled from login"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none bg-elevated/50"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Bank Name</label>
                  <input
                    type="text"
                    value={partyBankName}
                    onChange={(e) => setPartyBankName(e.target.value)}
                    placeholder="Bank of India"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Account Name</label>
                  <input
                    type="text"
                    value={partyAccountName}
                    onChange={(e) => setPartyAccountName(e.target.value)}
                    placeholder="Sai Steel Traders"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Account Number</label>
                  <input
                    type="text"
                    value={partyAccountNumber}
                    onChange={(e) => setPartyAccountNumber(e.target.value)}
                    placeholder="012345678901"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">IFSC Code</label>
                  <input
                    type="text"
                    value={partyIfscCode}
                    onChange={(e) => setPartyIfscCode(e.target.value)}
                    placeholder="SBIN0001234"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Tax No.</label>
                  <input
                    type="text"
                    value={partyTaxNo}
                    onChange={(e) => setPartyTaxNo(e.target.value)}
                    placeholder="GST / tax number"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Aadhaar Number</label>
                  <input
                    type="text"
                    value={partyAadhaar}
                    onChange={(e) => setPartyAadhaar(e.target.value)}
                    placeholder="12-digit number"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">PAN Card Number</label>
                  <input
                    type="text"
                    value={partyPan}
                    onChange={(e) => setPartyPan(e.target.value)}
                    placeholder="PAN card"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">ESI Number</label>
                  <input
                    type="text"
                    value={partyEsiNumber}
                    onChange={(e) => setPartyEsiNumber(e.target.value)}
                    placeholder="ESI number"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">PF Number</label>
                  <input
                    type="text"
                    value={partyPfNumber}
                    onChange={(e) => setPartyPfNumber(e.target.value)}
                    placeholder="PF number"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Father Name</label>
                  <input
                    type="text"
                    value={partyFatherName}
                    onChange={(e) => setPartyFatherName(e.target.value)}
                    placeholder="Father's full name"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Passport No.</label>
                  <input
                    type="text"
                    value={partyPassportNo}
                    onChange={(e) => setPartyPassportNo(e.target.value)}
                    placeholder="Passport number"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Passport Expiry Date</label>
                  <input
                    type="date"
                    value={partyPassportExpiryDate}
                    onChange={(e) => setPartyPassportExpiryDate(e.target.value)}
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>
              </div>

              <div className="rounded-lg border border-border-custom bg-elevated/40 p-4 space-y-3">
                <div className="text-xs font-semibold text-foreground uppercase tracking-wider">KYC Identity Documents</div>
                <p className="text-[11px] text-muted">Upload verified PAN and Aadhaar identity documents (JPEG, PNG, or PDF up to 5 MB). Documents are securely stored in private storage and accessed only via short-lived signed links.</p>

                {kycError && (
                  <div className="text-xs text-danger bg-danger/10 border border-danger/20 rounded p-2">
                    {kycError}
                  </div>
                )}

                {!editingId ? (
                  <p className="text-[11px] text-muted italic">Save/register this party first to enable secure document attachments.</p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                    {/* Aadhaar File */}
                    <div className="bg-card border border-border-custom rounded-lg p-3 space-y-2">
                      <div className="text-xs font-medium text-foreground">Aadhaar Document</div>
                      {partyAadhaarFile ? (
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] text-success font-medium">✓ Uploaded</span>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleViewKyc("aadhaar_file")}
                              className="text-[11px] text-primary hover:underline font-medium cursor-pointer"
                            >
                              View
                            </button>
                            <span className="text-muted text-xs">·</span>
                            <button
                              type="button"
                              onClick={() => handleDeleteKyc("aadhaar_file")}
                              className="text-[11px] text-danger hover:underline cursor-pointer"
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <label className="inline-block text-xs font-medium text-primary hover:underline cursor-pointer">
                            {uploadingKyc === "aadhaar_file" ? "Uploading…" : "Upload Aadhaar (PDF/Image)"}
                            <input
                              type="file"
                              accept="image/jpeg,image/png,application/pdf"
                              disabled={uploadingKyc === "aadhaar_file"}
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) handleUploadKyc("aadhaar_file", f);
                              }}
                              className="hidden"
                            />
                          </label>
                        </div>
                      )}
                    </div>

                    {/* PAN File */}
                    <div className="bg-card border border-border-custom rounded-lg p-3 space-y-2">
                      <div className="text-xs font-medium text-foreground">PAN Document</div>
                      {partyPanFile ? (
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] text-success font-medium">✓ Uploaded</span>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleViewKyc("pan_file")}
                              className="text-[11px] text-primary hover:underline font-medium cursor-pointer"
                            >
                              View
                            </button>
                            <span className="text-muted text-xs">·</span>
                            <button
                              type="button"
                              onClick={() => handleDeleteKyc("pan_file")}
                              className="text-[11px] text-danger hover:underline cursor-pointer"
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <label className="inline-block text-xs font-medium text-primary hover:underline cursor-pointer">
                            {uploadingKyc === "pan_file" ? "Uploading…" : "Upload PAN (PDF/Image)"}
                            <input
                              type="file"
                              accept="image/jpeg,image/png,application/pdf"
                              disabled={uploadingKyc === "pan_file"}
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) handleUploadKyc("pan_file", f);
                              }}
                              className="hidden"
                            />
                          </label>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <button
                type="submit"
                className="w-full py-2 bg-primary hover:bg-primary-hover text-white font-medium rounded-md text-sm transition-all mt-2 cursor-pointer"
              >
                {editingId ? "Update Party" : "Register Party"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Add Material Drawer Modal */}
      {isMaterialDrawerOpen && (
        <div className="fixed inset-0 bg-background/80 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-md bg-card border border-border-custom rounded-lg overflow-hidden shadow-lg animate-in fade-in zoom-in-95 duration-150">
            <div className="p-6 border-b border-border-custom flex justify-between items-center">
              <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">{editingId ? "Edit Material Item" : "New Material Item"}</h3>
              <button onClick={() => setIsMaterialDrawerOpen(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>

            <form onSubmit={handleCreateMaterial} className="p-6 space-y-3.5 max-h-[500px] overflow-y-auto">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Material Name *</label>
                <input
                  type="text"
                  required
                  value={matName}
                  onChange={(e) => setMatName(e.target.value)}
                  placeholder="e.g. Portland Cement (53 grade)"
                  className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Unit (UOM)</label>
                  <select
                    required
                    value={matUnit}
                    onChange={(e) => setMatUnit(e.target.value)}
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  >
                    <option value="">— Select unit —</option>
                    {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  {/* matAltUnit was in state and in the submit payload, and the
                      table has an Alternate UOM column, but there was no input
                      anywhere so the column could only ever read "-". */}
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Alternate UOM</label>
                  <select
                    value={matAltUnit}
                    onChange={(e) => setMatAltUnit(e.target.value)}
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  >
                    <option value="">— None —</option>
                    {UNITS.filter((u) => u !== matUnit).map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">GST Rate (%)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={matGst}
                    onChange={(e) => setMatGst(Number(e.target.value))}
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Standard Cost Price</label>
                  <input
                    type="number"
                    step="0.01"
                    value={matCost}
                    onChange={(e) => setMatCost(Number(e.target.value))}
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Lead Time (days)</label>
                  <input
                    type="number"
                    value={matLeadTime}
                    onChange={(e) => setMatLeadTime(Number(e.target.value))}
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">HSN/SAC Code</label>
                  <input
                    type="text"
                    value={matHsn}
                    onChange={(e) => setMatHsn(e.target.value)}
                    placeholder="e.g. 2523"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Item Code</label>
                  <input
                    type="text"
                    value={matCode}
                    onChange={(e) => setMatCode(e.target.value)}
                    placeholder="e.g. MAT-CEM"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Category / Group</label>
                <input
                  type="text"
                  value={matCategory}
                  onChange={(e) => setMatCategory(e.target.value)}
                  placeholder="e.g. Concrete Materials"
                  className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Specifications</label>
                <textarea
                  value={matSpecs}
                  onChange={(e) => setMatSpecs(e.target.value)}
                  placeholder="Compressive strength > 53 MPa after 28 days."
                  rows={2}
                  className="input-field w-full px-3 py-2 text-xs focus:outline-none resize-none"
                />
              </div>

              <button
                type="submit"
                className="w-full py-2 bg-primary hover:bg-primary-hover text-white font-medium rounded-md text-sm transition-all mt-2 cursor-pointer"
              >
                {editingId ? "Update Material" : "Save Material"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Add Rate Card Drawer Modal */}
      {isRateDrawerOpen && (
        <div className="fixed inset-0 bg-background/80 flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-md bg-card border border-border-custom rounded-lg overflow-hidden shadow-lg animate-in fade-in zoom-in-95 duration-150">
            <div className="p-6 border-b border-border-custom flex justify-between items-center">
              <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">{editingId ? "Edit Rate Card Item" : "New Rate Card Item"}</h3>
              <button onClick={() => setIsRateDrawerOpen(false)} className="text-muted hover:text-foreground cursor-pointer"><Icon name="close" className="w-5 h-5" /></button>
            </div>

            <form onSubmit={handleCreateRate} className="p-6 space-y-3.5 max-h-[500px] overflow-y-auto">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Item Name *</label>
                <input
                  type="text"
                  required
                  value={rateName}
                  onChange={(e) => setRateName(e.target.value)}
                  placeholder="e.g. Foundation Excavation Rate"
                  className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Item Code</label>
                  <input
                    type="text"
                    value={rateCode}
                    onChange={(e) => setRateCode(e.target.value)}
                    placeholder="e.g. RAT-EXC"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Unit (UOM)</label>
                  <select
                    required
                    value={rateUnit}
                    onChange={(e) => setRateUnit(e.target.value)}
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  >
                    <option value="">— Select unit —</option>
                    {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">GST Rate (%)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={rateGst}
                    onChange={(e) => setRateGst(Number(e.target.value))}
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Category</label>
                  <input
                    type="text"
                    value={rateCategory}
                    onChange={(e) => setRateCategory(e.target.value)}
                    placeholder="Excavation"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 border-t border-border-custom pt-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Unit Cost</label>
                  <input
                    type="number"
                    step="0.01"
                    value={rateCost}
                    onChange={(e) => setRateCost(Number(e.target.value))}
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Markup</label>
                  <input
                    type="number"
                    step="0.01"
                    value={rateMarkup}
                    onChange={(e) => setRateMarkup(Number(e.target.value))}
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Markup Type</label>
                  <select
                    value={rateMarkupType}
                    onChange={(e) => setRateMarkupType(e.target.value)}
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  >
                    <option value="percent">%</option>
                    <option value="flat">Flat</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-[10px] font-bold text-muted uppercase tracking-widest">
                  <span>Computed Sale Price</span>
                  <span className="text-success font-semibold">₹{rateSalePrice}</span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-border-custom pt-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">Cost Code Reference</label>
                  <input
                    type="text"
                    value={rateCostCode}
                    onChange={(e) => setRateCostCode(e.target.value)}
                    placeholder="e.g. CC-101"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted uppercase tracking-wider block mb-1.5">HSN/SAC Code</label>
                  <input
                    type="text"
                    value={rateHsn}
                    onChange={(e) => setRateHsn(e.target.value)}
                    placeholder="e.g. 9954"
                    className="input-field w-full px-3 py-2 text-xs focus:outline-none"
                  />
                </div>
              </div>

              <button
                type="submit"
                className="w-full py-2 bg-primary hover:bg-primary-hover text-white font-medium rounded-md text-sm transition-all mt-2 cursor-pointer"
              >
                {editingId ? "Update Rate Card Item" : "Save Rate Card Item"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Toast Alert */}
      {toastMessage && (
        <div className="absolute bottom-6 right-6 bg-card border border-success/30 rounded-md px-4 py-3 text-xs text-success shadow-2xl z-50 inline-flex items-center gap-1.5">
          <Icon name="bolt" className="w-3.5 h-3.5" />
          <span className="font-semibold">{toastMessage}</span>
        </div>
      )}
    </div>
  );
}

// Helper to coerce string columns to floats safely
function floatVal(val: any): number {
  if (val === undefined || val === null) return 0;
  return typeof val === "number" ? val : parseFloat(val) || 0;
}