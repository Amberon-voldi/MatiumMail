import type { Metadata } from "next";
import { ForgetMail } from "./forget-mail";
import { LoginForm } from "./login-form";
import { LoginShell } from "./login-shell";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <LoginShell
      title="Sign in to Matium Mail"
      subtitle="Use your work email address and its mailbox password, or your Matium Mail password."
    >
      <ForgetMail />
      <LoginForm />
    </LoginShell>
  );
}
