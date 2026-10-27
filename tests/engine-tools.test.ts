import { expect, test, vi } from 'vitest';
import { extractPdf, extractImage, ToolAdapter } from '../crawler/engine';
import { fixture } from './helpers/collector';
test('ENOENT is cached and explicitly recorded as unsupported without retrying',async()=>{
 const f=fixture();try{
  const exec=vi.fn(async()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'});});const tool=new ToolAdapter(f.store,exec);
  expect(await extractImage(tool,'/tmp/example-only')).toEqual({status:'unsupported',tool:'tesseract'});await extractImage(tool,'/tmp/example-only');expect(exec).toHaveBeenCalledTimes(1);
  expect(f.store.db.prepare('SELECT status FROM engine_tool_support WHERE tool=?').get('tesseract')).toMatchObject({status:'unsupported'});
 }finally{f.close();}
});
test('PDF/OCR use local tools with bounded execFile calls; timeout is retryable',async()=>{
 const f=fixture();try{
  const exec=vi.fn(async()=>({stdout:'example_only local text'}));const tool=new ToolAdapter(f.store,exec);
  await extractPdf(tool,'/tmp/example-only.pdf');await extractImage(tool,'/tmp/example-only.png');
  expect(exec.mock.calls).toContainEqual(['pdftotext',['-layout','-enc','UTF-8','/tmp/example-only.pdf','-'],{timeout:30000,maxBuffer:2097152}]);
  expect(exec.mock.calls).toContainEqual(['tesseract',['/tmp/example-only.png','stdout','-l','kor+eng'],{timeout:30000,maxBuffer:2097152}]);
  const failing=new ToolAdapter(f.store,async()=>{throw new Error('timeout');});await expect(failing.probeTool('example-tool')).rejects.toThrow('tool_timeout');
 }finally{f.close();}
});
test('transient tool probe timeout can be retried instead of caching a rejected promise forever',async()=>{
 const f=fixture();try{
  const execute=vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({stdout:'example_only version'}),tools=new ToolAdapter(f.store,execute);
  await expect(tools.probeTool('pdftotext')).rejects.toThrow('tool_timeout');expect(await tools.probeTool('pdftotext')).toBe(true);expect(execute).toHaveBeenCalledTimes(2);
 }finally{f.close();}
});
