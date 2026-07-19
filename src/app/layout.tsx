import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";

// Inter is the product typeface (Geist is a design-token alternative only). Self-hosted by next/font
// so there is no external fetch and no flash of fallback text; exposed as --font-inter, which
// globals.css wires into --font-sans.
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "jobchat.dev - the jobs market, answered",
  description: "Ask a question, get a verdict with a chart - from live job postings.",
};

/** Theme is read from the cookie server-side and stamped on <html> before paint (no FOUC). */
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const theme = (await cookies()).get("theme")?.value === "dark" ? "Dark" : "Light";
  return (
    <html lang="en" data-theme={theme} data-font="Inter" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
