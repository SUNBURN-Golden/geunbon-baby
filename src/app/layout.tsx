import type { Metadata } from "next";
import { SampleBanner } from "@/components/sample-banner";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "근본 · 프리미엄 기어 시세와 공구",
    template: "%s · 근본",
  },
  description:
    "스토케, 부가부, 베이비뵨처럼 오래 쓰는 프리미엄 육아 기어의 공구가·공식가·병행수입가·해외가·중고 시세. 거래 당사자가 아니며 결제하지 않습니다.",
  applicationName: "근본",
  openGraph: {
    title: "근본 · 프리미엄 기어 시세와 공구",
    description: "아이코닉 베이비 기어의 가격과 인스타 공구를 한곳에서 비교합니다.",
    locale: "ko_KR",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <SampleBanner />
        {children}
      </body>
    </html>
  );
}
