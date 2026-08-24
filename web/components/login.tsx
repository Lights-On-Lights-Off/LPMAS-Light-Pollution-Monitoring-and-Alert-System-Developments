"use client";

import { FormEvent, useState } from "react";
import { ArrowLeft, Eye, EyeOff, LockKeyhole, Mail } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Link from "next/link";

export function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setMessage("");

    if (!supabase) {
      setMessage("Supabase is not configured. Check your .env.local values.");
      setLoading(false);
      return;
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", data.user.id)
      .single();

    if (profileError || !profile) {
  console.error("Profile query error:", profileError);
  setMessage(
    `Profile error: ${profileError?.message || "No profile record returned"}`
  );
  await supabase.auth.signOut();
  return;
}
    router.replace("/dashboard");
    router.refresh();
  }

  async function resetPassword() {
    if (!supabase) { setMessage("Supabase is not configured."); return; }
    if (!email) { setMessage("Enter your email address first."); return; }
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}/login`
    });
    setMessage(error?.message ?? "Password reset email sent.");
  }

  return <main className="relative grid min-h-screen place-items-center overflow-hidden bg-leaf-900 p-5">
    <div className="absolute inset-0 opacity-15 [background-image:radial-gradient(circle_at_20%_25%,#d9a441_0,transparent_30%),radial-gradient(circle_at_85%_80%,#8f631f_0,transparent_22%)]" />
    <Link href="/" className="absolute left-5 top-5 z-10 flex items-center gap-2 text-sm text-metal-300 hover:text-metal-50">
      <ArrowLeft size={17} /> Back to home
    </Link>
    <form onSubmit={submit} className="metal-panel relative w-full max-w-md rounded-3xl border border-metal-600 p-8 shadow-soft">
      <img src="/Hayag-logo.png" alt="LPMAS" className="mx-auto h-14 w-14 object-contain" />
      <h1 className="mt-5 text-center text-2xl font-bold text-metal-50">Welcome to LPMAS</h1>
      <p className="mt-2 text-center text-sm text-metal-400">Sign in to access the Flowerland monitoring dashboard.</p>
      <label className="mt-7 block text-sm font-semibold text-metal-200">Email</label>
      <div className="mt-2 flex items-center gap-2 rounded-xl border border-metal-600 bg-metal-900/60 px-3">
        <Mail size={18} className="text-metal-500" />
        <input className="w-full border-0 bg-transparent px-0 text-metal-50 focus:ring-0" type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" />
      </div>
      <label className="mt-4 block text-sm font-semibold text-metal-200">Password</label>
      <div className="mt-2 flex items-center gap-2 rounded-xl border border-metal-600 bg-metal-900/60 px-3">
        <LockKeyhole size={18} className="text-metal-500" />
        <input className="w-full border-0 bg-transparent px-0 text-metal-50 focus:ring-0" type={showPassword ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" />
        <button type="button" onClick={() => setShowPassword(!showPassword)} className="text-metal-500 hover:text-metal-200" aria-label="Show password">{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button>
      </div>
      {message && <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{message}</p>}
      <button disabled={loading} className="mt-6 w-full rounded-xl bg-leaf-500 py-3 font-semibold text-ink hover:bg-leaf-100 disabled:opacity-60">{loading ? "Signing in..." : "Sign in"}</button>
      <button type="button" onClick={resetPassword} className="mt-4 w-full text-sm text-leaf-500 hover:text-leaf-100">Forgot password?</button>
    </form>
  </main>;
}
