'use client';

import { useState } from 'react';
import { isImageUrl } from '../../lib/image-url';

export function DealImage({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!isImageUrl(src) || failed === src) return null;
  // Signed CDN URLs load only in the browser; no optimization/proxy fetch.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="deal-image" src={src} alt={alt} width={640} height={480}
    loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(src)} />;
}
