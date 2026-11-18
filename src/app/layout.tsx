import type { Metadata } from "next";
import { RealtimeProvider } from "@/hooks/use-realtime";
import "./globals.css";

export const metadata: Metadata = {
  title: "Atelier Restaurant — SmartFloor",
  description: "Live restaurant digital twin and service floor for Atelier Restaurant.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>
        <RealtimeProvider>{children}</RealtimeProvider>
      </body>
    </html>
  );
}
