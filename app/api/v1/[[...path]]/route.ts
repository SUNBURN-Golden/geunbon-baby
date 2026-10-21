import { handleApi, json } from '../../../../lib/api';
import { environment } from '../../../../lib/db';
export const dynamic = 'force-dynamic';
async function handler(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  try { return await handleApi(request, (await context.params).path ?? [], environment()); }
  catch { return json({ error: '데이터를 불러오지 못했습니다. DB 마이그레이션 상태를 확인해 주세요.' }, 503); }
}
export { handler as GET, handler as POST };
