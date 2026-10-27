import { ToolAdapter } from './tools';
export const extractPdf=(tools:ToolAdapter,file:string)=>tools.run('pdftotext',['-layout','-enc','UTF-8',file,'-'],['-v']);
