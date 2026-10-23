// This function is serialized into an isolated browser world. Keep it self-contained.
export function extractRegion(selector:string, selectionOnly=false, expectedUrl='') {
  if(expectedUrl){const expected=new URL(expectedUrl),current=new URL(location.href);if(expected.origin!==current.origin||expected.pathname!==current.pathname)throw new Error('document_changed');}
  if(document.querySelector('input[type=password], [data-private-page]'))throw new Error('private_page');
  const forbidden='input,textarea,select,[contenteditable], [hidden], [aria-hidden="true"], nav,header,footer,[data-private],.profile,.comments,.messages,script,style,iframe';
  if(/\/(direct|messages|mail|account|member|profile|login)(\/|$)/i.test(location.pathname))throw new Error('private_page');
  const selection=window.getSelection();const range=selection?.rangeCount?selection.getRangeAt(0):null;
  const root=selectionOnly?range?.commonAncestorContainer:(selector?document.querySelector(selector):null);
  if(!root)throw new Error('region_required');
  const element=root.nodeType===Node.ELEMENT_NODE?root as Element:root.parentElement;
  if(!element||element.closest(forbidden)||element.querySelector('[type=password]'))throw new Error('private_region');
  if(range&&selectionOnly&&[...document.querySelectorAll(forbidden)].some(el=>range.intersectsNode(el)))throw new Error('private_selection');
  const clone=element.cloneNode(true) as Element;clone.querySelectorAll(`${forbidden},script,style,img,video,canvas,svg,iframe`).forEach(el=>el.remove());
  // Text nodes only, never values, attributes, HTML, cookies, images or page.content().
  const walker=document.createTreeWalker(clone,NodeFilter.SHOW_TEXT);const lines:string[]=[];while(walker.nextNode())lines.push(walker.currentNode.textContent??'');
  const text=selectionOnly?selection!.toString():lines.join('\n');
  // Canonical metadata alone is not an explicit republication relationship.
  const documentOrigin=document.querySelector<HTMLLinkElement>('link[rel=original]')?.href;
  return {documentOrigin,text:text.slice(0,4000),title:clone.querySelector('h1,h2')?.textContent?.slice(0,200)??'',locator:selectionOnly?'user-selection':selector};
}
