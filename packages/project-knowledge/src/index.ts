import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectRoot, VERSION, inputContract } from "../../contracts/src/index.js";
import { ensure, hash, type Json } from "../../contracts/src/domain.js";
import type { Repository } from "../../persistence/src/repository.js";
export function tokens(text:string,limit=500) {
  const result=new Set(text.toLowerCase().match(/[a-z0-9_]+/g)??[]);
  for(const sequence of text.match(/[\p{Script=Han}]+/gu)??[])for(let i=0;i<sequence.length-1;i++)result.add(sequence.slice(i,i+2));
  for(const [ch,en] of [["试运行","staging"],["生产","production"],["编排","workflow"],["绑定","binding"]])if(text.includes(ch!)||text.toLowerCase().includes(en!)){result.add(en!);for(let i=0;i<ch!.length-1;i++)result.add(ch!.slice(i,i+2));}
  return [...result].slice(0,limit);
}
export class ProjectKnowledge {
  constructor(readonly repo:Repository,readonly root=projectRoot){this.rebuild();}
  rebuild() {
    const sources=["README.md","docs/HOST_INTEGRATION.md","docs/V2_USER_GUIDE.md","docs/DISCOVERY_LOCALIZATION.md"];
    this.repo.tx(()=>{
      this.repo.db.exec("DELETE FROM knowledge_fts; DELETE FROM knowledge_chunks; DELETE FROM knowledge_documents");
      for(const path of sources) {
        let text;try{text=readFileSync(resolve(this.root,path),"utf8");}catch{continue;}
        const lines=text.split("\n"),documentId=hash(path);
        this.repo.put("knowledge_documents",documentId,{id:documentId,sourcePath:path,contentHash:hash(text),productVersion:VERSION});
        let heading=path;
        for(let offset=0,index=0;offset<lines.length;offset+=24,index++) {
          const content=lines.slice(offset,offset+24).join("\n");
          heading=content.match(/^#{1,4}\s+(.+)/m)?.[1]??heading;
          const chunkId=documentId+":"+index,citation={sourcePath:path,heading,lineStart:offset+1,lineEnd:Math.min(lines.length,offset+24),contentHash:hash(content),productVersion:VERSION,availability:"implemented"};
          this.repo.put("knowledge_chunks",chunkId,{id:chunkId,documentId,chunkIndex:index,content,...citation});
          // Index the tail of owned long paragraphs too. Query token and FTS
          // expression budgets remain unchanged.
          this.repo.db.prepare("INSERT INTO knowledge_fts(chunk_id,tokens) VALUES(?,?)").run(chunkId,tokens(content,20000).join(" "));
        }
      }
      for(const [name,definition] of Object.entries(inputContract.$defs) as [string,Json][]) {
        if(!definition.description)continue;
        const chunkId="tool:"+name;
        const sourceLines=readFileSync(resolve(this.root,"contracts/mcp-v2-tool-inputs.schema.json"),"utf8").split("\n"),defs=sourceLines.findIndex(l=>l.trim()==='"$defs": {');
        const lineStart=sourceLines.findIndex((l,index)=>index>defs&&l.trim()===JSON.stringify(name)+": {")+1;
        const lineEnd=sourceLines.findIndex((l,index)=>index>=lineStart&&l.trim().startsWith('"description":')&&l.includes(JSON.stringify(definition.description)))+1;
        const content=sourceLines.slice(lineStart-1,Math.max(lineStart,lineEnd)).join("\n");
        this.repo.put("knowledge_chunks",chunkId,{id:chunkId,documentId:"tools",chunkIndex:name,content,sourcePath:"contracts/mcp-v2-tool-inputs.schema.json",heading:name,lineStart,lineEnd:Math.max(lineStart,lineEnd),contentHash:hash(content),productVersion:VERSION,availability:"implemented"});
        this.repo.db.prepare("INSERT INTO knowledge_fts VALUES(?,?)").run(chunkId,tokens(content,20000).join(" "));
      }
    });
  }
  source(a:Json) {
    ensure(typeof a.chunkId==="string"&&a.chunkId.length>=1&&a.chunkId.length<=256,"INPUT_INVALID","Invalid knowledge chunk reference.");
    const hasCitation=["contentHash","lineStart","lineEnd"].some(key=>a[key]!==undefined);
    const line=(value:Json)=>typeof value==="string"&&/^[1-9]\d{0,8}$/.test(value)?Number(value):value;
    const lineStart=line(a.lineStart),lineEnd=line(a.lineEnd);
    if(hasCitation)ensure(typeof a.contentHash==="string"&&/^[a-f0-9]{64}$/.test(a.contentHash)&&Number.isSafeInteger(lineStart)&&lineStart>=1&&Number.isSafeInteger(lineEnd)&&lineEnd>=lineStart&&lineEnd<=999999999&&lineEnd-lineStart<1000,"INPUT_INVALID","Invalid knowledge citation hash or line range.");
    const chunk=this.repo.get("knowledge_chunks",a.chunkId);
    if(!chunk)return null;
    // A rebuilt chunk ID can refer to different text. Compare against the citation
    // actually shown to the reader, including its original line range.
    const cited=hasCitation?{...chunk,contentHash:a.contentHash,lineStart,lineEnd}:chunk;
    const content=readFileSync(resolve(this.root,chunk.sourcePath),"utf8").split("\n").slice(cited.lineStart-1,cited.lineEnd).join("\n");
    return {...cited,content,currentContentHash:hash(content),stale:hash(content)!==cited.contentHash};
  }
  search(a:Json) {
    const query=tokens(String(a.query??""));if(!query.length)return {excerpts:[],citations:[]};
    const expression=query.slice(0,40).map(t=>'"'+t.replaceAll('"','""')+'"').join(" OR ");
    const rows=this.repo.db.prepare("SELECT chunk_id,bm25(knowledge_fts) AS score FROM knowledge_fts WHERE knowledge_fts MATCH ? ORDER BY score LIMIT ?")
      .all(expression,Math.min(20,Number(a.limit??5))) as {chunk_id:string}[];
    const excerpts=rows.map(row=>this.repo.get("knowledge_chunks",row.chunk_id)).filter(Boolean).filter(c=>!a.productVersion||c.productVersion===a.productVersion);
    return {excerpts,citations:excerpts.map(({content,id,documentId,chunkIndex,...c}:Json)=>({...c,chunkId:id}))};
  }
}
