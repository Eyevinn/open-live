import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { getDb } from '../db/index.js';
import type { ProductionDoc } from '../db/types.js';
import { getTally, setTally, subscribe, unsubscribe, broadcast } from '../services/tally.service.js';
import { StromClient } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { config } from '../config.js';

type InboundMessage =
  | { type: 'CUT'; sourceId: string }
  | { type: 'TRANSITION'; sourceId: string; transitionType: string; durationMs?: number }
  | { type: 'TAKE' }
  | { type: 'GO_LIVE' }
  | { type: 'CUT_STREAM' }
  | { type: 'GRAPHIC_ON'; overlayId: string }
  | { type: 'GRAPHIC_OFF'; overlayId: string }
  | { type: 'DSK_TOGGLE'; layer: number; visible?: boolean }
  | { type: 'MACRO_EXEC'; macroId: string };

async function handleMessage(
  productionId: string,
  ws: WebSocket,
  raw: string
): Promise<void> {
  let msg: InboundMessage;
  try {
    msg = JSON.parse(raw) as InboundMessage;
  } catch {
    ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid JSON' }));
    return;
  }

  const db = getDb();
  let doc: ProductionDoc;
  try {
    doc = await db.get(productionId);
  } catch {
    ws.send(JSON.stringify({ type: 'ERROR', error: 'Production not found' }));
    return;
  }

  switch (msg.type) {
    case 'CUT': {
      const tally = getTally(productionId);
      const newTally = { pgm: msg.sourceId, pvw: tally.pgm };
      setTally(productionId, newTally);
      const updated: ProductionDoc = { ...doc, tally: newTally, updatedAt: new Date().toISOString() };
      await db.insert(updated);
      broadcast(productionId, { type: 'TALLY', ...newTally });
      break;
    }
    case 'TRANSITION': {
      const tally = getTally(productionId);
      const newTally = { pgm: msg.sourceId, pvw: tally.pgm };
      setTally(productionId, newTally);
      const updated: ProductionDoc = { ...doc, tally: newTally, updatedAt: new Date().toISOString() };
      await db.insert(updated);
      broadcast(productionId, { type: 'TALLY', ...newTally, transitionType: msg.transitionType, durationMs: msg.durationMs });
      break;
    }
    case 'TAKE': {
      const tally = getTally(productionId);
      const newTally = { pgm: tally.pvw, pvw: tally.pgm };
      setTally(productionId, newTally);
      const updated: ProductionDoc = { ...doc, tally: newTally, updatedAt: new Date().toISOString() };
      await db.insert(updated);
      broadcast(productionId, { type: 'TALLY', ...newTally });
      break;
    }
    case 'GO_LIVE': {
      const updated: ProductionDoc = { ...doc, status: 'active', updatedAt: new Date().toISOString() };
      await db.insert(updated);
      broadcast(productionId, { type: 'ON_AIR', value: true });
      break;
    }
    case 'CUT_STREAM': {
      const updated: ProductionDoc = { ...doc, status: 'active', updatedAt: new Date().toISOString() };
      await db.insert(updated);
      broadcast(productionId, { type: 'ON_AIR', value: false });
      break;
    }
    case 'GRAPHIC_ON':
    case 'GRAPHIC_OFF': {
      const active = msg.type === 'GRAPHIC_ON';
      const updated: ProductionDoc = {
        ...doc,
        graphics: doc.graphics.map((g) =>
          g.id === msg.overlayId ? { ...g, active } : g
        ),
        updatedAt: new Date().toISOString(),
      };
      await db.insert(updated);
      broadcast(productionId, { type: 'GRAPHIC', overlayId: msg.overlayId, active });
      break;
    }
    case 'DSK_TOGGLE': {
      if (!doc.stromFlowId || !doc.mixerBlockId) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Pipeline not active or mixer block not resolved' }));
        break;
      }
      const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
      const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
      const result = await strom.mixer.toggleDsk(doc.stromFlowId, doc.mixerBlockId, {
        layer: msg.layer,
        visible: msg.visible,
      });
      broadcast(productionId, { type: 'DSK_STATE', layer: result.layer, visible: result.visible });
      break;
    }
    case 'MACRO_EXEC': {
      const macro = (doc.macros ?? []).find((m) => m.id === msg.macroId);
      if (!macro) {
        ws.send(JSON.stringify({ type: 'ERROR', error: 'Macro not found' }));
        break;
      }
      const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
      const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
      let failedAt = -1;
      let failError = '';
      for (let i = 0; i < macro.actions.length; i++) {
        const action = macro.actions[i];
        try {
          if (action.type === 'CUT' && action.sourceId) {
            const tally = getTally(productionId);
            const newTally = { pgm: action.sourceId, pvw: tally.pgm };
            setTally(productionId, newTally);
            const updated: ProductionDoc = { ...doc, tally: newTally, updatedAt: new Date().toISOString() };
            await getDb().insert(updated);
            broadcast(productionId, { type: 'TALLY', ...newTally });
          } else if (action.type === 'TRANSITION' && action.sourceId) {
            const tally = getTally(productionId);
            const newTally = { pgm: action.sourceId, pvw: tally.pgm };
            setTally(productionId, newTally);
            const updated: ProductionDoc = { ...doc, tally: newTally, updatedAt: new Date().toISOString() };
            await getDb().insert(updated);
            broadcast(productionId, { type: 'TALLY', ...newTally, transitionType: action.transitionType, durationMs: action.durationMs });
          } else if (action.type === 'TAKE') {
            const tally = getTally(productionId);
            const newTally = { pgm: tally.pvw, pvw: tally.pgm };
            setTally(productionId, newTally);
            const updated: ProductionDoc = { ...doc, tally: newTally, updatedAt: new Date().toISOString() };
            await getDb().insert(updated);
            broadcast(productionId, { type: 'TALLY', ...newTally });
          } else if (action.type === 'GRAPHIC_ON' && action.overlayId) {
            const updated: ProductionDoc = {
              ...doc,
              graphics: doc.graphics.map((g) => g.id === action.overlayId ? { ...g, active: true } : g),
              updatedAt: new Date().toISOString(),
            };
            await getDb().insert(updated);
            broadcast(productionId, { type: 'GRAPHIC', overlayId: action.overlayId, active: true });
          } else if (action.type === 'GRAPHIC_OFF' && action.overlayId) {
            const updated: ProductionDoc = {
              ...doc,
              graphics: doc.graphics.map((g) => g.id === action.overlayId ? { ...g, active: false } : g),
              updatedAt: new Date().toISOString(),
            };
            await getDb().insert(updated);
            broadcast(productionId, { type: 'GRAPHIC', overlayId: action.overlayId, active: false });
          } else if (action.type === 'DSK_TOGGLE') {
            if (!doc.stromFlowId || !doc.mixerBlockId) {
              throw new Error('Pipeline not active or mixer block not resolved');
            }
            await strom.mixer.toggleDsk(doc.stromFlowId, doc.mixerBlockId, {
              layer: action.layer ?? 0,
              visible: action.visible,
            });
          }
        } catch (err) {
          failedAt = i;
          failError = err instanceof Error ? err.message : String(err);
          break;
        }
      }
      if (failedAt !== -1) {
        ws.send(JSON.stringify({ type: 'MACRO_ERROR', macroId: msg.macroId, failedActionIndex: failedAt, error: failError }));
      } else {
        broadcast(productionId, { type: 'MACRO_EXECUTED', macroId: msg.macroId });
      }
      break;
    }
    default: {
      ws.send(JSON.stringify({ type: 'ERROR', error: 'Unknown message type' }));
    }
  }
}

const controllerWs: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { id: string } }>(
    '/ws/productions/:id/controller',
    { websocket: true },
    async (socket, req) => {
      const { id } = req.params;
      subscribe(id, socket);

      // Send current state on connect
      const tally = getTally(id);
      socket.send(JSON.stringify({ type: 'TALLY', ...tally }));

      socket.on('message', (raw: Buffer | string) => {
        void handleMessage(id, socket, raw.toString());
      });

      socket.on('close', () => {
        unsubscribe(id, socket);
      });
    }
  );
};

export default controllerWs;
