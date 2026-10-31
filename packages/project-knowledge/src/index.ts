import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectRoot, VERSION, inputContract } from "../../contracts/src/index.js";
import { hash, type Json } from "../../contracts/src/domain.js";
import type { Repository } from "../../persistence/src/repository.js";
export function tokens(text:string) {
  const result=new Set(text.toLowerCase().match(/[a-z0-9_]+/g)??[]);
  for(const sequence of text.match(/[\p{Script=Han}]+/gu)??[])for(let i=0;i<sequence.length-1;i++)result.add(sequence.slice(i,i+2));
  for(const [ch,en] of [["试运行","staging"],["生产","production"],["编排","workflow"],["绑定","binding"]])if(text.includes(ch!)||text.toLowerCase().includes(en!)){result.add(en!);for(let i=0;i<ch!.length-1;i++)result.add(ch!.slice(i,i+2));}
  return [...result].slice(0,500);
}
export class ProjectKnowledge {
  constructor(readonly repo:Repository){this.rebuild();}
  rebuild() {
    const sources=["README.md","docs/HOST_INTEGRATION.md","docs/V2_USER_GUIDE.md"];
    this.repo.tx(()=>{
      this.repo.db.exec("DELETE FROM knowledge_fts; DELETE FROM knowledge_chunks; DELETE FROM knowledge_documents");
      for(const path of sources) {
        let text;try{text=readFileSync(resolve(projectRoot,path),"utf8");}catch{continue;}
        const lines=text.split("\n"),documentId=hash(path);
        this.repo.put("knowledge_documents",documentId,{id:documentId,sourcePath:path,contentHash:hash(text),productVersion:VERSION});
        let heading=path;
        for(let offset=0,index=0;offset<lines.length;offset+=24,index++) {
          const content=lines.slice(offset,offset+24).join("\n");
          heading=content.match(/^#{1,4}\s+(.+)/m)?.[1]??heading;
          const chunkId=documentId+":"+index,citation={sourcePath:path,heading,lineStart:offset+1,lineEnd:Math.min(lines.length,offset+24),contentHash:hash(content),productVersion:VERSION,availability:"implemented"};
          this.repo.put("knowledge_chunks",chunkId,{id:chunkId,documentId,chunkIndex:index,content,...citation});
          this.repo.db.prepare("INSERT INTO knowledge_fts(chunk_id,tokens) VALUES(?,?)").run(chunkId,tokens(content).join(" "));
        }
      }
      for(const [name,definition] of Object.entries(inputContract.$defs) as [string,Json][]) {
        if(!definition.description)continue;
        const content=name+" "+definition.description,chunkId="tool:"+name;
        const sourceLines=readFileSync(resolve(projectRoot,"contracts/mcp-v2-tool-inputs.schema.json"),"utf8").split("\n"),defs=sourceLines.findIndex(l=>l.trim()==='"$defs": {');
        const lineStart=sourceLines.findIndex((l,index)=>index>defs&&l.trim()===JSON.stringify(name)+": {")+1;
        const lineEnd=sourceLines.findIndex((l,index)=>index>=lineStart&&l.trim().startsWith('"description":')&&l.includes(JSON.stringify(definition.description)))+1;
        this.repo.put("knowledge_chunks",chunkId,{id:chunkId,documentId:"tools",chunkIndex:name,content,sourcePath:"contracts/mcp-v2-tool-inputs.schema.json",heading:name,lineStart,lineEnd:Math.max(lineStart,lineEnd),contentHash:hash(content),productVersion:VERSION,availability:"implemented"});
        this.repo.db.prepare("INSERT INTO knowledge_fts VALUES(?,?)").run(chunkId,tokens(content).join(" "));
      }
    });
  }
  search(a:Json) {
    const query=tokens(String(a.query??""));if(!query.length)return {excerpts:[],citations:[]};
    const expression=query.slice(0,40).map(t=>'"'+t.replaceAll('"','""')+'"').join(" OR ");
    const rows=this.repo.db.prepare("SELECT chunk_id,bm25(knowledge_fts) AS score FROM knowledge_fts WHERE knowledge_fts MATCH ? ORDER BY score LIMIT ?")
      .all(expression,Math.min(20,Number(a.limit??5))) as {chunk_id:string}[];
    const excerpts=rows.map(row=>this.repo.get("knowledge_chunks",row.chunk_id)).filter(Boolean).filter(c=>!a.productVersion||c.productVersion===a.productVersion);
    return {excerpts,citations:excerpts.map(({content,id,documentId,chunkIndex,...c}:Json)=>c)};
  }
}
