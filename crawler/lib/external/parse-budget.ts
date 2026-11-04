// Optional pure parser budget. Linux callers share one budget across extraction passes.
export class ParseBudget {
  private units = 0;
  private work = 0;
  constructor(readonly maxBytes = 2097152, readonly maxWork = 8000000) {}
  spend(n = 1) { if ((this.work += n) > this.maxWork) throw new Error('preparation_limit'); }
  node(n = 1) { if ((this.units += n) > 50000) throw new Error('preparation_limit'); this.spend(n); }
  preflight(body: string, json = false) {
    if (body.length > this.maxBytes) throw new Error('preparation_limit');
    let depth = 0, quoted = false, escaped = false, tokens = 0;
    for (const c of body) {
      this.spend();
      if (json) {
        if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
        if (c === '"') { quoted = true; tokens++; }
        else if (c === '{' || c === '[') { if (++depth > 128) throw new Error('preparation_limit'); tokens++; }
        else if (c === '}' || c === ']') depth--;
        else if (c === ',' || c === ':') tokens++;
      } else if (c === '<') tokens++;
      if (tokens > 50000) throw new Error('preparation_limit');
    }
    // No DTD/entity processing, external resources, or declaration expansion.
    if (!json && /<!\s*(?:ENTITY|DOCTYPE(?!\s+html\s*>))/i.test(body)) throw new Error('unsupported_xml');
    if (!json) {
      const stack:string[]=[];
      const voids=new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
      for(let i=0;i<body.length;i++){
        if(body[i]!=='<')continue;
        if(body.startsWith('<!--',i)||body.startsWith('<![CDATA[',i)){
          const end=body.indexOf(body.startsWith('<!--',i)?'-->':']]>',i+4);
          i=end<0?body.length:end+2;continue;
        }
        let quote='',end=i+1;
        for(;end<body.length;end++){
          this.spend();if(end-i>8192)throw new Error('preparation_limit');
          const c=body[end];if(quote){if(c===quote)quote='';}else if(c==='"'||c==="'")quote=c;else if(c==='>')break;
        }
        if(end===body.length)throw new Error('preparation_schema');
        const tag=body.slice(i,end+1);this.node((tag.match(/(?:[\w:-]+)\s*=/g)??[]).length);
        const match=/^<(\/)?([a-z][\w:-]*)/i.exec(tag);
        if(match){const name=match[2].toLowerCase();
          if(match[1]){const at=stack.lastIndexOf(name);if(at>=0)stack.length=at;}
          else if(!voids.has(name)&&!tag.endsWith('/>')){
            stack.push(name);if(stack.length>128)throw new Error('preparation_limit');
            if(['script','style','textarea'].includes(name)){
              const close=new RegExp(`</${name}\\s*>`,'gi');close.lastIndex=end+1;
              const found=close.exec(body);i=found?close.lastIndex-1:body.length;stack.pop();continue;
            }
          }
        }
        i=end;
      }
    }
  }
}
export function boundedJson(body: string, budget: ParseBudget): unknown {
  budget.preflight(body, true);
  try { return JSON.parse(body); } catch { throw new Error('preparation_schema'); }
}
