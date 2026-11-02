"use client";

import React, { useState, useEffect } from "react";
import { getApiHost, detailToMessage} from "@/lib/api";
import { authHeaders } from "@/lib/siteflow";
import Icon from "@/components/marketing/Icon";

const SEGMENTS = [
  "Building Construction",
  "Developer",
  "Industrial Construction",
  "Infrastructure / Heavy Civil Construction",
  "Interiors and Fit-Out",
  "PWD",
  "Specialized / MEP Trades",
];

const DEVELOPER_CATEGORIES = [
  "Residential Real Estate",
  "Commercial Real Estate",
  "Industrial Real Estate",
  "Mixed-Use Development",
  "Land Development",
];

export default function OnboardingPage() {
  const [companyName, setCompanyName] = useState("");
  const [city, setCity] = useState("");
  // Nothing is ticked for the user: a contractor left on a preset "Developer"
  // ended up labelled as one.
  const [selectedSegments, setSelectedSegments] = useState<string[]>([]);
  const [developerCategories, setDeveloperCategories] = useState<string[]>([]);
  const [isCategoryDropdownOpen, setIsCategoryDropdownOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const accessToken = typeof window !== "undefined" ? localStorage.getItem("access_token") : "";
  const companyId =
    typeof window !== "undefined" ? localStorage.getItem("company_id") : null;

  useEffect(() => {
    // D-V1: without a real company id there is no tenant context; a stale demo
    // id is equally unusable. Both bounce to /login.
    if (!companyId || companyId === "e0000000-0000-0000-0000-000000000000") {
      window.location.replace("/login");
    }
  }, [companyId]);

  useEffect(() => {
    const fetchCompany = async () => {
      if (!accessToken || !companyId) return;
      try {
        const apiHost = getApiHost();
        const res = await fetch(`${apiHost}/apis/v3/settings/company/${companyId}`, {
          headers: { ...(authHeaders() || {}) },
        });
        if (res.ok) {
          const data = await res.json();
          if (data.name) {
            setCompanyName(data.name);
          }
          // The city typed on the create-company step carries over.
          if (data.onboarding_city) {
            setCity((current) => current || data.onboarding_city);
          }
        }
      } catch {
        /* ignore */
      }
    };
    fetchCompany();
  }, [accessToken, companyId]);

  const handleToggleSegment = (seg: string) => {
    if (selectedSegments.includes(seg)) {
      setSelectedSegments(selectedSegments.filter((s) => s !== seg));
    } else {
      setSelectedSegments([...selectedSegments, seg]);
    }
  };

  const handleAddCategory = (cat: string) => {
    if (!developerCategories.includes(cat)) {
      setDeveloperCategories([...developerCategories, cat]);
    }
    setIsCategoryDropdownOpen(false);
  };

  const handleRemoveCategory = (cat: string) => {
    setDeveloperCategories(developerCategories.filter((c) => c !== cat));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyName.trim()) {
      setError("Company Name is required.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const apiHost = getApiHost();
      const response = await fetch(`${apiHost}/apis/v3/profile/onboarding`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authHeaders() || {}),
        },
        body: JSON.stringify({
          company_id: companyId,
          company_name: companyName,
          city: city,
          segment: selectedSegments.join(", "),
          categories: selectedSegments.includes("Developer")
            ? developerCategories.join(", ")
            : "",
        }),
      });

      const data = await response.json();
      if (response.ok && data.success) {
        window.location.href = `/c/${companyId}/reports`;
      } else {
        setError(detailToMessage(data.detail, "Onboarding failed. Please try again."));
      }
    } catch {
      setError("Verification failed. Could not connect to API server.");
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    "w-full px-4 py-3 text-sm rounded-md bg-alx-surface-container-lowest border border-alx-outline-variant/40 text-alx-on-surface placeholder-alx-on-surface-variant/60 focus:outline-none focus:border-alx-primary transition-colors motion-reduce:transition-none";

  const labelClass =
    "text-xs font-semibold text-alx-on-surface-variant uppercase tracking-wider block mb-1.5";

  const SUBMIT_CLASS =
    "w-full alx-bg-gradient-primary text-alx-on-primary py-3.5 px-6 rounded-md font-semibold text-sm shadow-md shadow-alx-primary/25 hover:shadow-lg hover:shadow-alx-primary/40 hover:-translate-y-0.5 transition-all motion-reduce:transition-none cursor-pointer disabled:opacity-50 inline-flex items-center justify-center relative overflow-hidden group";

  const SUBMIT_SHIMMER = (
    <div className="absolute inset-0 alx-shimmer opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
  );

  return (
    <div className="flex min-h-screen w-full bg-alx-surface-container-lowest text-alx-on-surface">
      {/* Brand panel */}
      <div className="relative hidden w-2/5 flex-col justify-between overflow-hidden alx-baby-blue-wash p-12 lg:flex border-r border-sky-200">
        <div className="alx-grain absolute inset-0 z-0 opacity-40" />

        <div className="flex items-center gap-2 z-10">
          <Icon name="architecture" className="w-8 h-8 text-sky-600" />
          <span className="text-xl font-bold tracking-tight">
            <span className="text-sky-950">Site</span>
            <span className="text-sky-500">Flow</span>
          </span>
        </div>

        <div className="z-10 max-w-md space-y-8 mt-auto">
          <div className="space-y-4">
            <h1 className="font-headline text-3xl font-extrabold leading-tight text-sky-950">
              Personalize your SiteFlow workspace.
            </h1>
            <p className="text-sm leading-relaxed text-sky-900/80">
              Tell us what kind of work your company does. You can change this any time in Settings.
            </p>
          </div>

          <ul className="space-y-2.5">
            {[
              "Attendance, payroll, PF and ESI for your staff",
              "RA bills for subcontractors and clients",
              "Daily progress reports from every site, with photos",
            ].map((point) => (
              <li key={point} className="flex items-center gap-3 text-sm text-sky-900/90">
                <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-sky-100 ring-1 ring-sky-200">
                  <svg
                    className="h-3 w-3 text-sky-600"
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={3}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m5 10.5 3.5 3.5 7-8" />
                  </svg>
                </span>
                {point}
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex w-full flex-col justify-center items-center p-5 sm:p-8 lg:w-3/5 bg-alx-surface-container-lowest relative overflow-hidden overflow-y-auto">
        <div className="absolute top-[-10%] right-[-10%] h-[40%] w-[40%] rounded-full bg-alx-primary/5 blur-[100px]" />
        <div className="w-full max-w-xl space-y-6 sm:space-y-7 z-10 py-4 sm:py-6">
          <div className="space-y-2 text-center">
            <h2 className="font-headline text-3xl sm:text-4xl font-bold tracking-tight text-alx-on-surface">Company Profile</h2>
            <p className="text-alx-on-surface-variant text-sm leading-relaxed">
              Pick the kind of work you do. This is a label on your company profile and can be changed later.
            </p>
          </div>

          {/* Steps Progress */}
          <div className="flex justify-center gap-3 text-xs">
            <div className="flex items-center gap-2 bg-alx-surface-container-low px-3.5 py-1.5 rounded-full border border-alx-outline-variant/30 text-alx-on-surface-variant">
              <span className="h-4 w-4 bg-emerald-500/20 text-emerald-600 rounded-full flex items-center justify-center font-bold text-[10px]">
                ✓
              </span>
              <span className="font-medium">User Profile</span>
            </div>
            <div className="flex items-center gap-2 bg-sky-500/10 px-3.5 py-1.5 rounded-full border border-sky-300/60 text-sky-950 font-semibold">
              <span className="h-4 w-4 bg-sky-600 text-white rounded-full flex items-center justify-center font-bold text-[10px]">
                2
              </span>
              <span>Segment Details</span>
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3.5 text-sm text-red-600 text-center">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Company Name */}
            <div className="space-y-2">
              <label className={labelClass}>Company Name *</label>
              <input
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="Enter Company Name"
                required
                disabled={loading}
                className={inputClass}
              />
            </div>

            {/* Company City */}
            <div className="space-y-2">
              <label className={labelClass}>Company City *</label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="e.g. Navi Mumbai"
                required
                disabled={loading}
                className={inputClass}
              />
            </div>

            {/* Segment Selector */}
            <div className="space-y-2">
              <label className={labelClass}>Construction Segment(s)</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {SEGMENTS.map((seg) => {
                  const isChecked = selectedSegments.includes(seg);
                  return (
                    <button
                      key={seg}
                      type="button"
                      onClick={() => handleToggleSegment(seg)}
                      className={`flex items-center gap-3 px-3.5 py-2.5 rounded-md border text-left text-xs font-semibold transition-all motion-reduce:transition-none cursor-pointer ${
                        isChecked
                          ? "alx-bg-gradient-primary text-alx-on-primary border-transparent shadow-sm shadow-alx-primary/30"
                          : "bg-alx-surface-container-low text-alx-on-surface-variant hover:text-alx-on-surface hover:bg-alx-surface-container border-alx-outline-variant/40"
                      }`}
                    >
                      <span
                        className={`h-4 w-4 rounded flex items-center justify-center text-[10px] border ${
                          isChecked
                            ? "bg-white/30 border-white/50 text-white font-bold"
                            : "border-alx-outline-variant/60"
                        }`}
                      >
                        {isChecked && "✓"}
                      </span>
                      <span>{seg}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Developer Categories Select Dropdown */}
            {selectedSegments.includes("Developer") && (
              <div className="space-y-3 border-t border-alx-outline-variant/30 pt-4">
                <label className={labelClass}>Developer Categories</label>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setIsCategoryDropdownOpen(!isCategoryDropdownOpen)}
                    className="w-full flex justify-between items-center bg-alx-surface-container-lowest border border-alx-outline-variant/40 rounded-md px-4 py-3 text-xs text-alx-on-surface font-semibold hover:border-alx-primary transition-colors cursor-pointer"
                  >
                    <span>Select developer category...</span>
                    <span className="text-[10px] opacity-60">v</span>
                  </button>
                  {isCategoryDropdownOpen && (
                    <div className="absolute top-[110%] left-0 w-full bg-alx-surface-container-lowest border border-alx-outline-variant/40 rounded-md shadow-2xl z-50 py-1 overflow-hidden">
                      {DEVELOPER_CATEGORIES.map((cat) => (
                        <button
                          key={cat}
                          type="button"
                          onClick={() => handleAddCategory(cat)}
                          className="w-full text-left px-4 py-2.5 text-xs hover:bg-alx-primary/10 hover:text-alx-on-surface font-semibold transition-colors cursor-pointer text-alx-on-surface-variant"
                        >
                          {cat}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Categories Chips */}
                {developerCategories.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {developerCategories.map((cat) => (
                      <span
                        key={cat}
                        className="flex items-center gap-1.5 bg-alx-primary/10 border border-alx-primary/20 rounded-full px-3 py-1 text-[11px] font-semibold text-alx-primary"
                      >
                        <span>{cat}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveCategory(cat)}
                          className="hover:text-alx-on-surface transition-colors ml-1 font-bold text-xs cursor-pointer"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            <button type="submit" disabled={loading} className={SUBMIT_CLASS}>
              {SUBMIT_SHIMMER}
              <span className="relative z-10">
                {loading ? "Completing Profile..." : "Complete Setup & Launch ERP →"}
              </span>
            </button>
          </form>

          <p className="flex items-center justify-center gap-1.5 pt-2 text-center text-xs text-alx-on-surface-variant/70">
            <svg className="h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="4" y="9" width="12" height="8" rx="1.5" />
              <path d="M6.5 9V6a3.5 3.5 0 0 1 7 0v3" />
            </svg>
            Everything you enter is sent over an encrypted connection.
          </p>
        </div>
      </div>
    </div>
  );
}


