import { ToolAdapter } from './tools';
export const extractImage=(tools:ToolAdapter,bytes:Buffer,maxBytes=2097152)=>tools.runBytes('tesseract',bytes,maxBytes);
