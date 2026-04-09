import { randomUUID } from 'crypto';
import type { ProductionDoc, SourceDoc, StromFlowTemplate } from '../db/types.js';
import { getSourcesDb, getTemplatesDb } from '../db/index.js';
import { StromClient } from './strom.js';

/**
 * Generates a Strom flow from a template + source assignments,
 * creates it in Strom, starts it, and returns the flow ID.
 *
 * Throws if no templateId is set, template is not found,
 * or Strom creation/start fails.
 */
export async function activateStromFlow(
  production: ProductionDoc,
  strom: StromClient,
): Promise<string> {
  if (!production.templateId) {
    throw new Error('Production has no templateId — cannot activate Strom flow');
  }

  // Load template
  const templatesDb = getTemplatesDb();
  const template = await templatesDb.get(production.templateId) as unknown as StromFlowTemplate;

  // Load all assigned sources
  const sourcesDb = getSourcesDb();
  const sourceMap = new Map<string, SourceDoc>();
  for (const assignment of production.sources) {
    const src = await sourcesDb.get(assignment.sourceId) as unknown as SourceDoc;
    sourceMap.set(assignment.sourceId, src);
  }

  // Deep-clone the template flow so we don't mutate the stored template
  const flow = JSON.parse(JSON.stringify(template.flow)) as StromFlowTemplate['flow'];

  // Patch source addresses into the appropriate blocks
  for (const assignment of production.sources) {
    const slot = template.inputs.find((inp) => inp.id === assignment.mixerInput);
    if (!slot) continue;

    const source = sourceMap.get(assignment.sourceId);
    if (!source) continue;

    // Skip patching when addressProperty is empty (e.g. hardwired dev template inputs)
    if (!slot.addressProperty) continue;

    const block = flow.blocks.find((b) => b['id'] === slot.blockId) as Record<string, unknown> | undefined;
    if (!block) continue;

    if (!block['properties'] || typeof block['properties'] !== 'object') {
      block['properties'] = {};
    }
    (block['properties'] as Record<string, unknown>)[slot.addressProperty] = source.address;
  }

  // POST /api/flows takes the full Flow struct. The server requires 'id' in the
  // body but overwrites it with a new UUID — always use created.flow.id for
  // all subsequent calls.
  const flowName = `${production.name}-${randomUUID().slice(0, 8)}`;
  const created = await strom.flows.create({
    id: randomUUID(),
    name: flowName,
    description: `Production: ${production.name}`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    elements: flow.elements as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blocks: flow.blocks as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    links: flow.links as any,
  });

  const flowId = created.flow.id;

  await strom.flows.start(flowId);

  return flowId;
}

/**
 * Stops and deletes the Strom flow associated with a production.
 * Silently ignores errors (flow may already be gone).
 */
export async function deactivateStromFlow(
  stromFlowId: string,
  strom: StromClient,
): Promise<void> {
  try {
    await strom.flows.stop(stromFlowId);
  } catch {
    // ignore — flow may not be running
  }
  try {
    await strom.flows.delete(stromFlowId);
  } catch {
    // ignore — flow may not exist
  }
}
