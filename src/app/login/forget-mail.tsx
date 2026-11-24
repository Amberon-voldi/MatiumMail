"use client";

import { useEffect } from "react";
import { forgetAllMail } from "@/lib/mail-cache";

/** Signed out: nothing of anyone's mail stays on this device. */
export function ForgetMail() {
  useEffect(() => {
    void forgetAllMail();
  }, []);
  return null;
}
