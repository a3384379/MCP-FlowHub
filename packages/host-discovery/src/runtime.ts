import {isAbsolute} from "node:path";
import {ensure,type Json} from "../../contracts/src/domain.js";

/** Code-only dependency injection for subprocess fixtures. Never part of a host-context DTO. */
export type DiscoveryRuntime={command?:(context:Json,args:readonly string[])=>{executable:string;args:string[]}};
export function discoveryCommand(context:Json,args:string[],runtime:DiscoveryRuntime={}) {
  const command=runtime.command?.(context,args)??{executable:context.codexPath,args};
  ensure(typeof command.executable==="string"&&isAbsolute(command.executable),"INPUT_INVALID","An absolute Codex executable is required.");
  return command;
}
