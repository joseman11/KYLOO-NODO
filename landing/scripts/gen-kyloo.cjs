// Genera components/Kyloo.tsx a partir de public/brand/kyloo.svg (logotipo vectorial, hereda el color).
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const k = fs.readFileSync(path.join(root, "public/brand/kyloo.svg"), "utf8").replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "").replace(/fill-rule=/g, "fillRule=");
fs.writeFileSync(
  path.join(root, "components/Kyloo.tsx"),
  `export function Kyloo({ width = 76 }: { width?: number }) {
  return (
    <svg role="img" aria-label="Kyloo" width={width} viewBox="0 0 214 80" fill="currentColor" style={{ display: "block" }}>
      ${k}
    </svg>
  );
}
`,
);
console.log("Kyloo.tsx listo");
