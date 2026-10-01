"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Eye, EyeOff, LockKeyhole } from "lucide-react";

import { supabase } from "@/lib/supabase";
import { logActivity } from "@/lib/activityLog";
import { describeResetError, validateNewPassword } from "@/lib/password-rules";

type Status = "checking" | "ready" | "submitting" | "done" | "error";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState("");

  // Supabase delivers the recovery token in the URL hash and establishes a
  // session for it; it does not hand us a plain query parameter. So the
  // "is this link still usable?" question has to be answered by asking the
  // auth client, not by reading the URL.
  useEffect(() => {
    let active = true;

    async function checkSession() {
      if (!supabase) {
        if (!active) return;
        setStatus("error");
        setMessage("Supabase is not configured. Check your .env.local values.");
        return;
      }

      const recoveryError = new URLSearchParams(window.location.hash.slice(1)).get("error") || new URLSearchParams(window.location.search).get("error");
      if (recoveryError) {setStatus("error");setMessage("This reset link has expired or has already been used. Request a new one.");return;}
      const { data } = await supabase.auth.getSession();
      if (!active) return;

      if (data.session) {
        setStatus("ready");
        return;
      }

      setStatus("error");
      setMessage(
        "This reset link has expired or has already been used. Request a new one."
      );
    }

    checkSession();
    return () => { active = false; };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage("");

    const check = validateNewPassword(password, confirm);
    if (!check.ok) {
      setStatus("ready");
      setMessage(check.error ?? "Choose a valid password.");
      return;
    }

    if (!supabase) {
      setStatus("error");
      setMessage("Supabase is not configured.");
      return;
    }

    setStatus("submitting");

    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setStatus("ready");
      setMessage(describeResetError(error.message));
      return;
    }

    // The recovery session is spent; signing out guarantees the next visit
    // needs a real password rather than riding the reset session.
    await logActivity("PASSWORD_RESET", "authentication", undefined, {});
    await supabase.auth.signOut();
    setStatus("done");

    router.replace("/login");
  }

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-leaf-900 p-5">
      <div className="absolute inset-0 opacity-15 [background-image:radial-gradient(circle_at_20%_25%,#d9a441_0,transparent_30%),radial-gradient(circle_at_85%_80%,#8f631f_0,transparent_22%)]" />

      <Link href="/" className="absolute left-5 top-5 z-10 flex items-center gap-2 text-sm text-metal-300 hover:text-metal-50">
        <ArrowLeft size={17} /> Back to home
      </Link>

      <div className="metal-panel relative w-full max-w-md rounded-3xl border border-metal-600 p-8 shadow-soft">
        <img src="/Hayag-logo.png" alt="LPMAS" className="mx-auto h-14 w-14 object-contain" />
        <h1 className="mt-5 text-center text-2xl font-bold text-metal-50">Choose a new password</h1>

        {status === "checking" ? (
          <p className="mt-6 text-center text-sm text-metal-400">Checking your reset link…</p>
        ) : status === "error" ? (
          <>
            <p className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{message}</p>
            <Link
              href="/forgot-password"
              className="mt-6 block w-full rounded-xl bg-leaf-500 py-3 text-center font-semibold text-ink hover:bg-leaf-100"
            >
              Request a new link
            </Link>
            <Link href="/login" className="mt-4 block w-full text-center text-sm text-leaf-500 hover:text-leaf-100">
              Back to sign in
            </Link>
          </>
        ) : status === "done" ? (
          <p className="mt-6 text-center text-sm text-metal-400">Password updated. Redirecting…</p>
        ) : (
          <form onSubmit={submit}>
            <label htmlFor="new-password" className="mt-7 block text-sm font-semibold text-metal-200">New password</label>
            <div className="mt-2 flex items-center gap-2 rounded-xl border border-metal-600 bg-metal-900/60 px-3">
              <LockKeyhole size={18} className="text-metal-500" />
              <input id="new-password"
                className="w-full border-0 bg-transparent px-0 text-metal-50 focus:ring-0"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoComplete="new-password"
                autoFocus
              />
              <button type="button" onClick={() => setShowPassword(!showPassword)} className="text-metal-500 hover:text-metal-200" aria-label={showPassword ? "Hide password" : "Show password"}>
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <p className="mt-1.5 text-xs text-metal-500">At least 8 characters.</p>

            <label htmlFor="confirm-password" className="mt-4 block text-sm font-semibold text-metal-200">Confirm new password</label>
            <div className="mt-2 flex items-center gap-2 rounded-xl border border-metal-600 bg-metal-900/60 px-3">
              <LockKeyhole size={18} className="text-metal-500" />
              <input id="confirm-password"
                className="w-full border-0 bg-transparent px-0 text-metal-50 focus:ring-0"
                type={showPassword ? "text" : "password"}
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                required
                autoComplete="new-password"
              />
            </div>

            {message && <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{message}</p>}

            <button
              disabled={status === "submitting"}
              className="mt-6 w-full rounded-xl bg-leaf-500 py-3 font-semibold text-ink hover:bg-leaf-100 disabled:opacity-60"
            >
              {status === "submitting" ? "Updating…" : "Update password"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
