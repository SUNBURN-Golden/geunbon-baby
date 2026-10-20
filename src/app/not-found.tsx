import Link from "next/link";

export default function NotFound() {
  return (
    <section className="wrap section">
      <h1 className="serif">페이지를 찾지 못했습니다</h1>
      <p>
        <Link href="/">홈으로</Link>
      </p>
    </section>
  );
}
