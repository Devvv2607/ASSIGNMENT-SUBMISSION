import { Suspense } from "react";
import { AddFlow } from "./AddFlow";

export const metadata = { title: "Add a person — Proxy" };

export default function AddPage() {
  return (
    <Suspense>
      <AddFlow />
    </Suspense>
  );
}
