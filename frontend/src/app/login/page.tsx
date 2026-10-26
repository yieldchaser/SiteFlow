"use client";

import React, { useState, useEffect, useRef } from "react";
import { getApiHost, detailToMessage} from "@/lib/api";
import { getApi, persistAuth } from "@/lib/siteflow";
import { getFirebaseAuth, isFirebaseConfigured } from "@/lib/firebase";
import {
  RecaptchaVerifier,
  signInWithPhoneNumber,
  type ConfirmationResult,
} from "firebase/auth";
import Icon from "@/components/marketing/Icon";

type Method = "phone" | "email_otp" | "password";
type Stage =
  | "input"        // phone / email / password entry
  | "otp"          // phone or email code entry
  | "register"     // email + password + name
  | "verify"       // verify email OTP after register
  | "forgot"       // request reset code
  | "reset"        // enter reset code + new password
  | "invite"       // accept team invite with OTP code + password
  | "pick";        // choose a company (multi-membership)

interface AuthCompany {
  id: string;
  name: string;
  slug?: string | null;
}
interface AuthResponse {
  access_token: string;
  onboarding?: boolean;
  needs_company_selection?: boolean;
  user?: { id?: string; name?: string };
  company?: { id?: string; name?: string; priority_type?: string } | null;
  companies?: AuthCompany[];
}

const COUNTRY_CODES = [
  { code: "+91", flag: "IN", label: "India" },
  { code: "+971", flag: "AE", label: "UAE" },
  { code: "+974", flag: "QA", label: "Qatar" },
  { code: "+966", flag: "SA", label: "KSA" },
];

export default function LoginPage() {
  const [method, setMethod] = useState<Method>("email_otp");
  const [stage, setStage] = useState<Stage>("input");

  const [mobile, setMobile] = useState("");
  const [countryCode, setCountryCode] = useState("+91");
  const [isCountryOpen, setIsCountryOpen] = useState(false);

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");

  const [companies, setCompanies] = useState<AuthCompany[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [timer, setTimer] = useState(0);

  // Firebase Phone Auth (client-side). When the public Firebase config is
  // present, the "Phone OTP" tab uses Firebase (which handles carrier routing
  // and DLT compliance); otherwise it falls back to the MSG91/demo-allowlist
  // flow unchanged. See src/lib/firebase.ts.
  const firebaseReady = isFirebaseConfigured();
  const recaptchaRef = useRef<RecaptchaVerifier | null>(null);
  const confirmationRef = useRef<ConfirmationResult | null>(null);

  useEffect(() => {
    if (timer <= 0) return;
    const id = setInterval(() => setTimer((t) => t - 1), 1000);
    return () => clearInterval(id);
  }, [timer]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const inviteCode = params.get("code") || params.get("invite");
      const inviteEmail = params.get("email");
      if (inviteCode || params.get("mode") === "invite") {
        setStage("invite");
        if (inviteEmail) setEmail(inviteEmail);
        if (inviteCode && inviteCode !== "true") setOtp(inviteCode);
      }
    }
  }, []);

  const reset = (m: Method) => {
    setMethod(m);
    setStage(m === "password" ? "input" : "input");
    setError("");
    setMessage("");
    setOtp("");
    setPassword("");
  };

  const fmtMobile = () => `${countryCode}${mobile}`;

  const call = async (path: string, body: Record<string, unknown>) => {
    const res = await fetch(getApi(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data } as { res: Response; data: any };
  };

  // Route the user after any successful auth.
  const finishLogin = async (data: AuthResponse) => {
    persistAuth(data);
    if (data.onboarding) {
      window.location.href = "/onboarding";
      return;
    }
    if (data.needs_company_selection && (data.companies?.length || 0) > 1) {
      setCompanies(data.companies || []);
      setStage("pick");
      setLoading(false);
      return;
    }
    const companyId = data.company?.id;
    if (!companyId) {
      window.location.href = "/onboarding";
      return;
    }
    // Send a new company's owner through the segment questionnaire. Staff who
    // join someone else's company go straight in: the questionnaire renames the
    // company and is not theirs to fill.
    let shouldOnboard = data.company?.priority_type === "partner";
    if (shouldOnboard) try {
      const r = await fetch(`${getApiHost()}/apis/v3/settings/company/${companyId}`, {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      if (r.ok) {
        const c = await r.json();
        if (c.onboarding_completed) shouldOnboard = false;
      }
    } catch (err: any) {
      console.error("company settings fetch failed", err?.code, err?.message, err);
    }
    window.location.href = shouldOnboard
      ? "/profile/onboarding"
      : `/c/${companyId}/d/home`;
  };

  const pickCompany = (companyId: string) => {
    localStorage.setItem("company_id", companyId);
    window.location.href = `/c/${companyId}/d/home`;
  };

  // ── Handlers ────────────────────────────────────────────────────────────
  const guard = () => {
    setLoading(true);
    setError("");
    setMessage("");
  };

  const handlePhoneSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mobile || mobile.length < 10) {
      setError("Please enter a valid mobile number.");
      return;
    }
    if (firebaseReady) {
      await handleFirebasePhoneSend();
      return;
    }
    guard();
    try {
      const { res, data } = await call("/auth/otp/send", { mobile: fmtMobile() });
      if (res.ok && data.success) {
        setStage("otp");
        setTimer(30);
        setMessage(data.demo_mode ? `Demo code: ${data.mock_code}` : "Code sent to your phone.");
      } else setError(detailToMessage(data.detail, "Failed to send code."));
    } catch (err: any) {
      console.error("login failed", err?.code, err?.message, err);
      setError("Could not reach the server. Is the backend running?");
    } finally {
      setLoading(false);
    }
  };

  // Firebase phone send: run the invisible reCAPTCHA and send the SMS via the
  // Firebase JS SDK (no MSG91 involved). The resulting confirmationResult is
  // held so the code-entry step can confirm it.
  const handleFirebasePhoneSend = async () => {
    guard();
    try {
      const auth = getFirebaseAuth();
      if (!auth) {
        setError("Phone login is temporarily unavailable.");
        setLoading(false);
        return;
      }
      if (!recaptchaRef.current) {
        recaptchaRef.current = new RecaptchaVerifier(auth, "firebase-recaptcha", {
          size: "invisible",
        });
      }
      const confirmation = await signInWithPhoneNumber(auth, fmtMobile(), recaptchaRef.current);
      confirmationRef.current = confirmation;
      setStage("otp");
      setTimer(30);
      setMessage("Code sent to your phone.");
    } catch (err: any) {
      // Log the real Firebase error code/message to the browser console (dev
      // visibility only, not sent anywhere) - swallowing it entirely made every
      // failure indistinguishable (bad number vs quota vs captcha vs billing).
      console.error("[firebase phone] signInWithPhoneNumber failed:", err?.code, err?.message, err);
      // Reset the verifier so a retry gets a fresh challenge.
      try {
        recaptchaRef.current?.clear();
      } catch (_e: any) {
        /* ignore */
      }
      recaptchaRef.current = null;
      if (err?.code === "auth/too-many-requests") {
        setError("Too many attempts. Please try again later.");
      } else {
        setError("Could not send the code. Please check the number and try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleEmailOtpSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      setError("Please enter your email.");
      return;
    }
    guard();
    try {
      const { res, data } = await call("/auth/email-otp/send", { email });
      if (res.ok && data.success) {
        setStage("otp");
        setTimer(30);
        setMessage(data.demo_mode ? `Demo code: ${data.mock_code}` : "Code sent to your email.");
      } else setError(detailToMessage(data.detail, "Failed to send code."));
    } catch (err: any) {
      console.error("login failed", err?.code, err?.message, err);
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  };

  const handleOtpVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otp || otp.length < 6) {
      setError("Enter the 6-digit code.");
      return;
    }
    if (method === "phone" && firebaseReady) {
      await handleFirebaseOtpVerify();
      return;
    }
    guard();
    try {
      const path = method === "phone" ? "/auth/otp/verify" : "/auth/email-otp/verify";
      const body = method === "phone" ? { mobile: fmtMobile(), code: otp } : { email, code: otp };
      const { res, data } = await call(path, body);
      if (res.ok && data.access_token) {
        setMessage("Success. Redirecting...");
        await finishLogin(data);
      } else {
        setError(detailToMessage(data.detail, "Invalid code."));
      }
    } catch (err: any) {
      console.error("login failed", err?.code, err?.message, err);
      setError("Verification failed.");
    } finally {
      setLoading(false);
    }
  };

  // Firebase phone verify: confirm the code with Firebase to obtain a signed ID
  // token, then hand that token to the backend which verifies it and mints our
  // session (same post-login handling as every other method).
  const handleFirebaseOtpVerify = async () => {
    guard();
    try {
      const confirmation = confirmationRef.current;
      if (!confirmation) {
        setError("Your session expired. Please request a new code.");
        setStage("input");
        setLoading(false);
        return;
      }
      const credential = await confirmation.confirm(otp);
      const idToken = await credential.user.getIdToken();
      const { res, data } = await call("/auth/firebase/verify", { id_token: idToken });
      if (res.ok && data.access_token) {
        setMessage("Success. Redirecting...");
        await finishLogin(data);
      } else {
        setError(detailToMessage(data.detail, "Could not complete sign-in."));
      }
    } catch (err: any) {
      console.error("login failed", err?.code, err?.message, err);
      const code = err?.code as string | undefined;
      if (code === "auth/invalid-verification-code") {
        setError("Invalid code. Please request a new one.");
      } else if (code === "auth/code-expired") {
        setError("Code expired. Please request a new one.");
      } else if (code === "auth/too-many-requests") {
        setError("Too many attempts. Please try again later.");
      } else {
        setError("Invalid code. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    guard();
    try {
      const { res, data } = await call("/auth/login", { email, password });
      if (res.ok && data.access_token) {
        setMessage("Success. Redirecting...");
        await finishLogin(data);
      } else if (res.status === 403) {
        // Email not verified: move the user into the verify step.
        setError("");
        setMessage("Verify your email to continue. We can send you a code.");
        setStage("verify");
      } else {
        setError(detailToMessage(data.detail, "Invalid email or password."));
      }
    } catch (err: any) {
      console.error("login failed", err?.code, err?.message, err);
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  };

  const handleAcceptInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !otp || !password) {
      setError("Please enter your email, invite code, and password.");
      return;
    }
    guard();
    try {
      const { res, data } = await call("/auth/team/invite/accept", {
        email,
        code: otp,
        password,
      });
      if (res.ok && data.access_token) {
        setMessage("Invitation accepted. Redirecting...");
        await finishLogin(data);
      } else {
        setError(detailToMessage(data.detail, "Could not accept invitation."));
      }
    } catch (err: any) {
      console.error("accept invite failed", err);
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Please enter your name.");
      return;
    }
    guard();
    try {
      const { res, data } = await call("/auth/register", { email, password, name });
      if (res.ok && data.success) {
        setStage("verify");
        setTimer(30);
        setMessage(
          data.demo_mode
            ? `Account created. Demo code: ${data.mock_code}`
            : "Account created. Enter the code we emailed you."
        );
      } else {
        setError(detailToMessage(data.detail, "Could not create the account."));
      }
    } catch (err: any) {
      console.error("login failed", err?.code, err?.message, err);
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  };

  // Verify email after register (or after a 403 login), then log in.
  const handleVerifyEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otp || otp.length < 6) {
      setError("Enter the 6-digit code.");
      return;
    }
    guard();
    try {
      const { res, data } = await call("/auth/email-otp/verify", { email, code: otp });
      if (res.ok && data.access_token) {
        setMessage("Verified. Redirecting...");
        await finishLogin(data);
      } else {
        setError(detailToMessage(data.detail, "Invalid code."));
      }
    } catch (err: any) {
      console.error("login failed", err?.code, err?.message, err);
      setError("Verification failed.");
    } finally {
      setLoading(false);
    }
  };

  const handleResendVerify = async () => {
    guard();
    try {
      const { res, data } = await call("/auth/email-otp/send", { email });
      if (res.ok) {
        setTimer(30);
        setMessage(data.demo_mode ? `Demo code: ${data.mock_code}` : "Code sent to your email.");
      } else setError(detailToMessage(data.detail, "Failed to send code."));
    } catch (err: any) {
      console.error("login failed", err?.code, err?.message, err);
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  };

  const handleForgotSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      setError("Please enter your email.");
      return;
    }
    guard();
    try {
      const { res, data } = await call("/auth/password/forgot", { email });
      if (res.ok) {
        setStage("reset");
        setTimer(30);
        setMessage("If an account exists, a reset code has been sent to your email.");
      } else setError(detailToMessage(data.detail, "Could not send a reset code."));
    } catch (err: any) {
      console.error("login failed", err?.code, err?.message, err);
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    guard();
    try {
      const { res, data } = await call("/auth/password/reset", {
        email,
        code: otp,
        new_password: password,
      });
      if (res.ok && data.success) {
        setStage("input");
        setOtp("");
        setPassword("");
        setMessage("Password updated. Please log in.");
      } else {
        setError(detailToMessage(data.detail, "Could not reset the password."));
      }
    } catch (err: any) {
      console.error("login failed", err?.code, err?.message, err);
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  };

  const SUBMIT_CLASS =
    "group relative overflow-hidden w-full flex justify-center items-center py-3 px-6 rounded-md text-alx-on-primary font-semibold alx-bg-gradient-primary hover:shadow-xl hover:shadow-alx-primary/30 hover:-translate-y-0.5 shadow-md transition-all motion-reduce:transition-none cursor-pointer disabled:opacity-50 disabled:pointer-events-none disabled:hover:translate-y-0";
  const SUBMIT_SHIMMER = (
    <span className="absolute inset-0 alx-shimmer opacity-0 group-hover:opacity-100 transition-opacity duration-300" aria-hidden="true" />
  );

  const startGoogle = () => {
    // Public GET: the backend 307-redirects to Google. No token in any URL.
    window.location.href = getApi("/auth/google/authorize");
  };

  const tabBtn = (m: Method, label: string) => (
    <button
      type="button"
      onClick={() => reset(m)}
      className={`w-full py-2.5 px-1 sm:px-2 text-center text-[11px] sm:text-xs font-semibold rounded-md transition-all motion-reduce:transition-none whitespace-nowrap overflow-hidden text-ellipsis ${
        method === m
          ? "alx-bg-gradient-primary text-alx-on-primary shadow-sm shadow-alx-primary/30"
          : "bg-alx-surface-container-low text-alx-on-surface-variant hover:text-alx-on-surface hover:bg-alx-surface-container border border-alx-outline-variant/40"
      }`}
    >
      {label}
    </button>
  );

  const heading = () => {
    if (stage === "pick") return "Choose a company";
    if (stage === "invite") return "Accept Team Invitation";
    if (stage === "otp" || stage === "verify") return "Enter verification code";
    if (stage === "forgot") return "Reset your password";
    if (stage === "reset") return "Set a new password";
    if (method === "password" && stage === "register") return "Create your account";
    return "Login & Sign Up";
  };

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
            <h2 className="font-headline text-3xl font-extrabold leading-tight text-sky-950">
              Your whole construction business in one workspace.
            </h2>
            <p className="text-sm leading-relaxed text-sky-900/80">
              Projects, billing, procurement, payroll and CRM stay connected, so your office and your site work from the same numbers.
            </p>
          </div>

          {/* Compact live-project mock, echoing the homepage hero card
              (same honest demo strings), adapted for this fixed half-width panel. */}
          <div className="rounded-xl border border-white bg-white/75 p-4 shadow-xl shadow-sky-900/5 space-y-3 backdrop-blur-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-sky-950">Greenline Residency</span>
              <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-700">
                Phase 2
              </span>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-sky-900/70">
                <span>Weighted progress</span>
                <span className="font-semibold text-sky-950">62%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-sky-100">
                <div className="h-full w-[62%] rounded-full bg-sky-600" />
              </div>
            </div>
            <div className="rounded-md border border-sky-100/50 bg-white/50 px-3 py-2 text-[11px] text-sky-900">
              Project P&amp;L: revenue Rs 61L, cost Rs 44L, margin 28%
            </div>
          </div>

          {/* Proportionate, honest proof points (mirrors the homepage trust bar). */}
          <ul className="space-y-2.5">
            {[
              "16 operational modules under one login",
              "Tally & Zoho accounting integrations",
              "GPS-geofenced attendance, IS-code compliant math",
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
      <div className="flex w-full flex-col justify-center items-center p-5 sm:p-8 lg:w-3/5 bg-alx-surface-container-lowest relative overflow-hidden">
        <div className="absolute top-[-10%] right-[-10%] h-[40%] w-[40%] rounded-full bg-alx-primary/5 blur-[100px]" />
        <div className="w-full max-w-md space-y-6 sm:space-y-7 z-10 py-4 sm:py-0">
          <div className="space-y-2.5 text-center">
            <h2 className="font-headline text-3xl sm:text-4xl font-bold tracking-tight text-alx-on-surface">{heading()}</h2>
            <p className="text-alx-on-surface-variant text-sm leading-relaxed">
              {stage === "input" && method === "phone" && "Enter your mobile number to receive a code."}
              {stage === "input" && method === "email_otp" && "Enter your email to receive a code."}
              {stage === "input" && method === "password" && "Log in with your email and password."}
              {stage === "register" && "Sign up with your email and a password."}
              {(stage === "otp" || stage === "verify") && "Enter the 6-digit code we sent you."}
              {stage === "forgot" && "We will email you a code to reset your password."}
              {stage === "reset" && "Enter the code and choose a new password."}
              {stage === "invite" && "Enter your invitation code and create a password to join the team."}
              {stage === "pick" && "You belong to more than one company."}
            </p>
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600 text-center">
              {error}
            </div>
          )}
          {message && (
            <div className="rounded-lg border border-success/20 bg-success/10 p-3 text-sm text-success text-center">
              {message}
            </div>
          )}

          {/* Google + method tabs shown only on the primary entry stages */}
          {(stage === "input" || stage === "register") && (
            <>
              <button
                type="button"
                onClick={startGoogle}
                className="w-full flex justify-center items-center gap-2 py-3 px-6 rounded-md font-semibold border border-alx-outline-variant/40 bg-alx-surface-container-lowest hover:bg-alx-surface-container-low hover:border-alx-outline hover:-translate-y-0.5 hover:shadow-md text-alx-on-surface transition-all motion-reduce:transition-none cursor-pointer"
              >
                <svg className="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.47c-.28 1.5-1.13 2.77-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81z" />
                  <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.92l-3.88-3c-1.08.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.26v3.09C3.24 21.3 7.28 24 12 24z" />
                  <path fill="#FBBC05" d="M5.27 14.27a7.2 7.2 0 010-4.54v-3.1H1.26a12 12 0 000 10.74z" />
                  <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0 7.28 0 3.24 2.7 1.26 6.63l4.01 3.1C6.22 6.86 8.87 4.75 12 4.75z" />
                </svg>
                Continue with Google
              </button>
              <div className="relative flex py-1 items-center">
                <div className="flex-grow border-t border-alx-outline-variant/40" />
                <span className="flex-shrink mx-4 text-xs font-bold text-alx-on-surface-variant uppercase tracking-widest">Or</span>
                <div className="flex-grow border-t border-alx-outline-variant/40" />
              </div>
              <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
                {tabBtn("email_otp", "Email OTP")}
                {tabBtn("phone", "Phone OTP")}
                {tabBtn("password", "Email & Password")}
              </div>
            </>
          )}

          {/* Phone input */}
          {stage === "input" && method === "phone" && (
            <form onSubmit={handlePhoneSend} className="space-y-5">
              <div className="relative flex rounded-md bg-alx-surface-container-lowest border border-alx-outline-variant/40 focus-within:border-alx-primary transition-colors motion-reduce:transition-none items-center p-1.5">
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setIsCountryOpen(!isCountryOpen)}
                    className="flex items-center gap-1.5 px-3 py-2 bg-alx-surface-container-low rounded-lg border border-alx-outline-variant/40 text-sm font-semibold hover:bg-alx-surface-container-low/80 transition-colors motion-reduce:transition-none cursor-pointer text-alx-on-surface"
                  >
                    <span>{countryCode}</span>
                    <span className="text-[10px] opacity-60">v</span>
                  </button>
                  {isCountryOpen && (
                    <div className="absolute top-[120%] left-0 w-32 bg-alx-surface-container-lowest border border-alx-outline-variant/40 rounded-lg shadow-2xl z-50 overflow-hidden">
                      {COUNTRY_CODES.map((c) => (
                        <button
                          key={c.code}
                          type="button"
                          onClick={() => {
                            setCountryCode(c.code);
                            setIsCountryOpen(false);
                          }}
                          className="w-full px-3 py-2 text-left text-xs font-semibold hover:bg-alx-primary/10 hover:text-alx-on-surface transition-colors motion-reduce:transition-none cursor-pointer text-alx-on-surface"
                        >
                          {c.code} {c.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <input
                  type="tel"
                  value={mobile}
                  onChange={(e) => setMobile(e.target.value.replace(/\D/g, "").slice(0, 10))}
                  placeholder="Mobile number"
                  required
                  disabled={loading}
                  className="w-full bg-transparent px-4 py-2 text-base font-semibold tracking-wide placeholder-alx-on-surface-variant/60 focus:outline-none text-alx-on-surface"
                />
              </div>
              <button type="submit" disabled={loading} className={SUBMIT_CLASS}>
                {SUBMIT_SHIMMER}
                <span className="relative z-10">{loading ? "Sending..." : "Send code"}</span>
              </button>
            </form>
          )}

          {/* Email OTP input */}
          {stage === "input" && method === "email_otp" && (
            <form onSubmit={handleEmailOtpSend} className="space-y-5">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                disabled={loading}
                className="w-full px-4 py-3 text-sm rounded-md bg-alx-surface-container-lowest border border-alx-outline-variant/40 text-alx-on-surface placeholder-alx-on-surface-variant/60 focus:outline-none focus:border-alx-primary"
              />
              <button type="submit" disabled={loading} className={SUBMIT_CLASS}>
                {SUBMIT_SHIMMER}
                <span className="relative z-10">{loading ? "Sending..." : "Send code"}</span>
              </button>
            </form>
          )}

          {/* Password login */}
          {stage === "input" && method === "password" && (
            <form onSubmit={handlePasswordLogin} className="space-y-4">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                disabled={loading}
                className="w-full px-4 py-3 text-sm rounded-md bg-alx-surface-container-lowest border border-alx-outline-variant/40 text-alx-on-surface placeholder-alx-on-surface-variant/60 focus:outline-none focus:border-alx-primary"
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                required
                disabled={loading}
                className="w-full px-4 py-3 text-sm rounded-md bg-alx-surface-container-lowest border border-alx-outline-variant/40 text-alx-on-surface placeholder-alx-on-surface-variant/60 focus:outline-none focus:border-alx-primary"
              />
              <button type="submit" disabled={loading} className={SUBMIT_CLASS}>
                {SUBMIT_SHIMMER}
                <span className="relative z-10">{loading ? "Signing in..." : "Log in"}</span>
              </button>
              <div className="flex justify-between text-xs text-alx-on-surface-variant pt-1">
                <button type="button" onClick={() => { setStage("register"); setError(""); setMessage(""); }} className="font-medium text-alx-primary hover:text-alx-on-surface">
                  Create account
                </button>
                <button type="button" onClick={() => { setStage("forgot"); setError(""); setMessage(""); }} className="font-medium text-alx-secondary hover:text-alx-on-surface">
                  Forgot password?
                </button>
              </div>
            </form>
          )}

          {/* Register */}
          {stage === "register" && (
            <form onSubmit={handleRegister} className="space-y-4">
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" required disabled={loading} className="w-full px-4 py-3 text-sm rounded-md bg-alx-surface-container-lowest border border-alx-outline-variant/40 text-alx-on-surface placeholder-alx-on-surface-variant/60 focus:outline-none focus:border-alx-primary" />
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required disabled={loading} className="w-full px-4 py-3 text-sm rounded-md bg-alx-surface-container-lowest border border-alx-outline-variant/40 text-alx-on-surface placeholder-alx-on-surface-variant/60 focus:outline-none focus:border-alx-primary" />
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (min 8 characters)" required disabled={loading} className="w-full px-4 py-3 text-sm rounded-md bg-alx-surface-container-lowest border border-alx-outline-variant/40 text-alx-on-surface placeholder-alx-on-surface-variant/60 focus:outline-none focus:border-alx-primary" />
              <button type="submit" disabled={loading} className={SUBMIT_CLASS}>
                {SUBMIT_SHIMMER}
                <span className="relative z-10">{loading ? "Creating..." : "Create account"}</span>
              </button>
              <button type="button" onClick={() => { setStage("input"); setError(""); setMessage(""); }} className="w-full text-xs font-medium text-alx-on-surface-variant hover:text-alx-on-surface pt-1">
                Back to login
              </button>
            </form>
          )}

          {/* OTP / verify code */}
          {(stage === "otp" || stage === "verify") && (
            <form onSubmit={stage === "otp" ? handleOtpVerify : handleVerifyEmail} className="space-y-5">
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                required
                disabled={loading}
                className="w-full px-4 py-3.5 text-center text-2xl font-bold tracking-widest rounded-md bg-alx-surface-container-lowest border border-alx-outline-variant/40 text-alx-on-surface placeholder-alx-on-surface-variant/60 focus:outline-none focus:border-alx-primary"
              />
              <button type="submit" disabled={loading} className={SUBMIT_CLASS}>
                {SUBMIT_SHIMMER}
                <span className="relative z-10">{loading ? "Verifying..." : "Verify"}</span>
              </button>
              <div className="flex justify-between items-center text-xs text-alx-on-surface-variant">
                <button type="button" onClick={() => { setStage("input"); setOtp(""); setError(""); }} className="font-medium text-alx-secondary hover:text-alx-on-surface">
                  Back
                </button>
                {timer > 0 ? (
                  <span>Resend in {timer}s</span>
                ) : (
                  <button
                    type="button"
                    onClick={stage === "otp" ? (method === "phone" ? handlePhoneSend : handleEmailOtpSend) as any : handleResendVerify}
                    disabled={loading}
                    className="font-medium text-alx-primary hover:text-alx-on-surface"
                  >
                    Resend code
                  </button>
                )}
              </div>
            </form>
          )}

          {/* Forgot */}
          {stage === "forgot" && (
            <form onSubmit={handleForgotSend} className="space-y-5">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required disabled={loading} className="w-full px-4 py-3 text-sm rounded-md bg-alx-surface-container-lowest border border-alx-outline-variant/40 text-alx-on-surface placeholder-alx-on-surface-variant/60 focus:outline-none focus:border-alx-primary" />
              <button type="submit" disabled={loading} className={SUBMIT_CLASS}>
                {SUBMIT_SHIMMER}
                <span className="relative z-10">{loading ? "Sending..." : "Send reset code"}</span>
              </button>
              <button type="button" onClick={() => { setStage("input"); setError(""); setMessage(""); }} className="w-full text-xs font-medium text-alx-on-surface-variant hover:text-alx-on-surface">
                Back to login
              </button>
            </form>
          )}

          {/* Reset */}
          {stage === "reset" && (
            <form onSubmit={handleReset} className="space-y-4">
              <input type="text" inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="Reset code" required disabled={loading} className="w-full px-4 py-3 text-center text-xl font-bold tracking-widest rounded-md bg-alx-surface-container-lowest border border-alx-outline-variant/40 text-alx-on-surface placeholder-alx-on-surface-variant/60 focus:outline-none focus:border-alx-primary" />
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password (min 8 characters)" required disabled={loading} className="w-full px-4 py-3 text-sm rounded-md bg-alx-surface-container-lowest border border-alx-outline-variant/40 text-alx-on-surface placeholder-alx-on-surface-variant/60 focus:outline-none focus:border-alx-primary" />
              <button type="submit" disabled={loading} className={SUBMIT_CLASS}>
                {SUBMIT_SHIMMER}
                <span className="relative z-10">{loading ? "Updating..." : "Update password"}</span>
              </button>
              <button type="button" onClick={() => { setStage("input"); setError(""); setMessage(""); }} className="w-full text-xs font-medium text-alx-on-surface-variant hover:text-alx-on-surface">
                Back to login
              </button>
            </form>
          )}

          {/* Accept Team Invite */}
          {stage === "invite" && (
            <form onSubmit={handleAcceptInvite} className="space-y-4">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
                disabled={loading}
                className="w-full px-4 py-3 text-sm rounded-md bg-alx-surface-container-lowest border border-alx-outline-variant/40 text-alx-on-surface placeholder-alx-on-surface-variant/60 focus:outline-none focus:border-alx-primary"
              />
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="6-digit Invite Code"
                required
                disabled={loading}
                className="w-full px-4 py-3 text-center text-xl font-bold tracking-widest rounded-md bg-alx-surface-container-lowest border border-alx-outline-variant/40 text-alx-on-surface placeholder-alx-on-surface-variant/60 focus:outline-none focus:border-alx-primary"
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Create password (min 8 characters)"
                required
                disabled={loading}
                className="w-full px-4 py-3 text-sm rounded-md bg-alx-surface-container-lowest border border-alx-outline-variant/40 text-alx-on-surface placeholder-alx-on-surface-variant/60 focus:outline-none focus:border-alx-primary"
              />
              <button type="submit" disabled={loading} className={SUBMIT_CLASS}>
                {SUBMIT_SHIMMER}
                <span className="relative z-10">{loading ? "Claiming account..." : "Accept & Join Team"}</span>
              </button>
              <button
                type="button"
                onClick={() => { setStage("input"); setError(""); setMessage(""); }}
                className="w-full text-xs font-medium text-alx-on-surface-variant hover:text-alx-on-surface"
              >
                Back to login
              </button>
            </form>
          )}

          {/* Company picker */}
          {stage === "pick" && (
            <div className="space-y-3">
              {companies.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => pickCompany(c.id)}
                  className="w-full text-left px-4 py-3 rounded-md border border-alx-outline-variant/40 bg-alx-surface-container-lowest hover:border-alx-primary hover:bg-alx-surface-container-low transition-colors motion-reduce:transition-none text-alx-on-surface font-semibold"
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}

          {/* Invisible reCAPTCHA host for Firebase Phone Auth (no-op when the
              MSG91 fallback is active). */}
          <div id="firebase-recaptcha" />

          {stage === "input" && (
            <button
              type="button"
              onClick={() => { setStage("invite"); setError(""); setMessage(""); }}
              className="w-full text-xs font-medium text-alx-primary hover:text-alx-on-surface"
            >
              Added by your company? Have an invite code?
            </button>
          )}

          <p className="flex items-center justify-center gap-1.5 pt-1 text-center text-xs text-alx-on-surface-variant/70">
            <svg className="h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="4" y="9" width="12" height="8" rx="1.5" />
              <path d="M6.5 9V6a3.5 3.5 0 0 1 7 0v3" />
            </svg>
            Secure ERP workspace terminal with end-to-end encryption.
          </p>
        </div>
      </div>
    </div>
  );
}
