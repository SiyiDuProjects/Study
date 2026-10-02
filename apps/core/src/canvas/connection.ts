import { INSTITUTIONS, type CanvasConnection } from "../domain.js";
import { CanvasApiError } from "./errors.js";

/** Shared account/host boundary for standard Canvas reads and writes at either school. */
export function requireCanvasConnection(connection: CanvasConnection | null, userId: string): CanvasConnection {
  if (!connection || connection.userId !== userId || !Object.hasOwn(INSTITUTIONS, connection.institution) ||
      connection.baseUrl.replace(/\/$/, "") !== INSTITUTIONS[connection.institution].baseUrl) {
    throw new CanvasApiError("permission_denied", "A matching school account and its approved Canvas host are required.");
  }
  return { ...connection, baseUrl: INSTITUTIONS[connection.institution].baseUrl };
}
