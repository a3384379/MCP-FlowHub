import {readdir,readFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {createHash} from "node:crypto";
import {fileURLToPath,pathToFileURL} from "node:url";

export async function executionSnapshot(root) {
  const sourceFiles={},compiledFiles={},digest=bytes=>createHash("sha256").update(bytes).digest("hex");
  const walk=async(path,target)=>{
    let entries;try{entries=await readdir(join(root,path),{withFileTypes:true});}catch(error){if(error.code==="ENOENT")return;throw error;}
    for(const entry of entries){
      if(entry.isSymbolicLink()||["node_modules",".git"].includes(entry.name))continue;
      const child=path+"/"+entry.name;
      if(entry.isDirectory())await walk(child,target);
      else if(/\.(?:[cm]?js|tsx?|json|css|html|md|sql)$/.test(entry.name))target[child]=digest(await readFile(join(root,child)));
    }
  };
  for(const path of ["apps","packages","tests","contracts","scripts","examples","templates"])await walk(path,sourceFiles);
  for(const path of ["dist/apps","dist/packages","dist/tests","web-dist"])await walk(path,compiledFiles);
  for(const path of ["package.json","package-lock.json","README.md","docs/HOST_INTEGRATION.md","docs/V2_USER_GUIDE.md","docs/DISCOVERY_LOCALIZATION.md","docs/V2_MIGRATION.md"])
    sourceFiles[path]=digest(await readFile(join(root,path)));
  return {capturedAt:new Date().toISOString(),node:process.versions.node,platform:process.platform,arch:process.arch,sourceFiles,compiledFiles};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  console.log(JSON.stringify(await executionSnapshot(fileURLToPath(new URL("../",import.meta.url))),null,2));
