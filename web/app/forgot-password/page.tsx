"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Mail, Send } from "lucide-react";

import { supabase } from "@/lib/supabase";
import { isValidEmail, resetRedirectTo } from "@/lib/password-rules";

type Status = "idle" | "loading" | "sent" | "error";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage("");

    if (!supabase) {
      setStatus("error");
      setMessage("Supabase is not configured. Check your .env.local values.");
      return;
    }

    if (!isValidEmail(email)) {
      setStatus("error");
      setMessage("Enter a valid email address.");
      return;
    }

    setStatus("loading");

    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: resetRedirectTo(window.location.origin),
    });

    if (error) {
      setStatus("error");
      setMessage(error.message);
      return;
    }

    setStatus("sent");
  }

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-leaf-900 p-5">
      <div className="absolute inset-0 opacity-15 [background-image:radial-gradient(circle_at_20%_25%,#d9a441_0,transparent_30%),radial-gradient(circle_at_85%_80%,#8f631f_0,transparent_22%)]" />

      <Link href="/" className="absolute left-5 top-5 z-10 flex items-center gap-2 text-sm text-metal-300 hover:text-metal-50">
        <ArrowLeft size={17} /> Back to home
      </Link>

      <div className="metal-panel relative w-full max-w-md rounded-3xl border border-metal-600 p-8 shadow-soft">
        <img src="/Hayag-logo.png" alt="LPMAS" className="mx-auto h-14 w-14 object-contain" />
        <h1 className="mt-5 text-center text-2xl font-bold text-metal-50">Reset your password</h1>
        <p className="mt-2 text-center text-sm text-metal-400">
          Enter your account email and we will send you a link to choose a new password.
        </p>

        {status === "sent" ? (
          <>
            <div className="mt-6 rounded-xl border border-leaf-500/40 bg-leaf-500/10 p-4 text-sm text-leaf-100">
              If an account exists for <span className="font-semibold">{email.trim()}</span>, a reset link is on its way.
              The link is valid for one use only.
            </div>
            {/* Deliberately not "no account with that email": confirming which
                addresses are registered would leak the user list. */}
            <Link
              href="/login"
              className="mt-6 block w-full rounded-xl bg-leaf-500 py-3 text-center font-semibold text-ink hover:bg-leaf-100"
            >
              Back to sign in
            </Link>
            <button
              type="button"
              onClick={() => { setStatus("idle"); setMessage(""); }}
              className="mt-4 w-full text-sm text-leaf-500 hover:text-leaf-100"
            >
              Send to a different address
            </button>
          </>
        ) : (
          <form onSubmit={submit}>
            <label className="mt-7 block text-sm font-semibold text-metal-200">Email</label>
            <div className="mt-2 flex items-center gap-2 rounded-xl border border-metal-600 bg-metal-900/60 px-3">
              <Mail size={18} className="text-metal-500" />
              <input
                className="w-full border-0 bg-transparent px-0 text-metal-50 focus:ring-0"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoComplete="email"
                autoFocus
              />
            </div>

            {message && status === "error" && (
              <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{message}</p>
            )}

            <button
              disabled={status === "loading"}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-leaf-500 py-3 font-semibold text-ink hover:bg-leaf-100 disabled:opacity-60"
            >
              <Send size={17} />
              {status === "loading" ? "Sending…" : "Send reset link"}
            </button>

            <Link href="/login" className="mt-4 block w-full text-center text-sm text-leaf-500 hover:text-leaf-100">
              Back to sign in
            </Link>
          </form>
        )}
      </div>
    </main>
  );
}
