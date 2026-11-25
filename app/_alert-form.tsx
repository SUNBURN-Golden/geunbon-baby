'use client';

import { useRef, useState, type FormEvent } from 'react';
import { alertAnchor, type AlertStatus, type AlertTargetType } from '../lib/alert-target';
import { homeCopy } from '../lib/copy/home.ko';

export function AlertForm({ type, id, initialStatus }: { type: AlertTargetType; id: string; initialStatus?: AlertStatus }) {
  const anchor = alertAnchor(type, id);
  const [status, setStatus] = useState<AlertStatus | 'pending' | undefined>(initialStatus);
  const pending = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    pending.current = true;
    setStatus('pending');
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(data)),
      });
      const { result } = await response.json<{ result?: AlertStatus }>();
      if (response.ok && result === 'success') {
        form.reset();
        setStatus('success');
      } else {
        setStatus(result === 'invalid' || result === 'target' ? result : 'retry');
      }
    } catch {
      setStatus('retry');
    } finally {
      pending.current = false;
    }
  }

  return (
    <form className="alert-form" id={anchor} method="post" action="/api/v1/alerts" onSubmit={submit} aria-label={homeCopy.alert.title}>
      <input type="hidden" name="target_type" value={type} />
      <input type="hidden" name="target_id" value={id} />
      <label htmlFor={`${anchor}-email`}>{homeCopy.alert.email}</label>
      <div className="alert-controls">
        <input id={`${anchor}-email`} name="email" type="email" autoComplete="email" required maxLength={254} aria-describedby={`${anchor}-result`} />
        <button type="submit" disabled={status === 'pending'}>{homeCopy.alert.submit}</button>
      </div>
      <p id={`${anchor}-result`} role="status">{status && homeCopy.alert[status]}</p>
    </form>
  );
}
