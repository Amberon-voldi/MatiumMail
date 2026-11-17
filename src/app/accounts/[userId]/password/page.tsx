import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";
import { setAppPasswordAction } from "@/app/actions/account";
import { Button } from "@/components/ui/button";
import { APP_PASSWORD_MIN_LENGTH, hasAppPassword } from "@/server/auth/app-password";
import { requireSignedInUser } from "@/server/auth/dal";
import { AppPasswordForm } from "./app-password-form";

export const metadata: Metadata = { title: "Matium Mail password" };

export default function AppPasswordPage(props: PageProps<"/accounts/[userId]/password">) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 items-center gap-2 border-b px-4">
        <Button asChild variant="ghost" size="icon" aria-label="Back to accounts">
          <Link href="/accounts">
            <ArrowLeft />
          </Link>
        </Button>
        <h1 className="text-sm font-semibold">Matium Mail password</h1>
      </header>
      <Suspense fallback={<div className="m-auto text-sm text-muted-foreground">Loading…</div>}>
        <AppPassword params={props.params} />
      </Suspense>
    </div>
  );
}

async function AppPassword({ params }: Pick<PageProps<"/accounts/[userId]/password">, "params">) {
  const { userId } = await params;
  if (!z.uuid().safeParse(userId).success) notFound();
  const user = await requireSignedInUser(userId);
  const isSet = await hasAppPassword(user.id);
  return (
    <div className="mx-auto w-full max-w-md space-y-6 p-6">
      <div className="space-y-2 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">{user.email}</p>
        <p>
          {isSet
            ? "This account has a Matium Mail password. You can change it here."
            : "Set a shorter password for signing in to this account here."}{" "}
          It only works on Matium Mail.
        </p>
        <p>The mailbox password keeps working too, and it&apos;s still the one other mail apps use.</p>
        <p>
          If the mailbox password is changed in mPanel, sign in once with the new one; after that this password works
          again.
        </p>
      </div>
      <AppPasswordForm
        action={setAppPasswordAction.bind(null, user.id)}
        email={user.email}
        minLength={APP_PASSWORD_MIN_LENGTH}
      />
    </div>
  );
}
