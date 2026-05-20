/**
 * Daemon internal event bus.
 *
 * Single in-process EventEmitter wired up at module load. Registry mutations
 * publish here; WS hub subscribes and rebroadcasts to connected clients.
 *
 * Kept narrow on purpose: no buffering, no schemas, no async. If the wire
 * shape ever needs versioning, do it at the WS hub boundary, not here.
 */
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(50);
