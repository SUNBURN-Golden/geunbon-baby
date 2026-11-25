export type AlertTargetType = 'model' | 'seller';
export type AlertStatus = 'success' | 'invalid' | 'target' | 'retry';
export type AlertSearch = { alert?: string | string[]; alert_seller?: string | string[] };
export const alertAnchor = (type: AlertTargetType, id: string) => `alert-${type}-${id}`;
export const isPlaceholderSeller = (id: string) => /^ext-.*-unknown$/.test(id);

export function alertStatus(value: AlertSearch['alert']): AlertStatus | undefined {
  if (value === 'success' || value === 'invalid' || value === 'target' || value === 'retry') return value;
}
