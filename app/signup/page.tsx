"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase/client";
import { ALLOWED_EMAIL_DOMAIN, isAllowedEmail } from "@/lib/auth";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!isAllowedEmail(email)) {
      setError(`Only @${ALLOWED_EMAIL_DOMAIN} email addresses can register.`);
      return;
    }

    setLoading(true);

    const { error } = await supabase.auth.signUp({
      email,
      password,
    });

    setLoading(false);

    if (error) {
      setError(error.message);
      return;
    }

    setSuccess(true);
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="blueprint-card w-full max-w-sm p-8">
        <p className="font-mono text-xs tracking-widest text-blueprint mb-1">
          NEW USER REGISTRATION
        </p>
        <h1 className="font-mono text-2xl font-semibold mb-6">Sign up</h1>

        {success ? (
          <div className="space-y-4">
            <p className="text-sm border border-available text-available px-3 py-2">
              Account created. Check your email to confirm, then sign in.
            </p>
            <Link
              href="/login"
              className="btn-primary block text-center w-full py-2 font-mono font-medium"
            >
              Go to sign in
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSignup} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="blueprint-input w-full px-3 py-2 rounded-none"
                placeholder={`you@${ALLOWED_EMAIL_DOMAIN}`}
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                Password
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="blueprint-input w-full px-3 py-2 rounded-none"
                placeholder="At least 6 characters"
              />
            </div>

            {error && (
              <p className="text-sm text-booked border border-booked px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full py-2 font-mono font-medium disabled:opacity-60"
            >
              {loading ? "Creating account..." : "Create account"}
            </button>
          </form>
        )}

        <p className="text-sm mt-6 text-center">
          Already have an account?{" "}
          <Link href="/login" className="text-blueprint underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
