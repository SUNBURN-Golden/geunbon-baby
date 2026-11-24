'use client';

import { useState, type ReactElement } from 'react';
import { offerImage } from '../../shared/verified-offer';
import { isImageUrl } from '../../lib/image-url';

export function DealImage({ src, alt, fallback = null, verifiedOffer = false }: { src: string | null; alt: string; fallback?: ReactElement | null; verifiedOffer?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || !(verifiedOffer ? offerImage(src) : isImageUrl(src)) || failed === src) return fallback;
  // Signed CDN URLs load only in the browser; no optimization/proxy fetch.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="deal-image" src={src} alt={alt} width={640} height={480}
    loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(src)} />;
}
