"use client";

import { useEffect, useId, useState } from "react";

export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/:/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: "base",
        themeVariables: { background: "#1b1815", primaryColor: "#24201c", primaryTextColor: "#f3ead8", primaryBorderColor: "#e8a066", lineColor: "#a89c88", fontFamily: "Inter, sans-serif", fontSize: "14px" },
      });
      const { svg } = await mermaid.render(`m${id}`, chart);
      if (alive) setSvg(svg);
    });
    return () => {
      alive = false;
    };
  }, [chart, id]);
  if (!svg) return <pre className="overflow-x-auto text-xs text-muted">{chart}</pre>;
  return <div className="flex justify-center overflow-x-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}
