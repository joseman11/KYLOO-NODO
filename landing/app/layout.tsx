import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

const display = localFont({ src: "./fonts/bricolage.woff2", variable: "--font-display", weight: "200 800", display: "swap" });
const text = localFont({ src: "./fonts/inter.woff2", variable: "--font-text", weight: "100 900", display: "swap" });
const mono = localFont({
  src: [
    { path: "./fonts/plex-mono-400.woff2", weight: "400" },
    { path: "./fonts/plex-mono-500.woff2", weight: "500" },
    { path: "./fonts/plex-mono-600.woff2", weight: "600" },
  ],
  variable: "--font-mono",
  display: "swap",
});

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: "Nodo · El comandero que sigue cuando se cae el internet",
  description:
    "Nodo es el comandero para restaurantes que funciona en tu red local: tablets de meseros, cocina, barra, caja e impresoras de tickets, sin depender del internet.",
  icons: { icon: "/brand/icon.svg" },
  openGraph: {
    title: "Nodo · Comandero para restaurantes",
    description: "Meseros, cocina, barra y caja conectados por tu propia red. Sigue funcionando sin internet.",
    images: ["/videos/hero.jpg"],
    locale: "es_MX",
    type: "website",
  },
};

export const viewport: Viewport = { themeColor: "#14110f" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${display.variable} ${text.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
