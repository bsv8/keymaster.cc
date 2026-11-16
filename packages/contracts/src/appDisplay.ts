export interface AppDisplay {name:string;description:string;icon:string}
export function validateAppDisplay(input:unknown):AppDisplay {
 if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).sort().join(",")!=="description,icon,name")throw new Error("directory display fields invalid");
 const d=input as AppDisplay;
 for(const [field,limit]of [["name",120],["description",2000],["icon",8192]] as const){const v=d[field];if(typeof v!=="string"||v!==v.trim()||[...v].length>limit||/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(v)||(field!=="description"&&!v))throw new Error("directory display invalid")}
 return {name:d.name,description:d.description,icon:d.icon};
}
