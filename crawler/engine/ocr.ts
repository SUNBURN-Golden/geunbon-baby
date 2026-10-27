import { ToolAdapter } from './tools';
export const extractImage=(tools:ToolAdapter,file:string)=>tools.run('tesseract',[file,'stdout','-l','kor+eng']);
