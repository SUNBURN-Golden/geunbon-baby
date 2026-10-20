import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="links">
          <Link href="/models">모델</Link>
          <Link href="/group-buys">공구</Link>
          <Link href="/submit">제보</Link>
          <Link href="/legal">안내</Link>
          <Link href="/admin">관리</Link>
        </div>
        <p>
          근본은 판매자, 구매 대행, 공구 주최자가 아닙니다. 가격은 참고용이며 샘플로 표시된 금액은 실제 판매가가
          아닙니다. 유료 게재에는 광고 표시를 붙입니다. 이동은 외부 링크뿐이고, 이 서비스 안에서 결제하지 않습니다.
        </p>
      </div>
    </footer>
  );
}
