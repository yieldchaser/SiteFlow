"use client";

import React, { useEffect, useState } from "react";
import { getApi, persistAuth, authHeaders } from "@/lib/siteflow";
import Icon from "@/components/marketing/Icon";
import { detailToMessage } from "@/lib/api";

export default function CreateCompanyOnboardingPage() {
  const [name, setName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [gstin, setGstin] = useState("");
  const [city, setCity] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (typeof window !== "undefined" && !localStorage.getItem("access_token")) {
      window.location.href = "/login";
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Company name is required.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(getApi("/auth/onboarding/create-company"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authHeaders() || {}) },
        body: JSON.stringify({
          name,
          legal_business_name: legalName || null,
          gstin: gstin || null,
          city: city || null,
          billing_address: address || null,
          phone: phone || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.access_token && data.company?.id) {
        persistAuth(data);
        window.location.href = "/profile/onboarding";
      } else if (res.status === 401) {
        window.location.href = "/login";
      } else {
        setError(detailToMessage(data.detail, "Could not create the company. Please try again."));
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    "w-full px-4 py-3 text-sm rounded-md bg-alx-surface-container-lowest border border-alx-outline-variant/40 text-alx-on-surface placeholder-alx-on-surface-variant/60 focus:outline-none focus:border-alx-primary transition-colors motion-reduce:transition-none";

  const labelClass =
    "text-xs font-semibold text-alx-on-surface-variant uppercase tracking-wider block";

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
              Set up your company workspace.
            </h1>
            <p className="text-sm leading-relaxed text-sky-900/80">
              You are the owner of this workspace. Configure your company details to initialize your SiteFlow instance.
            </p>
          </div>

          {/* Setup preview card */}
          <div className="rounded-xl border border-white bg-white/75 p-5 shadow-xl shadow-sky-900/5 space-y-4 backdrop-blur-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-sky-950">Workspace Setup</span>
              <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-700">
                Owner Access
              </span>
            </div>
            <div className="space-y-2.5">
              {[
                { title: "Company details", status: "Now", active: true },
                { title: "Type of work", status: "Next", active: false },
                { title: "Invite your team from Settings", status: "After that", active: false },
              ].map((step, idx) => (
                <div
                  key={idx}
                  className={`flex items-center justify-between rounded-lg px-3 py-2 text-xs font-medium ${
                    step.active
                      ? "bg-sky-500/10 text-sky-950 border border-sky-300/60"
                      : "bg-white/40 text-sky-900/60"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${step.active ? "bg-sky-600 animate-pulse" : "bg-sky-300"}`} />
                    {step.title}
                  </span>
                  <span className="text-[10px] opacity-70">{step.status}</span>
                </div>
              ))}
            </div>
          </div>

          <ul className="space-y-2.5">
            {[
              "Unlimited users, each with their own login",
              "Roles decide who sees money and which projects",
              "Your company's data is kept apart from every other company",
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
            <h2 className="font-headline text-3xl sm:text-4xl font-bold tracking-tight text-alx-on-surface">Create your company</h2>
            <p className="text-alx-on-surface-variant text-sm leading-relaxed">
              This becomes your central workspace. Only the company name is required to start.
            </p>
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3.5 text-sm text-red-600 text-center">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label className={labelClass}>Company Name *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Acme Constructions"
                required
                disabled={loading}
                className={inputClass}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className={labelClass}>Legal Business Name</label>
                <input
                  type="text"
                  value={legalName}
                  onChange={(e) => setLegalName(e.target.value)}
                  placeholder="Registered name"
                  disabled={loading}
                  className={inputClass}
                />
              </div>
              <div className="space-y-2">
                <label className={labelClass}>GSTIN / VAT</label>
                <input
                  type="text"
                  value={gstin}
                  onChange={(e) => setGstin(e.target.value)}
                  placeholder="Tax registration no."
                  disabled={loading}
                  className={inputClass}
                />
              </div>
              <div className="space-y-2">
                <label className={labelClass}>City</label>
                <input
                  type="text"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="e.g. Mumbai"
                  disabled={loading}
                  className={inputClass}
                />
              </div>
              <div className="space-y-2">
                <label className={labelClass}>Phone</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="Contact number"
                  disabled={loading}
                  className={inputClass}
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className={labelClass}>Billing Address</label>
              <textarea
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Registered / billing address"
                rows={2}
                disabled={loading}
                className={`${inputClass} resize-none`}
              />
            </div>

            <button type="submit" disabled={loading} className={SUBMIT_CLASS}>
              {SUBMIT_SHIMMER}
              <span className="relative z-10">{loading ? "Creating workspace..." : "Create company & continue →"}</span>
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

