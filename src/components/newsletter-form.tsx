"use client";

import { useState } from "react";

export function NewsletterForm({ source = "home" }: { source?: string }) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(unsubscribe: boolean) {
    setPending(true);
    setError(null);
    setMessage(null);
    const response = await fetch("/api/newsletter", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, source, unsubscribe }),
    });
    const body = await response.json().catch(() => null);
    setPending(false);
    if (!response.ok || !body?.ok) {
      setError(body?.error?.message ?? "저장하지 못했습니다.");
      return;
    }
    if (body.data.status === "exists") setMessage("이미 구독 중인 주소입니다.");
    else if (body.data.status === "removed") setMessage("구독 목록에서 제거했습니다.");
    else setMessage("이메일을 저장했습니다. 외부 발송 도구로는 자동 전송하지 않습니다.");
    if (!unsubscribe) setEmail("");
  }

  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(false);
      }}
    >
      <label className="field">
        <span>이메일</span>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
        />
      </label>
      <div className="row-actions">
        <button className="button" type="submit" disabled={pending}>
          구독 저장
        </button>
        <button className="button ghost" type="button" disabled={pending} onClick={() => void submit(true)}>
          구독 해지
        </button>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      {message ? <p className="form-success">{message}</p> : null}
    </form>
  );
}
