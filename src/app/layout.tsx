import type { Metadata } from "next";
import { Cairo } from "next/font/google";
import "./globals.css";

// خط عربي جيد للواجهة كاملة
const cairo = Cairo({
  subsets: ["arabic", "latin"],
  variable: "--font-cairo",
});

export const metadata: Metadata = {
  title: "مولد الوسائط — لوحة الإدارة",
  description: "خادم MCP لتوليد الصور والفيديو ودمج المقاطع مع إدارة المفاتيح المتسلسلة",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl">
      <body className={`${cairo.variable} font-sans antialiased`}>{children}</body>
    </html>
  );
}
