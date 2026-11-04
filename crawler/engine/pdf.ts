import { ToolAdapter } from './tools';
export const extractPdf=(tools:ToolAdapter,bytes:Buffer,maxBytes=2097152)=>tools.runBytes('pdftotext',bytes,maxBytes);
