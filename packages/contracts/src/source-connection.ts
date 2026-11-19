import { hash, type Json } from "./domain.js";

export function sourceConnectionRouteHash(connection: Json) {
  const target = connection.transport === "stdio"
    ? [connection.command, connection.args ?? [], connection.commandApproved ?? false, connection.envRefs ?? {}]
    : [connection.endpoint, connection.allowedHosts ?? [], connection.secretRef ?? null];
  return hash([connection.transport, connection.protocolEra, target]);
}

export function hasVerifiedSourceConnectionRoute(connection: Json) {
  if (!connection?.sourceId || !connection.sourceFingerprint) return false;
  // Import and configuration originally stored their exact routes at revision 1.
  return connection.sourceRouteHash === undefined
    ? connection.revision === 1
    : connection.sourceRouteHash === sourceConnectionRouteHash(connection);
}
