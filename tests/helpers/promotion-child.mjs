import './offline-child.mjs';
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url,options) => {
  const body=JSON.parse(options.body);appendFileSync(process.env.PROMOTION_TEST_CALLS,JSON.stringify({url,body})+'\n');
  if(url.endsWith('/api/v1/ingest')) return Response.json({data:process.env.PROMOTION_TEST_MISSING_ID==='1'?{}:{id:'exact-ingested-id',status:'candidate'}},{status:202});
  if(url.endsWith('/api/v1/admin/candidates/exact-ingested-id')) return Response.json({data:{deal_id:'fixture-deal'}});
  throw new Error('unrelated_candidate_or_endpoint');
};
