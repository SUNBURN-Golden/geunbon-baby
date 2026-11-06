type Tab = {id?:number;url?:string};
declare const chrome: {
 storage:{local:{get:(key:string|null)=>Promise<Record<string,unknown>>;set:(items:Record<string,unknown>)=>Promise<void>;setAccessLevel:(arg:{accessLevel:string})=>Promise<void>}};
 action:{onClicked:{addListener:(fn:(tab:Tab)=>void)=>void};setBadgeText:(v:{text:string})=>Promise<void>};
 scripting:{executeScript:<T,A extends unknown[]>(v:{target:{tabId:number};world:'ISOLATED';func:(...args:A)=>T;args:A})=>Promise<{result:T}[]>};
 tabs:{query:(v:Record<string,unknown>)=>Promise<Tab[]>};
 alarms:{create:(name:string,v:{periodInMinutes:number})=>Promise<void>;onAlarm:{addListener:(fn:()=>void)=>void}};
 runtime:{id:string;onStartup:{addListener:(fn:()=>void)=>void};onInstalled:{addListener:(fn:()=>void)=>void}};
 permissions:{contains:(v:{origins:string[]})=>Promise<boolean>;request:(v:{origins:string[]})=>Promise<boolean>;onRemoved:{addListener:(fn:()=>void)=>void}};
};
