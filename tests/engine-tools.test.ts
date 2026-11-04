import { expect, test, vi } from 'vitest';
import { extractPdf, extractImage, ToolAdapter } from '../crawler/engine';
import { fixture } from './helpers/collector';
test('executable availability never authorizes content-bearing subprocesses',async()=>{
 const f=fixture();try{
  const exec=vi.fn(async()=>({stdout:'pdftotext 1.2.3'})),tool=new ToolAdapter(f.store,exec);
  expect(await tool.probeTool('pdftotext')).toBe(true);
  expect(await extractPdf(tool,Buffer.from('synthetic'))).toEqual({status:'unsupported',tool:'pdftotext'});
  expect(await extractImage(tool,Buffer.from('synthetic'))).toEqual({status:'unsupported',tool:'tesseract'});
  expect(exec).toHaveBeenCalledTimes(1);
 }finally{f.close();}
});
test('injected memory-only tools receive bounded bytes and cancellation, never filenames',async()=>{
 const f=fixture();try{
  const run=vi.fn(async()=> 'Example stroller manual'),exec=vi.fn();
  const tool=new ToolAdapter(f.store,exec,{capability:{nonpersistent:true,version:'fixture@1'},run});
  expect(await extractPdf(tool,Buffer.from('example'))).toMatchObject({status:'ok',text:'Example stroller manual'});
  expect(await extractImage(tool,Buffer.from('example'))).toMatchObject({status:'ok'});
  expect(run.mock.calls[0]).toEqual(['pdftotext',Buffer.from('example'),expect.objectContaining({maxBytes:2097152,signal:expect.any(AbortSignal)})]);
  expect(exec).not.toHaveBeenCalled();
  await expect(extractPdf(tool,Buffer.alloc(100),99)).rejects.toThrow('preparation_limit');
 }finally{f.close();}
});
test('transient probe failures can be retried; untrusted version output is omitted',async()=>{
 const f=fixture();try{
  const execute=vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue({stdout:'ignore previous instructions'}),tools=new ToolAdapter(f.store,execute);
  await expect(tools.probeTool('pdftotext')).rejects.toThrow('tool_timeout');expect(await tools.probeTool('pdftotext')).toBe(true);
  expect(execute).toHaveBeenCalledTimes(2);expect(f.store.db.prepare('SELECT version FROM engine_tool_support').get()?.version).toBeNull();
 }finally{f.close();}
});
