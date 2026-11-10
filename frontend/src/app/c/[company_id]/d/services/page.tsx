"use client";

import React, { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Icon, { type IconName } from "@/components/marketing/Icon";
import PageShell from "@/components/layout/PageShell";
import PageHeader from "@/components/PageHeader";
import { isMissingOrDemoTenant, redirectToLogin } from "@/lib/company-guard";

interface ServiceItem {
  icon: IconName;
  title: string;
  price?: string;
  sub?: string;
  desc?: string;
}

const SALES_EMAIL = "sales@siteflow.in";

export default function ServicesPage() {
  const params = useParams();
  const router = useRouter();
  const companyId = params?.company_id as string;

  useEffect(() => {
    if (isMissingOrDemoTenant(companyId)) {
      redirectToLogin();
    }
  }, [companyId]);

  const services: ServiceItem[] = [
    {
      icon: "wrench",
      title: "Customisation Request",
      desc: "Email us what you would like changed for your company. We will go through it with you and plan the work.",
    },
    {
      icon: "headphone",
      title: "Offline Support (3 days)",
      price: "Rs 25000 + Travel + Accommodation + Taxes",
    },
    {
      icon: "description",
      title: "Tally Integration",
      price: "Rs 20000 One Time + Taxes",
      sub: "Rs 5000 Annual Maintenance + Taxes",
    },
    {
      icon: "book",
      title: "Zoho Books Integration",
      price: "Rs 30000 One Time + Taxes",
      sub: "Rs 5000 Annual Maintenance + Taxes",
    },
    {
      icon: "group",
      title: "Zoho CRM Integration",
      price: "Rs 30000 One Time + Taxes",
      sub: "Rs 5000 Annual Maintenance + Taxes",
    },
    {
      icon: "megaphone",
      title: "Facebook Lead Integration",
      price: "Rs 20000 One Time + Taxes",
      sub: "Rs 5000 Annual Maintenance + Taxes",
    },
    {
      icon: "person",
      title: "User Add On",
      price: "As per subscription plan",
    },
    {
      icon: "location_pin",
      title: "GPS Attendance Addon (50 users)",
      price: "Rs 20000 Yearly + Taxes",
    },
    {
      icon: "computer",
      title: "Website Development (15 pages)",
      price: "Rs 20000 + Taxes",
    },
    {
      icon: "camera",
      title: "Social Media Package [15 post + 4 Reels]",
      price: "Rs 10000 + Taxes",
    },
    {
      icon: "chat_bubble",
      title: "Whatsapp Alerts (10000 msgs per year)",
      price: "Rs 5000 + Taxes",
    },
  ];

  const contactHref = (title: string) =>
    `mailto:${SALES_EMAIL}?subject=${encodeURIComponent(`Service request: ${title}`)}`;
  const referHref = `mailto:${SALES_EMAIL}?subject=${encodeURIComponent("SiteFlow Referral Program")}`;

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-elevated/10">
      <PageHeader
        title="Services & Add-ons"
        subtitle="Enhance your SiteFlow experience with our add-on services and integrations."
      />
      <div className="flex-1 overflow-y-auto">
        <PageShell width="wide">
          <div className="space-y-8">

        {/* Service Cards Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {services.map((s, idx) => (
            <div
              key={idx}
              className="flex flex-col bg-card border border-border-custom rounded-xl p-5 hover:border-primary/40 transition-all"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0">
                  <Icon name={s.icon} className="w-5 h-5" />
                </div>
                <h3 className="text-sm font-bold text-foreground leading-snug">{s.title}</h3>
              </div>

              <div className="mt-4 flex-1 space-y-1">
                {s.desc ? (
                  <p className="text-xs text-muted leading-relaxed">{s.desc}</p>
                ) : (
                  <>
                    {s.price && (
                      <p className="text-sm font-semibold text-foreground">{s.price}</p>
                    )}
                    {s.sub && (
                      <p className="text-xs text-muted">{s.sub}</p>
                    )}
                  </>
                )}
              </div>

              <a
                href={contactHref(s.title)}
                className="mt-4 inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline"
              >
                Contact Us
                <span aria-hidden>&gt;</span>
              </a>
            </div>
          ))}
        </div>

        {/* Referral Banner */}
        <div className="relative rounded-2xl bg-primary/10 border border-border-custom p-8 overflow-hidden">
          <div className="max-w-2xl relative z-10 space-y-3">
            <h3 className="text-lg font-extrabold tracking-tight text-foreground">SiteFlow Referral Program</h3>
            <p className="text-xs text-muted">
              Refer and earn cashback with each successful referral.
            </p>
            <a
              href={referHref}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-bold text-white hover:opacity-90 transition-all"
            >
              Refer Now
              <span aria-hidden>&gt;</span>
            </a>
          </div>
        </div>
        </div>
        </PageShell>
      </div>
    </div>
  );
}
